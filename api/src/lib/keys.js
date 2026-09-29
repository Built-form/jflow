'use strict';

// Forecast-line keys (CONTRACT §4) — the ONLY builder and parser. No route,
// service or client pattern-matches a key string itself.
//
//   item.<id>                 one-off item      {targetKind: 'item',  targetId: '123', targetDate: null}
//   sched.<id>.<YYYY-MM-DD>   schedule instance {targetKind: 'sched', targetId: '45',  targetDate: '2026-06-01'}
//   ship.<id>                 shipping (ph. 2)  {targetKind: 'ship',  targetId: 'PO-778', targetDate: null}
//
// Keys use unreserved URL characters only, so they pass through a path, a log
// line and API Gateway unencoded. Numeric ids have no sign and no leading zero
// (at most 18 digits); a ship id is 1–64 of [A-Za-z0-9_-]; a schedule's date is
// the instance's NATURAL date and must be a real calendar date. `targetId` is
// always a string (D32: target_id is VARCHAR(64)).
//
// parseKey / isValidKey never throw (a route answers 422 ITEM_KEY_INVALID on
// null); the builders and formatKey throw TypeError on input that could not
// produce a valid key.

const { isValidDate } = require('./dates');

const TARGET_KINDS = ['item', 'sched', 'ship'];
const MAX_KEY_LENGTH = 80;   // item_key VARCHAR(80)

// The grammars, verbatim from CONTRACT §4.
const ITEM_RE = /^item\.([1-9][0-9]{0,17})$/;
const SCHED_RE = /^sched\.([1-9][0-9]{0,17})\.([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
const SHIP_RE = /^ship\.([A-Za-z0-9_-]{1,64})$/;

const NUMERIC_ID_RE = /^[1-9][0-9]{0,17}$/;
const SHIP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : typeof v === 'bigint' ? `${v}n` : String(v));

/** A positive integer id (safe number, bigint or canonical decimal string) → its decimal string. */
function numericId(id) {
    let s = null;
    if (typeof id === 'number') s = Number.isSafeInteger(id) && id > 0 ? String(id) : null;
    else if (typeof id === 'bigint') s = id > 0n ? String(id) : null;
    else if (typeof id === 'string') s = id;
    if (s === null || !NUMERIC_ID_RE.test(s)) {
        throw new TypeError(`Invalid id ${show(id)}: expected a positive integer with no sign or leading zero, at most 18 digits`);
    }
    return s;
}

function shipId(id) {
    if (typeof id !== 'string' || !SHIP_ID_RE.test(id)) {
        throw new TypeError(`Invalid shipping id ${show(id)}: expected 1–64 characters of [A-Za-z0-9_-]`);
    }
    return id;
}

function naturalDate(date) {
    if (!isValidDate(date)) {
        throw new TypeError(`Invalid natural date ${show(date)}: expected a real calendar date as YYYY-MM-DD`);
    }
    return date;
}

/** item.<id> */
function buildItemKey(id) {
    return `item.${numericId(id)}`;
}

/** sched.<scheduleId>.<naturalDate> */
function buildSchedKey(scheduleId, date) {
    return `sched.${numericId(scheduleId)}.${naturalDate(date)}`;
}

/** ship.<id> */
function buildShipKey(id) {
    return `ship.${shipId(id)}`;
}

/** key → {targetKind, targetId, targetDate}, or null when it is not a valid key. Never throws. */
function parseKey(key) {
    if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) return null;
    let m = ITEM_RE.exec(key);
    if (m) return { targetKind: 'item', targetId: m[1], targetDate: null };
    m = SCHED_RE.exec(key);
    if (m) return isValidDate(m[2]) ? { targetKind: 'sched', targetId: m[1], targetDate: m[2] } : null;
    m = SHIP_RE.exec(key);
    if (m) return { targetKind: 'ship', targetId: m[1], targetDate: null };
    return null;
}

/** True iff parseKey accepts `key`. */
function isValidKey(key) {
    return parseKey(key) !== null;
}

/**
 * {targetKind, targetId, targetDate} → key: the exact inverse of parseKey, so
 * formatKey(parseKey(k)) === k. `targetDate` must be null (or absent) on item
 * and ship and a real date on sched; anything else throws TypeError.
 */
function formatKey(parsed) {
    if (parsed === null || typeof parsed !== 'object') {
        throw new TypeError('formatKey expects {targetKind, targetId, targetDate}');
    }
    const { targetKind, targetId, targetDate } = parsed;
    if (targetKind !== 'sched' && targetDate != null) {
        throw new TypeError(`A ${show(targetKind)} key carries no targetDate, got ${show(targetDate)}`);
    }
    switch (targetKind) {
        case 'item': return buildItemKey(targetId);
        case 'sched': return buildSchedKey(targetId, targetDate);
        case 'ship': return buildShipKey(targetId);
        default: throw new TypeError(`Unknown targetKind ${show(targetKind)}: expected one of ${TARGET_KINDS.join(', ')}`);
    }
}

module.exports = {
    TARGET_KINDS,
    buildItemKey,
    buildSchedKey,
    buildShipKey,
    parseKey,
    isValidKey,
    formatKey,
};
