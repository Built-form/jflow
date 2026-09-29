'use strict';

// A schedule's virtual instances (CONTRACT §3.4, §5.5, §6.9). Instances are never stored:
// they are the schedule's natural dates, each with its override row when one exists.
// Pure: no DB, no clock; the route and services read the rows and pass `today` in.
//
//   buildInstance(schedule, naturalDate, override, payments)  the §6.9 instance JSON
//                                                             (derivedStatus is added
//                                                             by the caller, lib/lines.js)
//   expandInstances(schedule, overrides, from, to)            natural dates in a window,
//                                                             with ORPHAN_OVERRIDE warnings
//   hasOccurrenceOnOrAfter(schedule, overrides, today)        D17: still generates a date
//   owedCandidateDates(schedule, overrides, today)            D17: the instances that can
//                                                             be owed at all
//
// `schedule` is the schedule JSON (lib/shape.js scheduleToJson), `override` the override
// JSON (overrideToJson) or null, payments the payment JSON rows (paymentToJson).

const { addDays } = require('./dates');
const { buildSchedKey } = require('./keys');
const { parseMinor, formatMinor } = require('./money');
const { occurrences, isOccurrence, nextOccurrenceAfter, weekendAdjust, effectiveValues } = require('./recurrence');

/**
 * §8 rule 5: manual schedules are scanned back to max(start_date, today − 730 days). The
 * D17 guard uses the same bound, so it refuses exactly what /forecast would show.
 */
const OWED_SCAN_DAYS = 730;

/** §6.9's `override` object: the row without its parent ids (the instance carries them). */
function overrideView(o) {
    return {
        id: o.id,
        amount: o.amount,
        dueDate: o.dueDate,
        status: o.status,
        settleMode: o.settleMode,
        paidOn: o.paidOn,
        paidAmount: o.paidAmount,
        note: o.note,
        sourceScenarioId: o.sourceScenarioId,
        rowVersion: o.rowVersion,
        createdBy: o.createdBy,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    };
}

/**
 * One instance (§6.9) without `derivedStatus`: `dueDate`, `amount`, `status` and
 * `settleMode` are the effective values (§3.4, recurrence.effectiveValues);
 * `predictedDueDate` is the date before any tune; `remainingAmount` = effective amount −
 * the override's paid cache. It does not check isOccurrence: callers only build real ones.
 */
function buildInstance(schedule, naturalDate, override = null, payments = []) {
    const v = effectiveValues(schedule, naturalDate, override);
    const amountMinor = parseMinor(v.amount);
    const paidMinor = override && override.paidAmount != null ? parseMinor(override.paidAmount) : 0n;
    return {
        key: buildSchedKey(schedule.id, naturalDate),
        scheduleId: schedule.id,
        naturalDate,
        predictedDueDate: weekendAdjust(naturalDate, schedule.weekendRule),
        dueDate: v.effectiveDate,
        amount: formatMinor(amountMinor),
        remainingAmount: formatMinor(amountMinor - paidMinor),
        currency: schedule.currency,
        direction: schedule.direction,
        status: v.status,
        settleMode: v.settleMode,
        tuned: override !== null,
        override: override ? overrideView(override) : null,
        payments: (payments || []).map((p) => ({
            id: p.id, paidOn: p.paidOn, amount: p.amount, note: p.note, createdBy: p.createdBy, createdAt: p.createdAt,
        })),
    };
}

/**
 * The natural dates in [from, to] (ascending, active_from and the end honoured), each with
 * its override or null, plus one ORPHAN_OVERRIDE warning per override that is not an
 * occurrence (§5.5) — whatever the window: an orphan belongs to no date in any window.
 */
function expandInstances(schedule, overrides, from, to) {
    const byDate = new Map();
    const orphans = [];
    for (const o of overrides) {
        if (isOccurrence(schedule, o.naturalDate)) byDate.set(o.naturalDate, o);
        else orphans.push({ code: 'ORPHAN_OVERRIDE', scheduleId: schedule.id, naturalDate: o.naturalDate, overrideId: o.id });
    }
    const instances = occurrences(schedule, from, to).map((d) => ({ naturalDate: d, override: byDate.get(d) || null }));
    return { instances, orphans };
}

/**
 * D17 liveSchedules: the schedule still generates an instance whose effective date
 * (§3.4) is on or after `today`. An override moving a date forward counts; one moving a
 * date back does not. The weekend rule moves a date by at most two days, so natural
 * dates from today − 2 are walked until one lands on or after today (or the series ends).
 */
function hasOccurrenceOnOrAfter(schedule, overrides, today) {
    const byDate = new Map();
    for (const o of overrides) {
        if (!isOccurrence(schedule, o.naturalDate)) continue;
        byDate.set(o.naturalDate, o);
        if (o.dueDate != null && o.dueDate >= today) return true;
    }
    for (let d = nextOccurrenceAfter(schedule, addDays(today, -3)); d !== null; d = nextOccurrenceAfter(schedule, d)) {
        const o = byDate.get(d);
        const effective = o && o.dueDate != null ? o.dueDate : weekendAdjust(d, schedule.weekendRule);
        if (effective >= today) return true;
    }
    return false;
}

/**
 * D17 owedInstances: the natural dates whose instance can be owed, ascending, for the
 * caller to classify. A manual schedule: every occurrence from today − OWED_SCAN_DAYS to
 * today + 2 (the weekend rule can pull a natural date two days back). Any schedule: every
 * override on a real occurrence (a "Didn't happen" or a part-paid remainder names its
 * instance, whatever its date). Orphans never.
 */
function owedCandidateDates(schedule, overrides, today) {
    const dates = new Set();
    if (schedule.settleMode === 'manual') {
        for (const d of occurrences(schedule, addDays(today, -OWED_SCAN_DAYS), addDays(today, 2))) dates.add(d);
    }
    for (const o of overrides) {
        if (isOccurrence(schedule, o.naturalDate)) dates.add(o.naturalDate);
    }
    return [...dates].sort();
}

module.exports = {
    OWED_SCAN_DAYS,
    buildInstance,
    expandInstances,
    hasOccurrenceOnOrAfter,
    owedCandidateDates,
};
