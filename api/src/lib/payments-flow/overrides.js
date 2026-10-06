// Ported from ShipLine src/components/payments/paymentsFlowMath.ts (applyDueOverrides, dueOverrideKeys, DERIVED_DATE_FLAGS) and src/components/payments/paymentReviews.ts (depositKey, balanceKey, itemKey) @ 77577a1 — changes: since the 2026-10-06 re-pin a re-export of ./model.js and ./keys.js, kept for the tests and readers that found the feature here first
'use strict';

// Due dates set by hand (ShipLine, 2026-10-06). On the Payments flow page a
// person can give a payment, or one row of it, a date in place of the derived
// one; the date lives in shipping's `payment_due_dates` table under a key the
// page builds (./keys.js). JFlow reads the table (services/shippingReads.js)
// and hands the rows to buildPaymentsFlow as input.dueOverrides; the model
// (./model.js) replaces the derived date on the matching rows before the
// owed-air pass, keeping the derived date beside it as PaymentItem.dueOverride
// and swapping the derived-date flags for `due_set`. Without rows nothing
// changes.

const { depositKey, balanceKey, itemKey } = require('./keys');
const { dueOverrideKeys, DERIVED_DATE_FLAGS, applyDueOverrides } = require('./model');

module.exports = { depositKey, balanceKey, itemKey, dueOverrideKeys, DERIVED_DATE_FLAGS, applyDueOverrides };
