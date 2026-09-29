'use strict';

// One-off item routes (CONTRACT §6.7, §10.1, §10.3; D1, D4, D10, D12–D14,
// D17–D19, D23, D28).
//
// An item sits on one account and one category, and its direction is the
// category's (D14: a `direction` that differs is 400; omitted, it follows the
// category). Rules:
//   - `settleMode` edits in place: `manual` on an assumedSettled item is
//     "Didn't happen" (§9.6).
//   - `status` moves only expected ↔ skipped through PUT (D19). Pay and unpay
//     own paid / part_paid, so PUT refuses to change `status`, `amount` or
//     `currency` on a paid or part_paid item (409 ITEM_NOT_EDITABLE).
//   - Payments are rows (D23). Pay inserts one `payments` row and rewrites the
//     cache (`paid_amount` = SUM, `paid_on` = MAX) and the status under the
//     item's row lock; unpay deletes every payment row, one audit row each.
//   - Soft delete, any status, no in-use guard (D18).
// Every row answered carries `payments[]` and `derivedStatus` (services/items.js).
//
// Locks (§10.1): a write that sets or changes `accountId` / `categoryId`
// takes FOR SHARE on the account and the category FIRST, then the
// `cash_items` row FOR UPDATE; `payments` rows are touched only under it.

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const { isValidDate } = require('../lib/dates');
const { parseMinor, formatMinor } = require('../lib/money');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, itemToJson, paymentToJson,
} = require('../lib/shape');
const { ITEM_SELECT } = require('../services/forecastLoad');
const { decorateItems, readItem } = require('../services/items');

const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_NAME = 255;          // name, counterparty: VARCHAR(255)
const MAX_NOTE = 500;          // payments.note: VARCHAR(500)
const MAX_NOTES = 16000;       // notes: TEXT (65,535 bytes; 16,000 four-byte characters fit)
const PUT_FIELDS = [
    'accountId', 'categoryId', 'direction', 'name', 'counterparty', 'amount', 'currency',
    'dueDate', 'settleMode', 'status', 'notes',
];
// D19: the only statuses a PUT may write.
const PUT_STATUSES = ['expected', 'skipped'];

function parseName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= MAX_NAME ? name : null;
}

/**
 * Optional text: undefined = absent, null = clear (null or blank), else the
 * trimmed string of at most `max` characters. NaN = invalid (400).
 */
function parseText(value, max) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > max) return NaN;
    return value.trim() || null;
}

/** A DECIMAL money string (D1) → bigint minor units, or null (a JSON number is refused). */
function parseMoney(value) {
    try {
        return parseMinor(value);
    } catch {
        return null;
    }
}

/** A body id: a positive integer as a JSON number or numeric string, else null. */
function bodyId(value) {
    return typeof value === 'number' || typeof value === 'string' ? parseId(value) : null;
}

const isCurrency = (value) => typeof value === 'string' && CURRENCY_RE.test(value);

/** The `payment` audit snapshot (§2.8). */
const paymentSnapshot = (p) => ({
    cashItemId: p.cashItemId, overrideId: p.overrideId, paidOn: p.paidOn, amount: p.amount, note: p.note,
});

/**
 * §10.1's one exception, taken FIRST, before any standing-order lock: FOR
 * SHARE on the account and / or category named in the body. Returns the live
 * rows (null when not live); requireAccount / requireCategory are the re-check,
 * made for every create and for an update that changes the value. Account
 * deactivation / delete and category delete take FOR UPDATE on the same rows,
 * so an item cannot slip onto an account or category being switched off.
 */
async function shareReferences(conn, { accountId, categoryId }) {
    let account = null;
    let category = null;
    if (accountId) {
        const [rows] = await conn.query(
            'SELECT id, currency, is_active FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR SHARE',
            [accountId]
        );
        account = rows[0] || null;
    }
    if (categoryId) {
        const [rows] = await conn.query(
            'SELECT id, direction FROM categories WHERE id = ? AND deleted_at IS NULL FOR SHARE', [categoryId]
        );
        category = rows[0] || null;
    }
    return { account, category };
}

function requireAccount(account) {
    if (!account) throw apiError(400, undefined, 'accountId is not a live account.');
    if (!Number(account.is_active)) throw apiError(400, undefined, 'accountId is an inactive account.');
    return account;
}

function requireCategory(category) {
    if (!category) throw apiError(400, undefined, 'categoryId is not a live category.');
    return category;
}

/** D14: a sent `direction` must be the category's. */
function assertDirection(direction, category) {
    if (direction !== undefined && direction !== category.direction) {
        throw apiError(400, undefined,
            `direction must be the category's (${category.direction}); omit it to follow the category.`,
            { direction, categoryDirection: category.direction });
    }
}

/** Lock the live item row (§10.3 step 1) → 404; the D4 check under the lock; the full row. */
async function lockItem(conn, id, baseVersion) {
    const [locked] = await conn.query(
        'SELECT id, row_version FROM cash_items WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!locked.length) throw apiError(404, undefined, 'Item not found.');
    assertBaseVersion(locked[0], baseVersion);
    return readItem(conn, id);
}

const oneItem = async (conn, row, today) => (await decorateItems(conn, [row], today))[0];

module.exports = ({ schemaReady, fail, serverError, todayFor, enums }) => {
    const router = express.Router();
    const DIRECTIONS = enums.directions;
    const ITEM_STATUSES = enums.itemStatuses;
    const SETTLE_MODES = enums.settleModes;

    router.get('/items', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            if (req.query.includeDeleted !== '1') where.push('i.deleted_at IS NULL');
            for (const [key, column] of [['accountId', 'i.account_id'], ['companyId', 'a.company_id'], ['categoryId', 'i.category_id']]) {
                if (req.query[key] === undefined) continue;
                const value = parseId(req.query[key]);
                if (!value) return fail(res, 400, `${key} must be a positive integer.`);
                where.push(`${column} = ?`);
                params.push(value);
            }
            if (req.query.status !== undefined) {
                const statuses = String(req.query.status).split(',').map((s) => s.trim());
                const bad = statuses.filter((s) => !ITEM_STATUSES.includes(s));
                if (bad.length) return fail(res, 400, `status must be a comma list of: ${ITEM_STATUSES.join(', ')}.`);
                where.push(`i.status IN (${statuses.map(() => '?').join(', ')})`);
                params.push(...statuses);
            }
            if (req.query.settleMode !== undefined) {
                const mode = String(req.query.settleMode);
                if (!SETTLE_MODES.includes(mode)) return fail(res, 400, `settleMode must be one of: ${SETTLE_MODES.join(', ')}.`);
                where.push('i.settle_mode = ?');
                params.push(mode);
            }
            for (const [key, op] of [['from', '>='], ['to', '<=']]) {
                if (req.query[key] === undefined) continue;
                if (!isValidDate(req.query[key])) return fail(res, 400, `${key} must be a real date, YYYY-MM-DD.`);
                where.push(`i.due_date ${op} ?`);
                params.push(req.query[key]);
            }
            if (req.query.q) {
                where.push('(i.name LIKE ? OR i.counterparty LIKE ?)');
                params.push(`%${String(req.query.q)}%`, `%${String(req.query.q)}%`);
            }
            const today = todayFor(req);
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(
                    `SELECT COUNT(*) AS total FROM cash_items i LEFT JOIN bank_accounts a ON a.id = i.account_id ${whereSql}`,
                    params
                );
                const [rows] = await c.query(
                    `${ITEM_SELECT} ${whereSql} ORDER BY i.due_date ASC, i.id ASC LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, data: await decorateItems(c, rows, today) };
            });
            res.json(listResponse(out.data, { page, limit, total: Number(out.total) }));
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-list', err);
        }
    });

    router.post('/items', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            const accountId = bodyId(body.accountId);
            if (!accountId) return fail(res, 400, 'accountId is required (a positive integer).');
            const categoryId = bodyId(body.categoryId);
            if (!categoryId) return fail(res, 400, 'categoryId is required (a positive integer).');
            const name = parseName(body.name);
            if (!name) return fail(res, 400, `name is required (at most ${MAX_NAME} characters).`);
            const amount = parseMoney(body.amount);
            if (amount === null || amount <= 0n) {
                return fail(res, 400, 'amount is required: a decimal string greater than zero, e.g. "1024.00".');
            }
            if (!isValidDate(body.dueDate)) return fail(res, 400, 'dueDate is required: a real date, YYYY-MM-DD.');
            if (body.direction !== undefined && !DIRECTIONS.includes(body.direction)) {
                return fail(res, 400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
            }
            if (body.currency !== undefined && !isCurrency(body.currency)) {
                return fail(res, 400, 'currency must be three capital letters, e.g. GBP.');
            }
            const counterparty = parseText(body.counterparty, MAX_NAME);
            if (Number.isNaN(counterparty)) return fail(res, 400, `counterparty must be text of at most ${MAX_NAME} characters.`);
            const settleMode = body.settleMode === undefined ? 'auto' : body.settleMode;
            if (!SETTLE_MODES.includes(settleMode)) return fail(res, 400, `settleMode must be one of: ${SETTLE_MODES.join(', ')}.`);
            const notes = parseText(body.notes, MAX_NOTES);
            if (Number.isNaN(notes)) return fail(res, 400, `notes must be text of at most ${MAX_NOTES} characters.`);
            const today = todayFor(req);

            const created = await withTransaction(async (conn) => {
                const refs = await shareReferences(conn, { accountId, categoryId });
                const account = requireAccount(refs.account);
                const category = requireCategory(refs.category);
                assertDirection(body.direction, category);
                const [ins] = await conn.query(
                    `INSERT INTO cash_items
                        (account_id, category_id, direction, name, counterparty, amount, currency, due_date,
                         settle_mode, notes, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [accountId, categoryId, category.direction, name, counterparty ?? null, formatMinor(amount),
                        body.currency ?? account.currency, body.dueDate, settleMode, notes ?? null, req.userEmail]
                );
                const row = await readItem(conn, ins.insertId);
                await recordAudit(conn, {
                    entityType: 'cash_item', entityId: ins.insertId, action: 'create',
                    before: null, after: itemToJson(row), userEmail: req.userEmail,
                });
                return oneItem(conn, row, today);
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-create', err);
        }
    });

    router.get('/items/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Item not found.');
            const today = todayFor(req);
            const item = await withConnection(async (c) => {
                const row = await readItem(c, id, { includeDeleted: req.query.includeDeleted === '1' });
                return row ? oneItem(c, row, today) : null;
            });
            if (!item) return fail(res, 404, 'Item not found.');
            res.json(item);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-get', err);
        }
    });

    router.put('/items/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Item not found.');
            const body = req.body || {};
            const has = (k) => body[k] !== undefined;
            if (!PUT_FIELDS.some(has)) {
                return fail(res, 400, `Nothing to update: send any of ${PUT_FIELDS.join(', ')}.`);
            }
            const accountId = has('accountId') ? bodyId(body.accountId) : null;
            if (has('accountId') && !accountId) return fail(res, 400, 'accountId must be a positive integer.');
            const categoryId = has('categoryId') ? bodyId(body.categoryId) : null;
            if (has('categoryId') && !categoryId) return fail(res, 400, 'categoryId must be a positive integer.');
            if (has('direction') && !DIRECTIONS.includes(body.direction)) {
                return fail(res, 400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
            }
            const name = has('name') ? parseName(body.name) : null;
            if (has('name') && !name) return fail(res, 400, `name cannot be blank (at most ${MAX_NAME} characters).`);
            const counterparty = parseText(body.counterparty, MAX_NAME);
            if (Number.isNaN(counterparty)) return fail(res, 400, `counterparty must be text of at most ${MAX_NAME} characters.`);
            const amount = has('amount') ? parseMoney(body.amount) : null;
            if (has('amount') && (amount === null || amount <= 0n)) {
                return fail(res, 400, 'amount must be a decimal string greater than zero, e.g. "1024.00".');
            }
            if (has('currency') && !isCurrency(body.currency)) {
                return fail(res, 400, 'currency must be three capital letters, e.g. GBP.');
            }
            if (has('dueDate') && !isValidDate(body.dueDate)) return fail(res, 400, 'dueDate must be a real date, YYYY-MM-DD.');
            if (has('settleMode') && !SETTLE_MODES.includes(body.settleMode)) {
                return fail(res, 400, `settleMode must be one of: ${SETTLE_MODES.join(', ')}.`);
            }
            if (has('status') && !PUT_STATUSES.includes(body.status)) {
                return fail(res, 400, 'status may only move between expected and skipped; pay and unpay set paid and part_paid.');
            }
            const notes = parseText(body.notes, MAX_NOTES);
            if (Number.isNaN(notes)) return fail(res, 400, `notes must be text of at most ${MAX_NOTES} characters.`);
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);

            const updated = await withTransaction(async (conn) => {
                // §10.1: the reference share locks before the item row lock.
                const refs = await shareReferences(conn, { accountId, categoryId });
                const row = await lockItem(conn, id, baseVersion);
                // Re-checked only when the value changes: an unchanged id in the
                // body is not a move.
                if (accountId !== null && accountId !== Number(row.account_id)) requireAccount(refs.account);
                const category = categoryId !== null && categoryId !== Number(row.category_id)
                    ? requireCategory(refs.category) : null;

                const next = {
                    accountId: accountId ?? Number(row.account_id),
                    categoryId: categoryId ?? Number(row.category_id),
                    direction: category ? category.direction : row.direction,
                    name: name ?? row.name,
                    counterparty: counterparty === undefined ? row.counterparty : counterparty,
                    amount: amount ?? parseMinor(row.amount),
                    currency: has('currency') ? body.currency : row.currency,
                    dueDate: has('dueDate') ? body.dueDate : row.due_date,
                    settleMode: has('settleMode') ? body.settleMode : row.settle_mode,
                    status: has('status') ? body.status : row.status,
                    notes: notes === undefined ? row.notes : notes,
                };
                assertDirection(body.direction, { direction: next.direction });

                // D19 / ITEM_NOT_EDITABLE: pay and unpay own these on a paid or
                // part_paid item. A value equal to the stored one is not a change.
                if (row.status === 'paid' || row.status === 'part_paid') {
                    const locked = [];
                    if (has('status') && next.status !== row.status) locked.push('status');
                    if (next.amount !== parseMinor(row.amount)) locked.push('amount');
                    if (next.currency !== row.currency) locked.push('currency');
                    if (locked.length) {
                        throw apiError(409, 'ITEM_NOT_EDITABLE',
                            `This item is ${row.status === 'paid' ? 'paid' : 'part paid'}: unpay it before changing ${locked.join(', ')}.`,
                            { status: row.status });
                    }
                }

                const changed = next.accountId !== Number(row.account_id)
                    || next.categoryId !== Number(row.category_id)
                    || next.direction !== row.direction || next.name !== row.name
                    || next.counterparty !== row.counterparty || next.amount !== parseMinor(row.amount)
                    || next.currency !== row.currency || next.dueDate !== row.due_date
                    || next.settleMode !== row.settle_mode || next.status !== row.status
                    || next.notes !== row.notes;
                if (!changed) return oneItem(conn, row, today);

                await conn.query(
                    `UPDATE cash_items
                        SET account_id = ?, category_id = ?, direction = ?, name = ?, counterparty = ?, amount = ?,
                            currency = ?, due_date = ?, settle_mode = ?, status = ?, notes = ?,
                            row_version = row_version + 1
                      WHERE id = ?`,
                    [next.accountId, next.categoryId, next.direction, next.name, next.counterparty,
                        formatMinor(next.amount), next.currency, next.dueDate, next.settleMode, next.status,
                        next.notes, id]
                );
                const after = await readItem(conn, id);
                await recordAudit(conn, {
                    entityType: 'cash_item', entityId: id, action: 'update',
                    before: itemToJson(row), after: itemToJson(after), userEmail: req.userEmail,
                });
                return oneItem(conn, after, today);
            });
            res.json(updated);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-update', err);
        }
    });

    router.delete('/items/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Item not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            await withTransaction(async (conn) => {
                const row = await lockItem(conn, id, baseVersion);
                await conn.query(
                    'UPDATE cash_items SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?', [id]
                );
                await recordAudit(conn, {
                    entityType: 'cash_item', entityId: id, action: 'delete',
                    before: itemToJson(row), after: itemToJson(await readItem(conn, id, { includeDeleted: true })),
                    userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-delete', err);
        }
    });

    // §10.3 pay: one payments row, the cache rewritten from the rows, and the
    // status, all under the item's row lock.
    router.post('/items/:id/pay', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Item not found.');
            const body = req.body || {};
            const paidOn = body.paidOn;
            if (!isValidDate(paidOn)) return fail(res, 400, 'paidOn is required: a real date, YYYY-MM-DD.');
            const sentAmount = body.paidAmount !== undefined && body.paidAmount !== null;
            const paidAmount = sentAmount ? parseMoney(body.paidAmount) : undefined;
            if (paidAmount === null) {
                return fail(res, 400, 'paidAmount must be a decimal string with up to two decimals, e.g. "250.00".');
            }
            const note = parseText(body.note, MAX_NOTE);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
            const hasRemainderDate = body.remainderDueDate !== undefined && body.remainderDueDate !== null;
            const remainderDueDate = hasRemainderDate ? body.remainderDueDate : null;
            if (hasRemainderDate && !isValidDate(remainderDueDate)) {
                return fail(res, 400, 'remainderDueDate must be a real date, YYYY-MM-DD.');
            }
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);
            if (paidOn > today) {
                throw apiError(422, 'PAID_ON_IN_FUTURE', 'A payment cannot be dated after today.', { paidOn, today });
            }
            if (hasRemainderDate && remainderDueDate < today) {
                return fail(res, 400, 'remainderDueDate must be today or later.', undefined, { remainderDueDate, today });
            }

            const paid = await withTransaction(async (conn) => {
                const row = await lockItem(conn, id, baseVersion);
                const amountMinor = parseMinor(row.amount);
                const remaining = amountMinor - (row.paid_amount == null ? 0n : parseMinor(row.paid_amount));
                const payMinor = paidAmount === undefined ? remaining : paidAmount;
                if (remaining <= 0n || payMinor <= 0n || payMinor > remaining) {
                    throw apiError(422, 'PAID_AMOUNT_INVALID',
                        remaining <= 0n ? 'Nothing remains to be paid on this item.'
                            : payMinor <= 0n ? 'paidAmount must be greater than zero.'
                                : `paidAmount is more than the ${formatMinor(remaining)} still owed.`,
                        { paidAmount: formatMinor(payMinor), remainingAmount: formatMinor(remaining) });
                }
                if (payMinor < remaining && row.due_date < today && !hasRemainderDate) {
                    throw apiError(422, 'REMAINDER_DATE_REQUIRED',
                        'This item is already due: a part payment needs a date (today or later) for the remainder.',
                        { dueDate: row.due_date, today });
                }

                const [ins] = await conn.query(
                    'INSERT INTO payments (cash_item_id, paid_on, amount, note, created_by) VALUES (?, ?, ?, ?, ?)',
                    [id, paidOn, formatMinor(payMinor), note ?? null, req.userEmail]
                );
                const [[payment]] = await conn.query('SELECT * FROM payments WHERE id = ?', [ins.insertId]);
                await recordAudit(conn, {
                    entityType: 'payment', entityId: ins.insertId, action: 'create',
                    before: null, after: paymentSnapshot(paymentToJson(payment)), userEmail: req.userEmail,
                });

                // The cache, rewritten from the rows (D23).
                const [[cache]] = await conn.query(
                    `SELECT CAST(SUM(amount) AS CHAR) AS paid_amount, DATE_FORMAT(MAX(paid_on), '%Y-%m-%d') AS paid_on
                       FROM payments WHERE cash_item_id = ?`,
                    [id]
                );
                const status = parseMinor(cache.paid_amount) >= amountMinor ? 'paid' : 'part_paid';
                await conn.query(
                    `UPDATE cash_items
                        SET paid_amount = ?, paid_on = ?, status = ?, due_date = ?, row_version = row_version + 1
                      WHERE id = ?`,
                    [cache.paid_amount, cache.paid_on, status, hasRemainderDate ? remainderDueDate : row.due_date, id]
                );
                const after = await readItem(conn, id);
                await recordAudit(conn, {
                    entityType: 'cash_item', entityId: id, action: 'pay',
                    before: itemToJson(row), after: itemToJson(after), userEmail: req.userEmail,
                });
                return oneItem(conn, after, today);
            });
            res.json(paid);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-pay', err);
        }
    });

    // §10.3 unpay: every payment row deleted (one audit row each), the cache and
    // the status reset; `due_date` is not restored (D23). Nothing to undo → the
    // row unchanged, no audit.
    router.post('/items/:id/unpay', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Item not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);

            const unpaid = await withTransaction(async (conn) => {
                const row = await lockItem(conn, id, baseVersion);
                const [payments] = await conn.query(
                    'SELECT * FROM payments WHERE cash_item_id = ? ORDER BY paid_on ASC, id ASC FOR UPDATE', [id]
                );
                if (!payments.length) return oneItem(conn, row, today);
                for (const p of payments) {
                    await conn.query('DELETE FROM payments WHERE id = ?', [p.id]);
                    await recordAudit(conn, {
                        entityType: 'payment', entityId: Number(p.id), action: 'delete',
                        before: paymentSnapshot(paymentToJson(p)), after: null, userEmail: req.userEmail,
                    });
                }
                await conn.query(
                    `UPDATE cash_items
                        SET status = 'expected', paid_on = NULL, paid_amount = NULL, row_version = row_version + 1
                      WHERE id = ?`,
                    [id]
                );
                const after = await readItem(conn, id);
                await recordAudit(conn, {
                    entityType: 'cash_item', entityId: id, action: 'unpay',
                    before: itemToJson(row), after: itemToJson(after), userEmail: req.userEmail,
                });
                return oneItem(conn, after, today);
            });
            res.json(unpaid);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'items-unpay', err);
        }
    });

    return router;
};
