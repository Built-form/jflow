// Ported from ShipLine src/components/shared/containerHelpers.ts @ 77577a1 (unchanged since f9499bc: 340 lines, same sha256 — the oracle checks it) — changes: TS → CommonJS, types stripped; the model's runtime import for live-tracking lookup and internal container numbers
'use strict';

// Container helpers the model imports from ShipLine's
// src/components/shared/containerHelpers.ts (same commit): the live-tracking
// lookup and the internal container number parser.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

/** @typedef {import('./types').Order} Order */
/** @typedef {import('./types').Container} Container */

/**
 * Lookup container live-tracking data for a given order. The API joins on
 * `Order.externalContainerNumber` → `Container.containerNumber`. We also
 * fall back to `Order.containerNumber` for orders that pre-date the new field.

 *  @param {Pick<Order, 'externalContainerNumber'|'containerNumber'>} order
 *  @param {Map<string, Container>|null|undefined} index
 *  @returns {Container|undefined} */
function getContainerForOrder(order, index) {
    if (!index)
        return undefined;
    const ext = order.externalContainerNumber?.trim();
    if (ext) {
        const hit = index.get(ext) || index.get(ext.toUpperCase());
        if (hit)
            return hit;
    }
    const internal = order.containerNumber?.trim();
    if (internal) {
        return index.get(internal) || index.get(internal.toUpperCase());
    }
    return undefined;
}

const AIR_INTERNAL_RE = /^(\d+)\s*\.\s*air\s*freight$/i;
const SEA_INTERNAL_RE = /^(\d+)$/;

/** Collapse whitespace so "104 . Air  Freight" reads the same as "104. Air Freight". */
function tidyContainerNumber(raw) {
    return (raw ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Read the sequence number out of an internal container number, or null for
 * anything that isn't one (draft names, legacy free text, blanks).

 *  @param {string|null|undefined} raw
 *  @returns {{ freight: 'SEA'|'AIR', seq: number }|null} */
function parseInternalContainerNumber(raw) {
    const v = tidyContainerNumber(raw);
    if (!v)
        return null;
    const air = v.match(AIR_INTERNAL_RE);
    if (air)
        return { freight: 'AIR', seq: parseInt(air[1], 10) };
    const sea = v.match(SEA_INTERNAL_RE);
    if (sea)
        return { freight: 'SEA', seq: parseInt(sea[1], 10) };
    return null;
}

/** The stored form for a sequence number: "268" (sea) / "104. Air Freight" (air). */

module.exports = {
    getContainerForOrder, parseInternalContainerNumber,
};
