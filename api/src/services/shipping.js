'use strict';

// Shipping's payments feed — what the refresh (services/shippingRefresh.js) reads and
// how it is checked (CONTRACT §2.1, §10.12; docs/PLAN.md "Phase 2").
//
// Dev, 2026-09-29: JFlow reads shipping's own tables directly — same DB instance,
// schema SHIPPING_DB_SCHEMA (default `jfa`), read-only — and runs the ported ShipLine
// payment math itself. There is no shipping HTTP route and no API key:
// fetchPaymentsForecast delegates to services/shippingSource.js, which returns the
// body such a route would have ({meta, companies, items}). This file keeps the feed's
// vocabularies, validateFeed and the one failure shape.
//
// `reason` is one of SHIPPING_REASONS — what `SHIPPING_UNAVAILABLE.details.reason`
// carries:
//   source_schema  SHIPPING_DB_SCHEMA is not a valid name, or the schema lacks a column
//                  JFlow reads (or JFlow's DB user cannot read it — e.g. no grant);
//   source_error   any other failure reading shipping's data or computing the feed;
//   bad_response   a feed body with no items array.
//
// Nothing here runs inside a JFlow transaction: shippingRefresh.js calls
// fetchPaymentsForecast with no connection of its own held.

const { parseMinor, formatMinor } = require('../lib/money');
const { isValidDate } = require('../lib/dates');
const { buildShipKey } = require('../lib/keys');

// The feed's vocabularies (PHASE2 §3), enforced by validateFeed below; the handler serves
// them through /meta/enums (CONTRACT §7).
// `extra` (an extra charge or credit, or a forwarder's shipment cost) and `qc` (a QC unit
// owed on its own) joined with the re-pin to ShipLine 77577a1 (2026-10-06).
const FEED_KINDS = ['deposit', 'balance', 'extra', 'qc'];
const FEED_STATUSES = ['open', 'paid'];
const DATE_BASES = ['firm', 'estimated', 'undated'];
const AMOUNT_BASES = ['stated', 'derived'];
const BLOCKED_REASONS = ['shipment', 'artwork', 'pi', 'pi_signed'];
const SHIPPING_REASONS = ['source_schema', 'source_error', 'bad_response'];

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_ID_RE = /^[1-9][0-9]{0,17}$/;
// external_items column widths, in characters (MySQL counts characters, not bytes).
// `label` (2026-10-06): what a row is when it is not a PO's goods — an extra's kind, "PO
// charges", "Top-up", "QC units <code>"; null for goods.
const TEXT_LIMITS = { supplier: 255, poNumber: 64, containerRef: 100, label: 255 };
const FLAG_MAX_LENGTH = 64;
const PROBLEMS_KEPT = 20;
// `dueSet` (a date set by hand in ShipLine; external_items.due_set_json): the setter's
// name and email as shipping stores them (VARCHAR(255)), the note as payment_due_dates
// holds it (VARCHAR(500)), the instant as the source connection sends a TIMESTAMP.
const DUE_SET_SCOPES = ['payment', 'item'];
const DUE_SET_LIMITS = { by: 255, email: 255, note: 500 };
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The one failure shape: `err.reason` is a SHIPPING_REASONS value; the message is safe to log. */
function unavailable(reason, message) {
    const err = new Error(message || `Shipping is unavailable (${reason}).`);
    err.isShippingUnavailable = true;
    err.reason = reason;
    return err;
}

const isUnavailable = (err) => Boolean(err && err.isShippingUnavailable);

// shippingSource.js requires this module, so this one requires it lazily (at call time,
// when both are loaded). The e2e suites replace its readPaymentsForecast
// (test/helpers/shippingSourceStub.js), which works because it is looked up per call.
const source = () => require('./shippingSource');

/** True when SHIPPING_DB_SCHEMA (default `jfa`) is a valid schema name. Read per call. */
const isConfigured = () => source().sourceSchema() !== null;

/**
 * The feed body — an object whose `items` is an array (rows are checked by
 * validateFeed, not here) — for `today` (the route's Europe/London date) and
 * `paidSince`. Throws only `unavailable(reason)` (or a TypeError for bad arguments).
 */
async function fetchPaymentsForecast({ today, paidSince } = {}) {
    const body = await source().readPaymentsForecast({ today, paidSince });
    assertFeedShape(body);
    return body;
}

function assertFeedShape(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.items)) {
        throw unavailable('bad_response', 'The shipping feed has no items array.');
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
 * A row's `dueSet` → its normalised form, or undefined when malformed: `by` and `email`
 * non-empty strings within their widths, `at` an ISO UTC instant, `derivedDate` a real
 * date or null, `scope` payment | item, `note` within 500 characters or null ('' → null).
 */
function checkDueSet(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    for (const field of ['by', 'email']) {
        if (typeof v[field] !== 'string' || !v[field] || charLength(v[field]) > DUE_SET_LIMITS[field]) return undefined;
    }
    if (typeof v.at !== 'string' || !ISO_INSTANT_RE.test(v.at) || Number.isNaN(Date.parse(v.at))) return undefined;
    if (!isNullish(v.derivedDate) && !isValidDate(v.derivedDate)) return undefined;
    if (!DUE_SET_SCOPES.includes(v.scope)) return undefined;
    if (!isNullish(v.note) && (typeof v.note !== 'string' || charLength(v.note) > DUE_SET_LIMITS.note)) return undefined;
    return {
        by: v.by,
        email: v.email,
        at: v.at,
        derivedDate: isNullish(v.derivedDate) ? null : v.derivedDate,
        scope: v.scope,
        note: isNullish(v.note) || v.note === '' ? null : v.note,
    };
}

/**
 * One raw feed row → {item} or {reason}. The item is the normalised form the refresh
 * stores: nullable fields null (never undefined), `amount` canonical 2-dp, `flags`
 * sorted, `dueSet` null or checked (checkDueSet). `arranged` has no column
 * (CONTRACT §3.5) and is not carried.
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
        label: null,
        currency: row.currency,
        amount: formatMinor(minor),
        dueDate: null,
        paidOn: null,
        settles: null,
        dateBasis: row.dateBasis,
        amountBasis: row.amountBasis,
        blocked: isNullish(row.blocked) ? null : row.blocked,
        flags: [],
        dueSet: null,
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
    if (!isNullish(row.dueSet)) {
        const dueSet = checkDueSet(row.dueSet);
        if (dueSet === undefined) return { reason: 'dueSet' };
        item.dueSet = dueSet;
    }

    // Consistency (PHASE2 §3): a paid row is one dated payment; an open row is owed, and
    // is undated exactly when it has no due date. A date set by hand is a date: it
    // belongs to a dated open row.
    if (item.status === 'paid') {
        if (item.paidOn === null) return { reason: 'paidOn' };
        if (item.dueSet !== null) return { reason: 'dueSet' };
    } else {
        if (item.dueSet !== null && item.dueDate === null) return { reason: 'dueSet' };
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
 * A body with no items array throws unavailable('bad_response'), and so does a feed whose
 * every row is rejected (CONTRACT §10.12 step 2d): taken as it stands, it would mark the
 * whole snapshot gone. An empty feed is a valid one.
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
    if (rejected > 0 && items.length === 0) {
        const reasons = [...new Set(problems.map((p) => p.reason))].join(', ');
        throw unavailable('bad_response', `Every row of the shipping feed was rejected (${rejected}: ${reasons}).`);
    }
    return { items, rejected, problems, companies: feedCompanies(body) };
}

module.exports = {
    FEED_KINDS,
    FEED_STATUSES,
    DATE_BASES,
    AMOUNT_BASES,
    BLOCKED_REASONS,
    SHIPPING_REASONS,
    sourceSchema: () => source().sourceSchema(),
    isConfigured,
    isUnavailable,
    unavailable,
    fetchPaymentsForecast,
    validateFeed,
};
