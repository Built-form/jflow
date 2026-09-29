'use strict';

// The shipping feed's routes (CONTRACT §6.12; docs/PHASE2.md §4.3; P4, P8).
//
//   POST /external/refresh   forces a refresh run (services/shippingRefresh.js): the
//                            10-minute TTL is ignored, the 60-second claim is not.
//                            200 {ran: true, status} after a run; 200 {ran: false, status}
//                            when another run holds the claim; 503 SHIPPING_UNAVAILABLE
//                            {reason, lastSuccessAt} when the run fails — the last
//                            snapshot is untouched. No audit (P8).
//   GET  /external/status    the external_sync row, `companies` parsed from
//                            companies_json (the Settings picker), and `configured`.
//
//   GET  /external-items     (step 20) the snapshot's rows with their resolved company /
//                            account and derivedStatus (services/externalItems.js).
//
//   PUT    /external-items/:key   (step 21, §10.11) the overlay, a MERGE like an instance
//                                 tune: absent = unchanged, null clears plannedDate /
//                                 plannedAmount / note; `skipped` a boolean. Setting
//                                 plannedAmount stores planned_base_amount = the feed amount
//                                 under the lock (P6). Refused: a gone row (404
//                                 TARGET_MISSING), a paid one (409 TARGET_SETTLED), a past
//                                 plannedDate (422 PLANNED_DATE_IN_PAST), an empty merge (400:
//                                 DELETE reverts). Audit `external_item`/`plan`; answers the
//                                 row JSON with derivedStatus.
//   DELETE /external-items/:key   the revert (`unplan`): every planned_* column,
//                                 planned_skipped and source_scenario_id cleared. Works on a
//                                 gone or paid row too (an orphaned overlay must be clearable);
//                                 404 when nothing is set. Answers 200 with the row JSON, as
//                                 PUT does — CONTRACT §6.12 says 204; the web's plan dialog
//                                 replaces its row from the response (coordinator, step 21).
//   GET    /external-items/:key   one row's JSON with derivedStatus, gone or not — the plan
//                                 dialog reads it on open for rowVersion (its baseVersion) and
//                                 the note. Not in CONTRACT §6.12 (added at the web's request).
//
// `:key` arrives un-encoded (§4) and is parsed before any read: a key lib/keys.js rejects
// is 422 ITEM_KEY_INVALID; a grammatical key of another kind is a plain 404 (no row of it
// lives here). Each write is one transaction that locks only that external_items row and
// never writes a feed column. `today` is todayFor(req), once per request (D24).

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { isValidDate } = require('../lib/dates');
const { parseKey } = require('../lib/keys');
const { parseMinor, formatMinor } = require('../lib/money');
const {
    apiError, isApiError, sendApiError, externalSyncToJson, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion,
} = require('../lib/shape');
const shipping = require('../services/shipping');
const { runRefresh, readStatus } = require('../services/shippingRefresh');
const {
    listExternalItems, externalItemJson, lockExternalItem, hasOverlay, auditOverlay,
} = require('../services/externalItems');

const FEED_STATUSES = ['open', 'paid'];
const OVERLAY_FIELDS = ['plannedDate', 'plannedAmount', 'skipped', 'note'];
const MAX_NOTE = 500;          // external_items.planned_note VARCHAR(500)

/** The `ship.` key of the path → {key, extId}; thrown refusals per §6.12 (422 grammar, 404 another kind). */
function shipKeyOf(req) {
    const key = req.params.key;
    const parsed = parseKey(key);
    if (!parsed) {
        throw apiError(422, 'ITEM_KEY_INVALID', 'That is not a forecast key: expected ship.<id> here.', { key });
    }
    if (parsed.targetKind !== 'ship') throw apiError(404, undefined, 'No shipping line has that key.');
    return { key, extId: parsed.targetId };
}

/** A DECIMAL money string (D1) → bigint minor units, or null (a JSON number is refused). */
function parseMoney(value) {
    try {
        return parseMinor(value);
    } catch {
        return null;
    }
}

/** DECIMAL strings equal as money ("80" = "80.00"); null only equals null. */
const sameMoney = (a, b) => (a == null || b == null ? a == null && b == null : parseMinor(a) === parseMinor(b));

/** Optional text: undefined = absent, null = clear (null or blank), else trimmed. NaN = invalid (400). */
function parseText(value, max) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > max) return NaN;
    return value.trim() || null;
}

const statusJson = (sync) => externalSyncToJson(sync, { configured: shipping.isConfigured() });

module.exports = ({ schemaReady, fail, serverError, todayFor }) => {
    const router = express.Router();

    router.post('/external/refresh', async (req, res) => {
        try {
            await schemaReady;
            const today = todayFor(req);
            const result = await runRefresh({ today });
            if (result.status === 'failed') {
                return fail(res, 503,
                    `The shipping feed could not be refreshed (${result.reason}); the last snapshot is kept.`,
                    'SHIPPING_UNAVAILABLE',
                    {
                        reason: result.reason,
                        lastSuccessAt: statusJson(result.sync)?.lastSuccessAt ?? null,
                        // source_schema only: every `table.column` JFlow reads but cannot see.
                        ...(Array.isArray(result.missing) ? { missing: result.missing } : {}),
                    });
            }
            res.json({ ran: result.ran, status: statusJson(result.sync) });
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'external-refresh', err);
        }
    });

    router.get('/external/status', async (req, res) => {
        try {
            await schemaReady;
            const sync = await readStatus();
            if (!sync) return fail(res, 404, 'No shipping sync row: the Phase 2 migration has not run.');
            res.json(statusJson(sync));
        } catch (err) {
            serverError(res, 'external-status', err);
        }
    });

    // Step 20 (§6.12): the list. Every refusal is a message-only 400.
    router.get('/external-items', async (req, res) => {
        try {
            await schemaReady;
            const query = req.query || {};
            const { page, limit, offset } = parseListParams(query);
            let statuses = FEED_STATUSES;
            if (query.status !== undefined) {
                statuses = String(query.status).split(',').map((s) => s.trim());
                if (statuses.some((s) => !FEED_STATUSES.includes(s))) {
                    return fail(res, 400, `status must be a comma list of: ${FEED_STATUSES.join(', ')}.`);
                }
            }
            let companyId = 'all';
            if (query.companyId !== undefined && query.companyId !== 'all') {
                companyId = parseId(query.companyId);
                if (!companyId) return fail(res, 400, 'companyId must be a company id, or all.');
            }
            for (const key of ['from', 'to']) {
                if (query[key] !== undefined && !isValidDate(query[key])) return fail(res, 400, `${key} must be a real date, YYYY-MM-DD.`);
            }
            if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
                return fail(res, 400, 'from must be on or before to.');
            }
            const today = todayFor(req);
            const out = await withConnection(async (conn) => {
                if (companyId !== 'all') {
                    const [rows] = await conn.query('SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL', [companyId]);
                    if (!rows.length) return null;
                }
                return listExternalItems(conn, {
                    today, statuses, companyId, from: query.from, to: query.to,
                    includeGone: query.includeGone === '1' || query.includeGone === 'true',
                    q: query.q ? String(query.q) : null, limit, offset,
                });
            });
            if (out === null) return fail(res, 400, 'companyId is not a live company.');
            res.json(listResponse(out.data, { page, limit, total: out.total }));
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'external-items-list', err);
        }
    });

    // Step 21: one row by key, for the plan dialog.
    router.get('/external-items/:key', async (req, res) => {
        try {
            await schemaReady;
            const { extId } = shipKeyOf(req);
            const today = todayFor(req);
            const row = await withConnection((conn) => externalItemJson(conn, extId, today));
            if (!row) return fail(res, 404, 'No shipping line has that key.');
            res.json(row);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'external-items-get', err);
        }
    });

    // Step 21 (§10.11): plan a ship line — the merge, then one transaction on the row.
    router.put('/external-items/:key', async (req, res) => {
        try {
            await schemaReady;
            const { key, extId } = shipKeyOf(req);
            const body = req.body || {};
            const has = (k) => body[k] !== undefined;
            if (!OVERLAY_FIELDS.some(has)) {
                return fail(res, 400, `Nothing to update: send any of ${OVERLAY_FIELDS.join(', ')}.`);
            }
            if (has('plannedDate') && body.plannedDate !== null && !isValidDate(body.plannedDate)) {
                return fail(res, 400, 'plannedDate must be a real date, YYYY-MM-DD, or null.');
            }
            let plannedAmount = body.plannedAmount;               // undefined = absent, null = clear
            if (plannedAmount != null) {
                const minor = parseMoney(plannedAmount);
                if (minor === null || minor <= 0n) {
                    return fail(res, 400, 'plannedAmount must be a decimal string greater than zero, e.g. "1024.00", or null.');
                }
                plannedAmount = formatMinor(minor);
            }
            if (has('skipped') && typeof body.skipped !== 'boolean') return fail(res, 400, 'skipped must be true or false.');
            const note = parseText(body.note, MAX_NOTE);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters, or null.`);
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);
            if (body.plannedDate != null && body.plannedDate < today) {
                throw apiError(422, 'PLANNED_DATE_IN_PAST', 'A planned date cannot be before today.',
                    { plannedDate: body.plannedDate, today });
            }

            const out = await withTransaction(async (conn) => {
                const row = await lockExternalItem(conn, extId);
                if (!row) throw apiError(404, undefined, 'No shipping line has that key.');
                assertBaseVersion(row, baseVersion);
                if (row.gone_at != null) {
                    throw apiError(404, 'TARGET_MISSING',
                        'That shipping line has left the feed, so there is nothing to plan. DELETE clears an old plan.', { key });
                }
                if (row.feed_status === 'paid') {
                    throw apiError(409, 'TARGET_SETTLED', 'That shipping payment is paid: only an open line can be planned.',
                        { key, status: 'paid' });
                }
                const next = {
                    plannedDate: has('plannedDate') ? body.plannedDate : row.planned_date,
                    plannedAmount: has('plannedAmount') ? plannedAmount : row.planned_amount,
                    // P6: the base is the feed amount when the plan was set, cleared with it.
                    plannedBaseAmount: !has('plannedAmount') ? row.planned_base_amount : (plannedAmount === null ? null : row.amount),
                    plannedSkipped: has('skipped') ? (body.skipped ? 1 : 0) : Number(row.planned_skipped),
                    plannedNote: note === undefined ? row.planned_note : note,
                };
                if (next.plannedDate == null && next.plannedAmount == null && !next.plannedSkipped && next.plannedNote == null) {
                    throw apiError(400, undefined, 'Nothing to plan: every field would be empty. DELETE reverts the line to the feed.');
                }
                const changed = next.plannedDate !== row.planned_date
                    || !sameMoney(next.plannedAmount, row.planned_amount)
                    || !sameMoney(next.plannedBaseAmount, row.planned_base_amount)
                    || next.plannedSkipped !== Number(row.planned_skipped)
                    || next.plannedNote !== row.planned_note;
                if (changed) {
                    await conn.query(
                        `UPDATE external_items
                            SET planned_date = ?, planned_amount = ?, planned_base_amount = ?, planned_skipped = ?,
                                planned_note = ?, planned_by = ?, planned_at = UTC_TIMESTAMP(), row_version = row_version + 1
                          WHERE id = ?`,
                        [next.plannedDate, next.plannedAmount, next.plannedBaseAmount, next.plannedSkipped, next.plannedNote,
                            req.userEmail, row.id]
                    );
                    const after = await lockExternalItem(conn, extId);
                    await auditOverlay(conn, { action: 'plan', before: row, after, userEmail: req.userEmail });
                }
                return externalItemJson(conn, extId, today);
            });
            res.json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'external-items-plan', err);
        }
    });

    // Step 21 (§10.11): revert a ship line to the feed. No gone / paid check.
    router.delete('/external-items/:key', async (req, res) => {
        try {
            await schemaReady;
            const { extId } = shipKeyOf(req);
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);
            const out = await withTransaction(async (conn) => {
                const row = await lockExternalItem(conn, extId);
                if (!row) throw apiError(404, undefined, 'No shipping line has that key.');
                assertBaseVersion(row, baseVersion);
                if (!hasOverlay(row)) throw apiError(404, undefined, 'That shipping line has no plan to revert.');
                await conn.query(
                    `UPDATE external_items
                        SET planned_date = NULL, planned_amount = NULL, planned_base_amount = NULL, planned_skipped = 0,
                            planned_note = NULL, source_scenario_id = NULL, planned_by = NULL, planned_at = NULL,
                            row_version = row_version + 1
                      WHERE id = ?`,
                    [row.id]
                );
                const after = await lockExternalItem(conn, extId);
                await auditOverlay(conn, { action: 'unplan', before: row, after, userEmail: req.userEmail });
                return externalItemJson(conn, extId, today);
            });
            res.json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'external-items-unplan', err);
        }
    });

    return router;
};
