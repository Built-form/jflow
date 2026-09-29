// Copied from shipping/tools/test-payments-forecast-lib.js (phase2-payments-flow export) — changes: node:test → jest; rows are checked by JFlow's own services/shipping.js validateFeed instead of a copy of its rules; the fake-DB and HTTP-route cases moved to test/e2e/shipping-source.test.js (the real source on a shadow schema); a per-fixture paid-row invariant added; the query/filter/auth cases dropped with the route
'use strict';

// lib/payments-flow/forecast.js — the JFlow feed rows (docs/PHASE2.md §3; CONTRACT §1.1
// P2–P3): toForecastRows, collectPaidRows, splitCents, and the model's opt-in
// balanceClaims they split paid balances by. No database, no clock.

const lib = require('../../src/lib/payments-flow');
const { validateFeed } = require('../../src/services/shipping');
const H = require('../helpers/paymentsFlow');

const FEED_KEYS = ['id', 'kind', 'status', 'supplier', 'companyId', 'poId', 'poNumber', 'shipmentId', 'containerRef',
    'currency', 'amount', 'dueDate', 'dateBasis', 'amountBasis', 'blocked', 'arranged', 'paidOn', 'settles', 'flags'];
const cents = (s) => Math.round(Number(s) * 100);

function fixtureFeed(name, { paidSince } = {}) {
    const fixture = H.readFixture(name);
    const input = H.buildInput(fixture, lib);
    const flow = lib.buildPaymentsFlow(input, { claims: true });
    const shipmentIdByRef = H.shipmentIdByRef(fixture);
    const paid = lib.collectPaidRows(input, { paidSince: paidSince ?? lib.addDays(input.today, -60) });
    const rows = lib.toForecastRows(flow, paid, { pos: lib.poDirectory(input.poBundles), shipmentIdByRef });
    return { fixture, input, flow, paid, rows, shipmentIdByRef };
}

/** JFlow's validateFeed over the rows: → {rejected, problems}. */
const jflowAccepts = (rows) => {
    const out = validateFeed({ items: rows, companies: [] });
    return { rejected: out.rejected, problems: out.problems };
};

describe('the model\'s balanceClaims', () => {
    test('an invoice both allocated and shared shows both claims, whole, before any part payment', () => {
        const { flow, fixture } = fixtureFeed('allocated-shared-invoice');
        const sp = fixture.input.shipmentPayments.find((p) => p.id === 7001);
        const claims = flow.balanceClaims.filter((c) => c.shipmentPaymentId === 7001);
        expect(claims.map((c) => [c.poId, c.source]).sort()).toEqual([[901, 'allocated'], [901, 'share'], [902, 'share']]);
        expect(claims.every((c) => c.containerNumber === '280')).toBe(true);
        expect(cents(claims.reduce((a, c) => a + c.amount, 0))).toBe(cents(sp.amount));
        for (const c of flow.balanceClaims) {
            expect(Object.keys(c)).toEqual(['shipmentPaymentId', 'poId', 'containerNumber', 'source', 'amount']);
        }
    });
});

describe.each(H.listFixtures())('%s', (name) => {
    test('open rows: one per item — ids, 2-dp amounts, dateBasis, one company, Σ = kpis.outstanding, JFlow accepts all', () => {
        const { flow, rows, input, shipmentIdByRef } = fixtureFeed(name);
        const open = rows.filter((r) => r.status === 'open');
        const items = flow.currencies.flatMap((c) => c.items);
        expect(open).toHaveLength(items.length);
        open.forEach((r, i) => {
            const it = items[i];
            expect(Object.keys(r)).toEqual(FEED_KEYS);
            expect(r).toMatchObject({
                id: lib.itemFeedId(it, { shipmentIdByRef }),
                kind: it.kind,
                amount: it.amount.toFixed(2),
                dueDate: it.dueDate,
                dateBasis: it.dueDate == null ? 'undated' : it.flags.includes('estimated') ? 'estimated' : 'firm',
                amountBasis: it.basis,
                poId: it.poId,
                arranged: it.status === 'arranged',
                paidOn: null,
                settles: null,
            });
            expect(r.amount).toMatch(/^\d+\.\d{2}$/);
            const bundle = Object.values(input.poBundles).find((b) => b.id === it.poId);
            expect(r.companyId).toBe(Number.isSafeInteger(bundle?.companyId) ? bundle.companyId : null);
        });
        for (const c of flow.currencies) {
            const sum = open.filter((r) => r.currency === c.currency).reduce((a, r) => a + cents(r.amount), 0);
            expect({ currency: c.currency, sum }).toEqual({ currency: c.currency, sum: Math.round(c.kpis.outstanding * 100) });
        }
        expect(jflowAccepts(rows)).toEqual({ rejected: 0, problems: [] });
    });

    test('paid rows (every payment on file): each payment\'s parts add up to it, one PO each, JFlow accepts all', () => {
        const { rows, paid } = fixtureFeed(name, { paidSince: '2000-01-01' });
        const paidRows = rows.filter((r) => r.status === 'paid');
        const total = (list) => list.reduce((a, x) => a + cents(x.amount), 0);
        expect(total(paidRows)).toBe(paid.reduce((a, f) => a + Math.round(f.amount * 100), 0));
        for (const r of paidRows) {
            expect(r).toMatchObject({ dueDate: null, dateBasis: 'firm', amountBasis: 'stated', blocked: null, arranged: false });
            expect(r.paidOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(r.id).toMatch(/^(pay-\d+-(pi|dep)\d+|pay-\d+-bal\d+(-\d+)?|spd-\d+(-\d+)?)$/);
        }
        expect(jflowAccepts(rows)).toEqual({ rejected: 0, problems: [] });
    });
});

describe('splitting and formatting', () => {
    test('splitCents: exact, in key order, remainders to the largest fractions (ties to the smaller key)', () => {
        expect(lib.splitCents(30000, [{ key: 802, weight: 25946 }, { key: 801, weight: 54054 }]))
            .toEqual([{ key: 801, cents: 20270 }, { key: 802, cents: 9730 }]);
        expect(lib.splitCents(100, [{ key: 2, weight: 1 }, { key: 1, weight: 1 }, { key: 3, weight: 1 }]))
            .toEqual([{ key: 1, cents: 34 }, { key: 2, cents: 33 }, { key: 3, cents: 33 }]);
        expect(lib.splitCents(7, [{ key: 5, weight: 0 }, { key: 6, weight: 3 }])).toEqual([{ key: 5, cents: 0 }, { key: 6, cents: 7 }]);
        for (let n = 0; n < 200; n++) {
            const total = (n * 7919) % 1000003;
            const parts = [{ key: 1, weight: (n * 31) % 997 + 1 }, { key: 2, weight: (n * 17) % 991 + 1 }, { key: 3, weight: (n * 13) % 983 }];
            expect(lib.splitCents(total, parts).reduce((a, p) => a + p.cents, 0)).toBe(total);
        }
        expect(() => lib.splitCents(5, [{ key: 1, weight: 0 }])).toThrow(TypeError);
        expect(lib.formatCents(5)).toBe('0.05');
        expect(lib.formatCents(123456)).toBe('1234.56');
    });

    test('toForecastRows needs the claims when a paid balance has to be split', () => {
        const { input } = fixtureFeed('part-paid-transfer');
        const paid = lib.collectPaidRows(input, { paidSince: '2000-01-01' });
        expect(paid.some((f) => f.lineKind === 'balance' || f.source === 'record')).toBe(true);
        expect(() => lib.toForecastRows(lib.buildPaymentsFlow(input), paid, {})).toThrow(/claims: true/);
    });

    test('collectPaidRows needs a real paidSince', () => {
        const { input } = fixtureFeed('part-paid-transfer');
        expect(() => lib.collectPaidRows(input, { paidSince: 'soon' })).toThrow(TypeError);
    });

    test('display text is clipped to JFlow\'s column widths, never the id', () => {
        const { input } = fixtureFeed('multi-container');
        const flow = lib.buildPaymentsFlow(input, { claims: true });
        const it = flow.currencies[0].items[0];
        it.supplier = 'S'.repeat(300);
        it.poNumber = 'P'.repeat(80);
        const rows = lib.toForecastRows({ currencies: [{ items: [it] }] }, [], {});
        expect(rows[0].supplier).toHaveLength(255);
        expect(rows[0].poNumber).toHaveLength(64);
        expect(jflowAccepts(rows)).toEqual({ rejected: 0, problems: [] });
    });
});
