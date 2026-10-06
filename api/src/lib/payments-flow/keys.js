// Copied from ShipLine src/components/payments/paymentReviews.ts @ 77577a1 — changes: TS → CommonJS, types stripped; only the key builders the payments model imports (depositKey, balanceKey, itemKey) plus qcInvoiceKey; the sign-off logic (REQUIRED_SIGN_OFFS, keyOfItem, reviews, assignees) is the page's and is not here
'use strict';

// The keys ShipLine's Payments flow page files a payment under — sign-offs,
// assignees and due dates set by hand all hang on them (shipping tables
// payment_reviews, payment_assignees, payment_due_dates):
//   deposit:<purchase order id>                     the PO's deposit payment
//   balance:<currency>:<CONTAINER>|<supplier key>   a supplier's balance in one container
//   qc:<document id>                                the QC units one QC invoice bills
//   item:<row id>                                   one row of a payment
// The model (./model.js, the TS at the same commit) imports the first three.

const depositKey = (poId) => `deposit:${poId}`;

function balanceKey(currency, containerNumber, supplier) {
    const ref = (containerNumber ?? '').trim().toUpperCase() || '-';
    const sup = supplier.trim().toLowerCase().replace(/\s+/g, ' ');
    return `balance:${currency.trim().toUpperCase()}:${ref}|${sup}`;
}

const qcInvoiceKey = (documentId) => `qc:${documentId}`;

const itemKey = (itemId) => `item:${itemId}`;

module.exports = { depositKey, balanceKey, qcInvoiceKey, itemKey };
