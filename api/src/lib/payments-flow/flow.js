// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled); there: today required, and buildPaymentsFlow(input, {claims: true}) also returns balanceClaims (JFlow feed; without the option the output is the TS's)
'use strict';

// Whole-model assembly: buildPaymentsFlow. Resolves balance invoices into
// per-PO claims, applies due dates set by hand, runs every PO, dates owed
// air freight, places extras, QC units and credits, and rolls up per
// currency. In ./model.js, with the port's two deliberate differences:
// today is required, and options.claims adds `balanceClaims`, the per-PO
// claims every balance record resolved to, which the JFlow feed splits paid
// balances by (api/test/unit/payments-flow-golden.test.js proves the rest
// identical to the TS).

const { CURRENCY_ORDER, buildPaymentsFlow } = require('./model');

module.exports = {
    CURRENCY_ORDER, buildPaymentsFlow,
};
