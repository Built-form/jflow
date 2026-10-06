// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London; buildPaymentsFlow(input, {claims: true}) also returns balanceClaims (JFlow feed; without the option the output is the TS's); new, not in the TS: re-exports ids.js (feed ids) and forecast.js (feed rows); overrides.js (due dates set by hand, from the TS @ 6565188, ahead of the re-pin) re-exported too
'use strict';

// Payments-flow model — "what money leaves the account, to whom, when" for
// stock purchase orders. A CommonJS port of ShipLine's
// src/components/payments/paymentsFlowMath.ts at commit f9499bc (JFlow PHASE2
// P1 as amended: the math is ported into this API, api/src/lib/payments-flow/,
// and re-synced with the oracle when ShipLine's math changes). Pure: no
// database, no network, no clock.
//
// Identical to the TS (proved by api/test/unit/payments-flow-golden.test.js
// against the frozen TS itself, whose output api/tools/payments-flow-oracle.mjs
// records) except, deliberately:
//   1. buildPaymentsFlow requires input.today — no localTodayYmd() fallback.
//   2. dateOfInstant is pinned to Europe/London, not the host's zone.
//   3. buildPaymentsFlow(input, { claims: true }) also returns balanceClaims
//      (step 18, for the JFlow feed); without the option nothing changes.
// ids.js (feed ids, PHASE2 §3 P2) and forecast.js (the JFlow feed rows) are
// new; they read the model's output and add nothing to it.
//
// Modules, in dependency order:
//   dates       calendar math (dateOf, dateOfInstant, addDays)
//   containers  ShipLine containerHelpers: live-tracking lookup, internal numbers
//   lines       order-line facts (LANDED_STATUSES, value, dates)
//   money       cent rounding, tolerances, the derivation working
//   terms       free-text payment terms parser and source precedence
//   suppliers   PO supplier name → JFPRO record (tags: shipsline-legacy)
//   policy      company payment rules (default + supplier)
//   due         event chain, freight mode, balance and deposit due dates
//   po          summarizePo — one PO's payments
//   overrides   due dates set by hand (keys, applyDueOverrides) — TS @ 6565188
//   flow        buildPaymentsFlow — all POs, claims, set dates, owed air, rollups
//   ids         feed ids
//   forecast    JFlow feed rows: open items + payments made, split per PO
//   types       JSDoc types only
// Not ported (display-only or not called by the model; they stay in
// ShipLine): diffDays, weekMonday, isoWeek, fmtYmd, bucketize,
// describePolicy, depositPctForSupplier, suggestAirBalance, compareInvoiceToOwed.

const { dateOf, dateOfInstant, addDays } = require('./dates');
const { LANDED_STATUSES } = require('./lines');
const { describeRule, parsePaymentTerms, resolveTermsRule } = require('./terms');
const { indexSuppliersByName, isLegacySupplier, matchSupplier } = require('./suppliers');
const { AIR_LIMIT_DEFAULT_DAYS, EMPTY_PAYMENT_RULE_ESTIMATES, resolvePolicy, canonicalizeRules } = require('./policy');
const { buildPoChain, freightModeOf } = require('./due');
const { summarizePo } = require('./po');
const { CURRENCY_ORDER, buildPaymentsFlow } = require('./flow');
const { depositKey, balanceKey, itemKey, dueOverrideKeys, applyDueOverrides } = require('./overrides');
const { FEED_ID_RE, isFeedId, groupToken, feedId, itemFeedId } = require('./ids');
const {
    TEXT_LIMITS, shipmentIdOf, poDirectory, collectPaidRows, splitCents, formatCents, dueSetOf, toForecastRows,
} = require('./forecast');

module.exports = {
    // model
    buildPaymentsFlow, summarizePo,
    // terms, suppliers, policy
    parsePaymentTerms, resolveTermsRule, describeRule,
    indexSuppliersByName, isLegacySupplier, matchSupplier,
    resolvePolicy, canonicalizeRules, buildPoChain, freightModeOf,
    // dates
    dateOf, dateOfInstant, addDays,
    // constants
    LANDED_STATUSES, CURRENCY_ORDER, AIR_LIMIT_DEFAULT_DAYS, EMPTY_PAYMENT_RULE_ESTIMATES,
    // due dates set by hand
    depositKey, balanceKey, itemKey, dueOverrideKeys, applyDueOverrides,
    // feed ids
    FEED_ID_RE, isFeedId, groupToken, feedId, itemFeedId,
    // JFlow feed
    TEXT_LIMITS, shipmentIdOf, poDirectory, collectPaidRows, splitCents, formatCents, dueSetOf, toForecastRows,
};
