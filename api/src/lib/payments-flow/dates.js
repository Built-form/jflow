// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js (the whole TS, transpiled), kept so the port reads by concern; dateOfInstant is pinned to Europe/London there
'use strict';

// Calendar math on 'YYYY-MM-DD' strings: epoch-day arithmetic, never
// new Date(string) for a calendar date. The functions live in ./model.js
// (one transpiled copy of the TS); this module names the ones about dates.
// Deliberate difference from the TS, applied in model.js: dateOfInstant is
// pinned to Europe/London, so the server gives the page's answer.

const { dateOf, dateOfInstant, addDays, diffDays, addMonths } = require('./model');

module.exports = {
    dateOf, dateOfInstant, addDays, diffDays, addMonths,
};
