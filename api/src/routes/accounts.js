'use strict';

// Bank account routes (CONTRACT §6.3, §10.2).
//
// An account belongs to one company (immutable) and holds one currency. Rules:
//   - one `is_default` per company (D16): `isDefault: true` clears the flag on
//     the company's other live accounts in the same transaction, one audit row
//     each. The company's live accounts are locked ascending by id first — the
//     target among them — so two concurrent default flips cannot deadlock.
//   - currency change and delete are refused with 409 ACCOUNT_IN_USE while live
//     items, schedules or balances reference the account (D15).
//   - deactivation (`isActive: false`) is refused with 409 ACCOUNT_IN_USE while
//     the account has anything /forecast would show (D17). See owedOnAccount.
// Soft delete. `anchorDate`/`anchorBalance` (latest recorded balance) ride on the
// list and single read only.

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const { ITEM_SELECT } = require('../services/forecastLoad');
const { decorateItems } = require('../services/items');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, parseSortOrder, accountToJson,
} = require('../lib/shape');

const CURRENCY_RE = /^[A-Z]{3}$/;
const DETAIL_KEY_CAP = 50;   // D17: keys capped at 50 per kind

function parseName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= 255 ? name : null;
}

/** A body id: a positive integer as a JSON number or numeric string, else null. */
function bodyId(value) {
    return typeof value === 'number' || typeof value === 'string' ? parseId(value) : null;
}

const isCurrency = (value) => typeof value === 'string' && CURRENCY_RE.test(value);

// The anchor (latest recorded balance) — list and single read only.
const ANCHOR_COLUMNS = `
    (SELECT b.balance_date FROM bank_balances b WHERE b.account_id = a.id
      ORDER BY b.balance_date DESC LIMIT 1) AS anchor_date,
    (SELECT b.balance FROM bank_balances b WHERE b.account_id = a.id
      ORDER BY b.balance_date DESC LIMIT 1) AS anchor_balance`;

async function readAccount(conn, id, { includeDeleted = false, anchor = false } = {}) {
    const [rows] = await conn.query(
        `SELECT a.*${anchor ? `, ${ANCHOR_COLUMNS}` : ''}
           FROM bank_accounts a
          WHERE a.id = ?${includeDeleted ? '' : ' AND a.deleted_at IS NULL'}`,
        [id]
    );
    return rows.length ? rows[0] : null;
}

/** Live items, live schedules and balances on the account (D15 counts). */
async function references(conn, id) {
    const [[items]] = await conn.query(
        'SELECT COUNT(*) AS n FROM cash_items WHERE account_id = ? AND deleted_at IS NULL', [id]
    );
    const [[schedules]] = await conn.query(
        'SELECT COUNT(*) AS n FROM schedules WHERE account_id = ? AND deleted_at IS NULL', [id]
    );
    const [[balances]] = await conn.query(
        'SELECT COUNT(*) AS n FROM bank_balances WHERE account_id = ?', [id]
    );
    return { itemCount: Number(items.n), scheduleCount: Number(schedules.n), balanceCount: Number(balances.n) };
}

/**
 * What /forecast would still show for this account (D17), read under the
 * account lock. Refusing deactivation on any of it keeps owed money from
 * silently dropping out of the forecast.
 *
 *   owedItems      live one-offs with status `part_paid`, or `expected` with a
 *                  derivedStatus other than `assumedSettled` — the same
 *                  classify call GET /items makes (services/items.js), against
 *                  the account's anchor and `today` (§10.2). The candidates are
 *                  a locking read (FOR SHARE OF the items, after the account
 *                  row: §10.1's order), so they are current even when this
 *                  transaction's snapshot predates the account lock (the
 *                  isDefault path reads first).
 *   liveSchedules  every live schedule (ended ones included) — see below.
 *   owedInstances  none yet.
 *
 * TODO(step 5): keep only the schedules with an occurrence on or after `today`
 *   (lib/recurrence.js, effective dates), and fill owedInstances with the
 *   instances whose derivedStatus is `overdue` or `unresolved`.
 */
async function owedOnAccount(conn, id, today) {
    const [rows] = await conn.query(
        `${ITEM_SELECT}
          WHERE i.account_id = ? AND i.deleted_at IS NULL AND i.status IN ('expected', 'part_paid')
          ORDER BY i.due_date ASC, i.id ASC
          FOR SHARE OF i`,
        [id]
    );
    const owed = (await decorateItems(conn, rows, today))
        .filter((item) => item.status === 'part_paid' || item.derivedStatus !== 'assumedSettled');
    const [[scheduleCount]] = await conn.query(
        'SELECT COUNT(*) AS n FROM schedules WHERE account_id = ? AND deleted_at IS NULL', [id]
    );
    const [schedules] = await conn.query(
        'SELECT id FROM schedules WHERE account_id = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT ?',
        [id, DETAIL_KEY_CAP]
    );
    return {
        owedItems: { count: owed.length, keys: owed.slice(0, DETAIL_KEY_CAP).map((item) => item.key) },
        liveSchedules: { count: Number(scheduleCount.n), ids: schedules.map((r) => Number(r.id)) },
        owedInstances: { count: 0, keys: [] },
    };
}

/**
 * D16: clear is_default on the company's other live accounts in `locked` (the
 * company's live accounts, already locked ascending by id), one audit row each.
 */
async function clearSiblingDefaults(conn, locked, keepId, userEmail) {
    for (const sib of locked) {
        if (Number(sib.id) === keepId || !Number(sib.is_default)) continue;
        await conn.query(
            'UPDATE bank_accounts SET is_default = 0, row_version = row_version + 1 WHERE id = ?', [sib.id]
        );
        await recordAudit(conn, {
            entityType: 'bank_account', entityId: Number(sib.id), action: 'update',
            before: accountToJson(sib), after: accountToJson(await readAccount(conn, Number(sib.id))),
            userEmail,
        });
    }
}

/** The company's live accounts, locked ascending by id (§10.1, §10.2). */
async function lockCompanyAccounts(conn, companyId) {
    const [rows] = await conn.query(
        'SELECT * FROM bank_accounts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id ASC FOR UPDATE',
        [companyId]
    );
    return rows;
}

function parseBoolFlag(value) {
    return typeof value === 'boolean' ? value : null;
}

module.exports = ({ schemaReady, fail, serverError, todayFor }) => {
    const router = express.Router();

    router.get('/accounts', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            if (req.query.includeDeleted !== '1') where.push('a.deleted_at IS NULL');
            if (req.query.companyId !== undefined) {
                const companyId = parseId(req.query.companyId);
                if (!companyId) return fail(res, 400, 'companyId must be a positive integer.');
                where.push('a.company_id = ?');
                params.push(companyId);
            }
            if (req.query.isActive !== undefined) {
                const raw = String(req.query.isActive);
                if (!['1', '0', 'true', 'false'].includes(raw)) {
                    return fail(res, 400, 'isActive must be true or false.');
                }
                where.push('a.is_active = ?');
                params.push(raw === '1' || raw === 'true' ? 1 : 0);
            }
            if (req.query.q) {
                where.push('a.name LIKE ?');
                params.push(`%${String(req.query.q)}%`);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(
                    `SELECT COUNT(*) AS total FROM bank_accounts a ${whereSql}`, params
                );
                const [rows] = await c.query(
                    `SELECT a.*, ${ANCHOR_COLUMNS}
                       FROM bank_accounts a
                       LEFT JOIN companies c ON c.id = a.company_id
                       ${whereSql}
                      ORDER BY c.sort_order ASC, c.name ASC, a.company_id ASC,
                               a.sort_order ASC, a.name ASC, a.id ASC
                      LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, rows };
            });
            res.json(listResponse(out.rows.map(accountToJson), { page, limit, total: Number(out.total) }));
        } catch (err) {
            serverError(res, 'accounts-list', err);
        }
    });

    router.post('/accounts', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            const companyId = bodyId(body.companyId);
            if (!companyId) return fail(res, 400, 'companyId is required (a positive integer).');
            const name = parseName(body.name);
            if (!name) return fail(res, 400, 'name is required (at most 255 characters).');
            if (!isCurrency(body.currency)) return fail(res, 400, 'currency is required: three capital letters, e.g. GBP.');
            const sortOrder = parseSortOrder(body.sortOrder);
            if (Number.isNaN(sortOrder)) return fail(res, 400, 'sortOrder must be an integer.');
            const isActive = body.isActive === undefined ? true : parseBoolFlag(body.isActive);
            if (isActive === null) return fail(res, 400, 'isActive must be true or false.');
            const isDefault = body.isDefault === undefined ? false : parseBoolFlag(body.isDefault);
            if (isDefault === null) return fail(res, 400, 'isDefault must be true or false.');

            const created = await withTransaction(async (conn) => {
                // The company row first: company delete locks it too, so no
                // account can be added to a company being deleted.
                const [companies] = await conn.query(
                    'SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [companyId]
                );
                if (!companies.length) throw apiError(400, undefined, 'companyId is not a live company.');
                const siblings = isDefault ? await lockCompanyAccounts(conn, companyId) : [];
                const [ins] = await conn.query(
                    `INSERT INTO bank_accounts (company_id, name, currency, sort_order, is_active, is_default, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [companyId, name, body.currency, sortOrder, isActive ? 1 : 0, isDefault ? 1 : 0, req.userEmail]
                );
                const id = ins.insertId;
                if (isDefault) await clearSiblingDefaults(conn, siblings, id, req.userEmail);
                const after = accountToJson(await readAccount(conn, id));
                await recordAudit(conn, {
                    entityType: 'bank_account', entityId: id, action: 'create',
                    before: null, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'accounts-create', err);
        }
    });

    router.get('/accounts/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Account not found.');
            const row = await withConnection((c) =>
                readAccount(c, id, { includeDeleted: req.query.includeDeleted === '1', anchor: true }));
            if (!row) return fail(res, 404, 'Account not found.');
            res.json(accountToJson(row));
        } catch (err) {
            serverError(res, 'accounts-get', err);
        }
    });

    router.put('/accounts/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Account not found.');
            const body = req.body || {};
            const has = (k) => body[k] !== undefined;
            if (!['name', 'currency', 'sortOrder', 'isActive', 'isDefault', 'companyId'].some(has)) {
                return fail(res, 400, 'Nothing to update: send name, currency, sortOrder, isActive and/or isDefault.');
            }
            const name = has('name') ? parseName(body.name) : null;
            if (has('name') && !name) return fail(res, 400, 'name cannot be blank (at most 255 characters).');
            if (has('currency') && !isCurrency(body.currency)) {
                return fail(res, 400, 'currency must be three capital letters, e.g. GBP.');
            }
            const sortOrder = has('sortOrder') ? parseSortOrder(body.sortOrder) : null;
            if (has('sortOrder') && Number.isNaN(sortOrder)) return fail(res, 400, 'sortOrder must be an integer.');
            const isActive = has('isActive') ? parseBoolFlag(body.isActive) : null;
            if (has('isActive') && isActive === null) return fail(res, 400, 'isActive must be true or false.');
            const isDefault = has('isDefault') ? parseBoolFlag(body.isDefault) : null;
            if (has('isDefault') && isDefault === null) return fail(res, 400, 'isDefault must be true or false.');
            const companyId = has('companyId') ? bodyId(body.companyId) : null;
            if (has('companyId') && !companyId) return fail(res, 400, 'companyId cannot be changed.');
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            // Once per request, whichever branch needs it (CONTRACT §2.5).
            const today = todayFor(req);

            const updated = await withTransaction(async (conn) => {
                let row;
                let siblings = [];
                if (isDefault === true) {
                    // company_id is immutable, so this plain read picks the
                    // sibling set; the locking read below re-checks liveness.
                    const [meta] = await conn.query(
                        'SELECT company_id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL', [id]
                    );
                    if (meta.length) {
                        siblings = await lockCompanyAccounts(conn, meta[0].company_id);
                        row = siblings.find((a) => Number(a.id) === id);
                    }
                } else {
                    const [rows] = await conn.query(
                        'SELECT * FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
                    );
                    row = rows[0];
                }
                if (!row) throw apiError(404, undefined, 'Account not found.');
                assertBaseVersion(row, baseVersion);
                if (companyId && companyId !== Number(row.company_id)) {
                    throw apiError(400, undefined, 'companyId cannot be changed.');
                }

                const next = {
                    name: name ?? row.name,
                    currency: has('currency') ? body.currency : row.currency,
                    sortOrder: has('sortOrder') ? sortOrder : row.sort_order,
                    isActive: isActive ?? Boolean(Number(row.is_active)),
                    isDefault: isDefault ?? Boolean(Number(row.is_default)),
                };
                if (next.currency !== row.currency) {
                    const refs = await references(conn, id);
                    if (refs.itemCount || refs.scheduleCount || refs.balanceCount) {
                        throw apiError(409, 'ACCOUNT_IN_USE',
                            'This account has items, schedules or balances in its currency, so the currency cannot change.',
                            refs);
                    }
                }
                if (!next.isActive && Number(row.is_active)) {
                    const owed = await owedOnAccount(conn, id, today);
                    if (owed.owedItems.count || owed.liveSchedules.count || owed.owedInstances.count) {
                        throw apiError(409, 'ACCOUNT_IN_USE',
                            'This account still has money owed or expected in the forecast, so it cannot be deactivated.',
                            owed);
                    }
                }

                const before = accountToJson(row);
                const changed = next.name !== row.name || next.currency !== row.currency
                    || next.sortOrder !== row.sort_order || next.isActive !== Boolean(Number(row.is_active))
                    || next.isDefault !== Boolean(Number(row.is_default));
                if (next.isDefault) await clearSiblingDefaults(conn, siblings, id, req.userEmail);
                if (!changed) return before;
                await conn.query(
                    `UPDATE bank_accounts
                        SET name = ?, currency = ?, sort_order = ?, is_active = ?, is_default = ?,
                            row_version = row_version + 1
                      WHERE id = ?`,
                    [next.name, next.currency, next.sortOrder, next.isActive ? 1 : 0, next.isDefault ? 1 : 0, id]
                );
                const after = accountToJson(await readAccount(conn, id));
                await recordAudit(conn, {
                    entityType: 'bank_account', entityId: id, action: 'update', before, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.json(updated);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'accounts-update', err);
        }
    });

    router.delete('/accounts/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Account not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            await withTransaction(async (conn) => {
                const [rows] = await conn.query(
                    'SELECT * FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
                );
                if (!rows.length) throw apiError(404, undefined, 'Account not found.');
                assertBaseVersion(rows[0], baseVersion);
                const refs = await references(conn, id);
                if (refs.itemCount || refs.scheduleCount || refs.balanceCount) {
                    throw apiError(409, 'ACCOUNT_IN_USE',
                        'This account still has items, schedules or balances. Remove them first.', refs);
                }
                await conn.query(
                    'UPDATE bank_accounts SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?',
                    [id]
                );
                await recordAudit(conn, {
                    entityType: 'bank_account', entityId: id, action: 'delete',
                    before: accountToJson(rows[0]),
                    after: accountToJson(await readAccount(conn, id, { includeDeleted: true })),
                    userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'accounts-delete', err);
        }
    });

    return router;
};
