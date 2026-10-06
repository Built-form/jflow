// Ported from ShipLine src/components/payments/paymentsFlowMath.ts (applyDueOverrides, dueOverrideKeys, DERIVED_DATE_FLAGS) and src/components/payments/paymentReviews.ts (depositKey, balanceKey, itemKey) @ 6565188 — changes: TS → CommonJS, types stripped; ported AHEAD of the full re-pin of this folder (still f9499bc elsewhere) for the handover doc's "Dates set by hand" (2026-10-06); the rest of the TS at 6565188 (extras, QC units, drafts) is not here
'use strict';

// Due dates set by hand (ShipLine, 2026-10-06). On the Payments flow page a person
// can give a payment, or one row of it, a date in place of the derived one; the
// date lives in shipping's `payment_due_dates` table under a key the page builds:
//   deposit:<purchase order id>                     the PO's deposit payment
//   balance:<currency>:<CONTAINER>|<supplier key>   a supplier's balance in one container
//   item:<row id>                                   ONE row of a payment; beats the payment's
// JFlow reads the table (services/shippingReads.js), hands the rows to
// buildPaymentsFlow as input.dueOverrides, and the set date replaces the derived
// one on the matching rows here — before the owed-air pass, as the TS does — so
// everything downstream (kpis, the feed rows) sees it. Without rows nothing
// changes, which keeps the golden suite (f9499bc) exact.

const { dateOf } = require('./dates');

/** @typedef {import('./types').PaymentItem} PaymentItem */
/** @typedef {import('./types').PaymentDueDate} PaymentDueDate */
/** @typedef {import('./types').PaymentFlag} PaymentFlag */

// ── paymentReviews.ts: the keys a payment is filed under ────────────────

const depositKey = (poId) => `deposit:${poId}`;

function balanceKey(currency, containerNumber, supplier) {
    const ref = (containerNumber ?? '').trim().toUpperCase() || '-';
    const sup = supplier.trim().toLowerCase().replace(/\s+/g, ' ');
    return `balance:${currency.trim().toUpperCase()}:${ref}|${sup}`;
}

const itemKey = (itemId) => `item:${itemId}`;

// ── paymentsFlowMath.ts ─────────────────────────────────────────────────

/**
 * The keys a row's date can be set under: its own row key — a PO's unbooked
 * goods share one, whichever draft or plan parts of them sit in — and, when
 * the row can be paid, its payment's (every row of the payment at once).
 * @param {Pick<PaymentItem, 'id'|'kind'|'blocked'|'poId'|'currency'|'containerNumber'|'supplier'>} it
 * @returns {{ item: string, payment: string|null }}
 */
function dueOverrideKeys(it) {
    const item = itemKey(it.id.replace(/@.*$/, ''));
    if (it.blocked) return { item, payment: null };
    return { item, payment: it.kind === 'deposit' ? depositKey(it.poId) : balanceKey(it.currency, it.containerNumber, it.supplier ?? '(no supplier)') };
}

// What a derived date carried that a date set by hand does not: it is neither
// an estimate nor slipped, and grace is not added on top of it.
/** @type {Set<PaymentFlag>} */
const DERIVED_DATE_FLAGS = new Set(['estimated', 'estimate_passed', 'grace_applied', 'landed_fallback', 'departed_no_date', 'from_today']);

/**
 * Give each row the date set by hand for it — its own row's first, else its
 * payment's — keeping the derived date beside it. Payability is untouched.
 * @param {PaymentItem[]} items
 * @param {Map<string, PaymentDueDate>} byKey
 */
function applyDueOverrides(items, byKey) {
    if (!byKey.size) return;
    for (const it of items) {
        const keys = dueOverrideKeys(it);
        const hit = byKey.get(keys.item) ?? (keys.payment ? byKey.get(keys.payment) : undefined);
        const date = hit ? dateOf(hit.dueDate) : null;
        if (!hit || !date) continue;
        it.dueOverride = {
            id: hit.id, key: hit.key, scope: hit.key.startsWith('item:') ? 'item' : 'payment', dueDate: date, derivedDueDate: it.dueDate,
            setByEmail: hit.setByEmail, setByName: hit.setByName ?? null, setAt: hit.setAt, note: hit.note ?? null,
        };
        it.dueDate = date;
        it.contractualDate = date;
        it.flags = [...it.flags.filter(f => !DERIVED_DATE_FLAGS.has(f)), 'due_set'];
    }
}

module.exports = { depositKey, balanceKey, itemKey, dueOverrideKeys, DERIVED_DATE_FLAGS, applyDueOverrides };
