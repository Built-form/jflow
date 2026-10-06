// Copied from ShipLine src/api.ts, src/components/payments/PaymentsFlowView.tsx and src/components/shared/containerHelpers.ts @ 77577a1 — changes: TS → CommonJS, types stripped; api.ts mapOrder / fromApiStatus / isZeroDate / normalizePaymentRule verbatim in behaviour; getSuppliers' row mapping trimmed to supplierId, name, paymentTerms with tags always [] (PHASE2 Q5, CONTRACT §11); PaymentsFlowView's documentTargets / containerEvents / openContainers / shipmentIdByRef memos and its buildPaymentsFlow({...}) call as plain functions over the loaded payloads (pageState, pageInput); indexContainers verbatim; paymentExtras and dueOverrides passed through as the page does
'use strict';

// What ShipLine's Payments page does between its fetches and buildPaymentsFlow,
// so JFlow hands the port (lib/payments-flow) the input the page would build
// from the same rows. Pure: the payloads come from services/shippingReads.js,
// already through a JSON round trip (what the page receives over HTTP).

const flowLib = require('../payments-flow');

// PaymentsFlowView: api.getShipments({ stage: [...], limit: 2000 }).
const PAGE_SHIPMENT_STAGES = ['BOOKED', 'IN_TRANSIT', 'ARRIVED', 'CLOSED'];
const PAGE_SHIPMENT_LIMIT = 2000;
// PaymentsFlowView MAX_DOCUMENT_FETCHES.
const MAX_DOCUMENT_FETCHES = 40;

// ── api.ts ───────────────────────────────────────────────────────────────

const STATUS_FROM_API = {
    PLANNING: 'SCHEDULED',
    planning: 'SCHEDULED',
    IN_PRODUCTION: 'UNDER_PRODUCTION',
    in_production: 'UNDER_PRODUCTION',
    READY: 'READY_AT_FACTORY',
    ready: 'READY_AT_FACTORY',
};

const fromApiStatus = (s) => {
    if (typeof s !== 'string') return undefined;
    return STATUS_FROM_API[s] ?? s;
};

/** Every DATE / DATETIME column on an order. */
const ORDER_DATE_FIELDS = [
    'mfgDate', 'expDate', 'scheduledDate', 'poDate', 'qcDate',
    'artworkConfirmedDate', 'estimatedReadyDate', 'actualReadyDate', 'shippedDate',
    'estimatedDepartureDate', 'eta', 'deliveryDate', 'arrivedDate',
];

/** True for the zero dates MySQL hands back when a DATE column was written with
 *  an empty string — '0000-00-00', '0000-00-00 00:00:00', '0000-00-00T00:00:00Z'. */
const isZeroDate = (v) => typeof v === 'string' && /^0000-00-00/.test(v.trim());

// String ids and frontend statuses; zero dates dropped to undefined.
const mapOrder = (order) => {
    if (!order || typeof order !== 'object') return order;
    const out = { ...order };
    if (out.id != null) out.id = String(out.id);
    if (out.containerNumber != null) out.containerNumber = String(out.containerNumber);
    if (out.externalContainerNumber != null) out.externalContainerNumber = String(out.externalContainerNumber);
    if (out.shipmentId != null) out.shipmentId = Number(out.shipmentId);
    if (out.status) {
        const mapped = fromApiStatus(out.status);
        if (mapped && mapped !== out.status) out.status = mapped;
    }
    for (const field of ORDER_DATE_FIELDS) {
        if (isZeroDate(out[field])) out[field] = undefined;
    }
    return out;
};

/** A backend built before deposit timing / estimates / the air fields existed sends none of them — read them as unset. */
function normalizePaymentRule(r) {
    const empty = flowLib.EMPTY_PAYMENT_RULE_ESTIMATES;
    const e = (r.estimates ?? {});
    return { ...r, depositOffsetDays: r.depositOffsetDays ?? null, airOwedFrom: r.airOwedFrom ?? null, airLimitDays: r.airLimitDays ?? null, estimates: { ...empty, ...e, transit: { ...empty.transit, ...(e.transit ?? {}) } } };
}

/** getSuppliers' mapping of a JFPRO row, for the fields the model reads. Tags are
 *  not wired server-side (PHASE2 Q5): always []. */
function supplierFromRow(r) {
    return {
        supplierId: r.supplierId ?? r.id,
        name: r.name,
        paymentTerms: r.paymentTerms ?? r.payment_terms ?? null,
        tags: [],
    };
}

// ── containerHelpers.ts ──────────────────────────────────────────────────

function indexContainers(containers) {
    const m = new Map();
    for (const c of containers) {
        if (!c.containerNumber) continue;
        const k = c.containerNumber.trim();
        if (!k) continue;
        m.set(k, c);
        m.set(k.toUpperCase(), c);
    }
    return m;
}

// ── PaymentsFlowView ─────────────────────────────────────────────────────

/** The page's state after its fetches: what the memos and the model read. */
function pageState(sources) {
    return {
        orders: (sources.orders.data ?? []).map(mapOrder),
        poBundles: sources.orders.purchaseOrders ?? {},
        shipmentsById: sources.orders.shipments ?? {},
        containers: sources.containers.data ?? [],
        invoicePayments: sources.invoicePayments.data ?? [],
        rules: (sources.paymentRules.data ?? []).map(normalizePaymentRule),
        shipments: sources.shipments.data ?? [],
        shipmentPayments: sources.shipmentPayments.data ?? [],
        supplierPayments: sources.supplierPayments.data ?? [],
        suppliers: sources.suppliers ?? [],
        // The page's three later fetches (@ 77577a1): api.getOpenShipments (drafts and
        // plans with their lines), api.getPaymentExtras, api.getPaymentDueDates. [] when
        // the table is not there yet (shippingReads.js loadSources).
        openShipments: sources.openShipments?.data ?? [],
        paymentExtras: sources.paymentExtras?.data ?? [],
        dueOverrides: sources.paymentDueDates?.data ?? [],
    };
}

/**
 * PaymentsFlowView's openContainers memo: the open shipments as the model's
 * OpenContainer — id, a name, the stage, the mode, ETD and ETA as on file, and
 * the lines as {orderId, quantity}.
 */
function openContainersOf(openShipments) {
    return (openShipments ?? [])
        .filter(s => s.stage === 'DRAFT' || s.stage === 'PLANNED')
        .map(s => ({
            id: s.id,
            name: s.name ?? `Shipment ${s.id}`,
            stage: s.stage,
            mode: s.mode,
            etd: s.etd,
            eta: s.eta,
            lines: (s.lines ?? []).map(l => ({ orderId: l.orderId, quantity: l.quantity })),
        }));
}

// The shipments (not yet closed) that hold a line whose supplier is under a
// "when document attached" rule, capped — the only ones whose documents the page fetches.
function documentTargets({ rules, shipments, orders, suppliers }) {
    if (!rules?.some(r => r.balanceTrigger === 'container_document') || !shipments.length) return [];
    const index = flowLib.indexSuppliersByName(suppliers);
    const refsUnderRule = new Set();
    const seen = new Map();
    for (const o of orders) {
        const ref = o.containerNumber?.trim();
        const sup = (o.supplier ?? '').trim();
        if (!ref || refsUnderRule.has(ref)) continue;
        let hit = seen.get(sup);
        if (hit == null) {
            const m = flowLib.matchSupplier(sup, index, suppliers);
            hit = flowLib.resolvePolicy(rules, [sup, m?.supplier.name]).balanceTrigger === 'container_document';
            seen.set(sup, hit);
        }
        if (hit) refsUnderRule.add(ref);
    }
    return shipments
        .filter(s => s.stage !== 'CLOSED' && s.reference && refsUnderRule.has(s.reference.trim()))
        .map(s => s.id)
        .slice(0, MAX_DOCUMENT_FETCHES);
}

/** One GET /shipments/:id/documents body → the page's shipmentDocs entry. */
function documentsOf(body) {
    return [
        ...body.data.map(d => ({ type: d.type, attachedAt: flowLib.dateOf(d.generatedAt) })),
        ...body.qaDocuments.map(d => ({ type: 'qa', attachedAt: flowLib.dateOf(d.generatedAt) })),
    ];
}

// Per-container facts from the shipment entity, keyed by reference (= the
// orders' containerNumber). Telex release is not on the entity yet.
function eventsFromShipments(shipments, documentsById) {
    const map = new Map();
    for (const s of shipments) {
        const ref = s.reference?.trim();
        if (!ref) continue;
        const docs = documentsById[String(s.id)];
        map.set(ref, {
            stage: s.stage,
            mode: s.mode,
            ata: flowLib.dateOf(s.ata),
            departedAt: flowLib.dateOfInstant(s.departedAt),
            arrivedAt: flowLib.dateOfInstant(s.arrivedAt),
            blNumber: s.blNumber,
            telexReleasedAt: null,
            documents: docs ? documentsOf(docs) : [],
        });
    }
    return map;
}

/** GET /orders' shipments side-map first, then the list: reference (trimmed) → id. */
function shipmentIdByRefOf(shipmentsById, shipments) {
    const map = new Map();
    for (const s of Object.values(shipmentsById)) if (s.reference) map.set(s.reference.trim(), s.id);
    for (const s of shipments) if (s.reference && !map.has(s.reference.trim())) map.set(s.reference.trim(), s.id);
    return map;
}

/**
 * The model's input — PaymentsFlowView's buildPaymentsFlow({...}) call, same
 * keys, same order — and the page's shipmentIdByRef (for the feed ids).
 * shipmentPaymentDocuments is [] here: the model reads them only for
 * dataQuality and the container payables, never for an item (so for no feed row).
 */
function pageInput(sources, today) {
    const st = pageState(sources);
    const input = {
        orders: st.orders,
        poBundles: st.poBundles,
        invoicePayments: st.invoicePayments,
        suppliers: st.suppliers,
        containerIndex: indexContainers(st.containers),
        rules: st.rules,
        containerEvents: eventsFromShipments(st.shipments, sources.shipmentDocuments ?? {}),
        openContainers: openContainersOf(st.openShipments),
        shipmentPayments: st.shipmentPayments,
        shipmentPaymentDocuments: [],
        supplierPayments: st.supplierPayments,
        paymentExtras: st.paymentExtras,
        dueOverrides: st.dueOverrides,
        today,
    };
    return { input, shipmentIdByRef: shipmentIdByRefOf(st.shipmentsById, st.shipments) };
}

module.exports = {
    PAGE_SHIPMENT_STAGES,
    PAGE_SHIPMENT_LIMIT,
    MAX_DOCUMENT_FETCHES,
    mapOrder,
    normalizePaymentRule,
    supplierFromRow,
    indexContainers,
    pageState,
    openContainersOf,
    documentTargets,
    eventsFromShipments,
    shipmentIdByRefOf,
    pageInput,
};
