'use strict';

// FX rate routes (CONTRACT §6.5, §10.2, D3).
//
// A row says: from `effectiveFrom`, 1 unit of `currency` = `rateToGbp` GBP. The
// engine uses, for every date in a run, the latest rate with `effective_from <=
// today` (§9.7); GET /fx-rates/current answers that set for any date. GBP has no
// row — it is 1.000000 by definition — and is refused on create (D3).
// `(currency, effective_from)` is unique (409 FX_RATE_EXISTS {fxRateId}); the
// UNIQUE key is the real guard, the pre-check only gives the friendly answer.
// `currency` is immutable. HARD delete, audited with the full before-snapshot.
// `rateToGbp` travels as a DECIMAL string with up to six decimals (D1).

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const { isValidDate } = require('../lib/dates');
const { parseRate } = require('../lib/money');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, fxRateToJson,
} = require('../lib/shape');

const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_NOTE = 500;

const isCurrency = (value) => typeof value === 'string' && CURRENCY_RE.test(value);

/** A valid rate string (grammar and > 0), else null. Stored as sent: MySQL reads it exactly. */
function parseRateString(value) {
    try {
        parseRate(value);
        return value;
    } catch {
        return null;
    }
}

function parseNote(value) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > MAX_NOTE) return NaN;
    return value.trim() || null;
}

async function readRate(conn, id) {
    const [rows] = await conn.query('SELECT * FROM fx_rates WHERE id = ?', [id]);
    return rows.length ? rows[0] : null;
}

/** Another row on (currency, effectiveFrom), locked — or null. */
async function holderOf(conn, currency, effectiveFrom, exceptId) {
    const [rows] = await conn.query(
        `SELECT id FROM fx_rates WHERE currency = ? AND effective_from = ?${exceptId ? ' AND id <> ?' : ''}
          FOR UPDATE`,
        exceptId ? [currency, effectiveFrom, exceptId] : [currency, effectiveFrom]
    );
    return rows.length ? Number(rows[0].id) : null;
}

function rateExists(currency, effectiveFrom, fxRateId) {
    return apiError(409, 'FX_RATE_EXISTS',
        `A ${currency} rate effective from ${effectiveFrom} already exists.`, { fxRateId });
}

/**
 * Run a write that may race another onto the same (currency, effective_from):
 * the loser's ER_DUP_ENTRY becomes the same 409 the pre-check gives.
 */
async function guardDuplicate(conn, currency, effectiveFrom, exceptId, write) {
    try {
        return await write();
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            throw rateExists(currency, effectiveFrom, await holderOf(conn, currency, effectiveFrom, exceptId));
        }
        throw err;
    }
}

module.exports = ({ schemaReady, fail, serverError, todayFor }) => {
    const router = express.Router();

    router.get('/fx-rates', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            if (req.query.currency !== undefined) {
                if (!isCurrency(req.query.currency)) return fail(res, 400, 'currency must be three capital letters.');
                where.push('currency = ?');
                params.push(req.query.currency);
            }
            for (const [key, op] of [['from', '>='], ['to', '<=']]) {
                if (req.query[key] === undefined) continue;
                if (!isValidDate(req.query[key])) return fail(res, 400, `${key} must be a real date, YYYY-MM-DD.`);
                where.push(`effective_from ${op} ?`);
                params.push(req.query[key]);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(`SELECT COUNT(*) AS total FROM fx_rates ${whereSql}`, params);
                const [rows] = await c.query(
                    `SELECT * FROM fx_rates ${whereSql}
                      ORDER BY currency ASC, effective_from DESC, id ASC
                      LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, rows };
            });
            res.json(listResponse(out.rows.map(fxRateToJson), { page, limit, total: Number(out.total) }));
        } catch (err) {
            serverError(res, 'fx-rates-list', err);
        }
    });

    // Before /fx-rates/:id, or 'current' would be taken for an id.
    router.get('/fx-rates/current', async (req, res) => {
        try {
            await schemaReady;
            let on = req.query.on;
            if (on === undefined) on = todayFor(req);
            else if (!isValidDate(on)) return fail(res, 400, 'on must be a real date, YYYY-MM-DD.');
            const rows = await withConnection(async (c) => {
                const [r] = await c.query(
                    `SELECT f.* FROM fx_rates f
                       JOIN (SELECT currency, MAX(effective_from) AS effective_from
                               FROM fx_rates WHERE effective_from <= ? GROUP BY currency) latest
                         ON latest.currency = f.currency AND latest.effective_from = f.effective_from
                      ORDER BY f.currency ASC`,
                    [on]
                );
                return r;
            });
            const rates = {};
            for (const r of rows) {
                rates[r.currency] = { id: Number(r.id), rateToGbp: r.rate_to_gbp, effectiveFrom: r.effective_from };
            }
            res.json({ on, rates });
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'fx-rates-current', err);
        }
    });

    router.post('/fx-rates', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            if (!isCurrency(body.currency)) return fail(res, 400, 'currency is required: three capital letters, e.g. EUR.');
            if (body.currency === 'GBP') {
                return fail(res, 400, 'GBP needs no rate: it is always 1.000000.');
            }
            const rateToGbp = parseRateString(body.rateToGbp);
            if (!rateToGbp) {
                return fail(res, 400, 'rateToGbp is required as a decimal string greater than zero with up to six decimals, e.g. "1.170000".');
            }
            if (!isValidDate(body.effectiveFrom)) return fail(res, 400, 'effectiveFrom must be a real date, YYYY-MM-DD.');
            const note = parseNote(body.note);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
            const { currency, effectiveFrom } = body;

            const created = await withTransaction(async (conn) => {
                const holder = await holderOf(conn, currency, effectiveFrom, null);
                if (holder) throw rateExists(currency, effectiveFrom, holder);
                const [ins] = await guardDuplicate(conn, currency, effectiveFrom, null, () => conn.query(
                    `INSERT INTO fx_rates (currency, rate_to_gbp, effective_from, note, created_by)
                     VALUES (?, ?, ?, ?, ?)`,
                    [currency, rateToGbp, effectiveFrom, note ?? null, req.userEmail]
                ));
                const after = fxRateToJson(await readRate(conn, ins.insertId));
                await recordAudit(conn, {
                    entityType: 'fx_rate', entityId: ins.insertId, action: 'create',
                    before: null, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'fx-rates-create', err);
        }
    });

    router.get('/fx-rates/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'FX rate not found.');
            const row = await withConnection((c) => readRate(c, id));
            if (!row) return fail(res, 404, 'FX rate not found.');
            res.json(fxRateToJson(row));
        } catch (err) {
            serverError(res, 'fx-rates-get', err);
        }
    });

    router.put('/fx-rates/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'FX rate not found.');
            const body = req.body || {};
            const hasRate = body.rateToGbp !== undefined;
            const hasFrom = body.effectiveFrom !== undefined;
            const hasNote = body.note !== undefined;
            if (!hasRate && !hasFrom && !hasNote && body.currency === undefined) {
                return fail(res, 400, 'Nothing to update: send rateToGbp, effectiveFrom and/or note.');
            }
            const rateToGbp = hasRate ? parseRateString(body.rateToGbp) : null;
            if (hasRate && !rateToGbp) {
                return fail(res, 400, 'rateToGbp must be a decimal string greater than zero with up to six decimals.');
            }
            if (hasFrom && !isValidDate(body.effectiveFrom)) {
                return fail(res, 400, 'effectiveFrom must be a real date, YYYY-MM-DD.');
            }
            const note = parseNote(body.note);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            const updated = await withTransaction(async (conn) => {
                const [rows] = await conn.query('SELECT * FROM fx_rates WHERE id = ? FOR UPDATE', [id]);
                if (!rows.length) throw apiError(404, undefined, 'FX rate not found.');
                const row = rows[0];
                assertBaseVersion(row, baseVersion);
                // Immutable: sending the stored value back is not a change.
                if (body.currency !== undefined && body.currency !== row.currency) {
                    throw apiError(400, undefined, 'currency cannot be changed: delete this rate and add a new one.');
                }
                const next = {
                    rateToGbp: hasRate ? rateToGbp : row.rate_to_gbp,
                    effectiveFrom: hasFrom ? body.effectiveFrom : row.effective_from,
                    note: hasNote ? note : row.note,
                };
                if (next.effectiveFrom !== row.effective_from) {
                    const holder = await holderOf(conn, row.currency, next.effectiveFrom, id);
                    if (holder) throw rateExists(row.currency, next.effectiveFrom, holder);
                }
                const before = fxRateToJson(row);
                if (parseRate(next.rateToGbp) === parseRate(row.rate_to_gbp)
                    && next.effectiveFrom === row.effective_from && next.note === row.note) {
                    return before;
                }
                await guardDuplicate(conn, row.currency, next.effectiveFrom, id, () => conn.query(
                    `UPDATE fx_rates SET rate_to_gbp = ?, effective_from = ?, note = ?, row_version = row_version + 1
                      WHERE id = ?`,
                    [next.rateToGbp, next.effectiveFrom, next.note, id]
                ));
                const after = fxRateToJson(await readRate(conn, id));
                await recordAudit(conn, {
                    entityType: 'fx_rate', entityId: id, action: 'update', before, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.json(updated);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'fx-rates-update', err);
        }
    });

    router.delete('/fx-rates/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'FX rate not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            await withTransaction(async (conn) => {
                const [rows] = await conn.query('SELECT * FROM fx_rates WHERE id = ? FOR UPDATE', [id]);
                if (!rows.length) throw apiError(404, undefined, 'FX rate not found.');
                assertBaseVersion(rows[0], baseVersion);
                await conn.query('DELETE FROM fx_rates WHERE id = ?', [id]);
                await recordAudit(conn, {
                    entityType: 'fx_rate', entityId: id, action: 'delete',
                    before: fxRateToJson(rows[0]), after: null, userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'fx-rates-delete', err);
        }
    });

    return router;
};
