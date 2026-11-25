'use strict';

// Does the payments model JFlow runs know the sample-order rule?
//
// A sample order (shipping docs/sample-orders.md) is a purchase order of kind
// `sample`: a few units sent by courier, owed in full on the PO date, never
// split by the supplier's terms and never treated as paid because it shipped.
// That rule lives in ShipLine's paymentsFlowMath.ts (summarizeSamplePo), and
// reaches JFlow only when ./model.js is re-pinned to a ShipLine commit that has
// it (tools/payments-flow-port.mjs). A model from before reads a sample PO as
// stock and forecasts it wrongly.
//
// So the model is ASKED, with one small order, and what it answers is the
// truth about the code that is deployed, whatever commit its header names.
// GET /health reports it (`paymentsFlow.sampleOrders`), and shipping's
// tools/check-sample-orders.js refuses to switch sample orders on for a stage
// whose JFlow says no. Pure: no database, no clock.

/**
 * One sample order: one unit at 10, sent, nothing paid, on a supplier whose
 * terms are a 30% deposit and the balance on the bill of lading. In no
 * container. A model with the rule owes the 10; a model without it treats the
 * deposit as paid (the goods have shipped) and waits for a container that will
 * never come.
 */
const PROBE = Object.freeze({
    bundle: Object.freeze({
        id: 1, poNumber: 'SAMPLE-RULE-PROBE', supplier: 'Probe', currency: 'USD', shippingTotal: 0,
        createdAt: '2026-01-01T00:00:00.000Z', kind: 'sample', invoices: [], signedPis: [], payments: [],
    }),
    lines: Object.freeze([Object.freeze({
        id: '1', purchaseOrderId: 1, poNumber: 'SAMPLE-RULE-PROBE', poDate: '2026-01-01', supplier: 'Probe',
        jfCode: 'PROBE', asin: null, quantity: 1, receivedQuantity: 0, unitPrice: 10, status: 'ON_AIR',
        shippedDate: '2026-01-02', containerNumber: null, dates: {},
    })]),
    payments: Object.freeze([]),
    supplierTerms: '30D/70B BOL',
    today: '2026-01-10',
});

/**
 * True when `model.summarizePo` gives the probe exactly one item: the whole
 * order, flagged `sample`. Anything else, a throw included, is false.
 * @param {{ summarizePo?: Function } | null} [model] default: the model JFlow ships.
 */
function sampleRuleKnown(model = require('./model')) {
    try {
        if (!model || typeof model.summarizePo !== 'function') return false;
        const summary = model.summarizePo({
            bundle: { ...PROBE.bundle, invoices: [], signedPis: [], payments: [] },
            lines: PROBE.lines.map((line) => ({ ...line, dates: {} })),
            payments: [],
            supplierTerms: PROBE.supplierTerms,
            today: PROBE.today,
            issues: [],
        });
        const items = summary && Array.isArray(summary.items) ? summary.items : [];
        if (items.length !== 1) return false;
        const [item] = items;
        return item.amount === 10 && Array.isArray(item.flags) && item.flags.includes('sample');
    } catch {
        return false;
    }
}

module.exports = { sampleRuleKnown, PROBE };
