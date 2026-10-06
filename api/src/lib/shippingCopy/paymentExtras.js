// Copied from shipping/src/lib/payment-extras.js (EXTRA_KINDS, EXTRA_LABEL, RIDES_WITH, lineLabel, extraRowToJson) @ 2cd5900 — changes: only what GET /api/v1/payment-extras sends and the payments model reads; `settlements` is always [] (the model never reads them); the write-side rules (parseExtraBody, checkLine, decideEdit…) stay in shipping
'use strict';

// Extra charges and credits (ShipLine, 2026-09-29 → 10-01): money a supplier
// bills that is not goods — mould, handling, samples — or a credit they give;
// a forwarder's cost of the shipment itself (ridesWith 'shipment', paid to its
// own payee); a supplier credit note on account (ridesWith 'account'). One row
// of shipping's `payment_extras` → what the page's api.getPaymentExtras()
// hands buildPaymentsFlow as `paymentExtras`. Pure.

const EXTRA_KINDS = ['mould', 'tooling', 'handling', 'samples', 'testing', 'freight', 'packaging', 'bank_charge', 'discount', 'customs', 'duty', 'delivery', 'credit_note', 'other'];
const EXTRA_LABEL = {
    mould: 'Mould cost', tooling: 'Tooling', handling: 'Handling fee', samples: 'Samples', testing: 'Testing',
    freight: 'Freight', packaging: 'Packaging', bank_charge: 'Bank charge', discount: 'Discount',
    customs: 'Customs clearance', duty: 'Import duty', delivery: 'Delivery', credit_note: 'Credit note', other: 'Other charge',
};
const RIDES_WITH = ['deposit', 'balance', 'shipment', 'account'];

const money = n => Math.round(Number(n) * 100) / 100;
const iso = v => (v == null ? null : v.toISOString ? v.toISOString() : String(v));
const ymd = v => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// "PO_00395J mould cost", "301 handling fee".
function lineLabel(r) {
    const what = EXTRA_LABEL[r.kind] || 'Extra charge';
    const where = r.po_number || r.shipment_reference || null;
    return where ? `${where} ${what.toLowerCase()}` : what;
}

/** @returns {import('../payments-flow/types').PaymentExtra} */
function extraRowToJson(r, { applied = 0, settlements = [] } = {}) {
    const amount = Number(r.amount);
    return {
        id: r.id,
        supplierName: r.supplier_name,
        supplierKey: r.supplier_key,
        currency: r.currency,
        amount,
        kind: r.kind,
        label: lineLabel(r),
        description: r.description || null,
        ridesWith: r.rides_with,
        purchaseOrderId: r.purchase_order_id ?? null,
        poNumber: r.po_number || null,
        shipmentId: r.shipment_id ?? null,
        shipmentReference: r.shipment_reference || null,
        dueDate: ymd(r.due_date),
        sourceKind: r.source_kind || null,
        sourceId: r.source_id ?? null,
        status: r.status,
        paidOn: ymd(r.paid_on),
        settledByPaymentId: r.settled_by_payment_id ?? null,
        applied: money(applied),
        remaining: r.status === 'paid' ? 0 : money(amount - applied),
        note: r.note || null,
        createdByEmail: r.created_by_email,
        createdAt: iso(r.created_at),
        updatedByEmail: r.updated_by_email || null,
        updatedAt: iso(r.updated_at),
        settlements,
    };
}

module.exports = { EXTRA_KINDS, EXTRA_LABEL, RIDES_WITH, lineLabel, extraRowToJson };
