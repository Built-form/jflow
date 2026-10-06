// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// summarizePo — one PO's payments: deposit, balance per container group,
// QC units, top-ups and charges, with blockers and flags. In ./model.js.

const { summarizePo } = require('./model');

module.exports = {
    summarizePo,
};
