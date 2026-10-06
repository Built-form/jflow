// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// Due dates: the PO event chain, the freight mode, a container group's balance
// due date (booked, in a draft or plan, or from today) and the deposit's under
// policy. All in ./model.js; named here by concern.

const { buildPoChain, freightModeOf, deriveGroupDue, applyDepositPolicy, indexOpenContainers, unbookedParts } = require('./model');

module.exports = {
    buildPoChain, freightModeOf, deriveGroupDue, applyDepositPolicy, indexOpenContainers, unbookedParts,
};
