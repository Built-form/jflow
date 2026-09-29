'use strict';

// The §9.5 stale check for the scenario routes (CONTRACT §10.7 adjustment write, §10.8
// rebase, §10.9 apply), on services/forecastLoad.js loadTarget's result. Pure.
//
// The comparison itself is lib/engine.js `staleReason` — ONE definition, shared with the
// engine's /forecast run — in §9.5's order: TARGET_MISSING (no target), TARGET_SETTLED
// (status ≠ expected, or the override carries payment state), BASE_CHANGED (effective date
// ≠ base_date as strings, or effective amount ≠ base_amount as parsed minor units — D11),
// DATE_PASSED (an `adjust` whose new_date < today — D38). This file only adapts
// loadTarget's shape onto the engine's target record and names the two questions the
// routes ask.

const { parseMinor } = require('./money');
const { staleReason } = require('./engine');

/**
 * loadTarget's `{status, hasPaymentState, effectiveDate, effectiveAmount}` → the engine's
 * target record `{status, hasPaymentState, date, amountMinor}`. null stays null.
 */
function engineTarget(target) {
    if (!target) return null;
    return {
        status: target.status,
        hasPaymentState: Boolean(target.hasPaymentState),
        date: target.effectiveDate,
        amountMinor: parseMinor(target.effectiveAmount),
    };
}

/**
 * Why `adj` (adjustment JSON: kind, newDate, baseDate, baseAmount) is stale against
 * `target` (loadTarget's result, or null) on `today`, or null. Apply's re-check (§10.9
 * step 3) and the scenario read's `stale` field.
 */
function adjustmentStale(adj, target, today) {
    return staleReason(adj, engineTarget(target), today);
}

/**
 * The reason that would remain once the bases were refreshed to the target's current
 * values — the same check with base := current, so BASE_CHANGED cannot come back:
 * TARGET_MISSING, TARGET_SETTLED, DATE_PASSED or null. The adjustment write (§10.7 step 4:
 * its bases are the current values) and rebase (§10.8 step 3: DATE_PASSED is reported
 * even when the base also changed) ask this.
 */
function staleAfterRebase(adj, target, today) {
    if (!target) return 'TARGET_MISSING';
    return adjustmentStale(
        { ...adj, baseDate: target.effectiveDate, baseAmount: target.effectiveAmount }, target, today
    );
}

module.exports = { engineTarget, adjustmentStale, staleAfterRebase };
