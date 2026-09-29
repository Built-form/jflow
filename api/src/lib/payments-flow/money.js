// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Money: the cent rounding, tolerances and the derivation working that
// records each step as the model computes it.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

/** @typedef {import('./types').DerivationStep} DerivationStep */
/** @typedef {{ set(label: string, value: number, source?: string): Working, minus(label: string, value: number, source?: string): Working, times(label: string, fraction: number, source?: string): Working, percent(label: string, pct: number, source?: string): Working, fork(): Working, figure: number, steps: DerivationStep[] }} Working */

/** Fully-paid / zero tolerance for money comparisons. */
const EPS = 0.01;

/** Derived items below this are rounding dust (a 30% deposit PI rounded to
 *  the cent leaves a few cents of "remainder"), not a payment. */
const MIN_DERIVED = 0.5;

/**
 *  Cent rounding, exactly as the TS: Math.round(n * 100) / 100.
 *  @param {number} n
 *  @returns {number}
 */
const money = (n) => Math.round(n * 100) / 100;

/**
 *  @param {number} n
 *  @returns {string}  "1,234.50"
 */
const fmt2 = (n) => money(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 *  An item's working (PaymentItem.derivation), built next to the arithmetic it
 *  explains. Each step rounds to the cent exactly as that arithmetic does.
 *  @param {DerivationStep[]} [from]
 *  @param {number} [start]
 *  @returns {Working}
 */
function working(from = [], start = 0) {
    const steps = [...from];
    let figure = start;
    const add = (op, label, value, next, source) => {
        figure = money(next);
        steps.push({ op, label, value, result: figure, ...(source ? { source } : {}) });
    };
    const w = {
        set(label, value, source) { add('=', label, money(value), value, source); return w; },
        minus(label, value, source) { add('−', label, money(value), figure - value, source); return w; },
        times(label, fraction, source) { add('×', label, fraction, figure * fraction, source); return w; },
        percent(label, pct, source) { add('×', label, pct / 100, figure * pct / 100, source); return w; },
        fork: () => working(steps, figure),
        get figure() { return figure; },
        get steps() { return [...steps]; },
    };
    return w;
}

module.exports = {
    EPS, MIN_DERIVED, money, fmt2, working,
};
