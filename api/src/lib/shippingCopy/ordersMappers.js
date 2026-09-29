// Copied from shipping/src/handlers/orders.js — changes: only the row → JSON mappers the payments feed reads (rowToPurchaseOrder, invoiceRowToJson, signedPiRowToJson, paymentRowToJson, invoicePaymentRowToJson, rowToContainer, shipmentPaymentAllocationRowToJson, shipmentPaymentRowToJson, supplierPaymentLineToJson, supplierPaymentRowToJson), each trimmed to the fields lib/payments-flow and its feed rows read, key order kept; no S3 urls, sends, checks, documents or display totals
'use strict';

// Pure: no DB, no logging. Each function is shipping's, field for field, for the
// fields it keeps (verified against shipping/src/handlers/orders.js on
// 2026-09-29). The loaders that call them are services/shippingReads.js.

// ── Purchase orders and their paperwork (GET /orders purchaseOrders[id]) ──

function rowToPurchaseOrder(row) {
    return {
        id: row.id,
        poNumber: row.po_number,
        supplier: row.supplier || null,
        currency: row.currency || 'USD',
        shippingTotal: row.shipping_total != null ? Number(row.shipping_total) : 0,
        companyId: row.company_id ?? null,
        createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    };
}

function invoiceRowToJson(r) {
    return {
        id: r.id,
        purchaseOrderId: r.purchase_order_id,
        filename: r.filename,
        uploadedAt: r.uploaded_at?.toISOString?.() ?? r.uploaded_at,
    };
}

function signedPiRowToJson(r) {
    return {
        id: r.id,
        purchaseOrderId: r.purchase_order_id,
        uploadedAt: r.uploaded_at?.toISOString?.() ?? r.uploaded_at,
    };
}

// A proof-of-payment file on the PO (no amount).
function paymentRowToJson(r) {
    return {
        id: r.id,
        purchaseOrderId: r.purchase_order_id,
        uploadedAt: r.uploaded_at?.toISOString?.() ?? r.uploaded_at,
    };
}

// ── GET /purchase-order-invoice-payments ────────────────────────────────

function invoicePaymentRowToJson(r) {
    if (!r) return null;
    return {
        id: r.id,
        invoiceId: r.purchase_order_invoice_id,
        purchaseOrderId: r.purchase_order_id,
        paymentType: r.payment_type || null,
        amountDue: r.amount_due != null ? Number(r.amount_due) : null,
        currency: r.currency || null,
        depositPercentage: r.deposit_percentage != null ? Number(r.deposit_percentage) : null,
        invoiceTotal: r.invoice_total != null ? Number(r.invoice_total) : null,
        dueDate: r.due_date || null, // dateStrings:['DATE'] → already 'YYYY-MM-DD'
        dueTerms: r.due_terms || null,
        rawTermsText: r.raw_terms_text || null,
        paymentStatus: r.payment_status,
        updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at,
    };
}

// ── GET /containers (the cached ShipsGo table) ──────────────────────────

// The DATETIME columns stay Date objects here, as in shipping: the JSON round
// trip in shippingReads.loadSources turns them into ISO strings, exactly as
// res.json does for the page.
function rowToContainer(row) {
    return {
        containerNumber: row.container_number,
        times: {
            departure: row.departure_date,
            departureIsActual: row.departure_is_actual === 1,
            arrival: row.arrival_date,
            arrivalIsActual: row.arrival_is_actual === 1,
            eta: row.eta,
            ata: row.ata,
        },
    };
}

// ── GET /shipment-payments (balance records) ────────────────────────────

function shipmentPaymentAllocationRowToJson(r) {
    return {
        id: r.id,
        purchaseOrderId: r.purchase_order_id ?? null,
        poRef: r.po_ref || null,
        poNumber: r.po_number || r.po_ref || null,
        amount: r.amount != null ? Number(r.amount) : 0,
    };
}

function shipmentPaymentRowToJson(r, { allocations = [] } = {}) {
    const amount = r.amount != null ? Number(r.amount) : 0;
    return {
        // Which transfer settled it.
        settledByPaymentId: r.settled_by_payment_id ?? null,
        id: r.id,
        shipmentId: r.shipment_id,
        shipmentReference: r.shipment_reference,
        supplierName: r.supplier_name,
        amount,
        currency: r.currency,
        depositDeducted: r.deposit_deducted != null ? Number(r.deposit_deducted) : null,
        status: r.status,
        paidOn: r.paid_on || null,
        allocations,
    };
}

// ── GET /supplier-payments (transfers) ──────────────────────────────────

function supplierPaymentLineToJson(l, target) {
    return {
        id: l.id,
        kind: l.target_kind,
        targetId: l.target_id,
        amount: Number(l.amount),
        // What the line points at, resolved; null when it has since been deleted.
        shipmentId: target?.shipmentId ?? null,
        shipmentReference: target?.shipmentReference ?? null,
        purchaseOrderId: target?.purchaseOrderId ?? null,
        poNumber: target?.poNumber ?? null,
        paymentType: target?.paymentType ?? null,
    };
}

function supplierPaymentRowToJson(r, { lines = [] } = {}) {
    const amount = Number(r.amount) || 0;
    return {
        id: r.id,
        supplierName: r.supplier_name,
        amount,
        currency: r.currency,
        paidOn: r.paid_on || null,
        lines,
    };
}

module.exports = {
    rowToPurchaseOrder,
    invoiceRowToJson,
    signedPiRowToJson,
    paymentRowToJson,
    invoicePaymentRowToJson,
    rowToContainer,
    shipmentPaymentAllocationRowToJson,
    shipmentPaymentRowToJson,
    supplierPaymentLineToJson,
    supplierPaymentRowToJson,
};
