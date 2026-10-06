// Copied from shipping/src/handlers/orders.js (GET /orders + loadPurchaseOrdersForOrders, GET /containers, GET /purchase-order-invoice-payments, GET /payment-rules, GET /shipment-payments + hydrateShipmentPayments, GET /supplier-payments + hydrateSupplierPayments + loadSupplierPaymentTargets), src/services/shipment-sync.js (shipmentSelect, selectShipments, loadShipmentsForOrders) and src/services/shipment-routes.js (GET /shipments/:id/documents, mergedInto) — changes: every table schema-qualified through `t()` (SHIPPING_DB_SCHEMA); explicit column lists, all named in SOURCE_COLUMNS for the schema check; trimmed to what the payments model and its feed read: no PO documents, sends, invoice checks or company objects, no balance-record documents, link verdicts, applied totals or settlements, no loose proofs, no shipment member aggregates beyond the effective stage and no shipment_lines, the orders' shipment side-map reads only id + reference; loadShipmentsForOrders no longer swallows errors; plus loadCompanies and loadPoDirectory (the feed's companies[] and the POs a payment names with no bundle)
'use strict';

// The reads behind ShipLine's Payments page, run against shipping's own tables
// (docs/PLAN.md "Phase 2": same DB, different schema, read-only). Every query
// here is the route's query for the columns it keeps: same WHERE, same JOINs,
// same ORDER BY, same LIMIT. The rows go through the copied mappers
// (lib/shippingCopy/*) and then one JSON round trip, which is what the page
// receives over HTTP.
//
// `q` is anything with `query(sql, params) → [rows]` (services/shippingSource.js
// wraps the read-only connection with a per-query timeout). `t(name)` returns
// the schema-qualified, backquoted table name. Nothing here writes.

const { rowToOrder } = require('../lib/shippingCopy/orderShape');
const M = require('../lib/shippingCopy/ordersMappers');
const D = require('../lib/shippingCopy/paymentDueDates');
const X = require('../lib/shippingCopy/paymentExtras');
const { paymentRuleRowToJson } = require('../lib/shippingCopy/paymentRules');
const S = require('../lib/shippingCopy/shipments');
const page = require('../lib/shippingCopy/shiplinePage');

/**
 * Every column the queries below touch (select list, WHERE, JOIN, ORDER BY), per
 * table. services/shippingSource.js checks each one exists in SHIPPING_DB_SCHEMA
 * (information_schema.COLUMNS) before any read: a renamed or missing column is
 * `source_schema`, never a silently wrong figure. `suppliers` is a view.
 */
const SOURCE_COLUMNS = Object.freeze({
    orders: ['id', 'status', 'quantity', 'unit_price', 'purchase_order_id', 'po_number', 'supplier', 'container_number',
        'external_container_number', 'awb_number', 'eta', 'po_date', 'ordered_date', 'artwork_confirmed_date',
        'estimated_ready_date', 'shipped_date', 'estimated_departure_date', 'delivery_date', 'arrived_date', 'shipment_id',
        'created_at', 'deleted_at'],
    order_receipts: ['order_id', 'type', 'quantity'],
    purchase_orders: ['id', 'po_number', 'supplier', 'currency', 'shipping_total', 'company_id', 'created_at', 'deleted_at'],
    purchase_order_invoices: ['id', 'purchase_order_id', 'filename', 'uploaded_at', 'deleted_at'],
    purchase_order_signed_pis: ['id', 'purchase_order_id', 'uploaded_at', 'deleted_at'],
    purchase_order_payments: ['id', 'purchase_order_id', 'uploaded_at', 'deleted_at'],
    purchase_order_invoice_payments: ['id', 'purchase_order_invoice_id', 'purchase_order_id', 'payment_type', 'amount_due',
        'currency', 'deposit_percentage', 'invoice_total', 'due_date', 'due_terms', 'raw_terms_text', 'payment_status',
        'updated_at'],
    payment_rules: ['id', 'scope', 'supplier_name', 'supplier_label', 'deposit_pct', 'deposit_trigger', 'deposit_grace_days',
        'balance_trigger', 'balance_document_type', 'balance_offset_days', 'balance_grace_days', 'deposit_offset_days',
        'estimates_json', 'air_owed_from', 'air_limit_days'],
    containers: ['container_number', 'departure_date', 'departure_is_actual', 'arrival_date', 'arrival_is_actual', 'eta', 'ata'],
    shipments: ['id', 'reference', 'stage', 'mode', 'bl_number', 'ata', 'departed_at', 'arrived_at', 'booked_at', 'created_at',
        'merged_into_id', 'deleted_at'],
    shipment_payments: ['id', 'shipment_id', 'shipment_reference', 'supplier_name', 'amount', 'currency', 'deposit_deducted',
        'status', 'paid_on', 'settled_by_payment_id', 'deleted_at'],
    shipment_payment_allocations: ['id', 'payment_id', 'purchase_order_id', 'po_ref', 'amount'],
    supplier_payments: ['id', 'supplier_name', 'amount', 'currency', 'paid_on', 'deleted_at'],
    supplier_payment_lines: ['id', 'payment_id', 'target_kind', 'target_id', 'amount'],
    suppliers: ['id', 'name', 'paymentTerms', 'is_deleted'],
    companies: ['id', 'name'],
    draft_container_documents: ['id', 'shipment_id', 'type', 'generated_at', 'deleted_at'],
    quality_assurance_documents: ['id', 'shipment_id', 'generated_at', 'deleted_at'],
});

/**
 * Tables read only when they are there (handover doc "Dates set by hand", 2026-10-06,
 * its last open question): shipping's `payment_due_dates` reaches a stage with a shipping
 * deploy, so its absence means "no dates set by hand", never `source_schema`; the users
 * table only names who set a date. services/shippingSource.js checkSchema says which
 * are whole, and loadSources reads them accordingly.
 */
const OPTIONAL_COLUMNS = Object.freeze({
    payment_due_dates: ['id', 'target_key', 'due_date', 'note', 'set_by_email', 'updated_at'],
    shipping_allowed_emails: ['email', 'display_name'],
    // The re-pin to ShipLine 77577a1 (2026-10-06): extra charges and credits (2026-09-29),
    // and drafts / plans dating their goods (2026-10-05: `shipments.name`, `etd`, `eta`
    // beyond SOURCE_COLUMNS.shipments, with their `shipment_lines`).
    payment_extras: ['id', 'supplier_name', 'supplier_key', 'currency', 'amount', 'kind', 'description', 'rides_with',
        'purchase_order_id', 'shipment_id', 'shipment_reference', 'due_date', 'source_kind', 'source_id', 'status', 'paid_on',
        'settled_by_payment_id', 'note', 'created_by_email', 'created_at', 'updated_by_email', 'updated_at', 'deleted_at'],
    shipments: ['name', 'etd', 'eta'],
    shipment_lines: ['shipment_id', 'order_id', 'quantity'],
});

const ph = (list) => list.map(() => '?').join(',');
const viaJson = (x) => JSON.parse(JSON.stringify(x));

// shipment-sync.js intIds: distinct positive integers, ascending.
function intIds(list) {
    return [...new Set((list || []).map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

// shipment-sync.js: the booked stages as an SQL list.
const BOOKED_IN = `'BOOKED','IN_TRANSIT','ARRIVED','CLOSED'`;

// ── GET /orders ─────────────────────────────────────────────────────────

/** ORDER_SELECT … ORDER BY orders.created_at DESC, for the columns rowToOrder keeps. */
async function loadOrders(q, t) {
    const [rows] = await q.query(
        `SELECT orders.id, orders.status, orders.quantity, orders.unit_price, orders.purchase_order_id, orders.po_number,
                orders.supplier, orders.container_number, orders.external_container_number, orders.awb_number, orders.eta,
                orders.po_date, orders.ordered_date, orders.artwork_confirmed_date, orders.estimated_ready_date,
                orders.shipped_date, orders.estimated_departure_date, orders.delivery_date, orders.arrived_date,
                orders.shipment_id,
                COALESCE((SELECT SUM(quantity) FROM ${t('order_receipts')} WHERE order_id = orders.id AND type = 'received'), 0) AS received_quantity
           FROM ${t('orders')} orders
          WHERE orders.deleted_at IS NULL
          ORDER BY orders.created_at DESC`
    );
    return rows.map(rowToOrder);
}

/**
 * loadPurchaseOrdersForOrders: { [poId]: bundle } for every live PO the orders
 * point at — the header plus its invoices, signed PIs and proof-of-payment
 * files, each list in its query's order.
 */
async function loadPurchaseOrdersForOrders(q, t, orders) {
    const poIds = [...new Set(orders.map(o => o.purchaseOrderId).filter(Boolean))];
    if (!poIds.length) return {};

    const [poRows] = await q.query(
        `SELECT id, po_number, supplier, currency, shipping_total, company_id, created_at
           FROM ${t('purchase_orders')} WHERE id IN (${ph(poIds)}) AND deleted_at IS NULL`,
        poIds
    );
    if (!poRows.length) return {};
    const pos = poRows.map(M.rowToPurchaseOrder);
    const liveIds = pos.map(p => p.id);
    const inPos = ph(liveIds);

    const [invRows] = await q.query(
        `SELECT id, purchase_order_id, filename, uploaded_at
           FROM ${t('purchase_order_invoices')}
          WHERE purchase_order_id IN (${inPos}) AND deleted_at IS NULL
          ORDER BY uploaded_at DESC, id DESC`,
        liveIds
    );
    const [piRows] = await q.query(
        `SELECT id, purchase_order_id, uploaded_at
           FROM ${t('purchase_order_signed_pis')}
          WHERE purchase_order_id IN (${inPos}) AND deleted_at IS NULL
          ORDER BY uploaded_at DESC, id DESC`,
        liveIds
    );
    const [payRows] = await q.query(
        `SELECT id, purchase_order_id, uploaded_at
           FROM ${t('purchase_order_payments')}
          WHERE purchase_order_id IN (${inPos}) AND deleted_at IS NULL
          ORDER BY uploaded_at DESC, id DESC`,
        liveIds
    );

    const bundles = {};
    for (const po of pos) bundles[po.id] = { ...po, invoices: [], signedPis: [], payments: [] };
    for (const r of invRows) bundles[r.purchase_order_id]?.invoices.push(M.invoiceRowToJson(r));
    for (const r of piRows) bundles[r.purchase_order_id]?.signedPis.push(M.signedPiRowToJson(r));
    for (const r of payRows) bundles[r.purchase_order_id]?.payments.push(M.paymentRowToJson(r));
    return bundles;
}

/** loadShipmentsForOrders: the shipment each order travels in, id → {id, reference}. */
async function loadShipmentsForOrders(q, t, orders) {
    const ids = intIds(orders.map(o => o && o.shipmentId));
    if (!ids.length) return {};
    const [rows] = await q.query(`SELECT s.id, s.reference FROM ${t('shipments')} s WHERE s.id IN (${ph(ids)})`, ids);
    const out = {};
    for (const r of rows) out[r.id] = { id: r.id, reference: r.reference || null };
    return out;
}

// ── GET /shipments?stage=BOOKED,IN_TRANSIT,ARRIVED,CLOSED&limit=2000 ────

/**
 * shipmentSelect + selectShipments({stages, limit}): live shipments (not deleted,
 * not merged) whose EFFECTIVE stage — the later of the stored stage and the stage
 * the live member orders justify — is one of `stages`, newest booking first.
 */
async function selectShipments(q, t, { stages, limit }) {
    const [rows] = await q.query(
        `SELECT z.* FROM (
           SELECT y.*,
                  CASE WHEN y.stage IN (${BOOKED_IN})
                       THEN ELT(GREATEST(FIELD(y.stage, ${BOOKED_IN}),
                                         FIELD(COALESCE(y.derived_stage, ''), ${BOOKED_IN})),
                                ${BOOKED_IN})
                       ELSE y.stage END AS effective_stage
             FROM (
               SELECT s.id, s.reference, s.stage, s.mode, s.bl_number, s.ata, s.departed_at, s.arrived_at,
                      s.booked_at, s.created_at,
                      CASE WHEN s.stage NOT IN (${BOOKED_IN}) OR COALESCE(m.member_count, 0) = 0 THEN NULL
                           WHEN m.n_terminal = m.member_count THEN 'CLOSED'
                           WHEN m.n_arrived + m.n_terminal > 0 THEN 'ARRIVED'
                           WHEN m.n_transit > 0 THEN 'IN_TRANSIT'
                           ELSE 'BOOKED' END AS derived_stage
                 FROM ${t('shipments')} s
                 LEFT JOIN (
                     SELECT o.shipment_id,
                            COUNT(*) AS member_count,
                            SUM(o.status IN ('RECEIVED', 'PARTIALLY_RECEIVED', 'DESTROYED')) AS n_terminal,
                            SUM(o.status = 'ARRIVED_AT_WAREHOUSE') AS n_arrived,
                            SUM(o.status IN ('ON_SEA', 'ON_AIR')) AS n_transit
                       FROM ${t('orders')} o
                      WHERE o.deleted_at IS NULL AND o.shipment_id IS NOT NULL
                      GROUP BY o.shipment_id
                 ) m ON m.shipment_id = s.id
                WHERE s.deleted_at IS NULL AND s.merged_into_id IS NULL
             ) y
         ) z
         WHERE z.effective_stage IN (${ph(stages)})
         ORDER BY COALESCE(z.booked_at, z.created_at) DESC, z.id DESC
         LIMIT ${Number(limit)}`,
        stages
    );
    return rows.map(S.rowToShipment);
}

// ── GET /shipments/:id/documents (only where a document rule applies) ───

/** Shipments merged (directly or not) into `id`, five hops at most. */
async function mergedInto(q, t, id) {
    const out = [];
    let frontier = [id];
    for (let depth = 0; frontier.length && depth < 5; depth++) {
        const [rows] = await q.query(`SELECT id FROM ${t('shipments')} WHERE merged_into_id IN (${ph(frontier)})`, frontier);
        frontier = rows.map(r => r.id).filter(x => !out.includes(x));
        out.push(...frontier);
    }
    return out;
}

/** Each target's documents as the route lists them, reduced to what the page keeps. */
async function loadShipmentDocuments(q, t, ids) {
    const out = {};
    const at = (r) => r.generated_at?.toISOString?.() ?? r.generated_at;
    for (const id of ids) {
        const all = [id, ...(await mergedInto(q, t, id))];
        const [docs] = await q.query(
            `SELECT id, type, generated_at FROM ${t('draft_container_documents')}
              WHERE shipment_id IN (${ph(all)}) AND deleted_at IS NULL
              ORDER BY type ASC, generated_at DESC, id DESC`, all);
        const [qa] = await q.query(
            `SELECT id, generated_at FROM ${t('quality_assurance_documents')}
              WHERE shipment_id IN (${ph(all)}) AND deleted_at IS NULL
              ORDER BY generated_at DESC, id DESC`, all);
        out[String(id)] = {
            data: docs.map(r => ({ type: r.type || 'quote', generatedAt: at(r) })),
            qaDocuments: qa.map(r => ({ generatedAt: at(r) })),
        };
    }
    return viaJson(out);
}

// ── GET /shipment-payments (no filters) ─────────────────────────────────

async function loadShipmentPayments(q, t) {
    const [rows] = await q.query(
        `SELECT p.id, p.shipment_id, p.shipment_reference, p.supplier_name, p.amount, p.currency, p.deposit_deducted,
                p.status, p.paid_on, p.settled_by_payment_id
           FROM ${t('shipment_payments')} p WHERE p.deleted_at IS NULL ORDER BY p.id DESC`
    );
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const [allocRows] = await q.query(
        `SELECT a.id, a.payment_id, a.purchase_order_id, a.po_ref, a.amount, po.po_number
           FROM ${t('shipment_payment_allocations')} a
           LEFT JOIN ${t('purchase_orders')} po ON po.id = a.purchase_order_id
          WHERE a.payment_id IN (${ph(ids)})
          ORDER BY a.id`,
        ids
    );
    const allocByPayment = new Map();
    for (const a of allocRows) {
        if (!allocByPayment.has(a.payment_id)) allocByPayment.set(a.payment_id, []);
        allocByPayment.get(a.payment_id).push(M.shipmentPaymentAllocationRowToJson(a));
    }
    return rows.map(r => M.shipmentPaymentRowToJson(r, { allocations: allocByPayment.get(r.id) || [] }));
}

// ── GET /supplier-payments (no filters) ─────────────────────────────────

/** loadSupplierPaymentTargets: what each line points at, keyed `${kind}:${id}`; missing = deleted since. */
async function loadSupplierPaymentTargets(q, t, lines, optional = {}) {
    const out = new Map();
    const idsOf = kind => [...new Set(lines.filter(l => l.kind === kind).map(l => l.id))];
    const balIds = idsOf('balance');
    if (balIds.length) {
        const [rows] = await q.query(
            `SELECT p.id, p.shipment_id, p.shipment_reference
               FROM ${t('shipment_payments')} p WHERE p.id IN (${ph(balIds)}) AND p.deleted_at IS NULL`, balIds
        );
        for (const r of rows) {
            out.set(`balance:${r.id}`, {
                kind: 'balance', id: r.id, shipmentId: r.shipment_id, shipmentReference: r.shipment_reference,
                purchaseOrderId: null, poNumber: null, paymentType: null,
            });
        }
    }
    const piIds = idsOf('pi');
    if (piIds.length) {
        const [rows] = await q.query(
            `SELECT p.id, p.purchase_order_id, p.payment_type, po.po_number
               FROM ${t('purchase_order_invoice_payments')} p
               JOIN ${t('purchase_orders')} po ON po.id = p.purchase_order_id AND po.deleted_at IS NULL
               JOIN ${t('purchase_order_invoices')} i ON i.id = p.purchase_order_invoice_id AND i.deleted_at IS NULL
              WHERE p.id IN (${ph(piIds)})`, piIds
        );
        for (const r of rows) {
            out.set(`pi:${r.id}`, {
                kind: 'pi', id: r.id, purchaseOrderId: r.purchase_order_id, poNumber: r.po_number,
                paymentType: r.payment_type || null, shipmentId: null, shipmentReference: null,
            });
        }
    }
    const poIds = idsOf('po_deposit');
    if (poIds.length) {
        const [rows] = await q.query(
            `SELECT po.id, po.po_number FROM ${t('purchase_orders')} po WHERE po.id IN (${ph(poIds)}) AND po.deleted_at IS NULL`, poIds
        );
        for (const r of rows) {
            out.set(`po_deposit:${r.id}`, {
                kind: 'po_deposit', id: r.id, purchaseOrderId: r.id, poNumber: r.po_number, paymentType: 'deposit',
                shipmentId: null, shipmentReference: null,
            });
        }
    }
    // Lines on an extra (payment_extras.id) and on a QC unit (orders.id of an _FQC line),
    // since 2026-09-30 / 10-02; read only when the extras table is there (`optional`).
    const extraIds = optional.payment_extras ? idsOf('extra') : [];
    if (extraIds.length) {
        const [rows] = await q.query(
            `SELECT e.id, e.purchase_order_id, e.shipment_id, e.shipment_reference, po.po_number
               FROM ${t('payment_extras')} e LEFT JOIN ${t('purchase_orders')} po ON po.id = e.purchase_order_id
              WHERE e.id IN (${ph(extraIds)}) AND e.deleted_at IS NULL`, extraIds
        );
        for (const r of rows) {
            out.set(`extra:${r.id}`, {
                kind: 'extra', id: r.id, purchaseOrderId: r.purchase_order_id ?? null, poNumber: r.po_number || null, paymentType: null,
                shipmentId: r.shipment_id ?? null, shipmentReference: r.shipment_reference || null,
            });
        }
    }
    const qcIds = idsOf('qc');
    if (qcIds.length) {
        const [rows] = await q.query(
            `SELECT o.id, o.purchase_order_id, po.po_number
               FROM ${t('orders')} o JOIN ${t('purchase_orders')} po ON po.id = o.purchase_order_id AND po.deleted_at IS NULL
              WHERE o.id IN (${ph(qcIds)}) AND o.deleted_at IS NULL`, qcIds
        );
        for (const r of rows) {
            out.set(`qc:${r.id}`, {
                kind: 'qc', id: r.id, purchaseOrderId: r.purchase_order_id, poNumber: r.po_number, paymentType: null,
                shipmentId: null, shipmentReference: null,
            });
        }
    }
    return out;
}

async function loadSupplierPayments(q, t, optional = {}) {
    const [rows] = await q.query(
        `SELECT sp.id, sp.supplier_name, sp.amount, sp.currency, sp.paid_on
           FROM ${t('supplier_payments')} sp WHERE sp.deleted_at IS NULL ORDER BY sp.paid_on DESC, sp.id DESC`
    );
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const [lineRows] = await q.query(
        `SELECT id, payment_id, target_kind, target_id, amount
           FROM ${t('supplier_payment_lines')} WHERE payment_id IN (${ph(ids)}) ORDER BY id`, ids
    );
    const targets = await loadSupplierPaymentTargets(q, t, lineRows.map(l => ({ kind: l.target_kind, id: l.target_id })), optional);
    const linesByPayment = new Map();
    for (const l of lineRows) {
        if (!linesByPayment.has(l.payment_id)) linesByPayment.set(l.payment_id, []);
        linesByPayment.get(l.payment_id).push(M.supplierPaymentLineToJson(l, targets.get(`${l.target_kind}:${l.target_id}`) || null));
    }
    return rows.map(r => M.supplierPaymentRowToJson(r, { lines: linesByPayment.get(r.id) || [] }));
}

// ── The page's other feeds ──────────────────────────────────────────────

async function loadContainers(q, t) {
    const [rows] = await q.query(
        `SELECT container_number, departure_date, departure_is_actual, arrival_date, arrival_is_actual, eta, ata
           FROM ${t('containers')} ORDER BY COALESCE(eta, arrival_date, departure_date) DESC, container_number ASC`
    );
    return rows.map(M.rowToContainer);
}

async function loadInvoicePayments(q, t) {
    const [rows] = await q.query(
        `SELECT p.id, p.purchase_order_invoice_id, p.purchase_order_id, p.payment_type, p.amount_due, p.currency,
                p.deposit_percentage, p.invoice_total, p.due_date, p.due_terms, p.raw_terms_text, p.payment_status,
                p.updated_at
           FROM ${t('purchase_order_invoice_payments')} p
           JOIN ${t('purchase_order_invoices')} i ON i.id = p.purchase_order_invoice_id AND i.deleted_at IS NULL
           JOIN ${t('purchase_orders')} po        ON po.id = p.purchase_order_id        AND po.deleted_at IS NULL
          ORDER BY p.purchase_order_id, p.id`
    );
    return rows.map(M.invoicePaymentRowToJson);
}

async function loadPaymentRules(q, t) {
    const [rows] = await q.query(
        `SELECT id, scope, supplier_name, supplier_label, deposit_pct, deposit_trigger, deposit_grace_days, balance_trigger,
                balance_document_type, balance_offset_days, balance_grace_days, deposit_offset_days, estimates_json,
                air_owed_from, air_limit_days
           FROM ${t('payment_rules')} ORDER BY scope = 'default' DESC, supplier_label, id`
    );
    return rows.map(paymentRuleRowToJson);
}

/** JFPRO GET /api/suppliers (live suppliers by name), through shipping's suppliers view; id breaks ties. */
async function loadSuppliers(q, t) {
    const [rows] = await q.query(
        `SELECT id, name, paymentTerms FROM ${t('suppliers')} WHERE is_deleted = FALSE ORDER BY name ASC, id ASC`
    );
    return rows.map(page.supplierFromRow);
}

// ── GET /api/v1/payment-extras (payment-extra-routes.js: EXTRA_SELECT + hydrate) ──

/**
 * Every live extra (open and paid) with what live transfers have applied to it, as
 * the route sends them (lib/shippingCopy/paymentExtras.js extraRowToJson). The
 * model reads applied / remaining to know what is left of each.
 */
async function loadPaymentExtras(q, t) {
    const [rows] = await q.query(
        `SELECT e.id, e.supplier_name, e.supplier_key, e.currency, e.amount, e.kind, e.description, e.rides_with,
                e.purchase_order_id, e.shipment_id, e.shipment_reference, e.due_date, e.source_kind, e.source_id, e.status,
                e.paid_on, e.settled_by_payment_id, e.note, e.created_by_email, e.created_at, e.updated_by_email, e.updated_at,
                po.po_number
           FROM ${t('payment_extras')} e
           LEFT JOIN ${t('purchase_orders')} po ON po.id = e.purchase_order_id
          WHERE e.deleted_at IS NULL
          ORDER BY e.id`
    );
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const [appliedRows] = await q.query(
        `SELECT l.target_id, SUM(l.amount) AS applied
           FROM ${t('supplier_payment_lines')} l
           JOIN ${t('supplier_payments')} sp ON sp.id = l.payment_id AND sp.deleted_at IS NULL
          WHERE l.target_kind = 'extra' AND l.target_id IN (${ph(ids)})
          GROUP BY l.target_id`, ids
    );
    const applied = new Map(appliedRows.map(r => [r.target_id, Number(r.applied) || 0]));
    return rows.map(r => X.extraRowToJson(r, { applied: applied.get(r.id) || 0 }));
}

// ── GET /api/v1/shipments?stage=DRAFT,PLANNED&include=lines&limit=2000 ──────

/**
 * The open shipments (drafts and plans) with the fields the page's openContainers
 * memo reads — id, reference, name, stage, mode, etd, eta — and their lines as
 * {orderId, quantity} (shipment-routes.js GET /shipments + shipment-sync.js
 * loadLinesFor, trimmed: lines of deleted orders are left out as there).
 */
async function loadOpenShipments(q, t) {
    const [rows] = await q.query(
        `SELECT s.id, s.reference, s.name, s.stage, s.mode, s.etd, s.eta
           FROM ${t('shipments')} s
          WHERE s.deleted_at IS NULL AND s.merged_into_id IS NULL AND s.stage IN ('DRAFT', 'PLANNED')
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ${Number(page.PAGE_SHIPMENT_LIMIT)}`
    );
    const out = rows.map(r => ({
        id: r.id, reference: r.reference || null, name: r.name || null, stage: r.stage, mode: r.mode || null,
        etd: S.dateOnly(r.etd), eta: S.dateOnly(r.eta), lines: [],
    }));
    if (!out.length) return out;
    const byId = new Map(out.map(s => [s.id, s]));
    const [lines] = await q.query(
        `SELECT sl.shipment_id, sl.order_id, sl.quantity
           FROM ${t('shipment_lines')} sl
           INNER JOIN ${t('orders')} o ON o.id = sl.order_id AND o.deleted_at IS NULL
          WHERE sl.shipment_id IN (${ph(out.map(s => s.id))})
          ORDER BY sl.shipment_id ASC, sl.id ASC`, out.map(s => s.id)
    );
    for (const l of lines) byId.get(l.shipment_id)?.lines.push({ orderId: l.order_id, quantity: Number(l.quantity) || 0 });
    return out;
}

// ── GET /api/v1/payment-due-dates (payment-due-date-routes.js: SELECT d.*, setter) ──

/**
 * Every due date set by hand, as the route sends them (lib/shippingCopy/paymentDueDates.js).
 * `withNames` false (no readable users table): `setByName` is null and the page falls
 * back to the email, as ShipLine's hover does.
 */
async function loadPaymentDueDates(q, t, { withNames = true } = {}) {
    const [rows] = withNames
        ? await q.query(
            `SELECT d.id, d.target_key, d.due_date, d.note, d.set_by_email, d.updated_at, u.display_name AS setter_name
               FROM ${t('payment_due_dates')} d
               LEFT JOIN ${t('shipping_allowed_emails')} u ON u.email = d.set_by_email
              ORDER BY d.id`
        )
        : await q.query(
            `SELECT d.id, d.target_key, d.due_date, d.note, d.set_by_email, d.updated_at, NULL AS setter_name
               FROM ${t('payment_due_dates')} d
              ORDER BY d.id`
        );
    return rows.map(D.rowToJson);
}

/**
 * Every payload the page's model reads, as JSON. `shipmentDocuments` is filled by
 * loadShipmentDocuments once the targets are known (shippingSource.js). `optional`
 * (checkSchema's) says which OPTIONAL_COLUMNS tables are whole: `paymentDueDates` is
 * read only then, and says so (`read`).
 */
async function loadSources(q, t, { optional = {} } = {}) {
    const orders = await loadOrders(q, t);
    const purchaseOrders = await loadPurchaseOrdersForOrders(q, t, orders);
    const shipmentsById = await loadShipmentsForOrders(q, t, orders);
    const containers = await loadContainers(q, t);
    const invoicePayments = await loadInvoicePayments(q, t);
    const paymentRules = await loadPaymentRules(q, t);
    const shipments = await selectShipments(q, t, { stages: page.PAGE_SHIPMENT_STAGES, limit: page.PAGE_SHIPMENT_LIMIT });
    const shipmentPayments = await loadShipmentPayments(q, t);
    const supplierPayments = await loadSupplierPayments(q, t, optional);
    const suppliers = await loadSuppliers(q, t);
    const readDueDates = Boolean(optional.payment_due_dates);
    const paymentDueDates = readDueDates
        ? await loadPaymentDueDates(q, t, { withNames: Boolean(optional.shipping_allowed_emails) })
        : [];
    const readExtras = Boolean(optional.payment_extras);
    const paymentExtras = readExtras ? await loadPaymentExtras(q, t) : [];
    const readOpen = Boolean(optional.shipments && optional.shipment_lines);
    const openShipments = readOpen ? await loadOpenShipments(q, t) : [];
    return viaJson({
        orders: { data: orders, purchaseOrders, shipments: shipmentsById },
        containers: { data: containers },
        invoicePayments: { data: invoicePayments },
        paymentRules: { data: paymentRules },
        shipments: { data: shipments },
        shipmentPayments: { data: shipmentPayments },
        supplierPayments: { data: supplierPayments },
        suppliers,
        shipmentDocuments: {},
        paymentDueDates: { data: paymentDueDates, read: readDueDates },
        paymentExtras: { data: paymentExtras, read: readExtras },
        openShipments: { data: openShipments, read: readOpen },
    });
}

/** The feed's companies[]: shipping's companies, id and name. */
async function loadCompanies(q, t) {
    const [rows] = await q.query(`SELECT id, name FROM ${t('companies')} ORDER BY id`);
    return rows.map(r => ({ id: r.id, name: r.name }));
}

/** POs a payment names that have no bundle (no live order lines): id → {poNumber, supplier, companyId}. */
async function loadPoDirectory(q, t, ids) {
    const out = new Map();
    const want = intIds(ids);
    if (!want.length) return out;
    const [rows] = await q.query(
        `SELECT id, po_number, supplier, company_id FROM ${t('purchase_orders')} WHERE id IN (${ph(want)})`, want
    );
    for (const r of rows) out.set(r.id, { poNumber: r.po_number || `PO ${r.id}`, supplier: r.supplier || null, companyId: r.company_id ?? null });
    return out;
}

module.exports = {
    SOURCE_COLUMNS,
    OPTIONAL_COLUMNS,
    loadSources,
    loadPaymentDueDates,
    loadPaymentExtras,
    loadOpenShipments,
    loadShipmentDocuments,
    loadCompanies,
    loadPoDirectory,
};
