'use strict';

// Split and end, the pure decisions (CONTRACT §10.5 steps 2 and 5; D21, D22, D37).
// The transaction (locks, guards, writes) lives in routes/schedules.js; what it
// decides lives here, so the rules are unit-tested on their own:
//
//   changedStructure(schedule, changes)  the structural fields a body really changes
//   keepsSeries(schedule, changes)       true when the date grid survives (D21)
//   successorShape(schedule, k, changes) the successor's structure (§10.5 step 2)
//   partitionAdjustments(adjs, plan)     rekey[] / drop[] (§10.5 step 5)
//
// `schedule` is the schedule JSON (lib/shape.js scheduleToJson); `changes` holds
// only the structural fields a body sent, already validated, JSON names, money as a
// DECIMAL string. Pure: no DB, no clock.

const { parseMinor } = require('./money');
const { endBefore, isOccurrence } = require('./recurrence');

/** D37, JSON names, in the order refusals list them. */
const STRUCTURAL_FIELDS = [
    'amount', 'currency', 'accountId', 'frequency', 'intervalCount', 'startDate',
    'occurrenceCount', 'endDate', 'weekendRule', 'settleMode',
];
/** The fields that define the date grid: a split that leaves them alone keeps the series (D21). */
const SERIES_FIELDS = ['frequency', 'intervalCount', 'startDate', 'weekendRule'];
const END_FIELDS = ['occurrenceCount', 'endDate'];

/** Equal values of one structural field: money by minor units, ids and counts by value, null = null. */
function sameValue(field, a, b) {
    if (a == null || b == null) return a == null && b == null;
    if (field === 'amount') return parseMinor(String(a)) === parseMinor(String(b));
    if (field === 'accountId' || field === 'intervalCount' || field === 'occurrenceCount') return Number(a) === Number(b);
    return a === b;
}

/**
 * The structural fields present in `changes` whose value differs from the schedule's,
 * in STRUCTURAL_FIELDS order. An unchanged value in a body is not a change (§6.8).
 */
function changedStructure(schedule, changes) {
    return STRUCTURAL_FIELDS.filter((f) => changes[f] !== undefined && !sameValue(f, changes[f], schedule[f]));
}

/** D21: the successor keeps the predecessor's date grid unless frequency, interval, start or weekend rule changes. */
function keepsSeries(schedule, changes) {
    return !changedStructure(schedule, changes).some((f) => SERIES_FIELDS.includes(f));
}

/**
 * §10.5 step 2 / D21: the successor of a split of `schedule` from occurrence `k`.
 *   keepSeries: start_date = the old start_date, active_from = k, and the end inherited
 *     verbatim (n still counts from start_date);
 *   otherwise: start_date = changes.startDate ?? k, active_from = null, and the remaining
 *     end (end_date, or occurrence_count less the occurrences before k).
 * An end in `changes` (either field) replaces the inherited end entirely — D22 forbids
 * both, so the other becomes null. Every other structural field is `changes`' when sent,
 * else the old row's. Throws RangeError when `k` is not an occurrence (endBefore).
 */
function successorShape(schedule, k, changes) {
    const keepSeries = keepsSeries(schedule, changes);
    const { successor } = endBefore(schedule, k, { keepSeries });
    const pick = (f) => (changes[f] !== undefined ? changes[f] : schedule[f]);
    const endsFromChanges = END_FIELDS.some((f) => changes[f] !== undefined);
    return {
        keepSeries,
        amount: pick('amount'),
        currency: pick('currency'),
        accountId: pick('accountId'),
        frequency: pick('frequency'),
        intervalCount: pick('intervalCount'),
        weekendRule: pick('weekendRule'),
        settleMode: pick('settleMode'),
        startDate: keepSeries || changes.startDate === undefined ? successor.startDate : changes.startDate,
        activeFrom: successor.activeFrom,
        occurrenceCount: endsFromChanges ? (changes.occurrenceCount ?? null) : successor.occurrenceCount,
        endDate: endsFromChanges ? (changes.endDate ?? null) : successor.endDate,
    };
}

/**
 * §10.5 step 5 — decide only, write nothing. An adjustment (`{…, targetDate}`) is
 * re-keyable iff (a) the grid is kept, (b) the currency is unchanged (a re-keyed
 * new_amount would silently be in the wrong currency), (c) the action is a split,
 * never an end, and (d) the successor generates its natural date. Everything else is
 * drop[]. Input order is kept in both lists.
 *
 * plan = {action: 'split' | 'end', keepSeries, currencyChanged, successor}
 */
function partitionAdjustments(adjustments, { action, keepSeries = false, currencyChanged = false, successor = null }) {
    const rekey = [];
    const drop = [];
    for (const a of adjustments) {
        const rekeyable = action === 'split' && keepSeries && !currencyChanged && successor !== null
            && isOccurrence(successor, a.targetDate);
        (rekeyable ? rekey : drop).push(a);
    }
    return { rekey, drop };
}

module.exports = {
    STRUCTURAL_FIELDS,
    changedStructure,
    keepsSeries,
    successorShape,
    partitionAdjustments,
};
