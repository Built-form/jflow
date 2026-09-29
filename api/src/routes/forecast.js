'use strict';

// GET /forecast (CONTRACT §6.10; §8 load rules, §9 engine; D7, D12, D20, D24, D25).
//
// The route does four things and holds no engine rule:
//   1  `today` once (todayFor: Europe/London; `?today=` only locally / under test, D24)
//      and the query validation of §6.10 — every refusal a message-only 400, except a
//      scenario that is not live (404);
//   2  one consistent read: a READ ONLY transaction whose snapshot is taken up front,
//      on one connection, in which the company / scenario are checked and
//      services/forecastLoad.js builds the engineInput (§8). Nothing is written;
//   3  422 FX_RATE_MISSING {currencies} for any currency in scope (§3.4) other than GBP
//      with no rate `effective_from <= today` — before the engine runs;
//   4  lib/engine.js run → the §6.10 body, plus `meta.generatedAt`, serialised with
//      money as JSON integers (minor units).

const express = require('express');

const { withConnection } = require('../db');
const { isValidDate, addDays } = require('../lib/dates');
const { apiError, isApiError, sendApiError, parseId } = require('../lib/shape');
const { run, clampWindow, currenciesInScope, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } = require('../lib/engine');
const { loadEngineInput, loadScenario } = require('../services/forecastLoad');

const GBP = 'GBP';          // D3: rate 1.000000, never an fx_rates row

const invalid = (message) => apiError(400, undefined, message);

/**
 * §6.10's query validation → {companyId: number | 'all', from, to, bucket, include,
 * scenarioId: number | null}. `from` / `to` stay as requested (undefined when absent):
 * the engine applies D7's defaults and the clamps, and the loader bounds itself by
 * clampWindow's `to`. Throws a message-only 400.
 */
function parseQuery(query, today, { buckets, includeModes }) {
    const q = query || {};
    let companyId;
    if (q.companyId === 'all') companyId = 'all';
    else if (q.companyId === undefined || q.companyId === '') throw invalid('companyId is required: a company id, or all.');
    else if (!(companyId = parseId(q.companyId))) throw invalid('companyId must be a company id, or all.');

    for (const key of ['from', 'to']) {
        if (q[key] !== undefined && !isValidDate(q[key])) throw invalid(`${key} must be a real date, YYYY-MM-DD.`);
    }
    const { from, to } = q;
    const wantFrom = from ?? today;
    const wantTo = to ?? addDays(today, DEFAULT_WINDOW_DAYS);
    if (wantTo < today) throw invalid(`to must be today (${today}) or later: the forecast starts today.`);
    if (wantFrom > wantTo) throw invalid('from must be on or before to.');
    try {
        clampWindow(today, from, to);
    } catch (err) {
        // D25 caps `to` at today + 730; a window starting beyond the cap is empty.
        if (err instanceof RangeError) throw invalid(`from must be within ${MAX_WINDOW_DAYS} days of today (${today}).`);
        throw err;
    }

    const bucket = q.bucket === undefined ? 'week' : q.bucket;
    if (!buckets.includes(bucket)) throw invalid(`bucket must be one of: ${buckets.join(', ')}.`);
    const include = q.include === undefined ? 'grid' : q.include;
    if (!includeModes.includes(include)) throw invalid(`include must be one of: ${includeModes.join(', ')}.`);

    let scenarioId = null;
    if (q.scenarioId !== undefined && !(scenarioId = parseId(q.scenarioId))) {
        throw invalid('scenarioId must be a scenario id.');
    }
    return { companyId, from, to, bucket, include, scenarioId };
}

/**
 * One consistent read on one connection: a READ ONLY transaction with its snapshot
 * taken at START, so every rule of §8 sees the same data even while writers commit.
 * Rolled back at the end — there is nothing to commit.
 */
function readSnapshot(fn) {
    return withConnection(async (conn) => {
        await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        try {
            return await fn(conn);
        } finally {
            await conn.query('ROLLBACK');
        }
    });
}

/** JSON.stringify replacer: a bigint that reaches the edge becomes an exact JSON integer. */
function jsonNumbers(_key, value) {
    if (typeof value !== 'bigint') return value;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new RangeError(`forecast: ${value} is outside the safe integer range`);
    return n;
}

module.exports = ({ schemaReady, fail, serverError, todayFor, enums }) => {
    const router = express.Router();

    router.get('/forecast', async (req, res) => {
        try {
            await schemaReady;
            const today = todayFor(req);
            const q = parseQuery(req.query, today, enums);

            const input = await readSnapshot(async (conn) => {
                if (q.companyId !== 'all') {
                    const [rows] = await conn.query(
                        'SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL', [q.companyId]
                    );
                    if (!rows.length) throw invalid('companyId is not a live company.');
                }
                let scenario = null;
                if (q.scenarioId !== null) {
                    scenario = await loadScenario(conn, q.scenarioId);
                    if (!scenario) throw apiError(404, undefined, 'Scenario not found.');
                }
                return loadEngineInput(conn, {
                    today, from: q.from, to: q.to, bucket: q.bucket, include: q.include,
                    companyId: q.companyId, scenario,
                });
            });

            const missing = currenciesInScope(input).filter((c) => c !== GBP && !input.rates[c]);
            if (missing.length) {
                return fail(res, 422,
                    `No FX rate effective on or before ${today} for ${missing.join(', ')}. Add one in Settings.`,
                    'FX_RATE_MISSING', { currencies: missing });
            }

            const body = run(input);
            body.meta.generatedAt = new Date().toISOString();
            res.type('application/json').send(JSON.stringify(body, jsonNumbers));
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'forecast', err);
        }
    });

    return router;
};

module.exports.parseQuery = parseQuery;
