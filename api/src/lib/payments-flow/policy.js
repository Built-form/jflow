// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// Company payment rules (default + per-supplier): the empty estimates shape,
// resolution and canonical names. All in ./model.js; named here by concern.

const { AIR_LIMIT_DEFAULT_DAYS, EMPTY_PAYMENT_RULE_ESTIMATES, NO_POLICY, resolvePolicy, canonicalizeRules } = require('./model');

module.exports = {
    AIR_LIMIT_DEFAULT_DAYS, EMPTY_PAYMENT_RULE_ESTIMATES, NO_POLICY, resolvePolicy, canonicalizeRules,
};
