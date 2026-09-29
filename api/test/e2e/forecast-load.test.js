'use strict';

// services/forecastLoad.js, item side (CONTRACT §8), against a per-run
// jflow_test_<runid> schema: which one-off items each load rule selects
// (rules 1, 2, 5), item targets by id with their scope (rule 6), payment rows
// (rule 4), anchors (rule 9) and loadTarget's item branch. Rows in, the
// camelCase engine-input shape out, money still DECIMAL strings.

const { startHarness } = require('./harness');
const { parseKey } = require('../../src/lib/keys');

jest.setTimeout(180000);

let h;
let db;
let load;
beforeAll(async () => {
    h = await startHarness();
    // After the harness: the pool reads DB_NAME, which the harness points at the run's schema.
    db = require('../../src/db');
    load = require('../../src/services/forecastLoad');
});
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';
const MIN_A = '2026-03-01';
const TO = '2026-06-30';

const withToday = (req, today) => req.query({ today });
const post = (path, body, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const withConn = (fn) => db.withConnection(fn);

describe('forecastLoad — item side', () => {
    let inScope;
    let outScope;
    let noAnchor;
    const items = {};

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        const jfa = companies.find((c) => c.code === 'JFA');
        const hw = companies.find((c) => c.code === 'HW');
        const account = async (body) => (await api().post('/api/v1/accounts').send(body).expect(201)).body;
        inScope = await account({ companyId: jfa.id, name: 'In scope', currency: 'GBP' });
        outScope = await account({ companyId: hw.id, name: 'Out of scope', currency: 'GBP' });
        noAnchor = await account({ companyId: jfa.id, name: 'No anchor', currency: 'GBP' });
        const category = (await api().post('/api/v1/categories').send({ name: 'Costs', direction: 'out' }).expect(201)).body;
        await put(`/accounts/${inScope.id}/balances/2026-02-15`, { balance: '50.00' }).expect(200);
        await put(`/accounts/${inScope.id}/balances/${MIN_A}`, { balance: '100.00' }).expect(200);
        await put(`/accounts/${outScope.id}/balances/2026-02-01`, { balance: '-7.25' }).expect(200);

        const make = async (key, body, today = TODAY) => {
            items[key] = (await post('/items', {
                accountId: inScope.id, categoryId: category.id, name: key, amount: '100.00', ...body,
            }, today).expect(201)).body;
        };
        await make('dated', { dueDate: '2026-03-15' });                                  // rule 1
        await make('datedManual', { dueDate: '2026-03-12', settleMode: 'manual' });       // rule 1
        await make('afterTo', { dueDate: '2026-07-15' });                                 // none
        await make('autoBeforeA', { dueDate: '2026-02-01' });                             // none
        await make('manualOwed', { dueDate: '2026-01-10', settleMode: 'manual' });        // rule 5
        await make('partOld', { dueDate: '2025-12-20' });                                 // rule 5 (part_paid)
        await make('paidLate', { dueDate: '2026-02-10' });                                // rule 2
        await make('paidEarly', { dueDate: '2026-02-10' });                               // none
        await make('manualPaid', { dueDate: '2026-02-05', settleMode: 'manual' });        // none
        await make('manualSkipped', { dueDate: '2026-02-10', settleMode: 'manual' });     // none
        await make('straddle', { dueDate: '2026-03-20', amount: '1000.00' });             // rule 1, two payments
        await make('deleted', { dueDate: '2026-03-15' });                                 // none
        await make('elsewhere', { dueDate: '2026-03-15', accountId: outScope.id });       // rule 6 only

        // A part payment made on 15 Dec, before the item fell due: it stays
        // part_paid with due_date and paid_on both before minA.
        await post(`/items/${items.partOld.id}/pay`, { paidOn: '2025-12-15', paidAmount: '10.00' }, '2025-12-15').expect(200);
        await post(`/items/${items.paidLate.id}/pay`, { paidOn: '2026-03-02' }).expect(200);
        await post(`/items/${items.paidEarly.id}/pay`, { paidOn: '2026-02-20' }).expect(200);
        await post(`/items/${items.manualPaid.id}/pay`, { paidOn: '2026-02-06' }).expect(200);
        await put(`/items/${items.manualSkipped.id}`, { status: 'skipped' }).expect(200);
        await post(`/items/${items.straddle.id}/pay`, { paidOn: '2026-02-24', paidAmount: '400.00' }).expect(200);
        await post(`/items/${items.straddle.id}/pay`, { paidOn: '2026-03-03', paidAmount: '300.00' }).expect(200);
        await api().delete(`/api/v1/items/${items.deleted.id}`).expect(204);
    });

    test('loadAnchors: the latest balance on or before today, per account (rule 9)', async () => {
        const ids = [inScope.id, outScope.id, noAnchor.id];
        const anchors = await withConn((c) => load.loadAnchors(c, ids, TODAY));
        expect([...anchors.keys()].sort((a, b) => a - b)).toEqual([inScope.id, outScope.id]);
        expect(anchors.get(inScope.id)).toEqual({ anchorDate: MIN_A, anchorBalance: '100.00' });
        expect(anchors.get(outScope.id)).toEqual({ anchorDate: '2026-02-01', anchorBalance: '-7.25' });
        // A pinned today before the latest balance sees the one before it.
        const earlier = await withConn((c) => load.loadAnchors(c, ids, '2026-02-20'));
        expect(earlier.get(inScope.id)).toEqual({ anchorDate: '2026-02-15', anchorBalance: '50.00' });
        expect((await withConn((c) => load.loadAnchors(c, [], TODAY))).size).toBe(0);
    });

    test('loadItems: rules 1, 2 and 5 over the in-scope accounts, each item once, by due_date', async () => {
        const rows = await withConn((c) => load.loadItems(c, {
            accountIds: [inScope.id], minA: MIN_A, to: TO, today: TODAY,
        }));
        expect(rows.map((r) => r.name)).toEqual(['partOld', 'manualOwed', 'paidLate', 'datedManual', 'dated', 'straddle']);
        for (const row of rows) {
            expect(row.inScope).toBe(true);
            expect(row).not.toHaveProperty('payments');
            expect(row).not.toHaveProperty('derivedStatus');
            expect(typeof row.amount).toBe('string');
        }
        const partOld = rows.find((r) => r.name === 'partOld');
        expect(partOld).toMatchObject({
            key: items.partOld.key, status: 'part_paid', dueDate: '2025-12-20', paidOn: '2025-12-15',
            paidAmount: '10.00', remainingAmount: '90.00', accountId: inScope.id, companyId: inScope.companyId,
        });
        expect(await withConn((c) => load.loadItems(c, { accountIds: [], minA: MIN_A, to: TO, today: TODAY })))
            .toEqual([]);
    });

    test('loadItemTargets: by id whatever the bounds, with inScope; deleted or absent ids are left out (rule 6)', async () => {
        const rows = await withConn((c) => load.loadItemTargets(
            c, [items.elsewhere.id, items.afterTo.id, items.deleted.id, 999999], [inScope.id],
        ));
        expect(rows.map((r) => [r.name, r.inScope])).toEqual([['afterTo', true], ['elsewhere', false]]);
    });

    test('loadItemPayments: every row, or only paid_on >= minA (rule 4), ascending by paid_on', async () => {
        const ids = [items.straddle.id, items.paidLate.id, items.partOld.id];
        const all = await withConn((c) => load.loadItemPayments(c, ids));
        expect(all.map((p) => [p.cashItemId, p.paidOn, p.amount])).toEqual([
            [items.partOld.id, '2025-12-15', '10.00'],
            [items.straddle.id, '2026-02-24', '400.00'],
            [items.paidLate.id, '2026-03-02', '100.00'],
            [items.straddle.id, '2026-03-03', '300.00'],
        ]);
        expect(Object.keys(all[0]).sort())
            .toEqual(['amount', 'cashItemId', 'createdAt', 'createdBy', 'id', 'note', 'overrideId', 'paidOn']);
        const since = await withConn((c) => load.loadItemPayments(c, ids, { since: MIN_A }));
        expect(since.map((p) => p.paidOn)).toEqual(['2026-03-02', '2026-03-03']);
    });

    test('loadTarget: the item branch, null for deleted, ship. and absent sched. keys', async () => {
        const target = await withConn((c) => load.loadTarget(c, parseKey(items.dated.key), TODAY));
        expect(target).toEqual({
            kind: 'item', id: items.dated.id, naturalDate: null, status: 'expected', effectiveDate: '2026-03-15',
            effectiveAmount: '100.00', currency: 'GBP', accountId: inScope.id, settleMode: 'auto',
            hasPaymentState: false, overrideId: null,
        });
        const paid = await withConn((c) => load.loadTarget(c, parseKey(items.paidLate.key), TODAY));
        expect(paid).toMatchObject({ status: 'paid', hasPaymentState: true });
        expect(await withConn((c) => load.loadTarget(c, parseKey(items.deleted.key), TODAY))).toBeNull();
        expect(await withConn((c) => load.loadTarget(c, parseKey('ship.PO-778'), TODAY))).toBeNull();
        expect(await withConn((c) => load.loadTarget(c, null, TODAY))).toBeNull();
        // No schedule 1 in this schema (the sched. branch itself is pinned in schedules.test.js).
        expect(await withConn((c) => load.loadTarget(c, parseKey('sched.1.2026-03-01'), TODAY))).toBeNull();
    });
});
