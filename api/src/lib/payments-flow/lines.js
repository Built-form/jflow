// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Order-line facts: landed / departed by status, line value, first and
// earliest dates. LANDED_STATUSES is the set shipping's
// src/lib/delivered-air.js also uses; JFlow has no delivered-air.js.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (frozen until the JFlow PHASE2 step 17 cut-over): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

const { dateOf } = require('./dates');

/** @typedef {import('./types').Order} Order */
/** @typedef {import('./types').Ymd} Ymd */

// Server-side statuses such as PARTIALLY_RECEIVED pass through api.ts untouched,
// so compare on the raw string rather than the OrderStatus union.
const LANDED_STATUSES = new Set(['ARRIVED_AT_WAREHOUSE', 'RECEIVED', 'PARTIALLY_RECEIVED', 'IN_WAREHOUSE', 'MINTSOFT']);
const DEPARTED_STATUSES = new Set(['ON_SEA', 'ON_AIR']);

/**
 *  @param {Order} o
 *  @returns {string}
 */
const statusOf = (o) => String(o.status ?? '').toUpperCase();

/**
 *  @param {Order} o
 *  @returns {boolean}
 */
const isLandedLine = (o) => LANDED_STATUSES.has(statusOf(o)) || (o.receivedQuantity ?? 0) > 0;

/** Shipped by status, or by a recorded shipped date when the status lags behind it.
 *  @param {Order} o
 *  @returns {boolean} */
const isDepartedLine = (o) => DEPARTED_STATUSES.has(statusOf(o)) || isLandedLine(o) || dateOf(o.shippedDate) != null;

/**
 *  @param {Order} o
 *  @returns {number|null}  quantity × unit price; null when unpriced
 */
function lineValueOf(o) {
    return o.unitPrice != null && o.unitPrice > 0 ? o.unitPrice * (o.quantity || 0) : null;
}

/**
 *  @param {Order[]} lines
 *  @param {keyof Order} field
 *  @returns {Ymd|null}  the first line that has that date
 */
function firstDate(lines, field) {
    for (const l of lines) {
        const d = dateOf(l[field]);
        if (d)
            return d;
    }
    return null;
}

/**
 *  @param {Order[]} lines
 *  @param {keyof Order} field
 *  @returns {Ymd|null}  the earliest
 */
function minDate(lines, field) {
    let best = null;
    for (const l of lines) {
        const d = dateOf(l[field]);
        if (d && (!best || d < best))
            best = d;
    }
    return best;
}

module.exports = {
    LANDED_STATUSES, DEPARTED_STATUSES, statusOf, isLandedLine, isDepartedLine, lineValueOf, firstDate, minDate,
};
