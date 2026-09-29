'use strict';

// Classification (CONTRACT §9.6): where each line of a forecast lands, given its account's
// anchor A and today. THE ONLY PLACE THE TABLE LIVES: the engine (/forecast) and the lists
// (derivedStatus on /items and /instances) call this one function, so they cannot disagree.
// Pure: no DB, no clock; dates through lib/dates.js, money as bigint minor units.
//
//   classify(line, A, today) → { payments: PaidLine[], owed: OwedLine | null }
//   line     = { status, settleMode, effectiveDate, amountMinor, paidAmountMinor,
//                payments: [{ paymentId, paidOn, amountMinor }] }
//   PaidLine = { paymentId, band: 'settledBeforeAnchor' | 'paid', date: paidOn, amountMinor, partial }
//   OwedLine = { band: 'skipped' | 'assumedSettled' | 'assumed' | 'future' | 'overdue' | 'unresolved',
//                date, amountMinor, remainder }
//
// | # | State                                              | Band                           |
// |---|----------------------------------------------------|--------------------------------|
// | 1 | payment row, paidOn < A                            | settledBeforeAnchor (excluded) |
// | 2 | payment row, paidOn >= A                           | paid, at its paidOn            |
// | 3 | part_paid: remainder = amount − paid, forced manual | rows 7–9, remainder: true      |
// | 4 | skipped                                            | skipped (excluded)             |
// | 5 | expected, auto, effective < A                      | assumedSettled (excluded)      |
// | 6 | expected, auto, A <= effective < today             | assumed, at its effective date |
// | 7 | expected, any mode, effective >= today             | future                         |
// | 8 | expected, manual, effective < today, <= 45 days    | overdue, placed at today       |
// | 9 | expected, manual, effective < today, > 45 days     | unresolved (not in the series) |
//
// Settle mode is resolved by the caller (an override's when set, else the schedule's; a
// one-off's own). A = null means no anchor: minus infinity (D12), so nothing is
// settledBeforeAnchor or assumedSettled. Otherwise A <= today, so the overdue floor is today.
//
// Invariant (asserted by the unit matrix): one PaidLine per input payment row; `owed` is
// null iff status = 'paid', otherwise exactly one owed band.
//
// OwedLine.date is where the line is placed: today for an overdue line (row 8), the
// effective date for every other band.

const { diffDays, isValidDate } = require('./dates');

/** D9: `today − effectiveDate <= 45` is overdue; `> 45` is unresolved. */
const OVERDUE_WINDOW_DAYS = 45;

/** D10: one per item or instance, projected from classify's result by `derivedStatus`. */
const DERIVED_STATUSES = ['expected', 'overdue', 'unresolved', 'assumed', 'assumedSettled', 'paid', 'skipped'];

const STATUSES = ['expected', 'part_paid', 'paid', 'skipped'];
const SETTLE_MODES = ['auto', 'manual'];

// §9.6's projection: owed band → derivedStatus (owed null → 'paid').
const DERIVED_BY_BAND = {
    skipped: 'skipped',
    assumedSettled: 'assumedSettled',
    assumed: 'assumed',
    future: 'expected',
    overdue: 'overdue',
    unresolved: 'unresolved',
};

function requireDate(value, name) {
    if (!isValidDate(value)) throw new TypeError(`classify: ${name} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
}

function requireMinor(value, name) {
    if (typeof value !== 'bigint') throw new TypeError(`classify: ${name} must be bigint minor units, got ${typeof value}`);
}

/** Rows 5–9: the band of an owed line dated `date` in `settleMode`. */
function owedBand(settleMode, date, A, today) {
    if (date >= today) return 'future';                                       // row 7
    if (settleMode === 'auto') {
        return A !== null && date < A ? 'assumedSettled' : 'assumed';         // rows 5, 6
    }
    return diffDays(today, date) <= OVERDUE_WINDOW_DAYS ? 'overdue' : 'unresolved'; // rows 8, 9
}

/**
 * Classify one line against its account's anchor `A` (a date, or null for none) and
 * `today`. Throws on a status or settle mode outside the vocabulary, a malformed date,
 * non-bigint money, or A > today.
 */
function classify(line, A, today) {
    requireDate(today, 'today');
    const anchor = A == null ? null : A;
    if (anchor !== null) {
        requireDate(anchor, 'A');
        if (anchor > today) throw new RangeError(`classify: anchor ${anchor} is after today ${today}`);
    }
    const { status } = line;
    if (!STATUSES.includes(status)) {
        throw new TypeError(`classify: status must be one of ${STATUSES.join(', ')}, got ${JSON.stringify(status)}`);
    }

    // Rows 1–2: every payment row on its own paidOn, for paid and part_paid parents alike.
    const partial = status === 'part_paid';
    const payments = (line.payments || []).map((p) => {
        requireDate(p.paidOn, 'payment paidOn');
        requireMinor(p.amountMinor, 'payment amountMinor');
        return {
            paymentId: p.paymentId,
            band: anchor !== null && p.paidOn < anchor ? 'settledBeforeAnchor' : 'paid',
            date: p.paidOn,
            amountMinor: p.amountMinor,
            partial,
        };
    });

    if (status === 'paid') return { payments, owed: null };

    requireDate(line.effectiveDate, 'effectiveDate');
    requireMinor(line.amountMinor, 'amountMinor');
    const date = line.effectiveDate;

    if (status === 'skipped') {                                                // row 4
        return { payments, owed: { band: 'skipped', date, amountMinor: line.amountMinor, remainder: false } };
    }

    let settleMode = line.settleMode;
    let amountMinor = line.amountMinor;
    const remainder = status === 'part_paid';
    if (remainder) {                                                           // row 3
        const paid = line.paidAmountMinor == null ? 0n : line.paidAmountMinor;
        requireMinor(paid, 'paidAmountMinor');
        amountMinor -= paid;
        settleMode = 'manual';
    } else if (!SETTLE_MODES.includes(settleMode)) {
        throw new TypeError(`classify: settleMode must be one of ${SETTLE_MODES.join(', ')}, got ${JSON.stringify(settleMode)}`);
    }

    const band = owedBand(settleMode, date, anchor, today);
    return {
        payments,
        owed: { band, date: band === 'overdue' ? today : date, amountMinor, remainder },
    };
}

/**
 * §9.6 / D10: a classify result → derivedStatus. owed null (paid) → 'paid'; future →
 * 'expected'; every other owed band maps to itself. A part_paid line reports its
 * remainder's band, which is never assumed* (the remainder is forced manual).
 */
function derivedStatus(result) {
    return result.owed === null ? 'paid' : DERIVED_BY_BAND[result.owed.band];
}

module.exports = {
    OVERDUE_WINDOW_DAYS,
    DERIVED_STATUSES,
    classify,
    derivedStatus,
};
