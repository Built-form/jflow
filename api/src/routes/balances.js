'use strict';

// Bank balance routes (CONTRACT §6.6, §10.2).
//
// A balance is the cash at bank at the START of `balanceDate`, before that day's
// movements; the latest one per account is the forecast's anchor. One row per
// (account, date) — PUT creates or replaces it. `balanceDate` may not be after
// today (422 BALANCE_DATE_IN_FUTURE). HARD delete, audited with the full
// before-snapshot. The balance may be negative (overdraft); it travels as a
// DECIMAL string (D1).
//
// Locks (§10.1, §10.2): the account row (live) first, then the balance row. Bulk
// sorts its entries by accountId and locks the accounts ascending by id in one
// statement before touching any balance.

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const { isValidDate } = require('../lib/dates');
const { parseMinor, formatMinor } = require('../lib/money');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, balanceToJson,
} = require('../lib/shape');

const MAX_BULK_ENTRIES = 200;
const MAX_NOTE = 500;

/** DECIMAL string → canonical "1024.00", or null (a JSON number is refused, D1). */
function parseBalance(value) {
    try {
        return formatMinor(parseMinor(value));
    } catch {
        return null;
    }
}

/**
 * `note`: undefined = leave as is (a new row gets null), null = clear, else a
 * trimmed string of at most 500 characters (blank → null). NaN = invalid.
 */
function parseNote(value) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > MAX_NOTE) return NaN;
    return value.trim() || null;
}

function futureDate(balanceDate, today) {
    return apiError(422, 'BALANCE_DATE_IN_FUTURE',
        'A balance cannot be recorded for a date after today.', { balanceDate, today });
}

async function readBalance(conn, id) {
    const [rows] = await conn.query('SELECT * FROM bank_balances WHERE id = ?', [id]);
    return rows.length ? rows[0] : null;
}

/**
 * Insert or replace one balance whose account is already locked. `existing` is
 * the locked row or null. Writes and audits only when something changes.
 * @returns {Promise<object>} the row JSON
 */
async function writeBalance(conn, { accountId, balanceDate, balance, note, existing, userEmail }) {
    if (!existing) {
        const [ins] = await conn.query(
            `INSERT INTO bank_balances (account_id, balance_date, balance, note, entered_by)
             VALUES (?, ?, ?, ?, ?)`,
            [accountId, balanceDate, balance, note ?? null, userEmail]
        );
        const after = balanceToJson(await readBalance(conn, ins.insertId));
        await recordAudit(conn, {
            entityType: 'bank_balance', entityId: ins.insertId, action: 'create', before: null, after, userEmail,
        });
        return after;
    }
    const before = balanceToJson(existing);
    const nextNote = note === undefined ? existing.note : note;
    if (parseMinor(existing.balance) === parseMinor(balance) && nextNote === existing.note) return before;
    await conn.query(
        'UPDATE bank_balances SET balance = ?, note = ?, row_version = row_version + 1 WHERE id = ?',
        [balance, nextNote, existing.id]
    );
    const after = balanceToJson(await readBalance(conn, existing.id));
    await recordAudit(conn, {
        entityType: 'bank_balance', entityId: Number(existing.id), action: 'update', before, after, userEmail,
    });
    return after;
}

module.exports = ({ schemaReady, fail, serverError, todayFor }) => {
    const router = express.Router();

    router.get('/balances', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            let join = '';
            if (req.query.accountId !== undefined) {
                const accountId = parseId(req.query.accountId);
                if (!accountId) return fail(res, 400, 'accountId must be a positive integer.');
                where.push('b.account_id = ?');
                params.push(accountId);
            }
            if (req.query.companyId !== undefined) {
                const companyId = parseId(req.query.companyId);
                if (!companyId) return fail(res, 400, 'companyId must be a positive integer.');
                join = 'JOIN bank_accounts a ON a.id = b.account_id';
                where.push('a.company_id = ?');
                params.push(companyId);
            }
            for (const [key, op] of [['from', '>='], ['to', '<=']]) {
                if (req.query[key] === undefined) continue;
                if (!isValidDate(req.query[key])) return fail(res, 400, `${key} must be a real date, YYYY-MM-DD.`);
                where.push(`b.balance_date ${op} ?`);
                params.push(req.query[key]);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(
                    `SELECT COUNT(*) AS total FROM bank_balances b ${join} ${whereSql}`, params
                );
                const [rows] = await c.query(
                    `SELECT b.* FROM bank_balances b ${join} ${whereSql}
                      ORDER BY b.balance_date DESC, b.account_id ASC, b.id ASC
                      LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, rows };
            });
            res.json(listResponse(out.rows.map(balanceToJson), { page, limit, total: Number(out.total) }));
        } catch (err) {
            serverError(res, 'balances-list', err);
        }
    });

    router.put('/accounts/:id/balances/:date', async (req, res) => {
        try {
            await schemaReady;
            const accountId = parseId(req.params.id);
            if (!accountId) return fail(res, 404, 'Account not found.');
            const balanceDate = req.params.date;
            if (!isValidDate(balanceDate)) return fail(res, 400, 'The balance date must be a real date, YYYY-MM-DD.');
            const body = req.body || {};
            const balance = parseBalance(body.balance);
            if (balance === null) {
                return fail(res, 400, 'balance is required as a decimal string with up to two decimals, e.g. "1024.00".');
            }
            const note = parseNote(body.note);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);
            if (balanceDate > today) throw futureDate(balanceDate, today);

            const row = await withTransaction(async (conn) => {
                const [accounts] = await conn.query(
                    'SELECT id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [accountId]
                );
                if (!accounts.length) throw apiError(404, undefined, 'Account not found.');
                const [rows] = await conn.query(
                    'SELECT * FROM bank_balances WHERE account_id = ? AND balance_date = ? FOR UPDATE',
                    [accountId, balanceDate]
                );
                // A baseVersion names a row the caller loaded; if it has gone,
                // that is stale too (currentVersion null).
                assertBaseVersion(rows[0] || null, baseVersion);
                return writeBalance(conn, {
                    accountId, balanceDate, balance, note, existing: rows[0] || null, userEmail: req.userEmail,
                });
            });
            res.json(row);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'balances-put', err);
        }
    });

    router.delete('/accounts/:id/balances/:date', async (req, res) => {
        try {
            await schemaReady;
            const accountId = parseId(req.params.id);
            if (!accountId) return fail(res, 404, 'Account not found.');
            const balanceDate = req.params.date;
            if (!isValidDate(balanceDate)) return fail(res, 400, 'The balance date must be a real date, YYYY-MM-DD.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            await withTransaction(async (conn) => {
                const [accounts] = await conn.query(
                    'SELECT id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [accountId]
                );
                if (!accounts.length) throw apiError(404, undefined, 'Account not found.');
                const [rows] = await conn.query(
                    'SELECT * FROM bank_balances WHERE account_id = ? AND balance_date = ? FOR UPDATE',
                    [accountId, balanceDate]
                );
                if (!rows.length) throw apiError(404, undefined, 'No balance is recorded for that account and date.');
                assertBaseVersion(rows[0], baseVersion);
                await conn.query('DELETE FROM bank_balances WHERE id = ?', [rows[0].id]);
                await recordAudit(conn, {
                    entityType: 'bank_balance', entityId: Number(rows[0].id), action: 'delete',
                    before: balanceToJson(rows[0]), after: null, userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'balances-delete', err);
        }
    });

    router.post('/balances/bulk', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            const balanceDate = body.balanceDate;
            if (!isValidDate(balanceDate)) return fail(res, 400, 'balanceDate must be a real date, YYYY-MM-DD.');
            const raw = body.entries;
            if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BULK_ENTRIES) {
                return fail(res, 400, `entries must be a list of 1 to ${MAX_BULK_ENTRIES} balances.`);
            }
            // details.entries[i] is null for a good entry, else what is wrong with it.
            const problems = raw.map(() => null);
            const seen = new Set();
            const entries = raw.map((e, i) => {
                const entry = e && typeof e === 'object' && !Array.isArray(e) ? e : {};
                const accountId = typeof entry.accountId === 'number' || typeof entry.accountId === 'string'
                    ? parseId(entry.accountId) : null;
                const balance = parseBalance(entry.balance);
                const note = parseNote(entry.note);
                if (!accountId) problems[i] = 'accountId must be a positive integer.';
                else if (seen.has(accountId)) problems[i] = 'This account appears more than once.';
                else if (balance === null) problems[i] = 'balance must be a decimal string with up to two decimals.';
                else if (Number.isNaN(note)) problems[i] = `note must be text of at most ${MAX_NOTE} characters.`;
                if (accountId) seen.add(accountId);
                return { index: i, accountId, balance, note };
            });
            if (problems.some(Boolean)) {
                return fail(res, 400, 'Some entries are invalid.', undefined, { entries: problems });
            }
            const today = todayFor(req);
            if (balanceDate > today) throw futureDate(balanceDate, today);

            const rows = await withTransaction(async (conn) => {
                const ordered = [...entries].sort((a, b) => a.accountId - b.accountId);
                const ids = ordered.map((e) => e.accountId);
                const marks = ids.map(() => '?').join(', ');
                const [accounts] = await conn.query(
                    `SELECT id, is_active FROM bank_accounts
                      WHERE id IN (${marks}) AND deleted_at IS NULL
                      ORDER BY id ASC FOR UPDATE`,
                    ids
                );
                const byId = new Map(accounts.map((a) => [Number(a.id), a]));
                const bad = raw.map(() => null);
                for (const e of entries) {
                    const account = byId.get(e.accountId);
                    if (!account) bad[e.index] = 'No live account has this id.';
                    else if (!Number(account.is_active)) bad[e.index] = 'This account is inactive.';
                }
                if (bad.some(Boolean)) throw apiError(400, undefined, 'Some entries are invalid.', { entries: bad });

                const [existing] = await conn.query(
                    `SELECT * FROM bank_balances
                      WHERE balance_date = ? AND account_id IN (${marks})
                      ORDER BY account_id ASC FOR UPDATE`,
                    [balanceDate, ...ids]
                );
                const existingBy = new Map(existing.map((r) => [Number(r.account_id), r]));
                const out = new Array(entries.length);
                for (const e of ordered) {
                    out[e.index] = await writeBalance(conn, {
                        accountId: e.accountId, balanceDate, balance: e.balance, note: e.note,
                        existing: existingBy.get(e.accountId) || null, userEmail: req.userEmail,
                    });
                }
                return out;
            });
            res.json({ data: rows });
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'balances-bulk', err);
        }
    });

    return router;
};
