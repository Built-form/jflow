'use strict';

// Ship lines in /forecast (Phase 2 step 20; CONTRACT §6.10, §6.12, §8 rules 6 and 11,
// §9.3.1, P4–P9), end to end against a per-run jflow_test_<runid> schema, with shipping's
// data served by an in-process stand-in for services/shippingSource.js
// (test/helpers/shippingSourceStub.js). The feed reaches external_items only through the
// real refresh (POST /external/refresh, or /forecast's own refreshIfStale); overlays are
// SQL, as step 21's routes will leave them. No real shipping data is read.
//
// Pinned here:
//   · the Stock payments row: ship lines, accounts by currency else the company default
//     (P5, resolved in SQL at load time), absorbed paid rows, unresolved, undated counts;
//   · SHIP_UNMAPPED per shipping company and reason (no company linked, or a linked company
//     with no account to land on), and re-mapping moving rows on the next /forecast;
//   · GET /external-items: its shape, filters and order, and derivedStatus agreeing with
//     /forecast for every row (null for undated, gone and unmapped rows);
//   · a failed refresh → 200 + SHIPPING_UNAVAILABLE on the last snapshot (source_error,
//     source_schema), include=summary keeping the shipping block;
//   · rule 6 / loadTarget for ship. keys, and a draft scenario's ship. adjustments;
//   · FX_RATE_MISSING for a ship currency.

const { startHarness } = require('./harness');
const { stubShippingSource, feedItem, feedBody } = require('../helpers/shippingSourceStub');
const { insertScenario, insertAdjustment } = require('./forecastHelpers');
const { toGbp, parseRate } = require('../../src/lib/money');
const { parseKey } = require('../../src/lib/keys');

jest.setTimeout(240000);

const TODAY = '2026-09-29';
const A = '2026-09-20';
const USD = '0.786543';
const CNY = '0.108765';
const usdGbp = (minor) => Number(toGbp(BigInt(minor), parseRate(USD)));
const cnyGbp = (minor) => Number(toGbp(BigInt(minor), parseRate(CNY)));

let h;
let stub;
let db;
let load;

beforeAll(async () => {
    h = await startHarness();
    stub = stubShippingSource();
    db = require('../../src/db');
    load = require('../../src/services/forecastLoad');
});

afterAll(async () => {
    if (stub) stub.restore();
    if (h) await h.stop();
});

let warnSpy;
let errorSpy;
beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
});

const api = () => h.api();
const q = (req, query = {}) => req.query({ today: TODAY, ...query });
const forecast = (query) => q(api().get('/api/v1/forecast'), query);
const ok = async (query) => {
    const res = await forecast(query);
    if (res.status !== 200) throw new Error(`forecast ${JSON.stringify(query)} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
};
const externalItems = async (query = {}) => (await q(api().get('/api/v1/external-items'), { limit: 500, ...query }).expect(200)).body;

const releaseClaim = () => h.sql("UPDATE external_sync SET last_attempt_at = NULL WHERE source = 'ship'");
/** Serve `items` and force one refresh (the 60-second claim lifted first). */
async function refreshWith(items) {
    await releaseClaim();
    stub.reset();
    stub.respond(feedBody(items));
    await q(api().post('/api/v1/external/refresh')).expect(200);
}
const overlay = (extId, set) => h.sql(`UPDATE external_items SET ${set} WHERE source = 'ship' AND ext_id = ?`, [extId]);

const lines = (body) => body.rows.flatMap((r) => r.items);
const lineOf = (body, key) => {
    const found = lines(body).filter((l) => l.key === key);
    if (found.length !== 1) throw new Error(`${found.length} lines for ${key}`);
    return found[0];
};
const shipWarnings = (body) => body.warnings.filter((w) => w.code.startsWith('SHIP'));
/** Where /forecast put a key: rows (plain, overdue or paid), absorbed, unresolved, or nowhere. */
function placeOf(body, key) {
    const inRows = lines(body).filter((l) => l.key === key);
    if (inRows.length) {
        const f = inRows[0].flags;
        return f.includes('paid') ? 'rows:paid' : f.includes('overdue') ? 'rows:overdue' : 'rows';
    }
    if (body.accounts.some((a) => a.absorbed.some((e) => e.key === key))) return 'absorbed';
    if (body.unresolved.some((u) => u.key === key)) return 'unresolved';
    return 'none';
}

// The feed. Shipping company 1 → co1, 2 → co2; 3 maps to no JFlow company; null = no company.
const F = {
    bal812: feedItem('bal-812-s311'),                                                           // USD, 2026-10-15
    dep813: feedItem('dep-813', { kind: 'deposit', currency: 'CNY', amount: '5000.00', dueDate: '2026-10-01', shipmentId: null, containerRef: null }),
    bal814: feedItem('bal-814-n', { amount: '100.00', dueDate: '2026-08-15', shipmentId: null }),   // today − 45
    bal815: feedItem('bal-815-n', { amount: '200.00', dueDate: '2026-08-14', shipmentId: null }),   // today − 46
    pi77: feedItem('pi-77-s311', { amount: '750.25', dueDate: null, dateBasis: 'undated', flags: ['projected'] }),
    pay1: feedItem('pay-1-bal812', { status: 'paid', paidOn: '2026-09-25', dueDate: null, amount: '300.00', settles: 'bal-812-s311' }),
    pay2: feedItem('pay-2-bal812', { status: 'paid', paidOn: TODAY, dueDate: null, amount: '50.00', settles: 'bal-812-s311' }),
    pay3: feedItem('pay-3-bal812', { status: 'paid', paidOn: '2026-09-19', dueDate: null, amount: '40.00', settles: 'bal-812-s311' }),
    bal900: feedItem('bal-900-s1', { companyId: 2, amount: '10.00', dueDate: '2026-10-02' }),        // co2 has no USD, no default
    bal901: feedItem('bal-901-n', { companyId: null, amount: '20.00', dueDate: '2026-10-03' }),
    bal902: feedItem('bal-902-n', { companyId: 3, currency: 'GBP', amount: '30.00', dueDate: '2026-10-04' }),
    bal903: feedItem('bal-903-n', { companyId: 2, currency: 'GBP', amount: '40.00', dueDate: '2026-10-05' }),
    bal916: feedItem('bal-916-n', { amount: '16.00', dueDate: '2026-10-20' }),                       // skipped by overlay
    bal917: feedItem('bal-917-n', { amount: '17.00', dueDate: '2026-08-01' }),                       // re-dated by overlay
    bal918: feedItem('bal-918-n', { amount: '18.00', dueDate: '2026-10-21', dateBasis: 'estimated', flags: ['estimated'] }),
    dep919: feedItem('dep-919', { kind: 'deposit', amount: '19.00', dueDate: '2026-10-22' }),        // goes gone
};
const FEED = Object.values(F);
const WITHOUT_919 = FEED.filter((i) => i.id !== 'dep-919');

describe('ship lines in /forecast (step 20)', () => {
    let co1;
    let co2;
    let a1;          // co1, GBP, the default
    let a2;          // co1, USD, sort_order 5
    let a3;          // co1, USD, sort_order 2 → the USD account
    let b1;          // co2, GBP, not the default
    let stock;       // the seeded Stock payments category

    beforeAll(async () => {
        const company = async (code, shippingCompanyId) => {
            const co = (await api().post('/api/v1/companies').send({ code, name: code }).expect(201)).body;
            return (await api().put(`/api/v1/companies/${co.id}`).send({ shippingCompanyId }).expect(200)).body;
        };
        co1 = await company('SHA', 1);
        co2 = await company('SHB', 2);
        const account = async (companyId, name, currency, sortOrder, isDefault = false) => {
            const acct = (await api().post('/api/v1/accounts').send({ companyId, name, currency, sortOrder, isDefault }).expect(201)).body;
            await q(api().put(`/api/v1/accounts/${acct.id}/balances/${A}`)).send({ balance: '10000.00' }).expect(200);
            return acct;
        };
        a1 = await account(co1.id, 'Sterling', 'GBP', 1, true);
        a2 = await account(co1.id, 'Dollars B', 'USD', 5);
        a3 = await account(co1.id, 'Dollars A', 'USD', 2);
        b1 = await account(co2.id, 'HW Sterling', 'GBP', 1);
        for (const [currency, rateToGbp] of [['USD', USD], ['CNY', CNY]]) {
            await api().post('/api/v1/fx-rates').send({ currency, rateToGbp, effectiveFrom: '2026-09-01' }).expect(201);
        }
        stock = (await api().get('/api/v1/categories').query({ q: 'Stock payments' }).expect(200)).body.data[0];
        await refreshWith(FEED);
        await overlay('bal-916-n', 'planned_skipped = 1');
        await overlay('bal-917-n', "planned_date = '2026-10-06'");
        await overlay('bal-918-n', "planned_amount = '15.00', planned_base_amount = '18.00'");
        await overlay('dep-919', "planned_note = 'held for QC'");
        await refreshWith(WITHOUT_919);                                    // dep-919 → gone, overlay kept
    });

    test('the Stock payments row: lines, the USD account by sort_order, CNY on the default, paid and owed bands', async () => {
        const body = await ok({ companyId: co1.id, bucket: 'day' });
        expect(Object.keys(body)).toEqual(
            ['meta', 'accounts', 'days', 'buckets', 'rows', 'summary', 'scenario', 'hidden', 'unresolved', 'shipping', 'warnings'],
        );
        const row = body.rows.find((r) => r.categoryId === stock.id);
        expect(row).toMatchObject({ categoryName: 'Stock payments', direction: 'out', sortOrder: 900 });
        expect(lines(body).every((l) => l.kind === 'ship')).toBe(true);

        expect(lineOf(body, 'ship.bal-812-s311')).toEqual({
            key: 'ship.bal-812-s311', kind: 'ship', id: 'bal-812-s311', name: 'Acme Textiles · PO-812 · balance',
            counterparty: 'Acme Textiles', accountId: a3.id, currency: 'USD',
            amountMinor: 1234567, accountMinor: 1234567, gbpMinor: usdGbp(1234567),
            date: '2026-10-15', dueDate: '2026-10-15', bucketIndex: 16, status: 'expected', settleMode: 'manual',
            flags: [], editable: true,
            ship: {
                kind: 'balance', poNumber: 'PO-812', containerRef: 'MSKU1234567', dateBasis: 'firm', amountBasis: 'stated',
                blocked: null, feedDate: '2026-10-15', feedAmountMinor: 1234567,
                dueSet: null, dateMovedFrom: null, dateMovedAt: null,
            },
        });
        // No CNY account: the company's default (GBP) account, through GBP (§9.8).
        expect(lineOf(body, 'ship.dep-813')).toMatchObject({
            name: 'Acme Textiles · PO-812 · deposit', accountId: a1.id, currency: 'CNY',
            amountMinor: 500000, gbpMinor: cnyGbp(500000), accountMinor: cnyGbp(500000),
        });
        expect(lineOf(body, 'ship.bal-814-n')).toMatchObject({ date: TODAY, dueDate: '2026-08-15', flags: ['overdue'], bucketIndex: 0 });
        expect(body.unresolved).toEqual([expect.objectContaining({
            key: 'ship.bal-815-n', kind: 'ship', accountId: a3.id, amountMinor: 20000, ageDays: 46, settleMode: 'manual',
        })]);
        expect(lineOf(body, 'ship.bal-917-n')).toMatchObject({ date: '2026-10-06', dueDate: '2026-10-06', flags: ['planned'] });
        expect(lineOf(body, 'ship.bal-918-n')).toMatchObject({ amountMinor: 1500, flags: ['estimated', 'planned'] });
        expect(placeOf(body, 'ship.bal-916-n')).toBe('none');           // skipped
        expect(placeOf(body, 'ship.pi-77-s311')).toBe('none');          // undated: counted, not banded
        expect(placeOf(body, 'ship.dep-919')).toBe('none');             // gone

        // Paid: A−1 inside the anchor, A..today−1 absorbed with no paymentId, today in today's bucket.
        expect(placeOf(body, 'ship.pay-3-bal812')).toBe('none');
        const usd = body.accounts.find((x) => x.accountId === a3.id);
        expect(usd.absorbed).toEqual([{
            key: 'ship.pay-1-bal812', name: 'Acme Textiles · PO-812 · balance', categoryId: stock.id, date: '2026-09-25',
            currency: 'USD', amountMinor: 30000, accountMinor: 30000, gbpMinor: usdGbp(30000), direction: 'out', flags: ['paid'],
        }]);
        expect(usd.openingNative).toBe(1000000 - 30000);
        const paidToday = lineOf(body, 'ship.pay-2-bal812');
        expect(paidToday).toMatchObject({ date: TODAY, bucketIndex: 0, status: 'paid', flags: ['paid'], editable: false });
        expect('paymentId' in paidToday).toBe(false);

        expect(body.shipping).toEqual({
            lastSuccessAt: expect.any(String), feedToday: TODAY,
            openCount: 8, undatedCount: 1, undatedGbp: usdGbp(75025), unmappedCount: 2,
        });
        expect(new Date(body.shipping.lastSuccessAt).toISOString()).toBe(body.shipping.lastSuccessAt);
        // bal-900-s1 belongs to co2 (matched, but no USD account and no default): not co1's to report.
        expect(shipWarnings(body)).toEqual([
            { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 3, count: 1, reason: 'company' },
            { code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-919' },
        ]);
        expect(body.meta.ratesUsed).toMatchObject({ CNY: { rateToGbp: CNY }, USD: { rateToGbp: USD } });
        expect(body.warnings.some((w) => w.code === 'SHIPPING_UNAVAILABLE')).toBe(false);
    });

    test('SHIP_PLAN_STALE: the feed amount moved under a planned amount', async () => {
        await refreshWith(WITHOUT_919.map((i) => (i.id === 'bal-918-n' ? { ...i, amount: '18.50' } : i)));
        const body = await ok({ companyId: co1.id });
        expect(lineOf(body, 'ship.bal-918-n')).toMatchObject({ amountMinor: 1850, ship: expect.objectContaining({ feedAmountMinor: 1850 }) });
        expect(shipWarnings(body)).toContainEqual({ code: 'SHIP_PLAN_STALE', key: 'ship.bal-918-n' });
        await refreshWith(WITHOUT_919);
        expect(shipWarnings(await ok({ companyId: co1.id }))).not.toContainEqual({ code: 'SHIP_PLAN_STALE', key: 'ship.bal-918-n' });
    });

    test('SHIP_UNMAPPED per shipping company in all; accounts by currency, else the default; re-mapping moves rows', async () => {
        const all = await ok({ companyId: 'all' });
        expect(shipWarnings(all).filter((w) => w.code === 'SHIP_UNMAPPED')).toEqual([
            { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' },
            // co2 is linked, but its only account is GBP and not the default: bal-900-s1 (USD) has nowhere to land.
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 2, count: 1, reason: 'account', companyId: co2.id, currencies: ['USD'] },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 3, count: 1, reason: 'company' },
        ]);
        expect(all.shipping.unmappedCount).toBe(3);
        expect(lineOf(all, 'ship.bal-903-n')).toMatchObject({ accountId: b1.id, currency: 'GBP', amountMinor: 4000 });
        expect(placeOf(all, 'ship.bal-900-s1')).toBe('none');

        try {
            // co2 gains a default: its USD row lands there, through GBP.
            await api().put(`/api/v1/accounts/${b1.id}`).send({ isDefault: true }).expect(200);
            const withDefault = await ok({ companyId: 'all' });
            expect(lineOf(withDefault, 'ship.bal-900-s1')).toMatchObject({ accountId: b1.id, amountMinor: 1000, accountMinor: usdGbp(1000) });
            expect(withDefault.shipping.unmappedCount).toBe(2);
            expect(shipWarnings(withDefault)).not.toContainEqual(expect.objectContaining({ code: 'SHIP_UNMAPPED', shippingCompanyId: 2 }));

            // The USD account goes inactive: the next USD account by sort_order; then the default.
            await api().put(`/api/v1/accounts/${a3.id}`).send({ isActive: false }).expect(200);
            expect(lineOf(await ok({ companyId: co1.id }), 'ship.bal-812-s311').accountId).toBe(a2.id);
            await api().put(`/api/v1/accounts/${a2.id}`).send({ isActive: false }).expect(200);
            const onDefault = lineOf(await ok({ companyId: co1.id }), 'ship.bal-812-s311');
            expect(onDefault).toMatchObject({ accountId: a1.id, amountMinor: 1234567, accountMinor: usdGbp(1234567) });

            // Unmapping co1 unmaps every row of shipping company 1, counted under 1.
            await api().put(`/api/v1/companies/${co1.id}`).send({ shippingCompanyId: null }).expect(200);
            const unmapped = await ok({ companyId: 'all' });
            expect(lines(unmapped).map((l) => l.key)).not.toContain('ship.bal-812-s311');
            expect(shipWarnings(unmapped)).toContainEqual({ code: 'SHIP_UNMAPPED', shippingCompanyId: 1, count: 10, reason: 'company' });
        } finally {
            await api().put(`/api/v1/companies/${co1.id}`).send({ shippingCompanyId: 1 }).expect(200);
            await api().put(`/api/v1/accounts/${a2.id}`).send({ isActive: true }).expect(200);
            await api().put(`/api/v1/accounts/${a3.id}`).send({ isActive: true }).expect(200);
            await h.sql('UPDATE bank_accounts SET is_default = 0 WHERE id = ?', [b1.id]);
        }
        expect(lineOf(await ok({ companyId: co1.id }), 'ship.bal-812-s311').accountId).toBe(a3.id);
    });

    test('SHIP_UNMAPPED says why: no company linked, or a linked company with no account to land on; a default clears it', async () => {
        const unmappedOf = (body) => shipWarnings(body).filter((w) => w.code === 'SHIP_UNMAPPED');
        // No JFlow company is linked to shipping company 3, and bal-901-n has none in shipping: 'company', in every scope.
        expect(unmappedOf(await ok({ companyId: co1.id }))).toEqual([
            { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 3, count: 1, reason: 'company' },
        ]);

        // Shipping company 1 moves to a company with no accounts at all: every currency fails.
        const co4 = (await api().post('/api/v1/companies').send({ code: 'SHD', name: 'SHD' }).expect(201)).body;
        let usd = null;
        try {
            await api().put(`/api/v1/companies/${co1.id}`).send({ shippingCompanyId: null }).expect(200);
            await api().put(`/api/v1/companies/${co4.id}`).send({ shippingCompanyId: 1 }).expect(200);
            const noAccounts = await ok({ companyId: 'all' });
            expect(unmappedOf(noAccounts)).toEqual([
                { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' },
                { code: 'SHIP_UNMAPPED', shippingCompanyId: 1, count: 10, reason: 'account', companyId: co4.id, currencies: ['CNY', 'USD'] },
                { code: 'SHIP_UNMAPPED', shippingCompanyId: 2, count: 1, reason: 'account', companyId: co2.id, currencies: ['USD'] },
                { code: 'SHIP_UNMAPPED', shippingCompanyId: 3, count: 1, reason: 'company' },
            ]);
            expect(noAccounts.shipping.unmappedCount).toBe(13);
            // Matched rows are co4's to report, not co1's.
            expect(unmappedOf(await ok({ companyId: co1.id })).map((w) => w.shippingCompanyId)).toEqual([null, 3]);
            expect(unmappedOf(await ok({ companyId: co4.id }))).toContainEqual(
                expect.objectContaining({ shippingCompanyId: 1, reason: 'account', companyId: co4.id, currencies: ['CNY', 'USD'] }),
            );

            // A USD account that is not the default: the USD rows land on it, CNY still has nowhere to go.
            usd = (await api().post('/api/v1/accounts').send({ companyId: co4.id, name: 'D Dollars', currency: 'USD' }).expect(201)).body;
            expect(unmappedOf(await ok({ companyId: 'all' }))).toContainEqual(
                { code: 'SHIP_UNMAPPED', shippingCompanyId: 1, count: 1, reason: 'account', companyId: co4.id, currencies: ['CNY'] },
            );

            // Marking it the default clears the warning: CNY falls back to it.
            await api().put(`/api/v1/accounts/${usd.id}`).send({ isDefault: true }).expect(200);
            const withDefault = await ok({ companyId: 'all' });
            expect(unmappedOf(withDefault).map((w) => w.shippingCompanyId)).toEqual([null, 2, 3]);
            expect(withDefault.shipping.unmappedCount).toBe(3);
        } finally {
            if (usd) await api().delete(`/api/v1/accounts/${usd.id}`).expect(204);
            await api().put(`/api/v1/companies/${co4.id}`).send({ shippingCompanyId: null }).expect(200);
            await api().delete(`/api/v1/companies/${co4.id}`).expect(204);
            await api().put(`/api/v1/companies/${co1.id}`).send({ shippingCompanyId: 1 }).expect(200);
        }
        expect(lineOf(await ok({ companyId: co1.id }), 'ship.bal-812-s311').accountId).toBe(a3.id);
    });

    test('GET /external-items: the §6.12 row, resolution, effective values; order and filters', async () => {
        const body = await externalItems({ includeGone: '1' });
        expect(body).toMatchObject({ page: 1, limit: 500, total: FEED.length });
        const byId = Object.fromEntries(body.data.map((r) => [r.extId, r]));
        expect(Object.keys(byId['bal-812-s311'])).toEqual([
            'key', 'id', 'source', 'extId', 'feedKind', 'feedStatus', 'supplier', 'shippingCompanyId', 'companyId',
            'accountId', 'poId', 'poNumber', 'shipmentId', 'containerRef', 'label', 'currency', 'amount', 'dueDate', 'paidOn',
            'settles', 'dateBasis', 'amountBasis', 'blocked', 'flags', 'dueSet', 'dueDatePrev', 'dueDateMovedAt', 'goneAt',
            'plannedDate', 'plannedAmount',
            'plannedSkipped', 'plannedBaseAmount', 'plannedNote', 'sourceScenarioId', 'plannedBy', 'plannedAt',
            'effectiveDate', 'effectiveAmount', 'planStale', 'derivedStatus', 'dateMoved', 'rowVersion', 'createdBy', 'createdAt',
            'updatedAt',
        ]);
        expect(byId['bal-812-s311']).toMatchObject({
            key: 'ship.bal-812-s311', source: 'ship', feedStatus: 'open', shippingCompanyId: 1, companyId: co1.id,
            accountId: a3.id, amount: '12345.67', effectiveDate: '2026-10-15', effectiveAmount: '12345.67',
            planStale: false, derivedStatus: 'expected', createdBy: 'shipping-feed',
        });
        expect(byId['bal-918-n']).toMatchObject({ plannedAmount: '15.00', effectiveAmount: '15.00', planStale: false });
        expect(byId['bal-917-n']).toMatchObject({ dueDate: '2026-08-01', plannedDate: '2026-10-06', effectiveDate: '2026-10-06' });
        expect(byId['pay-1-bal812']).toMatchObject({ effectiveDate: '2026-09-25', derivedStatus: 'paid' });
        expect(byId['bal-900-s1']).toMatchObject({ companyId: co2.id, accountId: null, derivedStatus: null });
        expect(byId['bal-901-n']).toMatchObject({ companyId: null, accountId: null, derivedStatus: null });
        expect(byId['dep-919']).toMatchObject({ goneAt: expect.any(String), plannedNote: 'held for QC', derivedStatus: null });
        expect(byId['pi-77-s311']).toMatchObject({ effectiveDate: null, derivedStatus: null });

        // Effective date ascending, undated last, then id.
        const dates = body.data.map((r) => r.effectiveDate);
        const dated = dates.filter((d) => d !== null);
        expect(dated).toEqual([...dated].sort());
        expect(dates.slice(dated.length).every((d) => d === null)).toBe(true);

        expect((await externalItems()).total).toBe(FEED.length - 1);                         // gone excluded
        const paid = await externalItems({ status: 'paid' });
        expect(paid.data.map((r) => r.extId).sort()).toEqual(['pay-1-bal812', 'pay-2-bal812', 'pay-3-bal812']);
        const co2Rows = await externalItems({ companyId: co2.id });
        expect(co2Rows.data.map((r) => r.extId)).toEqual(['bal-900-s1', 'bal-903-n']);
        const window = await externalItems({ from: '2026-10-01', to: '2026-10-05' });
        expect(window.data.map((r) => r.extId)).toEqual(['dep-813', 'bal-900-s1', 'bal-901-n', 'bal-902-n', 'bal-903-n']);
        expect((await externalItems({ q: 'MSKU' })).total).toBeGreaterThan(0);
        expect((await externalItems({ q: 'no-such-thing' })).total).toBe(0);

        for (const bad of [{ status: 'late' }, { companyId: 'x' }, { from: '2026-02-30' }, { from: '2026-10-05', to: '2026-10-01' }]) {
            await q(api().get('/api/v1/external-items'), bad).expect(400);
        }
        await q(api().get('/api/v1/external-items'), { companyId: 999999 }).expect(400);
    });

    test('derivedStatus on /external-items agrees with /forecast for every row', async () => {
        const list = (await externalItems({ includeGone: '1' })).data;
        for (const scope of [co1.id, 'all']) {
            const body = await ok({ companyId: scope });
            const accounts = new Set(body.accounts.map((a) => a.accountId));
            const seen = new Set();
            for (const r of list) {
                if (r.accountId !== null && !accounts.has(r.accountId)) continue;   // another company's
                const place = placeOf(body, r.key);
                seen.add(r.derivedStatus);
                const expected = {
                    expected: ['rows'],
                    overdue: ['rows:overdue'],
                    unresolved: ['unresolved'],
                    paid: r.paidOn < A ? ['none'] : ['rows:paid', 'absorbed'],
                    skipped: ['none'],
                    null: ['none'],
                }[String(r.derivedStatus)];
                expect({ key: r.key, derivedStatus: r.derivedStatus, place, allowed: expected.includes(place) })
                    .toEqual({ key: r.key, derivedStatus: r.derivedStatus, place, allowed: true });
            }
            expect([...seen].map(String).sort()).toEqual(['expected', 'null', 'overdue', 'paid', 'skipped', 'unresolved']);
        }
    });

    test('a failed refresh → 200 + SHIPPING_UNAVAILABLE on the last snapshot; include=summary keeps shipping', async () => {
        const before = await ok({ companyId: co1.id });
        const lastSuccessAt = before.shipping.lastSuccessAt;
        // Make the snapshot due, then fail the read.
        expect(typeof lastSuccessAt).toBe('string');
        await h.sql("UPDATE external_sync SET last_success_at = last_success_at - INTERVAL 11 MINUTE, last_attempt_at = NULL WHERE source = 'ship'");
        const stale = (await h.sql("SELECT last_success_at FROM external_sync WHERE source = 'ship'"))[0].last_success_at.toISOString();
        stub.reset();
        stub.fail('source_error');

        const body = await ok({ companyId: co1.id });
        expect(body.warnings).toContainEqual({ code: 'SHIPPING_UNAVAILABLE', reason: 'source_error', lastSuccessAt: stale });
        expect(body.shipping).toMatchObject({ lastSuccessAt: stale, openCount: 8 });
        expect(lineOf(body, 'ship.bal-812-s311').accountId).toBe(a3.id);          // the last snapshot, unchanged
        expect(stub.requests).toHaveLength(1);

        // Inside the 60-second claim the next request does not fetch, and still says why.
        const summary = await ok({ companyId: co1.id, include: 'summary' });
        expect('rows' in summary).toBe(false);
        expect(summary.shipping).toMatchObject({ lastSuccessAt: stale, undatedCount: 1 });
        expect(summary.warnings).toContainEqual({ code: 'SHIPPING_UNAVAILABLE', reason: 'source_error', lastSuccessAt: stale });
        expect(stub.requests).toHaveLength(1);

        // A source that throws something else (a bug, not an unavailable) is reported as
        // source_error (with the loaded snapshot's age); then an invalid SHIPPING_DB_SCHEMA through the
        // real source is source_schema.
        const saved = process.env.SHIPPING_DB_SCHEMA;
        try {
            await releaseClaim();
            stub.reset();
            stub.respondWith(() => { throw new TypeError('boom'); });
            expect((await ok({ companyId: co1.id })).warnings)
                .toContainEqual({ code: 'SHIPPING_UNAVAILABLE', reason: 'source_error', lastSuccessAt: stale });
            process.env.SHIPPING_DB_SCHEMA = 'no such schema';
            await releaseClaim();
            stub.reset();
            stub.passThrough();
            expect((await ok({ companyId: co1.id })).warnings)
                .toContainEqual({ code: 'SHIPPING_UNAVAILABLE', reason: 'source_schema', lastSuccessAt: stale });
            expect(stub.requests).toHaveLength(1);
        } finally {
            process.env.SHIPPING_DB_SCHEMA = saved;
        }

        // The feed is back: the next due /forecast refreshes and the warning goes.
        await releaseClaim();
        stub.reset();
        stub.respond(feedBody(WITHOUT_919));
        const back = await ok({ companyId: co1.id });
        expect(back.warnings.some((w) => w.code === 'SHIPPING_UNAVAILABLE')).toBe(false);
        expect(back.shipping.lastSuccessAt > stale).toBe(true);
        expect(stub.requests).toHaveLength(1);
    });

    test('rule 6 and loadTarget for ship. keys; a draft scenario\'s ship. adjustments (§9.5)', async () => {
        const target = (key) => db.withConnection((c) => load.loadTarget(c, parseKey(key), TODAY));
        expect(await target('ship.bal-812-s311')).toEqual({
            kind: 'ship', id: 'bal-812-s311', naturalDate: null, status: 'expected', effectiveDate: '2026-10-15',
            effectiveAmount: '12345.67', currency: 'USD', accountId: a3.id, settleMode: 'manual', hasPaymentState: false,
            overrideId: null,
        });
        expect(await target('ship.bal-917-n')).toMatchObject({ effectiveDate: '2026-10-06', status: 'expected' });
        expect(await target('ship.bal-918-n')).toMatchObject({ effectiveAmount: '15.00' });
        expect(await target('ship.bal-916-n')).toMatchObject({ status: 'skipped', hasPaymentState: false });
        expect(await target('ship.pay-1-bal812')).toMatchObject({ status: 'paid', effectiveDate: '2026-09-25', hasPaymentState: true });
        expect(await target('ship.bal-901-n')).toMatchObject({ accountId: null, status: 'expected' });
        expect(await target('ship.pi-77-s311')).toBeNull();          // undated
        expect(await target('ship.dep-919')).toBeNull();             // gone
        expect(await target('ship.no-such-row')).toBeNull();
        expect(await target('ship.BAL-812-S311')).toBeNull();        // the ext_id must match exactly

        const scenarioId = await insertScenario(h, { name: 'Ship what-if', companyId: co1.id });
        const adjust = (itemKey, over) => insertAdjustment(h, { scenarioId, itemKey, ...over });
        await adjust('ship.bal-812-s311', { newDate: '2026-10-29', baseDate: '2026-10-15', baseAmount: '12345.67' });
        await adjust('ship.bal-917-n', { kind: 'exclude', baseDate: '2026-10-06', baseAmount: '17.00' });
        await adjust('ship.dep-813', { newDate: '2026-10-02', baseDate: '2026-09-30', baseAmount: '5000.00' });   // drifted
        await adjust('ship.dep-919', { kind: 'exclude', baseDate: '2026-10-22', baseAmount: '19.00' });          // gone
        await adjust('ship.pay-2-bal812', { kind: 'exclude', baseDate: TODAY, baseAmount: '50.00' });            // paid
        await adjust('ship.bal-903-n', { kind: 'exclude', baseDate: '2026-10-05', baseAmount: '40.00' });         // co2's

        const loaded = await db.withConnection((c) => load.loadEngineInput(c, {
            today: TODAY, companyId: co1.id, scenario: { id: scenarioId, name: 'Ship what-if', status: 'draft' },
        }));
        const targets = Object.fromEntries(loaded.externalItems.map((e) => [e.extId, e]));
        expect(targets['dep-919']).toMatchObject({ goneAt: expect.any(Date), inScope: true });
        expect(targets['bal-903-n']).toMatchObject({ accountId: b1.id, inScope: false });
        expect(loaded.categories.map((c) => c.systemKey)).toContain('ship');

        const body = await ok({ companyId: co1.id, scenarioId });
        expect(lineOf(body, 'ship.bal-812-s311')).toMatchObject({
            date: '2026-10-29', flags: ['adjusted'], baseline: expect.objectContaining({ date: '2026-10-15' }),
        });
        expect(lineOf(body, 'ship.bal-917-n').flags).toEqual(['planned', 'excluded']);
        expect(body.scenario.warnings).toEqual([
            { code: 'STALE', key: 'ship.dep-813', reason: 'BASE_CHANGED' },
            { code: 'STALE', key: 'ship.dep-919', reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'ship.pay-2-bal812', reason: 'TARGET_SETTLED' },
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: 'ship.bal-903-n' },
        ]);
        const oct = (b) => b.buckets.find((x) => x.start <= '2026-10-15' && x.end >= '2026-10-15');
        expect(oct(body).outflow).toBe(oct(await ok({ companyId: co1.id })).outflow - usdGbp(1234567));
    });

    test('FX_RATE_MISSING for a ship currency in scope', async () => {
        const co3 = (await api().post('/api/v1/companies').send({ code: 'SHC', name: 'SHC' }).expect(201)).body;
        await api().put(`/api/v1/companies/${co3.id}`).send({ shippingCompanyId: 4 }).expect(200);
        const acct = (await api().post('/api/v1/accounts').send({ companyId: co3.id, name: 'C', currency: 'GBP', isDefault: true }).expect(201)).body;
        await q(api().put(`/api/v1/accounts/${acct.id}/balances/${A}`)).send({ balance: '1.00' }).expect(200);
        await refreshWith([...WITHOUT_919, feedItem('bal-950-n', { companyId: 4, currency: 'HKD', amount: '1.00', dueDate: null, dateBasis: 'undated' })]);
        const res = await forecast({ companyId: co3.id }).expect(422);
        expect(res.body).toMatchObject({ code: 'FX_RATE_MISSING', details: { currencies: ['HKD'] } });
        await ok({ companyId: co1.id });                                              // another scope is unaffected
    });
});
