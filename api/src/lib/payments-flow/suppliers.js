// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// PO supplier name → JFPRO supplier record: name folding, the index, legacy
// tags and the match. All in ./model.js; named here by concern.

const { normName, looseName, indexSuppliersByName, isLegacySupplier, matchSupplier } = require('./model');

module.exports = {
    normName, looseName, indexSuppliersByName, isLegacySupplier, matchSupplier,
};
