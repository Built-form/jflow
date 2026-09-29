'use strict';

// Shipping's payments feed — the ONE file that talks to the shipping API and the only one
// that knows SHIPPING_API_BASE / SHIPPING_API_KEY (CONTRACT §2.1, §10.12; docs/PHASE2.md
// §3, §4.1).
//
// Modelled on workflows/api/src/services/jfpro.js (read, not copied): the key travels only
// in X-Api-Key against shipping's /api/internal/* route, which sits before its Google-JWT
// middleware; configuration is read per call; the call is bounded by an AbortController;
// every failure is one `unavailable(reason)` the caller degrades on. Two differences from
// that model:
//   · the timeout covers the BODY as well as the headers — a feed that sends headers and
//     then stalls must not hold a /forecast request past 5 s;
//   · an unconfigured client is a failure with a reason, never a silent pass: there is
//     no "validation off" mode here, the caller just keeps its last snapshot.
//
// `reason` is one of SHIPPING_REASONS: unconfigured | timeout | unreachable | http_401 |
// http_<status> | bad_response. It is what `SHIPPING_UNAVAILABLE.details.reason` carries.
//
// No DB here, and no network I/O may run inside a transaction: shippingRefresh.js calls
// fetchPaymentsForecast with no connection held.

const log = require('../lib/logger');
const { parseMinor, formatMinor } = require('../lib/money');
const { isValidDate } = require('../lib/dates');
const { buildShipKey } = require('../lib/keys');

// Bounded like the secret fetch: the Lambda has a 29 s budget, and /forecast runs a due
// refresh before it answers (P4) — an unreachable shipping must cost at most this.
const SHIPPING_TIMEOUT_MS = 5000;
const FEED_PATH = '/api/internal/payments-forecast';

// The feed's vocabularies (PHASE2 §3), enforced by validateFeed below; the handler serves
// the first four through /meta/enums (CONTRACT §7).
const FEED_KINDS = ['deposit', 'balance'];
const FEED_STATUSES = ['open', 'paid'];
const DATE_BASES = ['firm', 'estimated', 'undated'];
const AMOUNT_BASES = ['stated', 'derived'];
const BLOCKED_REASONS = ['shipment', 'artwork', 'pi', 'pi_signed'];
const SHIPPING_REASONS = ['unconfigured', 'timeout', 'unreachable', 'http_401', 'http_<status>', 'bad_response'];

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_ID_RE = /^[1-9][0-9]{0,17}$/;
// external_items column widths, in characters (MySQL counts characters, not bytes).
const TEXT_LIMITS = { supplier: 255, poNumber: 64, containerRef: 100 };
const FLAG_MAX_LENGTH = 64;
const PROBLEMS_KEPT = 20;

/** The one failure shape: `err.reason` is a SHIPPING_REASONS value; the message is safe to log. */
function unavailable(reason, message) {
    const err = new Error(message || `Shipping is unavailable (${reason}).`);
    err.isShippingUnavailable = true;
    err.reason = reason;
    return err;
}

const isUnavailable = (err) => Boolean(err && err.isShippingUnavailable);

/**
 * Base URL without a trailing slash, or null when unset. Read per call: lib/secrets.js
 * overlays the runtime secret onto process.env at the first invocation, after this file
 * is required, so a value captured at load time could be stale.
 */
function baseUrl() {
    const raw = String(process.env.SHIPPING_API_BASE || '').trim();
    return raw ? raw.replace(/\/+$/, '') : null;
}

function apiKey() {
    return String(process.env.SHIPPING_API_KEY || '').trim() || null;
}

/** True when both halves of the config are present. False → fetchPaymentsForecast makes no call. */
const isConfigured = () => Boolean(baseUrl() && apiKey());

/**
 * GET shipping's payments forecast and return the parsed body: an object whose `items` is
 * an array (rows are checked by validateFeed, not here). Throws only `unavailable(reason)`.
 * `timeoutMs` exists for the tests; callers take the default.
 */
async function fetchPaymentsForecast({ today, paidSince } = {}, { timeoutMs = SHIPPING_TIMEOUT_MS } = {}) {
    const base = baseUrl();
    const key = apiKey();
    if (!base || !key) {
        throw unavailable('unconfigured', 'Shipping is not configured (SHIPPING_API_BASE / SHIPPING_API_KEY).');
    }
    let url;
    try {
        url = new URL(base + FEED_PATH);
    } catch {
        throw unavailable('unconfigured', 'SHIPPING_API_BASE is not a valid URL.');
    }
    if (today) url.searchParams.set('today', today);
    if (paidSince) url.searchParams.set('paidSince', paidSince);

    // AbortController rather than Promise.race: on timeout the SOCKET must close, not just
    // the wait. The timer stays armed until the body is read, so a stalled body aborts too.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const lost = (err, stage) => {
        if (controller.signal.aborted) {
            log.warn(`[shipping] GET ${FEED_PATH} timed out after ${timeoutMs}ms (${stage})`);
            return unavailable('timeout', `Shipping did not answer within ${timeoutMs}ms.`);
        }
        // The URL is safe to log: the key travels in a header, never the query string.
        log.warn(`[shipping] GET ${FEED_PATH} failed (${stage}):`, err && err.message);
        return unavailable('unreachable', 'Shipping could not be reached.');
    };
    try {
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: { 'X-Api-Key': key, Accept: 'application/json' },
                signal: controller.signal,
            });
        } catch (err) {
            throw lost(err, 'request');
        }

        if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* nothing to release */ }
            // A 401 has two causes that need different fixes, so name both (as jfpro.js does):
            // the key is wrong, or the path is missing from shipping's gateway route table and
            // fell through to its JWT authorizer.
            const detail = response.status === 401
                ? 'refused the request (401): either SHIPPING_API_KEY is wrong, or '
                    + `${FEED_PATH} is not in shipping's gateway route table and fell through to its JWT authorizer`
                : `returned HTTP ${response.status}`;
            log.warn(`[shipping] GET ${FEED_PATH}: shipping ${detail}.`);
            throw unavailable(`http_${response.status}`, `Shipping ${detail}.`);
        }

        let text;
        try {
            text = await response.text();
        } catch (err) {
            throw lost(err, 'body');
        }
        let body;
        try {
            body = JSON.parse(text);
        } catch (err) {
            log.warn(`[shipping] GET ${FEED_PATH}: the response was not JSON:`, err.message);
            throw unavailable('bad_response', 'Shipping returned a response that is not JSON.');
        }
        assertFeedShape(body);
        return body;
    } finally {
        clearTimeout(timer);
    }
}

function assertFeedShape(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.items)) {
        log.warn(`[shipping] GET ${FEED_PATH}: the response has no items array.`);
        throw unavailable('bad_response', 'Shipping returned a feed with no items array.');
    }
}

// ── validateFeed ────────────────────────────────────────────────────────────

const isNullish = (v) => v === null || v === undefined;
const charLength = (s) => [...s].length;

/** A positive id: a safe integer, or a canonical decimal string of one. Else undefined. */
function positiveId(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : undefined;
    if (typeof v === 'string' && DECIMAL_ID_RE.test(v)) {
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : undefined;
    }
    return undefined;
}

/** A feed id (§4's ship grammar, through lib/keys.js — the only key grammar). */
function isFeedId(v) {
    if (typeof v !== 'string') return false;
    try {
        buildShipKey(v);
        return true;
    } catch {
        return false;
    }
}

/**
 * One raw feed row → {item} or {reason}. The item is the normalised form the refresh
 * stores: nullable fields null (never undefined), `amount` canonical 2-dp, `flags`
 * sorted. `arranged` has no column (CONTRACT §3.5) and is not carried.
 */
function checkRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { reason: 'not an object' };
    if (!isFeedId(row.id)) return { reason: 'id' };
    if (!FEED_KINDS.includes(row.kind)) return { reason: 'kind' };
    if (!FEED_STATUSES.includes(row.status)) return { reason: 'status' };
    if (!DATE_BASES.includes(row.dateBasis)) return { reason: 'dateBasis' };
    if (!AMOUNT_BASES.includes(row.amountBasis)) return { reason: 'amountBasis' };
    if (!isNullish(row.blocked) && !BLOCKED_REASONS.includes(row.blocked)) return { reason: 'blocked' };
    if (typeof row.currency !== 'string' || !CURRENCY_RE.test(row.currency)) return { reason: 'currency' };

    let minor;
    try {
        minor = parseMinor(row.amount);
    } catch {
        return { reason: 'amount' };
    }
    if (minor <= 0n) return { reason: 'amount' };

    const item = {
        id: row.id,
        kind: row.kind,
        status: row.status,
        supplier: null,
        companyId: null,
        poId: null,
        poNumber: null,
        shipmentId: null,
        containerRef: null,
        currency: row.currency,
        amount: formatMinor(minor),
        dueDate: null,
        paidOn: null,
        settles: null,
        dateBasis: row.dateBasis,
        amountBasis: row.amountBasis,
        blocked: isNullish(row.blocked) ? null : row.blocked,
        flags: [],
    };

    for (const field of ['companyId', 'poId', 'shipmentId']) {
        if (isNullish(row[field])) continue;
        const id = positiveId(row[field]);
        if (id === undefined) return { reason: field };
        item[field] = id;
    }
    for (const [field, max] of Object.entries(TEXT_LIMITS)) {
        if (isNullish(row[field])) continue;
        if (typeof row[field] !== 'string' || charLength(row[field]) > max) return { reason: field };
        item[field] = row[field];
    }
    for (const field of ['dueDate', 'paidOn']) {
        if (isNullish(row[field])) continue;
        if (!isValidDate(row[field])) return { reason: field };
        item[field] = row[field];
    }
    if (!isNullish(row.settles)) {
        if (!isFeedId(row.settles)) return { reason: 'settles' };
        item.settles = row.settles;
    }
    if (!isNullish(row.flags)) {
        if (!Array.isArray(row.flags)
            || !row.flags.every((f) => typeof f === 'string' && f.length > 0 && f.length <= FLAG_MAX_LENGTH)) {
            return { reason: 'flags' };
        }
        item.flags = [...row.flags].sort();
    }

    // Consistency (PHASE2 §3): a paid row is one dated payment; an open row is owed, and
    // is undated exactly when it has no due date.
    if (item.status === 'paid') {
        if (item.paidOn === null) return { reason: 'paidOn' };
    } else {
        if (item.paidOn !== null) return { reason: 'paidOn' };
        if ((item.dueDate === null) !== (item.dateBasis === 'undated')) return { reason: 'dateBasis' };
    }
    return { item };
}

/** The feed's companies[] → [{id, name}], dropping entries that are not a positive id and a name. */
function feedCompanies(body) {
    if (!Array.isArray(body.companies)) return [];
    const out = [];
    for (const c of body.companies) {
        if (!c || typeof c !== 'object') continue;
        const id = positiveId(c.id);
        if (id === undefined || typeof c.name !== 'string' || !c.name || charLength(c.name) > 255) continue;
        out.push({ id, name: c.name });
    }
    return out;
}

/**
 * Check every feed row. → `{items, rejected, problems, companies}`:
 *   items      the accepted rows, normalised (checkRow), in feed order;
 *   rejected   how many rows were dropped — bad grammar or enum, an amount parseMinor
 *              refuses or ≤ 0, an unreal date, a currency outside ^[A-Z]{3}$, an
 *              inconsistent paid/open row, or an id already seen (compared as the DB's
 *              case-insensitive unique key compares it);
 *   problems   the first few rejections as {index, id, reason}, for the log;
 *   companies  the feed's companies[], cleaned (feedCompanies).
 * A body with no items array throws unavailable('bad_response').
 */
function validateFeed(body) {
    assertFeedShape(body);
    const items = [];
    const problems = [];
    const seen = new Set();
    let rejected = 0;
    body.items.forEach((row, index) => {
        let { item, reason } = checkRow(row);
        if (item) {
            const key = item.id.toLowerCase();
            if (seen.has(key)) {
                item = null;
                reason = 'duplicate id';
            } else {
                seen.add(key);
            }
        }
        if (item) {
            items.push(item);
            return;
        }
        rejected += 1;
        if (problems.length < PROBLEMS_KEPT) {
            const id = row && typeof row === 'object' && typeof row.id === 'string' ? row.id.slice(0, 80) : null;
            problems.push({ index, id, reason });
        }
    });
    return { items, rejected, problems, companies: feedCompanies(body) };
}

module.exports = {
    SHIPPING_TIMEOUT_MS,
    FEED_KINDS,
    FEED_STATUSES,
    DATE_BASES,
    AMOUNT_BASES,
    BLOCKED_REASONS,
    SHIPPING_REASONS,
    isConfigured,
    isUnavailable,
    unavailable,
    fetchPaymentsForecast,
    validateFeed,
};
