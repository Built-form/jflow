// Copied from shipping/tools/test-payments-forecast-lib.js (phase2-payments-flow export) — changes: node:test → jest; rows are checked by JFlow's own services/shipping.js validateFeed instead of a copy of its rules; the fake-DB and HTTP-route cases moved to test/e2e/shipping-source.test.js (the real source on a shadow schema); a per-fixture paid-row invariant added; the query/filter/auth cases dropped with the route
'use strict';

// lib/payments-flow/forecast.js — the JFlow feed rows (docs/PHASE2.md §3; CONTRACT §1.1
// P2–P3): toForecastRows, collectPaidRows, splitCents, and the model's opt-in
// balanceClaims they split paid balances by. No database, no clock.

const lib = require('../../src/lib/payments-flow');
const { validateFeed } = require('../../src/services/shipping');
const H = require('../helpers/paymentsFlow');

const FEED_KEYS = ['id', 'kind', 'status', 'supplier', 'companyId', 'poId', 'poNumber', 'shipmentId', 'containerRef', 'label',
    'currency', 'amount', 'dueDate', 'dateBasis', 'amountBasis', 'blocked', 'arranged', 'paidOn', 'settles', 'flags', 'dueSet'];
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
    test('open rows: one per item and QC unit — ids, 2-dp amounts (credit netted), dateBasis, one company, Σ = kpis.outstanding − credit netted, JFlow accepts all', () => {
        const { flow, rows, input, shipmentIdByRef } = fixtureFeed(name);
        const open = rows.filter((r) => r.status === 'open');
        // Items first, then the currency's QC units, as toForecastRows emits them.
        const items = flow.currencies.flatMap((c) => [...c.items, ...(c.qcItems ?? [])]).filter((it) => Math.round((it.amount - (it.creditForecast ?? 0)) * 100) > 0);
        expect(open).toHaveLength(items.length);
        open.forEach((r, i) => {
            const it = items[i];
            expect(Object.keys(r)).toEqual(FEED_KEYS);
            expect(r).toMatchObject({
                id: lib.itemFeedId(it, { shipmentIdByRef }),
                kind: it.extraId != null ? 'extra' : it.kind,
                amount: (Math.round((it.amount - (it.creditForecast ?? 0)) * 100) / 100).toFixed(2),
                dueDate: it.dueDate,
                dateBasis: it.dueDate == null ? 'undated' : it.flags.includes('estimated') ? 'estimated' : 'firm',
                amountBasis: it.basis,
                // An extra naming no PO (a forwarder's cost) has poId 0 in the model: no PO on the row.
                poId: Number.isSafeInteger(it.poId) && it.poId > 0 ? it.poId : null,
                arranged: it.status === 'arranged',
                paidOn: null,
                settles: null,
            });
            expect(r.amount).toMatch(/^\d+\.\d{2}$/);
            // A row's company is its PO's; a forwarder's cost names no PO and takes its box's
            // (the companiesByBox tests below).
            const bundle = Object.values(input.poBundles).find((b) => b.id === it.poId);
            if (r.poId !== null) expect(r.companyId).toBe(Number.isSafeInteger(bundle?.companyId) ? bundle.companyId : null);
        });
        for (const c of flow.currencies) {
            const sum = open.filter((r) => r.currency === c.currency).reduce((a, r) => a + cents(r.amount), 0);
            // outstanding (goods, charges, top-ups, extras, QC units) less the credit the model
            // forecasts against this currency's items, which the rows carry netted.
            const netted = c.items.reduce((a, it) => a + Math.round((it.creditForecast ?? 0) * 100), 0);
            expect({ currency: c.currency, sum }).toEqual({ currency: c.currency, sum: Math.round(c.kpis.outstanding * 100) - netted });
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
            expect(r.id).toMatch(/^(pay-\d+-(pi|dep|ext|qc)\d+|pay-\d+-bal\d+(-\d+)?|spd-\d+(-\d+)?)$/);
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

describe('the re-pin (77577a1): extras, QC units, split parts, credits', () => {
    const F = require('../../src/lib/payments-flow/forecast');

    test('extras-qc-credit: the mould cost rides as kind extra with its label; the forwarder cost names the forwarder, keeps its own currency and date, and falls to the company with the bigger share of its box\'s goods; the QC unit is a qc row; the credit is netted', () => {
        const { rows, flow } = fixtureFeed('extras-qc-credit');
        const open = rows.filter((r) => r.status === 'open');
        const byId = Object.fromEntries(open.map((r) => [r.id, r]));
        expect(Object.keys(byId).sort()).toEqual(['bal-812-s311', 'bal-901-s311', 'ext-44', 'ext-45', 'qc-81202']);
        expect(byId['ext-44']).toMatchObject({ kind: 'extra', label: 'Mould cost', supplier: 'Suzhou Sunmed Co.,Ltd.', poId: 812, companyId: 1, containerRef: '268', shipmentId: 311, currency: 'USD', amount: '300.00', flags: ['extra_charge'] });
        // Box 268 holds company 1's 1645 + 300 and company 2's 700, all USD: company 1's share is the bigger.
        expect(byId['ext-45']).toMatchObject({ kind: 'extra', label: 'Freight', supplier: 'Fast Forwarders Ltd', poId: null, poNumber: null, companyId: 1, containerRef: '268', currency: 'GBP', amount: '1200.00', dueDate: '2026-10-20', flags: ['shipment_cost'] });
        expect(byId['qc-81202']).toMatchObject({ kind: 'qc', label: 'QC units JF-ABC', poId: 812, companyId: 1, containerRef: '268', shipmentId: 311, amount: '32.90', dueDate: '2026-09-20', flags: ['qc_unit'] });
        // The 150 credit note is forecast against Sunmed's most urgent payment and netted into it.
        expect(byId['bal-812-s311']).toMatchObject({ amount: '1495.00', flags: ['credit_netted'] });
        expect(flow.currencies.find((c) => c.currency === 'USD').kpis.credit).toBe(150);
        // The paid extra (settled by transfer 7001) makes no open row, and its transfer line a paid row.
        const paid = rows.filter((r) => r.status === 'paid');
        expect(paid.map((r) => [r.id, r.kind, r.settles, r.amount])).toEqual([['pay-7001-ext47', 'extra', 'ext-47', '80.00']]);
        expect(jflowAccepts(rows)).toEqual({ rejected: 0, problems: [] });
    });

    test('a forwarder cost on a box whose goods are all one company\'s takes that company', () => {
        const pos = new Map([[812, { poNumber: 'PO-812', supplier: 'Acme', companyId: 1 }], [813, { poNumber: 'PO-813', supplier: 'Acme', companyId: 1 }], [901, { poNumber: 'PO-901', supplier: 'Other', companyId: 2 }]]);
        const item = (id, poId, box, extra = {}) => ({ id, kind: 'balance', basis: 'derived', poId, poNumber: pos.get(poId)?.poNumber ?? '', supplier: 'Acme', currency: 'USD', amount: 100, dueDate: '2026-10-20', contractualDate: '2026-10-20', trigger: 'bl', containerNumber: box, containerShare: 1, status: 'projected', blocked: null, shipmentPaymentId: null, flags: [], invoiceId: null, paymentId: null, ...extra });
        const flow = { today: '2026-10-06', balanceClaims: [], currencies: [{ currency: 'USD', items: [
            item('derived:bal:812:300', 812, '300'), item('derived:bal:813:300', 813, ' 300 '),
            item('derived:bal:812:301', 812, '301'), item('derived:bal:901:301', 901, '301'),
            item('extra:1', 0, '300', { basis: 'stated', kind: 'balance', extraId: 1, extraKind: 'freight', supplier: 'Fwd', flags: ['shipment_cost'] }),
            item('extra:2', 0, '301', { basis: 'stated', kind: 'balance', extraId: 2, extraKind: 'freight', supplier: 'Fwd', flags: ['shipment_cost'] }),
            item('extra:3', 0, '999', { basis: 'stated', kind: 'balance', extraId: 3, extraKind: 'freight', supplier: 'Fwd', flags: ['shipment_cost'] }),
        ], qcItems: [] }] };
        expect([...F.companiesByBox(flow, { pos })]).toEqual([['300', 1], ['301', null]]);
        const rows = lib.toForecastRows(flow, [], { pos });
        const co = Object.fromEntries(rows.map((r) => [r.id, r.companyId]));
        // <g> for '300' and '301' is the hash of the ref as spelt (no shipment maps them).
        expect(co).toEqual({ 'bal-812-r983bd614bb': 1, 'bal-813-r983bd614bb': 1, 'bal-812-rc3ea99f86b': 1, 'bal-901-rc3ea99f86b': 2, 'ext-1': 1, 'ext-2': null, 'ext-3': null });
    });

    test('a forwarder cost on a box two companies share takes the bigger share of its goods; a tie, or goods in two currencies, leaves it unmapped', () => {
        const pos = new Map([[812, { poNumber: 'PO-812', supplier: 'Acme', companyId: 1 }], [813, { poNumber: 'PO-813', supplier: 'Acme', companyId: 1 }], [901, { poNumber: 'PO-901', supplier: 'Other', companyId: 2 }], [950, { poNumber: 'PO-950', supplier: 'Nobody', companyId: null }]]);
        const item = (id, poId, box, amount, extra = {}) => ({ id, kind: 'balance', basis: 'derived', poId, poNumber: pos.get(poId)?.poNumber ?? '', supplier: 'Acme', currency: 'USD', amount, dueDate: '2026-10-20', contractualDate: '2026-10-20', trigger: 'bl', containerNumber: box, containerShare: 1, status: 'projected', blocked: null, shipmentPaymentId: null, flags: [], invoiceId: null, paymentId: null, ...extra });
        const freight = (n, box) => item(`extra:${n}`, 0, box, 500, { basis: 'stated', extraId: n, extraKind: 'freight', supplier: 'Fwd', flags: ['shipment_cost'] });
        const flow = { today: '2026-10-07', balanceClaims: [], currencies: [
            { currency: 'USD', items: [
                // 302: company 2 holds the biggest single payment, company 1 the bigger share (100 + 50).
                item('derived:bal:812:302', 812, '302', 100), item('derived:bal:813:302', 813, '302', 50), item('derived:bal:901:302', 901, '302', 120),
                // 303: company 2's share is the bigger; a PO with no company weighs nothing.
                item('derived:bal:812:303', 812, '303', 100), item('derived:bal:901:303', 901, '303', 300), item('derived:bal:950:303', 950, '303', 900),
                // 304: level.
                item('derived:bal:812:304', 812, '304', 75.5), item('derived:bal:901:304', 901, '304', 75.5),
                // 305 and 306: USD here, GBP below.
                item('derived:bal:812:305', 812, '305', 100), item('derived:bal:812:306', 812, '306', 100),
                freight(2, '302'), freight(3, '303'), freight(4, '304'), freight(5, '305'), freight(6, '306'),
            ], qcItems: [] },
            { currency: 'GBP', items: [
                // 305: two companies in two currencies — no rates here to weigh them by.
                item('derived:bal:901:305', 901, '305', 900, { currency: 'GBP' }),
                // 306: two currencies, but all one company's.
                item('derived:bal:813:306', 813, '306', 900, { currency: 'GBP' }),
            ], qcItems: [] },
        ] };
        expect(Object.fromEntries(F.companiesByBox(flow, { pos }))).toEqual({ 302: 1, 303: 2, 304: null, 305: null, 306: 1 });
        const rows = lib.toForecastRows(flow, [], { pos });
        const co = Object.fromEntries(rows.filter((r) => r.kind === 'extra').map((r) => [r.id, r.companyId]));
        expect(co).toEqual({ 'ext-2': 1, 'ext-3': 2, 'ext-4': null, 'ext-5': null, 'ext-6': 1 });
        expect(jflowAccepts(rows)).toEqual({ rejected: 0, problems: [] });
    });
});
