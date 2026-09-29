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
// The overlay writes (PUT/DELETE /external-items/:key) join this file at step 21. `today`
// is todayFor(req), once per request (D24).

const express = require('express');

const { withConnection } = require('../db');
const { isValidDate } = require('../lib/dates');
const { isApiError, sendApiError, externalSyncToJson, listResponse, parseId, parseListParams } = require('../lib/shape');
const shipping = require('../services/shipping');
const { runRefresh, readStatus } = require('../services/shippingRefresh');
const { listExternalItems } = require('../services/externalItems');

const FEED_STATUSES = ['open', 'paid'];

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
                    { reason: result.reason, lastSuccessAt: result.sync ? result.sync.last_success_at : null });
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

    return router;
};
