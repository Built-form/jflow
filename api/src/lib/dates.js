'use strict';

// Calendar days (CONTRACT §2.5).
//
// Every date on the wire and in the engine is a 'YYYY-MM-DD' string that must be
// a real (proleptic Gregorian) calendar date, years 0001–9999. Arithmetic is on
// EPOCH DAYS — whole days since 1970-01-01 — with pure integer maths, so no
// `Date` object, local time zone or DST ever touches a calendar day. Two dates
// compare correctly as plain strings.
//
// The one clock-facing function is `londonToday(now)`: the Europe/London
// calendar date of an instant. Routes call it once per request and pass the
// result down (nothing below the route reads a clock); `now` is injectable so
// tests can pin BST and GMT instants.
//
// The weekend RULE (`weekendAdjust(date, rule)`) belongs to lib/recurrence.js
// (CONTRACT §5.3); this file supplies `dayOfWeek` and `isWeekend` for it.
//
// Conventions:
//   dayOfWeek: ISO numbering, Monday 1 … Sunday 7 (1970-01-01 was a Thursday = 4).
//   Every function throws (TypeError / RangeError) on an invalid date or a
//   non-integer count; only `isValidDate` answers false instead of throwing.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysInMonth(y, m) {
    if (m === 2) return isLeapYear(y) ? 29 : 28;
    return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// Howard Hinnant's days_from_civil / civil_from_days: exact integer
// conversions between a proleptic Gregorian (y, m, d) and days since 1970-01-01.
function daysFromCivil(y, m, d) {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;                                   // [0, 399]
    const mp = (m + 9) % 12;                                      // March = 0
    const doy = Math.floor((153 * mp + 2) / 5) + d - 1;           // [0, 365]
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

function civilFromDays(n) {
    const z = n + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;                                 // [0, 146096]
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
        - Math.floor(doe / 146096)) / 365);                       // [0, 399]
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const pad = (n, width) => String(n).padStart(width, '0');
const format = (y, m, d) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

/** [y, m, d] of a valid date string, or null. */
function parts(value) {
    if (typeof value !== 'string') return null;
    const match = DATE_RE.exec(value);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return [y, m, d];
}

function partsOrThrow(value) {
    const p = parts(value);
    if (!p) throw new TypeError(`Invalid date ${JSON.stringify(String(value))}: expected a real calendar date as YYYY-MM-DD`);
    return p;
}

function assertInteger(n, what) {
    if (!Number.isSafeInteger(n)) throw new TypeError(`${what} must be an integer, got ${String(n)}`);
}

const MIN_EPOCH_DAY = daysFromCivil(1, 1, 1);
const MAX_EPOCH_DAY = daysFromCivil(9999, 12, 31);

/** True iff `value` is a 'YYYY-MM-DD' string naming a real calendar date (0001–9999). Never throws. */
function isValidDate(value) {
    return parts(value) !== null;
}

/** 'YYYY-MM-DD' → whole days since 1970-01-01 (negative before it). */
function toEpochDay(date) {
    const [y, m, d] = partsOrThrow(date);
    return daysFromCivil(y, m, d);
}

/** Whole days since 1970-01-01 → 'YYYY-MM-DD'. Throws outside 0001-01-01 … 9999-12-31. */
function fromEpochDay(n) {
    assertInteger(n, 'Epoch day');
    if (n < MIN_EPOCH_DAY || n > MAX_EPOCH_DAY) {
        throw new RangeError(`Epoch day ${n} is outside 0001-01-01 … 9999-12-31`);
    }
    const [y, m, d] = civilFromDays(n);
    return format(y, m, d);
}

/** `date` plus `n` days (n may be negative). */
function addDays(date, n) {
    assertInteger(n, 'Day count');
    return fromEpochDay(toEpochDay(date) + n);
}

/** epoch(a) − epoch(b): positive when `a` is later. */
function diffDays(a, b) {
    return toEpochDay(a) - toEpochDay(b);
}

/** ISO day of week: Monday 1 … Sunday 7. */
function dayOfWeek(date) {
    // Epoch day 0 (1970-01-01) was a Thursday (ISO 4). Modulo kept non-negative
    // for dates before the epoch.
    return ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1;
}

/** Saturday or Sunday. */
function isWeekend(date) {
    return dayOfWeek(date) >= 6;
}

/**
 * Add `n` months (n may be negative) to the year/month of `date`, keep the day
 * of month and clamp it to the last day of the resulting month (CONTRACT §5.1):
 * 2026-01-31 + 1 → 2026-02-28; 2028-02-29 + 12 → 2029-02-28. Recurrence calls it
 * from `start_date` for every occurrence, never chained.
 */
function addMonthsClamped(date, n) {
    assertInteger(n, 'Month count');
    const [y, m, d] = partsOrThrow(date);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = total - ny * 12 + 1;
    if (ny < 1 || ny > 9999) {
        throw new RangeError(`${date} plus ${n} months is outside 0001-01-01 … 9999-12-31`);
    }
    return format(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

// One formatter per container. 'en-CA' as CONTRACT §2.5 names it; the parts are
// read by type rather than trusting the locale's pattern, so an ICU change to
// en-CA's separator or order cannot corrupt `today`.
const LONDON = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/**
 * The Europe/London calendar date of the instant `now` (a Date or epoch
 * milliseconds; default: the current instant) as 'YYYY-MM-DD'. BST-aware:
 * 2026-06-30T23:30Z is '2026-07-01'; 2026-01-15T23:30Z is '2026-01-15'.
 */
function londonToday(now = new Date()) {
    const ms = Object.prototype.toString.call(now) === '[object Date]' ? now.getTime() : now;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new TypeError('londonToday: `now` must be a valid Date or epoch milliseconds');
    }
    const got = {};
    for (const part of LONDON.formatToParts(ms)) got[part.type] = part.value;
    const result = format(Number(got.year), Number(got.month), Number(got.day));
    if (!isValidDate(result)) throw new RangeError(`londonToday: could not format ${ms}`);
    return result;
}

module.exports = {
    toEpochDay,
    fromEpochDay,
    addDays,
    diffDays,
    dayOfWeek,
    isWeekend,
    addMonthsClamped,
    isValidDate,
    londonToday,
};
