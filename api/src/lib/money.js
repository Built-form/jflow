'use strict';

// Money (CONTRACT §2.6, §9.8).
//
// Amounts are integer MINOR units held as `bigint`, parsed from and formatted to
// the DECIMAL strings MySQL returns and the API carries (D1). FX rates are
// DECIMAL(12,6) strings parsed to MICRO-units (`bigint`, 1.000000 = 1_000_000n).
// Conversion multiplies in bigint and rounds ONCE with `roundHalfUp`, so no
// float ever touches money.
//
// Signs: `parseMinor` accepts a leading minus (a balance may be negative);
// whether a field may be negative, zero or must be > 0 is the route's rule
// (`amount`, `paidAmount`, `newAmount` > 0; `balance` any sign). `parseRate`
// is strictly positive.
//
// Every parser throws on bad input — TypeError for a non-string or a string
// outside the grammar, RangeError for a zero rate or divisor — and the route
// turns that into its 400.

const MONEY_RE = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/;   // DECIMAL(14,2)
const RATE_RE = /^(\d{1,6})(?:\.(\d{1,6}))?$/;         // DECIMAL(12,6), unsigned
const RATE_SCALE = 1000000n;                           // micro-units per unit

function describe(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint') return `${value}n`;
    return typeof value === 'number' ? String(value) : typeof value;
}

function assertBigInt(value, what) {
    if (typeof value !== 'bigint') throw new TypeError(`${what} must be a bigint, got ${describe(value)}`);
}

/**
 * DECIMAL(14,2) string → bigint minor units. Grammar `^-?\d{1,12}(\.\d{1,2})?$`:
 * "1024.00" → 102400n, "1024" → 102400n, "-250.50" → -25050n. Anything else —
 * a JSON number, "1e3", "1.234", ".5", whitespace — throws TypeError.
 */
function parseMinor(str) {
    if (typeof str !== 'string') {
        throw new TypeError(`Money must be a DECIMAL string, got ${describe(str)}`);
    }
    const m = MONEY_RE.exec(str);
    if (!m) {
        throw new TypeError(`Invalid money amount ${describe(str)}: expected up to 12 digits and 2 decimals, e.g. "1024.00"`);
    }
    const magnitude = BigInt(m[2]) * 100n + BigInt((m[3] || '').padEnd(2, '0'));
    return m[1] === '-' ? -magnitude : magnitude;
}

/**
 * bigint minor units → DECIMAL string with exactly two decimals: 102400n →
 * "1024.00", -5n → "-0.05". A safe-integer number (a /forecast figure) is
 * accepted too; anything fractional or unsafe throws TypeError.
 */
function formatMinor(minor) {
    let v = minor;
    if (typeof v === 'number' && Number.isSafeInteger(v)) v = BigInt(v);
    assertBigInt(v, 'Minor units');
    const negative = v < 0n;
    const abs = negative ? -v : v;
    return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/**
 * DECIMAL(12,6) rate string → bigint micro-units: "1.234567" → 1234567n,
 * "0.005234" → 5234n. Grammar `^\d{1,6}(\.\d{1,6})?$` (TypeError otherwise)
 * and strictly > 0 (RangeError for a zero rate).
 */
function parseRate(str) {
    if (typeof str !== 'string') {
        throw new TypeError(`Rate must be a DECIMAL string, got ${describe(str)}`);
    }
    const m = RATE_RE.exec(str);
    if (!m) {
        throw new TypeError(`Invalid rate ${describe(str)}: expected up to 6 digits and 6 decimals, e.g. "1.234567"`);
    }
    const micro = BigInt(m[1]) * RATE_SCALE + BigInt((m[2] || '').padEnd(6, '0'));
    if (micro <= 0n) throw new RangeError(`Rate ${describe(str)} must be greater than zero`);
    return micro;
}

/**
 * numerator / denominator (both bigint) rounded to the nearest integer, a half
 * rounding AWAY FROM ZERO: the magnitude is rounded half up, then the sign
 * restored. 5/10 → 1, -5/10 → -1, 25/10 → 3, 7/-2 → -4.
 */
function roundHalfUp(numerator, denominator) {
    assertBigInt(numerator, 'Numerator');
    assertBigInt(denominator, 'Denominator');
    if (denominator === 0n) throw new RangeError('Division by zero');
    const negative = (numerator < 0n) !== (denominator < 0n);
    const n = numerator < 0n ? -numerator : numerator;
    const d = denominator < 0n ? -denominator : denominator;
    let q = n / d;
    if ((n % d) * 2n >= d) q += 1n;
    return negative ? -q : q;
}

/** Native minor units → GBP minor units at a micro-unit rate, rounded once (§9.8). */
function toGbp(nativeMinor, rateMicro) {
    assertBigInt(nativeMinor, 'Native minor units');
    assertBigInt(rateMicro, 'Rate');
    return roundHalfUp(nativeMinor * rateMicro, RATE_SCALE);
}

/** GBP minor units → an account currency's minor units at its micro-unit rate, rounded once (§9.8). */
function fromGbp(gbpMinor, rateMicro) {
    assertBigInt(gbpMinor, 'GBP minor units');
    assertBigInt(rateMicro, 'Rate');
    return roundHalfUp(gbpMinor * RATE_SCALE, rateMicro);
}

module.exports = {
    parseMinor,
    formatMinor,
    parseRate,
    roundHalfUp,
    toGbp,
    fromGbp,
};
