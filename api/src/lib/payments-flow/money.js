// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// Cent rounding, tolerances and the derivation working. The TS's float money
// arithmetic, untouched — all in ./model.js; named here by concern.

const { EPS, MIN_DERIVED, money, fmt2, working } = require('./model');

module.exports = {
    EPS, MIN_DERIVED, money, fmt2, working,
};
