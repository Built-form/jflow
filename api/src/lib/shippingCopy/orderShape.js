// Copied from shipping/src/lib/order-shape.js — changes: rowToOrder trimmed to the fields the payments model (lib/payments-flow) reads, key order kept; ORDER_SELECT moved to services/shippingReads.js (schema-qualified, explicit columns, received_quantity only); parseDates, normalizeExpiry and receiptToJson dropped
'use strict';

// Order-shaping helpers, as GET /api/v1/orders shapes an order before ShipLine's
// api.ts mapOrder sees it (lib/shippingCopy/shiplinePage.js). Pure.
//
// The connection that reads these rows (services/shippingSource.js) uses
// `dateStrings: ['DATE']` and `timezone: 'Z'`, which is how shipping's pool reads
// them on Lambda (DATE → 'YYYY-MM-DD'; DATETIME / TIMESTAMP → a Date in UTC), so
// formatDate / formatDateTime give the strings the deployed API sends.

// MySQL's zero date ('0000-00-00 00:00:00') comes back from mysql2 as a JS
// Date whose time value is NaN, and toISOString() on one throws RangeError —
// which, from inside a .map() over the result set, fails the WHOLE request. A
// single unrepresentable cell in one row 500s every order in the list, so these
// helpers report an unusable date as "no date" rather than throwing.
function isUnrepresentableDate(val) {
    return val instanceof Date && Number.isNaN(val.getTime());
}

function formatDate(val) {
    if (!val || isUnrepresentableDate(val)) return null;
    return val.toISOString?.().slice(0, 10) ?? val;
}

// Like formatDate but preserves the time component — for DATETIME columns
// (e.g. delivery_date) where the client needs the wall-clock time, not just
// the calendar day. Returns a full ISO string for Date inputs, passes strings
// through untouched.
function formatDateTime(val) {
    if (!val || isUnrepresentableDate(val)) return null;
    return val.toISOString?.() ?? val;
}

function rowToOrder(row) {
    const quantity = Number(row.quantity || 0);
    const receivedQuantity = Number(row.received_quantity || 0);
    return {
        id: row.id,
        quantity,
        receivedQuantity,
        status: row.status,
        poNumber: row.po_number || null,
        supplier: row.supplier || null,
        containerNumber: row.container_number || null,
        eta: formatDate(row.eta),
        poDate: formatDate(row.po_date),
        deliveryDate: formatDateTime(row.delivery_date),
        arrivedDate: formatDate(row.arrived_date),
        externalContainerNumber: row.external_container_number || null,
        awbNumber: row.awb_number || null,
        purchaseOrderId: row.purchase_order_id ?? null,
        unitPrice: row.unit_price != null ? Number(row.unit_price) : null,
        estimatedDepartureDate: formatDate(row.estimated_departure_date),
        shippedDate: formatDate(row.shipped_date),
        orderedDate: formatDate(row.ordered_date),
        estimatedReadyDate: formatDate(row.estimated_ready_date),
        artworkConfirmedDate: formatDate(row.artwork_confirmed_date),
        shipmentId: row.shipment_id ?? null,
    };
}

module.exports = {
    formatDate,
    formatDateTime,
    rowToOrder,
};
