'use strict';

// services/forecastLoad.js end to end (CONTRACT §8, BUILD_PLAN step 6): the assembled
// `engineInput` of lib/engine.js's typedef, against a per-run jflow_test_<runid> schema.
// Pinned here, rule by rule:
//   - the account set: live + active accounts of the company (or all), anchors = the
//     latest balance on or before today, NO_ANCHOR for the rest, whose rows stay unloaded;
//   - rule 1 for schedules with the weekend-widened bound (start_date <= to + 2,
//     end_date >= minA − 2), both edges;
//   - rule 2 (paid late), rule 3 (EVERY override of a loaded schedule: amount-only, moved
//     out, orphan, part-paid behind minA), rule 4 (payments since minA only);
//   - rule 5: manual schedules back to today − 730; and a schedule that no longer reaches
//     the window but has an override that needs it — moved into [minA, to], part_paid, or
//     manual + expected (rules 1/3/5 read together: rule 3 alone never sees them);
//   - rule 6: every adjustment target by key, out-of-scope ones with inScope: false,
//     deleted / absent / ship. targets absent; rule 7: late joiners bring their overrides;
//   - rules 8–10: rates for currenciesInScope only (latest effective_from <= today),
//     categories of what was loaded, adjustments ascending, scenario {id, name, status};
//   - de-duplication across rules, and the loader's `to` = clampWindow(...).to.

const { startHarness } = require('./harness');
const {
    insertSchedule, insertOverride, insertOverridePayment, insertScenario, insertAdjustment,
} = require('./forecastHelpers');

jest.setTimeout(240000);

let h;
let db;
let load;
let engine;
beforeAll(async () => {
    h = await startHarness();
    // After the harness: the pool reads DB_NAME, which the harness points at the run's schema.
    db = require('../../src/db');
    load = require('../../src/services/forecastLoad');
    engine = require('../../src/lib/engine');
});
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';       // a Tuesday
const MIN_A = '2026-03-01';       // main's anchor, the earliest in scope
const FROM = '2026-03-01';        // as requested (the engine clamps it)
const TO = '2026-04-30';          // to + 2 = 2026-05-02; minA − 2 = 2026-02-27

const q = (req, today = TODAY) => req.query({ today });
const post = (path, body, today) => q(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body, today) => q(api().put(`/api/v1${path}`), today).send(body);
const withConn = (fn) => db.withConnection(fn);
const byId = (a, b) => a.id - b.id;
const names = (rows) => rows.map((r) => r.name).sort();

describe('loadEngineInput (§8 → the engineInput typedef)', () => {
    let inCo;
    let outCo;
    let main;        // GBP, anchors 2026-02-15 and 2026-03-01 (→ minA)
    let second;      // EUR, anchor 2026-03-05
    let bare;        // GBP, no balance (NO_ANCHOR)
    let dormant;     // GBP, inactive: not in the set
    let other;       // outCo, USD, anchor 2026-03-01
    let costs;
    let sales;
    let unused;
    const items = {};
    const sched = {};
    const over = {};
    let scenarioId;
    const adj = {};

    beforeAll(async () => {
        const company = async (code) => (await api().post('/api/v1/companies').send({ code, name: code }).expect(201)).body;
        inCo = await company('LDIN');
        outCo = await company('LDOUT');
        const account = async (body) => (await api().post('/api/v1/accounts').send(body).expect(201)).body;
        main = await account({ companyId: inCo.id, name: 'A main', currency: 'GBP' });
        second = await account({ companyId: inCo.id, name: 'B second', currency: 'EUR' });
        bare = await account({ companyId: inCo.id, name: 'C bare', currency: 'GBP' });
        dormant = await account({ companyId: inCo.id, name: 'D dormant', currency: 'GBP' });
        await api().put(`/api/v1/accounts/${dormant.id}`).send({ isActive: false }).expect(200);
        other = await account({ companyId: outCo.id, name: 'E other', currency: 'USD' });
        const category = async (name, direction) => (await api().post('/api/v1/categories').send({ name, direction }).expect(201)).body;
        costs = await category('Costs', 'out');
        sales = await category('Sales', 'in');
        unused = await category('Unused', 'out');

        await put(`/accounts/${main.id}/balances/2026-02-15`, { balance: '50.00' }).expect(200);
        await put(`/accounts/${main.id}/balances/${MIN_A}`, { balance: '1000.00' }).expect(200);
        await put(`/accounts/${second.id}/balances/2026-03-05`, { balance: '200.00' }).expect(200);
        await put(`/accounts/${other.id}/balances/2026-03-01`, { balance: '300.00' }).expect(200);

        const rate = (currency, rateToGbp, effectiveFrom) => api().post('/api/v1/fx-rates')
            .send({ currency, rateToGbp, effectiveFrom }).expect(201);
        await rate('EUR', '0.850000', '2026-01-01');
        await rate('EUR', '0.860000', '2026-04-01');      // after today: not the run's rate
        await rate('USD', '0.750000', '2026-02-01');
        await rate('JPY', '0.005000', '2026-01-01');      // no JPY in scope: not loaded

        const item = async (key, body, today) => {
            items[key] = (await post('/items', {
                accountId: main.id, categoryId: costs.id, name: key, amount: '100.00', dueDate: '2026-03-15', ...body,
            }, today).expect(201)).body;
        };
        await item('inWindow', {});
        await item('eurItem', { accountId: second.id, categoryId: sales.id, dueDate: '2026-03-20' });
        await item('onBare', { accountId: bare.id });
        await item('elsewhere', { accountId: other.id, dueDate: '2026-03-20' });
        await item('farTarget', { dueDate: '2026-09-01' });
        await item('targetInWindow', { dueDate: '2026-03-25' });
        await item('deletedTarget', { dueDate: '2026-03-25' });
        await item('paidStraddle', { dueDate: '2026-02-20', amount: '1000.00' });
        await item('withinCap', { dueDate: '2028-03-01' });
        await item('beyondCap', { dueDate: '2028-06-01' });
        await api().delete(`/api/v1/items/${items.deletedTarget.id}`).expect(204);
        // 400 on 25 Feb (before minA: not loaded), 300 on 2 Mar (loaded).
        await post(`/items/${items.paidStraddle.id}/pay`,
            { paidOn: '2026-02-25', paidAmount: '400.00', remainderDueDate: '2026-03-12' }, '2026-02-25').expect(200);
        await post(`/items/${items.paidStraddle.id}/pay`, { paidOn: '2026-03-02', paidAmount: '300.00' }).expect(200);

        const schedule = async (key, s) => {
            sched[key] = await insertSchedule(h, { accountId: main.id, categoryId: costs.id, name: key, ...s });
        };
        await schedule('running', { startDate: '2026-01-20' });
        await schedule('startsLate', { startDate: '2026-05-03' });                                 // to + 3
        await schedule('startsAtEdge', { startDate: '2026-05-02' });                               // to + 2
        await schedule('endsAtEdge', { startDate: '2025-10-27', endDate: '2026-02-27' });          // minA − 2
        await schedule('endedBefore', { startDate: '2025-10-26', endDate: '2026-02-26' });         // minA − 3
        await schedule('manualOld', { startDate: '2025-01-01', endDate: '2025-06-01', settleMode: 'manual' });
        await schedule('manualAncient', { startDate: '2023-01-01', endDate: '2024-03-09', settleMode: 'manual' });
        for (const key of ['paidLate', 'partPaidOld', 'didntHappen', 'tunedOnly', 'settledManual', 'movedIn', 'movedFar']) {
            await schedule(key, { startDate: '2025-10-15', endDate: '2025-12-15' });
        }
        await schedule('elsewhereSched', { accountId: other.id, currency: 'USD', startDate: '2026-01-15' });
        await schedule('onBare', { accountId: bare.id, startDate: '2026-01-15' });
        await schedule('deletedSched', { startDate: '2026-01-15', deleted: true });
        await schedule('targetFar', { startDate: '2026-06-10', categoryId: sales.id, direction: 'in' });

        const override = async (key, o) => { over[key] = await insertOverride(h, o); };
        await override('amountOnly', { scheduleId: sched.running, naturalDate: '2026-03-20', amount: '983.00' });
        await override('orphan', { scheduleId: sched.running, naturalDate: '2026-02-21', amount: '1.00' });
        await override('movedOut', { scheduleId: sched.running, naturalDate: '2026-04-20', dueDate: '2026-12-01' });
        await override('partBehind', {
            scheduleId: sched.running, naturalDate: '2026-01-20', status: 'part_paid', paidAmount: '40.00',
            paidOn: '2026-01-18', dueDate: '2026-02-10',
        });
        await insertOverridePayment(h, { overrideId: over.partBehind, paidOn: '2026-01-18', amount: '40.00' });
        await override('paidLate', {
            scheduleId: sched.paidLate, naturalDate: '2025-12-15', status: 'paid', paidAmount: '100.00', paidOn: '2026-03-02',
        });
        over.paidLatePayment = await insertOverridePayment(h, { overrideId: over.paidLate, paidOn: '2026-03-02', amount: '100.00' });
        await override('partPaidOld', {
            scheduleId: sched.partPaidOld, naturalDate: '2025-12-15', status: 'part_paid', paidAmount: '30.00',
            paidOn: '2025-12-10', dueDate: '2026-01-05',
        });
        await insertOverridePayment(h, { overrideId: over.partPaidOld, paidOn: '2025-12-10', amount: '30.00' });
        await override('didntHappen', { scheduleId: sched.didntHappen, naturalDate: '2025-11-15', settleMode: 'manual' });
        await override('tunedOnly', { scheduleId: sched.tunedOnly, naturalDate: '2025-11-15', amount: '90.00' });
        await override('settledManual', {
            scheduleId: sched.settledManual, naturalDate: '2025-11-15', settleMode: 'manual', status: 'paid',
            paidAmount: '100.00', paidOn: '2025-11-15',
        });
        await override('elsewhere', { scheduleId: sched.elsewhereSched, naturalDate: '2026-02-15', amount: '5.00' });
        // An ended schedule's old instance moved into [minA, to] — and one moved past `to`.
        await override('movedIn', { scheduleId: sched.movedIn, naturalDate: '2025-12-15', dueDate: '2026-03-20' });
        await override('movedFar', { scheduleId: sched.movedFar, naturalDate: '2025-12-15', dueDate: '2026-12-01' });

        scenarioId = await insertScenario(h, { name: 'Loader what-if', companyId: inCo.id });
        const adjust = async (key, a) => { adj[key] = await insertAdjustment(h, { scenarioId, ...a }); };
        await adjust('targetInWindow', { itemKey: items.targetInWindow.key, newAmount: '150.00', baseDate: '2026-03-25', baseAmount: '100.00' });
        await adjust('elsewhere', { itemKey: items.elsewhere.key, newAmount: '150.00', baseDate: '2026-03-20', baseAmount: '100.00' });
        await adjust('farTarget', { itemKey: items.farTarget.key, newDate: '2026-03-30', baseDate: '2026-09-01', baseAmount: '100.00' });
        await adjust('deletedTarget', { itemKey: items.deletedTarget.key, kind: 'exclude', baseDate: '2026-03-25', baseAmount: '100.00' });
        await adjust('elsewhereSched', { itemKey: `sched.${sched.elsewhereSched}.2026-06-15`, kind: 'exclude', baseDate: '2026-06-15', baseAmount: '100.00' });
        await adjust('deletedSched', { itemKey: `sched.${sched.deletedSched}.2026-03-15`, kind: 'exclude', baseDate: '2026-03-15', baseAmount: '100.00' });
        await adjust('targetFar', { itemKey: `sched.${sched.targetFar}.2026-08-10`, newDate: '2026-04-01', baseDate: '2026-08-10', baseAmount: '100.00' });
        await adjust('ship', { itemKey: 'ship.PO-1', kind: 'exclude', baseDate: '2026-03-20', baseAmount: '1.00' });
        await adjust('absent', { itemKey: 'item.999999', kind: 'exclude', baseDate: '2026-03-20', baseAmount: '1.00' });
    });

    const loadIn = (over2 = {}) => withConn(async (c) => load.loadEngineInput(c, {
        today: TODAY, from: FROM, to: TO, bucket: 'week', include: 'grid', companyId: inCo.id,
        scenario: { id: scenarioId, name: 'Loader what-if', status: 'draft' }, ...over2,
    }));

    test('the typedef\'s keys; from / to as requested; accounts, anchors and NO_ANCHOR (rule 9)', async () => {
        const input = await loadIn();
        expect(Object.keys(input).sort()).toEqual([
            'accounts', 'adjustments', 'bucket', 'categories', 'companyId', 'externalItems', 'from', 'include',
            'items', 'overrides', 'payments', 'rates', 'scenario', 'schedules', 'to', 'today', 'warnings',
        ]);
        expect(input).toMatchObject({
            today: TODAY, from: FROM, to: TO, bucket: 'week', include: 'grid', companyId: inCo.id, externalItems: [],
            scenario: { id: scenarioId, name: 'Loader what-if', status: 'draft' },
        });
        // Live + active accounts of the company, in the /accounts order; dormant is out.
        expect(input.accounts).toEqual([
            { id: main.id, companyId: inCo.id, name: 'A main', currency: 'GBP', anchorDate: MIN_A, anchorBalance: '1000.00' },
            { id: second.id, companyId: inCo.id, name: 'B second', currency: 'EUR', anchorDate: '2026-03-05', anchorBalance: '200.00' },
            { id: bare.id, companyId: inCo.id, name: 'C bare', currency: 'GBP', anchorDate: null, anchorBalance: null },
        ]);
        expect(input.warnings).toEqual([{ code: 'NO_ANCHOR', accountId: bare.id }]);
        // A pinned today before a balance does not see it (§8 rule 9, the anchor <= today).
        const early = await loadIn({ today: '2026-02-20', from: '2026-02-20', to: '2026-03-31', scenario: null });
        expect(early.accounts.find((a) => a.id === main.id)).toMatchObject({ anchorDate: '2026-02-15', anchorBalance: '50.00' });
        expect(early.accounts.find((a) => a.id === second.id).anchorDate).toBeNull();
    });

    test('items: rules 1, 2, 5 on anchored accounts, plus rule 6 targets by id; each once; inScope', async () => {
        const input = await loadIn();
        expect(names(input.items)).toEqual(
            ['eurItem', 'elsewhere', 'farTarget', 'inWindow', 'paidStraddle', 'targetInWindow'].sort(),
        );
        expect(new Set(input.items.map((i) => i.id)).size).toBe(input.items.length);
        for (const i of input.items) expect(i.inScope).toBe(i.name !== 'elsewhere');
        expect(input.items.find((i) => i.name === 'paidStraddle')).toMatchObject({
            key: items.paidStraddle.key, status: 'part_paid', dueDate: '2026-03-12', paidAmount: '700.00', amount: '1000.00',
        });
        // The loader's `to` is the clamped one; `to` itself is echoed as requested.
        const wide = await loadIn({ to: '2030-01-01', scenario: null });
        expect(wide.to).toBe('2030-01-01');
        expect(names(wide.items)).toContain('withinCap');
        expect(names(wide.items)).not.toContain('beyondCap');
        expect(names(wide.items)).not.toContain('elsewhere');   // no scenario, no rule 6
    });

    test('schedules: rule 1 widened by two days at both edges, rules 2, 5, 6 and 7; inScope', async () => {
        const input = await loadIn();
        expect(names(input.schedules)).toEqual([
            'running', 'startsAtEdge', 'endsAtEdge', 'manualOld', 'paidLate', 'partPaidOld', 'didntHappen',
            'movedIn', 'elsewhereSched', 'targetFar',
        ].sort());
        expect(new Set(input.schedules.map((s) => s.id)).size).toBe(input.schedules.length);
        for (const s of input.schedules) expect(s.inScope).toBe(s.name !== 'elsewhereSched');
        expect(input.schedules.find((s) => s.name === 'running')).toMatchObject({
            id: sched.running, accountId: main.id, companyId: inCo.id, categoryId: costs.id, direction: 'out',
            amount: '100.00', currency: 'GBP', frequency: 'monthly', intervalCount: 1, startDate: '2026-01-20',
            activeFrom: null, occurrenceCount: null, endDate: null, weekendRule: 'none', settleMode: 'auto',
        });
        expect(input.schedules.find((s) => s.name === 'elsewhereSched')).toMatchObject({ accountId: other.id, currency: 'USD' });
    });

    test('overrides: every row of every loaded schedule, whatever its dates or columns (rule 3, D31)', async () => {
        const input = await loadIn();
        const got = input.overrides.map((o) => o.id).sort((a, b) => a - b);
        const want = [over.amountOnly, over.orphan, over.movedOut, over.partBehind, over.paidLate, over.partPaidOld,
            over.didntHappen, over.movedIn, over.elsewhere].sort((a, b) => a - b);
        expect(got).toEqual(want);
        expect(input.overrides.find((o) => o.id === over.amountOnly)).toMatchObject({
            scheduleId: sched.running, naturalDate: '2026-03-20', amount: '983.00', dueDate: null, status: null,
            settleMode: null, paidOn: null, paidAmount: null, sourceScenarioId: null,
        });
        expect(input.overrides.find((o) => o.id === over.partBehind)).toMatchObject({
            status: 'part_paid', paidAmount: '40.00', paidOn: '2026-01-18', dueDate: '2026-02-10',
        });
    });

    test('payments: rows of loaded items and overrides with paid_on >= minA only (rule 4)', async () => {
        const input = await loadIn();
        const rows = [...input.payments].sort(byId).map((p) => [p.cashItemId, p.overrideId, p.paidOn, p.amount]);
        expect(rows).toEqual([
            [items.paidStraddle.id, null, '2026-03-02', '300.00'],
            [null, over.paidLate, '2026-03-02', '100.00'],
        ]);
        expect(Object.keys(input.payments[0]).sort())
            .toEqual(['amount', 'cashItemId', 'createdAt', 'createdBy', 'id', 'note', 'overrideId', 'paidOn']);
    });

    test('categories of what was loaded; rates for the currencies in scope only (rule 8)', async () => {
        const input = await loadIn();
        expect([...input.categories].sort(byId)).toEqual([
            { id: costs.id, name: 'Costs', direction: 'out', sortOrder: 0 },
            { id: sales.id, name: 'Sales', direction: 'in', sortOrder: 0 },
        ].sort(byId));
        expect(input.categories.map((c) => c.id)).not.toContain(unused.id);
        expect(engine.currenciesInScope(input)).toEqual(['EUR', 'GBP', 'USD']);
        expect(input.rates).toEqual({
            EUR: { rateToGbp: '0.850000', effectiveFrom: '2026-01-01' },
            USD: { rateToGbp: '0.750000', effectiveFrom: '2026-02-01' },
        });
        // Without the scenario, the USD target is gone and so is its rate.
        const plain = await loadIn({ scenario: null });
        expect(plain.rates).toEqual({ EUR: { rateToGbp: '0.850000', effectiveFrom: '2026-01-01' } });
        expect(plain.adjustments).toEqual([]);
    });

    test('adjustments: every row of the scenario, ascending id, in the adjustment JSON (rule 10)', async () => {
        const input = await loadIn();
        expect(input.adjustments.map((a) => a.id)).toEqual(Object.values(adj).sort((a, b) => a - b));
        expect(input.adjustments[0]).toMatchObject({
            id: adj.targetInWindow, scenarioId, itemKey: items.targetInWindow.key, targetKind: 'item',
            targetId: String(items.targetInWindow.id), targetDate: null, kind: 'adjust', newDate: null,
            newAmount: '150.00', baseDate: '2026-03-25', baseAmount: '100.00',
        });
        expect(input.adjustments.find((a) => a.id === adj.targetFar))
            .toMatchObject({ targetKind: 'sched', targetId: String(sched.targetFar), targetDate: '2026-08-10' });
    });

    test('a scenario that is not draft brings no adjustments and no targets (coordinator decision)', async () => {
        for (const status of ['applied', 'archived']) {
            const input = await loadIn({ scenario: { id: scenarioId, name: 'Loader what-if', status } });
            expect(input.scenario).toEqual({ id: scenarioId, name: 'Loader what-if', status });
            expect(input.adjustments).toEqual([]);
            expect(names(input.items)).not.toContain('elsewhere');
            expect(names(input.items)).not.toContain('farTarget');
            expect(names(input.schedules)).not.toContain('elsewhereSched');
            expect(names(input.schedules)).not.toContain('targetFar');
            expect(input.rates).toEqual({ EUR: { rateToGbp: '0.850000', effectiveFrom: '2026-01-01' } });
        }
    });

    test('the engine runs on it: the in-scope orphan warns, the out-of-scope target is only a warning', async () => {
        const body = engine.run(await loadIn());
        expect(body.warnings).toEqual(expect.arrayContaining([
            { code: 'NO_ANCHOR', accountId: bare.id },
            { code: 'ORPHAN_OVERRIDE', scheduleId: sched.running, naturalDate: '2026-02-21', overrideId: over.orphan },
        ]));
        expect(body.warnings.filter((w) => w.code === 'ORPHAN_OVERRIDE')).toHaveLength(1);
        expect(body.scenario.warnings).toEqual([
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: items.elsewhere.key },
            { code: 'STALE', key: items.deletedTarget.key, reason: 'TARGET_MISSING' },
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: `sched.${sched.elsewhereSched}.2026-06-15` },
            { code: 'STALE', key: `sched.${sched.deletedSched}.2026-03-15`, reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'ship.PO-1', reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'item.999999', reason: 'TARGET_MISSING' },
        ]);
    });

    test('no anchor anywhere: the accounts and NO_ANCHOR, and no rows (§8)', async () => {
        const lone = (await api().post('/api/v1/companies').send({ code: 'LDNONE', name: 'None' }).expect(201)).body;
        const acct = (await api().post('/api/v1/accounts').send({ companyId: lone.id, name: 'Lone', currency: 'GBP' }).expect(201)).body;
        await post('/items', { accountId: acct.id, categoryId: costs.id, name: 'lonely', amount: '5.00', dueDate: '2026-03-15' }).expect(201);
        await insertSchedule(h, { accountId: acct.id, categoryId: costs.id, name: 'lonelySched', startDate: '2026-01-15', settleMode: 'manual' });
        const input = await loadIn({ companyId: lone.id, scenario: null });
        expect(input.accounts).toEqual([
            { id: acct.id, companyId: lone.id, name: 'Lone', currency: 'GBP', anchorDate: null, anchorBalance: null },
        ]);
        expect(input).toMatchObject({
            items: [], schedules: [], overrides: [], payments: [], adjustments: [], categories: [], rates: {},
            warnings: [{ code: 'NO_ANCHOR', accountId: acct.id }],
        });
    });

    test('companyId all: every company\'s live, active accounts', async () => {
        const input = await loadIn({ companyId: 'all', scenario: null });
        const ids = input.accounts.map((a) => a.id);
        expect(ids).toEqual(expect.arrayContaining([main.id, second.id, bare.id, other.id]));
        expect(ids).not.toContain(dormant.id);
        expect(input.companyId).toBe('all');
    });
});
