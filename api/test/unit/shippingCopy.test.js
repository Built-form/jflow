'use strict';

// lib/shippingCopy — the shipping and ShipLine code copied to build the model's input the
// way ShipLine's Payments page does (docs/PLAN.md "Phase 2"). No database. The whole
// assembly runs against shipping's real table shapes in test/e2e/shipping-source.test.js.

const { rowToOrder, formatDate, formatDateTime } = require('../../src/lib/shippingCopy/orderShape');
const M = require('../../src/lib/shippingCopy/ordersMappers');
const { paymentRuleRowToJson } = require('../../src/lib/shippingCopy/paymentRules');
const { rowToShipment, effectiveStage } = require('../../src/lib/shippingCopy/shipments');
const page = require('../../src/lib/shippingCopy/shiplinePage');

describe('orderShape (shipping/src/lib/order-shape.js)', () => {
    test('dates: DATE strings pass, DATETIME Dates become ISO, zero and invalid dates are null', () => {
        expect(formatDate('2026-09-29')).toBe('2026-09-29');
        expect(formatDate(new Date('2026-09-29T00:00:00Z'))).toBe('2026-09-29');
        expect(formatDate(new Date('invalid'))).toBeNull();
        expect(formatDate(null)).toBeNull();
        expect(formatDateTime(new Date('2026-08-20T14:30:00Z'))).toBe('2026-08-20T14:30:00.000Z');
        expect(formatDateTime(new Date(NaN))).toBeNull();
    });

    test('rowToOrder: numbers, nulls and the received quantity', () => {
        const o = rowToOrder({
            id: 5001, quantity: '1000', received_quantity: '300', status: 'ON_SEA', po_number: '', supplier: 'S',
            container_number: '268', unit_price: '2.5000', purchase_order_id: 801, shipment_id: null, eta: '2026-10-10',
            delivery_date: null,
        });
        expect(o).toMatchObject({
            id: 5001, quantity: 1000, receivedQuantity: 300, poNumber: null, unitPrice: 2.5, purchaseOrderId: 801,
            shipmentId: null, eta: '2026-10-10', deliveryDate: null, externalContainerNumber: null,
        });
        expect(rowToOrder({ quantity: null, unit_price: null }).unitPrice).toBeNull();
    });
});

describe('ShipLine api.ts + PaymentsFlowView (f9499bc)', () => {
    test('mapOrder: string ids, frontend statuses, zero dates dropped', () => {
        const o = page.mapOrder({ id: 7, containerNumber: 268, status: 'IN_PRODUCTION', poDate: '0000-00-00', eta: '2026-10-10', shipmentId: '311' });
        expect(o).toEqual({ id: '7', containerNumber: '268', status: 'UNDER_PRODUCTION', poDate: undefined, eta: '2026-10-10', shipmentId: 311 });
        expect(page.mapOrder({ status: 'PARTIALLY_RECEIVED' }).status).toBe('PARTIALLY_RECEIVED');
    });

    test('normalizePaymentRule fills the estimates shape; supplierFromRow never carries tags (Q5)', () => {
        const r = page.normalizePaymentRule({ id: 1, scope: 'default', estimates: { transit: { sea: 35 } } });
        expect(r).toMatchObject({ depositOffsetDays: null, airOwedFrom: null, airLimitDays: null });
        expect(r.estimates).toEqual({ artwork: null, pi: null, piSigned: null, ready: null, telex: null, document: null, transit: { sea: 35, air: null, road: null } });
        expect(page.supplierFromRow({ id: 11, name: 'Sunmed', paymentTerms: '30D/70B BOL', tags: [{ name: 'shipsline-legacy' }] }))
            .toEqual({ supplierId: 11, name: 'Sunmed', paymentTerms: '30D/70B BOL', tags: [] });
    });

    test('indexContainers: trimmed and upper-cased keys', () => {
        const c = { containerNumber: ' mscu1 ' };
        const m = page.indexContainers([c, { containerNumber: '' }, { containerNumber: null }]);
        expect([...m.keys()]).toEqual(['mscu1', 'MSCU1']);
    });

    test('containerEvents: stage moments are London dates; documents only where fetched', () => {
        const events = page.eventsFromShipments([
            { id: 311, reference: ' 268 ', stage: 'IN_TRANSIT', mode: 'SEA', ata: null, departedAt: '2026-09-01T23:30:00.000Z', arrivedAt: null, blNumber: 'BL-1' },
            { id: 312, reference: null, stage: 'BOOKED' },
        ], { 311: { data: [{ type: 'packing_list', generatedAt: '2026-09-15T23:30:00.000Z' }], qaDocuments: [{ generatedAt: '2026-09-12T09:00:00.000Z' }] } });
        expect([...events.keys()]).toEqual(['268']);
        expect(events.get('268')).toEqual({
            stage: 'IN_TRANSIT', mode: 'SEA', ata: null, departedAt: '2026-09-02', arrivedAt: null, blNumber: 'BL-1',
            telexReleasedAt: null,
            documents: [{ type: 'packing_list', attachedAt: '2026-09-15' }, { type: 'qa', attachedAt: '2026-09-12' }],
        });
    });

    test('shipmentIdByRef: the orders\' side-map first, then the list', () => {
        const map = page.shipmentIdByRefOf({ 5: { id: 5, reference: 'R1 ' } }, [{ id: 6, reference: 'R1' }, { id: 7, reference: 'R2' }]);
        expect([...map]).toEqual([['R1', 5], ['R2', 7]]);
    });

    test('documentTargets: only under a container_document rule, not CLOSED, capped at 40', () => {
        const rules = [{ scope: 'supplier', supplierName: 'Acme', balanceTrigger: 'container_document', estimates: {} }];
        const orders = [{ containerNumber: 'A1', supplier: 'Acme' }, { containerNumber: 'B1', supplier: 'Other' }];
        const shipments = [
            { id: 1, reference: 'A1', stage: 'BOOKED' }, { id: 2, reference: 'B1', stage: 'BOOKED' },
            { id: 3, reference: 'A1', stage: 'CLOSED' },
        ];
        expect(page.documentTargets({ rules, shipments, orders, suppliers: [] })).toEqual([1]);
        expect(page.documentTargets({ rules: [], shipments, orders, suppliers: [] })).toEqual([]);
        const many = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, reference: 'A1', stage: 'BOOKED' }));
        expect(page.documentTargets({ rules, shipments: many, orders, suppliers: [] })).toHaveLength(page.MAX_DOCUMENT_FETCHES);
    });
});

describe('shipping mappers (orders.js, payment-rules.js, shipments.js)', () => {
    test('rowToContainer keeps the live times; actual flags are === 1', () => {
        const at = new Date('2026-09-02T02:00:00Z');
        expect(M.rowToContainer({ container_number: 'X', departure_date: at, departure_is_actual: 1, arrival_date: null, arrival_is_actual: 0, eta: null, ata: null }))
            .toEqual({ containerNumber: 'X', times: { departure: at, departureIsActual: true, arrival: null, arrivalIsActual: false, eta: null, ata: null } });
    });

    test('balance records and transfers: numbers, the settling transfer, resolved line targets', () => {
        const rec = M.shipmentPaymentRowToJson({ id: 1, shipment_id: 2, shipment_reference: '268', supplier_name: 'S', amount: '800.00', currency: 'USD', deposit_deducted: null, status: 'pending', paid_on: null, settled_by_payment_id: null });
        expect(rec).toMatchObject({ id: 1, amount: 800, depositDeducted: null, settledByPaymentId: null, paidOn: null, allocations: [] });
        const line = M.supplierPaymentLineToJson({ id: 9, target_kind: 'pi', target_id: 7002, amount: '200.00' }, { purchaseOrderId: 802, poNumber: 'PO-802', paymentType: 'deposit' });
        expect(line).toEqual({ id: 9, kind: 'pi', targetId: 7002, amount: 200, shipmentId: null, shipmentReference: null, purchaseOrderId: 802, poNumber: 'PO-802', paymentType: 'deposit' });
        expect(M.supplierPaymentLineToJson({ id: 10, target_kind: 'balance', target_id: 1, amount: '1' }, null).purchaseOrderId).toBeNull();
        expect(M.shipmentPaymentAllocationRowToJson({ id: 1, purchase_order_id: null, po_ref: 'PO-9', po_number: null, amount: null }))
            .toEqual({ id: 1, purchaseOrderId: null, poRef: 'PO-9', poNumber: 'PO-9', amount: 0 });
    });

    test('paymentRuleRowToJson: stored estimates parsed (bad JSON → empty), air start on the default rule only', () => {
        const def = paymentRuleRowToJson({ id: 1, scope: 'default', supplier_name: '', deposit_grace_days: 0, balance_grace_days: 2, estimates_json: '{"transit":{"sea":35}}', air_owed_from: '2026-09-01', air_limit_days: 30 });
        expect(def).toMatchObject({ supplierName: null, balanceGraceDays: 2, airOwedFrom: '2026-09-01', airLimitDays: 30 });
        expect(def.estimates.transit).toEqual({ sea: 35, air: null, road: null });
        const sup = paymentRuleRowToJson({ id: 2, scope: 'supplier', supplier_name: 'acme', estimates_json: '{nope', air_owed_from: '2026-09-01' });
        expect(sup).toMatchObject({ supplierName: 'acme', airOwedFrom: null, depositGraceDays: 0 });
        expect(sup.estimates.artwork).toBeNull();
    });

    test('rowToShipment: the effective stage; a booked shipment never lags its members', () => {
        expect(effectiveStage('BOOKED', 'IN_TRANSIT')).toBe('IN_TRANSIT');
        expect(effectiveStage('ARRIVED', 'BOOKED')).toBe('ARRIVED');
        expect(effectiveStage('DRAFT', 'CLOSED')).toBe('DRAFT');
        expect(rowToShipment({ id: 1, reference: '', stage: 'BOOKED', derived_stage: 'ARRIVED', ata: '2026-08-18', departed_at: new Date('2026-09-01T23:30:00Z') }))
            .toEqual({ id: 1, reference: null, mode: null, stage: 'ARRIVED', blNumber: null, ata: '2026-08-18', departedAt: '2026-09-01T23:30:00.000Z', arrivedAt: null });
    });
});
