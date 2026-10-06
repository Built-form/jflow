// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern
'use strict';

// Order-line facts: landed / departed statuses, a line's value, first and
// earliest dates. All in ./model.js; named here by concern.

const {
    LANDED_STATUSES, DEPARTED_STATUSES, READY_NOW_STATUSES, statusOf, isLandedLine, isDepartedLine, lineValueOf, firstDate, minDate,
} = require('./model');

module.exports = {
    LANDED_STATUSES, DEPARTED_STATUSES, READY_NOW_STATUSES, statusOf, isLandedLine, isDepartedLine, lineValueOf, firstDate, minDate,
};
