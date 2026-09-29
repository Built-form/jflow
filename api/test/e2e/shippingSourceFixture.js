// Copied from shipping/tools/payments-flow-db-fixture.js (phase2-payments-flow export) — changes: the rows only, with real jfa columns, for insert into the shadow schema (test/e2e/shippingShadow.js) instead of a fake connection; a line's received quantity is an order_receipts row; shipments carry no hand-set derived stage (the source's SQL derives it from the member orders); the zero po_date is left out (strict SQL mode refuses it); tables the source does not read are dropped; a draft document with no type is '' (the column is NOT NULL); `created_at` spelled out where the order of rows depends on it
'use strict';

// The scenario (today 2026-09-29, shipping companies 1 JFA / 2 HW):
//   PO 801 (company 1) and PO 802 (company 2), Suzhou Sunmed, share shipment 311
//   (reference '268'); 801 also has lines not booked in ('MSKU1').
//   PO 803 (company 1), Ningbo Hangers: lines landed; a deposit paid by transfer.
//   PO 804 is soft-deleted (its order line stays, its bundle does not).
//   Balance 6001 on '268': paid by hand on 2026-09-20 (no transfer), 1000 named for 801
//   and the 500 rest shared 801:802 by value (2500:1200).
//   Balance 6002 on '268': open, 800 shared, 300 of it paid by transfer 8001.
//   Transfers: 8001 (2026-09-25: 300 on 6002 + 200 on PI 7002 of PO 802),
//   8002 (2026-09-10: deposit on PO 803), 8003 (2026-06-01, PI 7001; before the default
//   paidSince).
//   PO 805 (company 1), Sunmed, alone on shipment 314 (reference '270'), on the water: its
//   balance is dated by the packing list attached to shipment 315, merged into 314.
//   Rules: a default, and Sunmed "balance when a packing list is attached", so the
//   documents of shipments 311 and 314 (and of 309 and 315, merged into them) are read.

const TODAY = '2026-09-29';
const d = (iso) => new Date(iso);

function sourceTables() {
    return {
        companies: [
            { id: 1, name: 'JFA Medical Ltd', address_lines: '["1 High St"]', country: 'GB' },
            { id: 2, name: 'Hangerworld Ltd', address_lines: null, country: 'GB' },
        ],
        suppliers: [
            { id: 12, name: 'Ningbo Hangers Ltd', paymentTerms: '30D/70B BOL', is_deleted: 0 },
            { id: 11, name: 'Suzhou Sunmed Co., Ltd.', paymentTerms: '30% deposit, 70% before shipment', is_deleted: 0 },
            { id: 13, name: 'Gone Supplier', paymentTerms: '100D', is_deleted: 1 },
            { id: 14, name: 'Blank Terms Co', paymentTerms: '', is_deleted: 0 },
        ],
        purchase_orders: [
            { id: 801, po_number: 'PO-801', supplier: 'Suzhou Sunmed Co., Ltd.', currency: 'USD', shipping_total: '0.00', company_id: 1, created_at: d('2026-07-01T09:00:00Z'), deleted_at: null },
            { id: 802, po_number: 'PO-802', supplier: 'Suzhou Sunmed Co., Ltd.', currency: 'USD', shipping_total: '120.00', company_id: 2, created_at: d('2026-07-02T09:00:00Z'), deleted_at: null },
            { id: 803, po_number: 'PO-803', supplier: 'Ningbo Hangers Ltd', currency: 'usd', shipping_total: null, company_id: 1, created_at: d('2026-05-02T09:00:00Z'), deleted_at: null },
            { id: 805, po_number: 'PO-805', supplier: 'Suzhou Sunmed Co., Ltd.', currency: 'USD', shipping_total: '0.00', company_id: 1, created_at: d('2026-07-04T09:00:00Z'), deleted_at: null },
            { id: 804, po_number: 'PO-804', supplier: 'Suzhou Sunmed Co., Ltd.', currency: 'USD', shipping_total: '0.00', company_id: 1, created_at: d('2026-07-03T09:00:00Z'), deleted_at: d('2026-08-01T09:00:00Z') },
        ],
        orders: [
            order({ id: 5001, purchase_order_id: 801, po_number: 'PO-801', container_number: '268', external_container_number: 'MSCU1234567', status: 'ON_SEA', quantity: 1000, unit_price: '2.5000', po_date: '2026-07-01', shipped_date: '2026-09-01', eta: '2026-10-10', shipment_id: 311, created_at: d('2026-07-01T10:00:00Z') }),
            order({ id: 5002, purchase_order_id: 801, po_number: 'PO-801', container_number: 'MSKU1', status: 'IN_PRODUCTION', quantity: 200, unit_price: '2.5000', created_at: d('2026-07-01T10:01:00Z') }),
            order({ id: 5003, purchase_order_id: 802, po_number: 'PO-802', container_number: '268', status: 'READY', quantity: 400, unit_price: '3.0000', po_date: '2026-07-02', shipment_id: 311, created_at: d('2026-07-02T10:00:00Z') }),
            order({ id: 5004, purchase_order_id: 804, po_number: 'PO-804', container_number: null, status: 'PO_SENT', quantity: 10, unit_price: '1.0000', created_at: d('2026-07-03T10:00:00Z') }),
            order({ id: 5007, purchase_order_id: 805, po_number: 'PO-805', container_number: '270', status: 'ON_SEA', quantity: 100, unit_price: '5.0000', po_date: '2026-07-04', shipment_id: 314, created_at: d('2026-07-04T10:00:00Z') }),
            order({ id: 5005, purchase_order_id: 803, po_number: 'PO-803', supplier: 'Ningbo Hangers Ltd', container_number: '240', status: 'RECEIVED', quantity: 300, unit_price: '4.0000', po_date: '2026-05-02', delivery_date: d('2026-08-20T14:30:00Z'), arrived_date: '2026-08-19', shipment_id: 312, created_at: d('2026-05-02T10:00:00Z') }),
        ],
        order_receipts: [
            { id: 1, order_id: 5005, type: 'received', quantity: 300, received_at: d('2026-08-20T15:00:00Z') },
        ],
        purchase_order_invoices: [
            { id: 9001, purchase_order_id: 801, filename: 'PI-801.pdf', s3_key: 'inv/9001.pdf', uploaded_at: d('2026-07-05T09:00:00Z'), deleted_at: null },
            { id: 9002, purchase_order_id: 802, filename: 'PI-802.pdf', s3_key: 'inv/9002.pdf', uploaded_at: d('2026-07-06T09:00:00Z'), deleted_at: null },
        ],
        purchase_order_invoice_payments: [
            invoicePayment({ id: 7001, purchase_order_invoice_id: 9001, purchase_order_id: 801, payment_type: 'deposit', amount_due: '750.00', deposit_percentage: '30.000', invoice_total: '2500.00', payment_status: 'paid', updated_at: d('2026-07-10T09:00:00Z') }),
            invoicePayment({ id: 7002, purchase_order_invoice_id: 9002, purchase_order_id: 802, payment_type: 'deposit', amount_due: '360.00', deposit_percentage: '30.000', invoice_total: null, due_date: '2026-08-01', payment_status: 'pending', raw_terms_text: '30% deposit, 70% before shipment' }),
        ],
        purchase_order_signed_pis: [
            { id: 71, purchase_order_id: 801, filename: 'PI-801-signed.pdf', s3_key: 'spi/71.pdf', uploaded_at: d('2026-07-06T09:00:00Z'), deleted_at: null },
        ],
        purchase_order_payments: [
            { id: 81, purchase_order_id: 802, filename: 'swift.pdf', s3_key: 'pay/81.pdf', uploaded_at: d('2026-07-20T09:00:00Z'), deleted_at: null },
        ],
        containers: [
            { container_number: 'MSCU1234567', bl_number: 'BL-1', departure_date: d('2026-09-02T02:00:00Z'), departure_is_actual: 1, arrival_date: d('2026-10-12T08:00:00Z'), arrival_is_actual: 0, eta: d('2026-10-12T08:00:00Z'), ata: null },
        ],
        payment_rules: [
            { id: 1, scope: 'default', supplier_name: '', supplier_label: null, deposit_pct: null, deposit_trigger: null, deposit_grace_days: 0, balance_trigger: null, balance_document_type: null, balance_offset_days: null, balance_grace_days: 2, deposit_offset_days: null, estimates_json: JSON.stringify({ transit: { sea: 35 } }), air_owed_from: '2026-09-01', air_limit_days: 30 },
            { id: 2, scope: 'supplier', supplier_name: 'suzhou sunmed co., ltd.', supplier_label: 'Suzhou Sunmed Co., Ltd.', deposit_pct: null, deposit_trigger: null, deposit_grace_days: 0, balance_trigger: 'container_document', balance_document_type: 'packing_list', balance_offset_days: 3, balance_grace_days: 0, deposit_offset_days: null, estimates_json: null, air_owed_from: null, air_limit_days: null },
        ],
        shipments: [
            shipment({ id: 311, reference: '268', stage: 'BOOKED', mode: 'SEA', bl_number: 'BL-1', departed_at: d('2026-09-01T23:30:00Z'), booked_at: d('2026-08-25T09:00:00Z') }),
            shipment({ id: 312, reference: '240', stage: 'CLOSED', mode: 'SEA', departed_at: d('2026-07-01T10:00:00Z'), arrived_at: d('2026-08-19T10:00:00Z'), ata: '2026-08-18', booked_at: d('2026-06-20T09:00:00Z') }),
            shipment({ id: 309, reference: 'OLD-268', stage: 'BOOKED', mode: 'SEA', merged_into_id: 311, booked_at: d('2026-08-01T09:00:00Z') }),
            shipment({ id: 314, reference: '270', stage: 'BOOKED', mode: 'SEA', booked_at: d('2026-08-26T09:00:00Z') }),
            shipment({ id: 315, reference: 'OLD-270', stage: 'BOOKED', mode: 'SEA', merged_into_id: 314, booked_at: d('2026-08-02T09:00:00Z') }),
            shipment({ id: 313, reference: 'DRAFT-SEA-1', stage: 'DRAFT', mode: 'SEA', created_at: d('2026-09-10T09:00:00Z') }),
        ],
        draft_container_documents: [
            { id: 91, draft_container_name: '268', version: 1, s3_key: 'dcd/91.pdf', shipment_id: 311, type: 'packing_list', generated_at: d('2026-09-15T23:30:00Z'), deleted_at: null },
            { id: 92, draft_container_name: 'OLD-268', version: 1, s3_key: 'dcd/92.pdf', shipment_id: 309, type: '', generated_at: d('2026-08-02T09:00:00Z'), deleted_at: null },
            { id: 94, draft_container_name: 'OLD-270', version: 1, s3_key: 'dcd/94.pdf', shipment_id: 315, type: 'packing_list', generated_at: d('2026-09-15T23:30:00Z'), deleted_at: null },
            { id: 93, draft_container_name: '268', version: 2, s3_key: 'dcd/93.pdf', shipment_id: 311, type: 'invoice', generated_at: d('2026-09-16T09:00:00Z'), deleted_at: d('2026-09-17T09:00:00Z') },
        ],
        quality_assurance_documents: [
            { id: 95, version: 1, order_ids: '[5001]', order_ids_key: '5001', s3_key: 'qa/95.pdf', shipment_id: 311, generated_at: d('2026-09-12T09:00:00Z'), deleted_at: null },
        ],
        shipment_payments: [
            record({ id: 6001, amount: '1500.00', status: 'paid', paid_on: '2026-09-20', invoice_number: 'INV-6001' }),
            record({ id: 6002, amount: '800.00', status: 'pending', paid_on: null, invoice_number: 'INV-6002' }),
        ],
        shipment_payment_allocations: [
            { id: 1, payment_id: 6001, purchase_order_id: 801, po_ref: 'PO-801', amount: '1000.00', source: 'manual' },
        ],
        supplier_payments: [
            transfer({ id: 8001, supplier_name: 'Suzhou Sunmed Co., Ltd.', amount: '500.00', paid_on: '2026-09-25', bank_ref: 'TT-1' }),
            transfer({ id: 8002, supplier_name: 'Ningbo Hangers Ltd', amount: '900.00', paid_on: '2026-09-10' }),
            transfer({ id: 8003, supplier_name: 'Suzhou Sunmed Co., Ltd.', amount: '750.00', paid_on: '2026-06-01' }),
        ],
        supplier_payment_lines: [
            { id: 1, payment_id: 8001, target_kind: 'balance', target_id: 6002, amount: '300.00' },
            { id: 2, payment_id: 8001, target_kind: 'pi', target_id: 7002, amount: '200.00' },
            { id: 3, payment_id: 8002, target_kind: 'po_deposit', target_id: 803, amount: '900.00' },
            { id: 4, payment_id: 8003, target_kind: 'pi', target_id: 7001, amount: '750.00' },
        ],
    };
}

function order(o) {
    return {
        jf_code: `JF${o.id}`, product_name: `Item ${o.id}`, status: 'PO_SENT', supplier: 'Suzhou Sunmed Co., Ltd.',
        deleted_at: null,
        ...o,
    };
}

function invoicePayment(p) {
    return {
        currency: 'USD', deposit_percentage: null, invoice_total: null, due_date: null, due_terms: null,
        raw_terms_text: null, settled_by_payment_id: null,
        created_at: d('2026-07-05T09:02:00Z'), updated_at: d('2026-07-05T09:02:00Z'),
        ...p,
    };
}

function shipment(s) {
    return {
        mode_source: 'reference', needs_review: 0, origin: 'legacy_route', merged_into_id: null,
        created_at: d('2026-08-01T09:00:00Z'), deleted_at: null,
        ...s,
    };
}

function record(r) {
    return {
        shipment_id: 311, shipment_reference: '268', supplier_name: 'Suzhou Sunmed Co., Ltd.', supplier_key: 'suzhou sunmed',
        kind: 'balance', currency: 'USD', invoice_date: '2026-09-15', source: 'manual', settled_by_payment_id: null,
        deleted_at: null,
        ...r,
    };
}

function transfer(t) {
    return {
        supplier_key: String(t.supplier_name).toLowerCase(), currency: 'USD', source: 'manual', deleted_at: null,
        ...t,
    };
}

module.exports = { TODAY, sourceTables };
