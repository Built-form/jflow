'use strict';

// services/shippingReads — the SQL JFlow reads shipping's tables with. Only what a
// unit test can say: which columns a read asks for under which schema. The whole
// assembly runs against real table shapes in test/e2e/shipping-source.test.js.

const reads = require('../../src/services/shippingReads');

const t = (name) => `\`jfa\`.\`${name}\``;

/** A connection that records every query and answers the purchase_orders one. */
function fakeQ(poRows) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return [/FROM `jfa`\.`purchase_orders`/.test(sql) ? poRows : []];
        },
    };
}

const poRow = (over = {}) => ({
    id: 431, po_number: 'PO_00431J', supplier: 'Acme Co., Ltd.', currency: 'USD', shipping_total: '18.00', company_id: 1,
    created_at: new Date('2026-11-25T09:00:00Z'), ...over,
});

describe('loadPurchaseOrdersForOrders — the kind of a purchase order (sample orders)', () => {
    const orders = [{ id: 10, purchaseOrderId: 431 }];

    test('a schema with purchase_orders.kind: the column is read, and a sample order says so', async () => {
        const q = fakeQ([poRow({ kind: 'sample' })]);
        const bundles = await reads.loadPurchaseOrdersForOrders(q, t, orders, { purchase_orders: true });
        expect(q.calls[0].sql).toMatch(/SELECT id, po_number, supplier, currency, shipping_total, company_id, created_at, kind\s+FROM `jfa`\.`purchase_orders`/);
        expect(bundles[431].kind).toBe('sample');
        expect(bundles[431]).toMatchObject({ poNumber: 'PO_00431J', shippingTotal: 18, invoices: [], signedPis: [], payments: [] });
    });

    test('a schema without it (before shipping\'s sample-orders migration): not asked for, and every PO is stock', async () => {
        for (const optional of [{}, { purchase_orders: false }, undefined]) {
            const q = fakeQ([poRow()]);
            const bundles = await reads.loadPurchaseOrdersForOrders(q, t, orders, optional);
            expect(q.calls[0].sql).not.toMatch(/\bkind\b/);
            expect(bundles[431].kind).toBe('stock');
        }
    });

    test('an ordinary PO in a schema with the column is stock', async () => {
        const q = fakeQ([poRow({ kind: 'stock' })]);
        const bundles = await reads.loadPurchaseOrdersForOrders(q, t, orders, { purchase_orders: true });
        expect(bundles[431].kind).toBe('stock');
    });
});
