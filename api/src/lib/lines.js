'use strict';

// Classifier input lines (CONTRACT §9.6): an item or instance in its JSON /
// engine-input shape → the `line` that lib/classify.js takes. Shaping only:
// money DECIMAL strings are parsed to bigint minor units, the effective values
// are read off the row, and nothing is decided here. The table itself lives in
// classify.js alone; every caller (GET /items, the D17 deactivation guard, and
// the engine from step 6) builds its line here and makes ONE classify call.
//
// Pure: no DB, no clock.

const { parseMinor } = require('./money');
const { classify, derivedStatus } = require('./classify');

/**
 * A one-off item → its classify line. `item` is the item JSON (lib/shape.js
 * itemToJson): a one-off's effective date is its `dueDate`, its settle mode its
 * own. `payments` are the item's payment rows ({id, paidOn, amount}); omitted
 * or empty when the caller has none to hand (§8 rule 4 leaves out payments
 * before minA — the remainder uses the cached `paidAmount`, so it is unaffected).
 */
function itemLine(item, payments = item.payments) {
    return {
        status: item.status,
        settleMode: item.settleMode,
        effectiveDate: item.dueDate,
        amountMinor: parseMinor(item.amount),
        paidAmountMinor: item.paidAmount == null ? 0n : parseMinor(item.paidAmount),
        payments: (payments || []).map((p) => ({
            paymentId: p.id,
            paidOn: p.paidOn,
            amountMinor: parseMinor(p.amount),
        })),
    };
}

/**
 * §9.6 / D10: an item's `derivedStatus` against its account's anchor `A` (a
 * date, or null for none — D12) and `today`: the projection of one classify call.
 */
function itemDerivedStatus(item, A, today) {
    return derivedStatus(classify(itemLine(item), A, today));
}

module.exports = { itemLine, itemDerivedStatus };
