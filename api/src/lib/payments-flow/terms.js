// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// Free-text payment terms: the parser, the source precedence (PI terms over
// the supplier's), and a rule in words. All in ./model.js; named here by concern.

const { describeRule, parsePaymentTerms, resolveTermsRule } = require('./model');

module.exports = {
    describeRule, parsePaymentTerms, resolveTermsRule,
};
