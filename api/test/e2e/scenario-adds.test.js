'use strict';

// Scenario adds, splits and un-apply (Dev, 2026-10-07; CONTRACT D39–D44, §3.6, §6.10, §6.11,
// §10.7a, §10.7b, §10.9, §10.13), end to end against a per-run jflow_test_<runid> schema that
// the harness migrates with every file — the new 2026-10-07 migration included — and `today`
// pinned through ?today= (D24):
//   - POST /scenarios/:id/adjustments: every 400 (POST /items' grammar, the references, D14),
//     ADJUSTMENT_DATE_IN_PAST, SCENARIO_NOT_DRAFT, nothing written; the 201 (key new.<id>,
//     targetKind new, null bases, current null) and its one audit row; GET shows it;
//   - PUT / DELETE on a new. key: the full replace, the D43 400s, 404 from another scenario;
//   - /forecast: an add is a `new` line of the scenario set only (baseline null, flag added,
//     its bucket, deltaByBucket); a stale one (DATE_PASSED, TARGET_MISSING) is a STALE
//     warning and is not placed; ADJUSTMENT_OUT_OF_SCOPE;
//   - split: the 400/404/409/422 refusals writing nothing, the group (anchor adjust + adds,
//     "80" summing as "80.00"), a re-split replacing the old group, PUT on the anchor
//     keeping it, item / schedule / stock-payment targets, /forecast flags `split`, deleting
//     a part alone and the anchor with its group;
//   - apply: each add's one-off stamped source_scenario_id, splits applied end to end,
//     applied_state on every row with row_version untouched and never served; a stale add
//     refusing the apply;
//   - un-apply: SCENARIO_NOT_APPLIED; a full restore (items, an override apply created and
//     one it updated, an add's one-off soft-deleted, a ship overlay with its planned_at),
//     audited, a draft that reads up to date and applies again; SCENARIO_UNAPPLY_BLOCKED
//     with TARGET_SETTLED, CHANGED, TARGET_MISSING and NO_RECORD, writing nothing;
//   - rebase (an add is never rebased; dropStale drops a stale one) and duplicate (fresh
//     keys, re-pointed groups, no applied_state).

const { startHarness } = require('./harness');

jest.setTimeout(300000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';       // a Tuesday
const A = '2026-03-01';           // every account's anchor
const LATER = '2026-03-15';
const USER = 'local@dev';

const withToday = (req, today) => req.query(today ? { today } : {});
const post = (path, body = {}, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body = {}, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const del = (path, body = {}, today = TODAY) => withToday(api().delete(`/api/v1${path}`), today).send(body);
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });

const adjPath = (sid, key) => `/scenarios/${sid}/adjustments/${key}`;
const addTo = (sid, body, today) => post(`/scenarios/${sid}/adjustments`, body, today);
const putAdj = (sid, key, body, today) => put(adjPath(sid, key), body, today);
const delAdj = (sid, key, body, today) => del(adjPath(sid, key), body, today);
const split = (sid, key, body, today) => post(`${adjPath(sid, key)}/split`, body, today);
const apply = (sid, body = {}, today) => post(`/scenarios/${sid}/apply`, body, today);
const unapply = (sid, body = {}, today) => post(`/scenarios/${sid}/unapply`, body, today);
const detail = async (sid, query = {}) => (await get(`/scenarios/${sid}`, query).expect(200)).body;
const byKey = (scenario, key) => scenario.adjustments.find((a) => a.itemKey === key);
const adjRows = (sid) => h.sql('SELECT * FROM scenario_adjustments WHERE scenario_id = ? ORDER BY id', [sid]);
const stateOf = (row) => (typeof row.applied_state === 'string' ? JSON.parse(row.applied_state) : row.applied_state);
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));
const lines = (body) => body.rows.flatMap((r) => r.items);
const lineOf = (body, key) => lines(body).find((l) => l.key === key);

// §6.11's adjustment JSON (2026-10-07: the add's six one-off fields and splitGroup).
const ADJ_KEYS = [
    'accountId', 'baseAmount', 'baseDate', 'categoryId', 'counterparty', 'createdAt', 'createdBy', 'currency',
    'direction', 'id', 'itemKey', 'kind', 'name', 'newAmount', 'newDate', 'note', 'rowVersion', 'scenarioId',
    'splitGroup', 'targetDate', 'targetId', 'targetKind', 'updatedAt',
];
const OVERLAY = [
    'planned_date', 'planned_amount', 'planned_skipped', 'planned_base_amount', 'planned_note',
    'source_scenario_id', 'planned_by', 'planned_at',
];

/** Every row a scenario write could touch, plus the audit count — "nothing written" is equality. */
async function snapshot() {
    const out = {};
    for (const t of ['cash_items', 'schedules', 'schedule_overrides', 'payments', 'scenarios', 'scenario_adjustments', 'external_items']) {
        out[t] = await h.sql(`SELECT * FROM ${t} ORDER BY id`);
    }
    out.audit = Number((await h.sql('SELECT COUNT(*) AS n FROM audit_log'))[0].n);
    return JSON.parse(JSON.stringify(out));
}

describe('scenario adds, splits and un-apply', () => {
    let jfa;
    let main;       // JFA, GBP, anchored at A
    let costs;      // out
    let sales;      // in
    let fc;         // a company of its own for the /forecast checks
    let fcMain;
    let fcSide;
    let shipAcct;   // the account a ship row resolves to
    let stockPayments;

    let n = 0;
    const makeItem = async (body = {}) => (await post('/items', {
        accountId: main.id, categoryId: costs.id, name: `Item ${++n}`, amount: '250.00', dueDate: '2026-04-15', ...body,
    }).expect(201)).body;
    const makeScenario = async (body = {}) => (await post('/scenarios', { name: `Scenario ${++n}`, ...body }).expect(201)).body;
    const makeSchedule = async (body = {}) => (await post('/schedules', {
        accountId: main.id, categoryId: costs.id, name: 'Rent', amount: '1000.00', frequency: 'monthly',
        startDate: '2026-04-01', ...body,
    }).expect(201)).body;
    const makeAccount = async (companyId, name, body = {}) => {
        const acct = (await api().post('/api/v1/accounts').send({ companyId, name, currency: 'GBP', ...body }).expect(201)).body;
        if (body.isActive !== false) await put(`/accounts/${acct.id}/balances/${A}`, { balance: '5000.00' }).expect(200);
        return acct;
    };
    const addBody = (over = {}) => ({
        kind: 'add', accountId: main.id, categoryId: costs.id, name: 'Late fee', newDate: '2026-03-20', newAmount: '75.00', ...over,
    });
    /** A ship row as the refresh leaves it (feed columns only), for a company mapped to shipping company 77. */
    const insertShip = async (extId, { amount = '1000.00', dueDate = '2026-04-10', shippingCompanyId = 77 } = {}) => {
        await h.sql(
            `INSERT INTO external_items
                (source, ext_id, feed_kind, feed_status, supplier, shipping_company_id, po_number, currency, amount, due_date,
                 date_basis, amount_basis, feed_hash, created_by)
             VALUES ('ship', ?, 'balance', 'open', 'Acme', ?, 'PO-9', 'GBP', ?, ?, 'firm', 'stated', REPEAT('a', 64), 'shipping-feed')`,
            [extId, shippingCompanyId, amount, dueDate]
        );
        return (await h.sql("SELECT * FROM external_items WHERE source = 'ship' AND ext_id = ?", [extId]))[0];
    };

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        jfa = companies.find((c) => c.code === 'JFA');
        main = await makeAccount(jfa.id, 'Main');
        costs = (await api().post('/api/v1/categories').send({ name: 'Costs', direction: 'out' }).expect(201)).body;
        sales = (await api().post('/api/v1/categories').send({ name: 'Sales', direction: 'in' }).expect(201)).body;
        fc = (await api().post('/api/v1/companies').send({ code: 'FC', name: 'Forecast co' }).expect(201)).body;
        fcMain = await makeAccount(fc.id, 'FC main');
        fcSide = await makeAccount(fc.id, 'FC side');
        const shp = (await api().post('/api/v1/companies').send({ code: 'SHP', name: 'Ship co' }).expect(201)).body;
        await api().put(`/api/v1/companies/${shp.id}`).send({ shippingCompanyId: 77 }).expect(200);
        shipAcct = await makeAccount(shp.id, 'Ship GBP', { isDefault: true });
        [stockPayments] = await h.sql("SELECT id FROM categories WHERE system_key = 'ship'");
    });

    describe('POST /scenarios/:id/adjustments — an add (D39, §10.7a)', () => {
        test('validation: every 400 (grammar, references, D14), the 422, 404 and SCENARIO_NOT_DRAFT — nothing written', async () => {
            const s = await makeScenario();
            const dormant = await makeAccount(jfa.id, 'Dormant', { isActive: false });
            const gone = (await api().post('/api/v1/categories').send({ name: 'Gone', direction: 'out' }).expect(201)).body;
            await del(`/categories/${gone.id}`).expect(204);
            const applied = await makeScenario();
            await apply(applied.id).expect(200);
            const before = await snapshot();

            for (const [body, re] of [
                [{ ...addBody(), kind: undefined }, /kind/],
                [addBody({ kind: 'adjust' }), /kind/],
                [addBody({ accountId: undefined }), /accountId/],
                [addBody({ categoryId: 'x' }), /categoryId/],
                [addBody({ name: '   ' }), /name/],
                [addBody({ name: 'x'.repeat(256) }), /name/],
                [addBody({ newAmount: 75 }), /newAmount/],          // D1: a JSON number is refused
                [addBody({ newAmount: '0' }), /newAmount/],
                [addBody({ newAmount: '-5.00' }), /newAmount/],
                [addBody({ newAmount: '1.234' }), /newAmount/],
                [addBody({ newDate: '2026-02-30' }), /newDate/],
                [addBody({ newDate: undefined }), /newDate/],
                [addBody({ direction: 'sideways' }), /direction/],
                [addBody({ direction: 'in' }), /direction/],        // D14: Costs is out
                [addBody({ currency: 'gbp' }), /currency/],
                [addBody({ counterparty: 'x'.repeat(256) }), /counterparty/],
                [addBody({ note: 'x'.repeat(501) }), /note/],
                [addBody({ accountId: 999999 }), /not a live account/],
                [addBody({ accountId: dormant.id }), /inactive/],
                [addBody({ categoryId: gone.id }), /not a live category/],
                [addBody({ categoryId: 999999 }), /not a live category/],
            ]) {
                const res = await addTo(s.id, body).expect(400);
                expect(res.body.error).toMatch(re);
                expect(res.body.code).toBeUndefined();
            }
            const past = await addTo(s.id, addBody({ newDate: '2026-03-09' })).expect(422);
            expect(past.body).toMatchObject({ code: 'ADJUSTMENT_DATE_IN_PAST', details: { newDate: '2026-03-09', today: TODAY } });
            await addTo(999999, addBody()).expect(404);
            await addTo('abc', addBody()).expect(404);
            const notDraft = await addTo(applied.id, addBody()).expect(409);
            expect(notDraft.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
            expect(await snapshot()).toEqual(before);
        });

        test('201: key new.<id>, targetKind new, null bases, current null; one audit row; GET /scenarios/:id shows it', async () => {
            const s = await makeScenario();
            const res = await addTo(s.id, addBody({
                name: '  Late-payment fine  ', newAmount: '75', counterparty: 'HMRC', note: 'if we pay late',
            })).expect(201);
            const a = res.body;
            expect(Object.keys(a).sort()).toEqual([...ADJ_KEYS, 'current', 'stale'].sort());
            expect(a).toEqual({
                id: a.id, scenarioId: s.id, itemKey: `new.${a.id}`, targetKind: 'new', targetId: String(a.id), targetDate: null,
                kind: 'add', newDate: '2026-03-20', newAmount: '75.00', baseDate: null, baseAmount: null, note: 'if we pay late',
                accountId: main.id, categoryId: costs.id, direction: 'out', name: 'Late-payment fine', counterparty: 'HMRC',
                currency: 'GBP', splitGroup: null, rowVersion: 0, createdBy: USER,
                createdAt: expect.any(String), updatedAt: expect.any(String), stale: null, current: null,
            });
            const [row] = await adjRows(s.id);
            expect(row).toMatchObject({
                item_key: `new.${a.id}`, target_kind: 'new', target_id: String(a.id), target_date: null, kind: 'add',
                base_date: null, base_amount: null, split_group: null, applied_state: null, row_version: 0,
            });
            const audit = await h.audit('scenario_adjustment', a.id);
            expect(audit).toHaveLength(1);
            expect(audit[0]).toMatchObject({
                action: 'create', before: null, after: { itemKey: `new.${a.id}`, targetId: String(a.id), kind: 'add', name: 'Late-payment fine' },
            });
            expect(audit[0].after).not.toHaveProperty('appliedState');

            // currency: the account's unless sent; direction: the category's.
            const income = (await addTo(s.id, addBody({ categoryId: sales.id, currency: 'EUR', newAmount: '10.00' })).expect(201)).body;
            expect(income).toMatchObject({ currency: 'EUR', direction: 'in', itemKey: `new.${income.id}` });
            const read = await detail(s.id);
            expect(read.adjustmentCount).toBe(2);
            expect(byKey(read, a.itemKey)).toMatchObject({ id: a.id, kind: 'add', name: 'Late-payment fine', stale: null, current: null });
            expect(Object.keys(byKey(read, a.itemKey)).sort()).toEqual([...ADJ_KEYS, 'current', 'stale'].sort());
        });

        test('PUT on a new. key is a full replace (200, its key and group kept); the D43 400s; 404 elsewhere; DELETE', async () => {
            const s = await makeScenario();
            const other = await makeScenario();
            const a = (await addTo(s.id, addBody({ counterparty: 'HMRC', note: 'first' })).expect(201)).body;
            const key = a.itemKey;
            const body = { kind: 'add', accountId: main.id, categoryId: sales.id, name: 'Refund', newDate: '2026-03-25', newAmount: '40.5' };

            const replaced = (await putAdj(s.id, key, body).expect(200)).body;
            expect(replaced).toMatchObject({
                id: a.id, itemKey: key, targetKind: 'new', kind: 'add', categoryId: sales.id, direction: 'in', name: 'Refund',
                newDate: '2026-03-25', newAmount: '40.50', counterparty: null, note: null, baseDate: null, baseAmount: null,
                rowVersion: 1, stale: null, current: null,
            });
            expect((await h.audit('scenario_adjustment', a.id))[0]).toMatchObject({
                action: 'update', before: { name: 'Late fee', counterparty: 'HMRC', note: 'first' }, after: { name: 'Refund', counterparty: null, note: null },
            });
            // The same body again changes nothing: no bump, no audit row.
            expect((await putAdj(s.id, key, { ...body, newAmount: '40.50' }).expect(200)).body.rowVersion).toBe(1);
            expect(await h.audit('scenario_adjustment', a.id)).toHaveLength(2);
            expect((await putAdj(s.id, key, { ...body, baseVersion: 0 }).expect(409)).body)
                .toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 1 } });

            // D43: a new. key takes kind add only; kind add only on a new. key.
            expect((await putAdj(s.id, key, { kind: 'adjust', newAmount: '1.00' }).expect(400)).body.error).toMatch(/kind add/);
            await putAdj(s.id, key, { kind: 'exclude' }).expect(400);
            const item = await makeItem();
            expect((await putAdj(s.id, item.key, addBody()).expect(400)).body.error).toMatch(/new\.<id>/);
            // The add's grammar and date, as POST.
            await putAdj(s.id, key, addBody({ name: '' })).expect(400);
            expect((await putAdj(s.id, key, addBody({ newDate: '2026-03-01' })).expect(422)).body.code).toBe('ADJUSTMENT_DATE_IN_PAST');
            // 404: no such add in this scenario, or the key belongs to another one; a PUT never creates an add.
            await putAdj(s.id, 'new.999999', addBody()).expect(404);
            await putAdj(other.id, key, addBody()).expect(404);
            await delAdj(other.id, key).expect(404);
            expect(await adjRows(other.id)).toEqual([]);

            await delAdj(s.id, key).expect(204);
            expect(await adjRows(s.id)).toEqual([]);
            expect((await h.audit('scenario_adjustment', a.id))[0]).toMatchObject({ action: 'delete', before: { itemKey: key }, after: null });
            await delAdj(s.id, key).expect(404);
        });
    });

    describe('/forecast with adds (§6.10, §9.5)', () => {
        const window = { from: TODAY, to: '2026-03-31', bucket: 'day' };

        test('an add is a line of the scenario set only: kind new, baseline null, flag added, its bucket and the delta', async () => {
            const s = await makeScenario({ companyId: fc.id });
            const out = (await addTo(s.id, addBody({ accountId: fcMain.id, name: 'Fine', counterparty: 'HMRC', newDate: '2026-03-20' })).expect(201)).body;
            const inn = (await addTo(s.id, addBody({
                accountId: fcMain.id, categoryId: sales.id, name: 'Interest', newDate: '2026-03-12', newAmount: '200.00',
            })).expect(201)).body;

            const plain = (await get('/forecast', { companyId: fc.id, ...window }).expect(200)).body;
            expect(lines(plain).filter((l) => l.kind === 'new')).toEqual([]);
            const res = (await get('/forecast', { companyId: fc.id, ...window, scenarioId: s.id }).expect(200)).body;
            expect(lineOf(res, out.itemKey)).toEqual({
                key: out.itemKey, kind: 'new', id: out.id, name: 'Fine', counterparty: 'HMRC', accountId: fcMain.id, currency: 'GBP',
                amountMinor: 7500, accountMinor: 7500, gbpMinor: 7500, date: '2026-03-20', dueDate: '2026-03-20', bucketIndex: 10,
                status: 'expected', settleMode: 'auto', flags: ['added'], editable: true, baseline: null, splitGroup: null,
            });
            expect(lineOf(res, inn.itemKey)).toMatchObject({ kind: 'new', bucketIndex: 2, gbpMinor: 20000, flags: ['added'], baseline: null });
            // D44: the add's category is loaded, so its row has a name.
            expect(res.rows.find((r) => r.categoryId === costs.id)).toMatchObject({ categoryName: 'Costs', direction: 'out', total: 7500 });
            expect(res.scenario.warnings).toEqual([]);
            expect(res.scenario.deltaByBucket[2]).toMatchObject({ inflow: 20000, outflow: 0, closing: 20000 });
            expect(res.scenario.deltaByBucket[10]).toMatchObject({ inflow: 0, outflow: 7500, closing: 12500 });
            expect(res.summary.closing - res.scenario.baselineSummary.closing).toBe(12500);
            expect(res.scenario.baselineSummary).toEqual(plain.summary);
        });

        test('a stale add is a STALE warning and is not placed: DATE_PASSED under a later ?today=, TARGET_MISSING with its account off', async () => {
            const s = await makeScenario({ companyId: fc.id });
            const soon = (await addTo(s.id, addBody({ accountId: fcMain.id, newDate: '2026-03-12' })).expect(201)).body;
            const side = (await addTo(s.id, addBody({ accountId: fcSide.id, newDate: '2026-03-25' })).expect(201)).body;

            const later = (await get('/forecast', { companyId: fc.id, ...window, from: LATER, today: LATER, scenarioId: s.id }).expect(200)).body;
            expect(later.scenario.warnings).toEqual([{ code: 'STALE', key: soon.itemKey, reason: 'DATE_PASSED' }]);
            expect(lineOf(later, soon.itemKey)).toBeUndefined();
            expect(lineOf(later, side.itemKey)).toMatchObject({ flags: ['added'] });
            expect((await detail(s.id, { today: LATER })).adjustments.map((a) => [a.stale, a.current])).toEqual([['DATE_PASSED', null], [null, null]]);

            await put(`/accounts/${fcSide.id}`, { isActive: false }).expect(200);
            try {
                const res = (await get('/forecast', { companyId: fc.id, ...window, scenarioId: s.id }).expect(200)).body;
                expect(res.scenario.warnings).toEqual([{ code: 'STALE', key: side.itemKey, reason: 'TARGET_MISSING' }]);
                expect(lineOf(res, side.itemKey)).toBeUndefined();
                expect(lineOf(res, soon.itemKey)).toMatchObject({ flags: ['added'] });
                expect((await detail(s.id)).adjustments.map((a) => [a.itemKey, a.stale, a.current]))
                    .toEqual([[soon.itemKey, null, null], [side.itemKey, 'TARGET_MISSING', null]]);
            } finally {
                await put(`/accounts/${fcSide.id}`, { isActive: true }).expect(200);
            }
        });

        test('an add on an account outside the company in view → ADJUSTMENT_OUT_OF_SCOPE (D44)', async () => {
            const s = await makeScenario();
            const a = (await addTo(s.id, addBody()).expect(201)).body;       // on JFA's Main
            const res = (await get('/forecast', { companyId: fc.id, ...window, scenarioId: s.id }).expect(200)).body;
            expect(res.scenario.warnings).toEqual([{ code: 'ADJUSTMENT_OUT_OF_SCOPE', key: a.itemKey }]);
            expect(lineOf(res, a.itemKey)).toBeUndefined();
        });
    });

    describe('split (D40, §10.7b)', () => {
        const TWO = [{ newDate: '2026-04-15', newAmount: '200.00' }, { newDate: '2026-05-15', newAmount: '100.00' }];

        test('refusals: 400 grammar and a new. key; 422 key, past date and sum; 404 missing; 409 settled and not draft — nothing written', async () => {
            const s = await makeScenario();
            const item = await makeItem({ amount: '300.00', dueDate: '2026-04-15' });
            const paid = await makeItem({ amount: '50.00', dueDate: TODAY });
            await post(`/items/${paid.id}/pay`, { paidOn: TODAY }).expect(200);
            const added = (await addTo(s.id, addBody()).expect(201)).body;
            const unmapped = await insertShip('bal-88-s1', { shippingCompanyId: 88 });
            const applied = await makeScenario();
            await apply(applied.id).expect(200);
            const before = await snapshot();

            for (const [body, re] of [
                [{}, /parts/],
                [{ parts: [TWO[0]] }, /parts/],
                [{ parts: 'x' }, /parts/],
                [{ parts: [TWO[0], null] }, /parts\[1\]/],
                [{ parts: [TWO[0], { newDate: '2026-02-30', newAmount: '100.00' }] }, /parts\[1\]\.newDate/],
                [{ parts: [TWO[0], { newDate: '2026-05-15', newAmount: 100 }] }, /parts\[1\]\.newAmount/],
                [{ parts: [TWO[0], { newDate: '2026-05-15', newAmount: '0' }] }, /parts\[1\]\.newAmount/],
                [{ parts: TWO, note: 'x'.repeat(501) }, /note/],
                [{ parts: TWO, baseVersion: -1 }, /baseVersion/],
            ]) {
                const res = await split(s.id, item.key, body).expect(400);
                expect(res.body.error).toMatch(re);
            }
            expect((await split(s.id, added.itemKey, { parts: TWO }).expect(400)).body.error).toMatch(/cannot be split/);
            expect((await split(s.id, `ship.${unmapped.ext_id}`, { parts: [{ newDate: '2026-04-10', newAmount: '500' }, { newDate: '2026-05-10', newAmount: '500' }] })
                .expect(400)).body.error).toMatch(/no account/);
            expect((await split(s.id, 'item.0', { parts: TWO }).expect(422)).body).toMatchObject({ code: 'ITEM_KEY_INVALID', details: { key: 'item.0' } });
            const early = await split(s.id, item.key, {
                parts: [TWO[0], { newDate: '2026-03-09', newAmount: '99.00' }, { newDate: '2026-03-08', newAmount: '1.00' }],
            }).expect(422);
            expect(early.body).toMatchObject({ code: 'ADJUSTMENT_DATE_IN_PAST', details: { newDate: '2026-03-09', today: TODAY } });
            const sum = await split(s.id, item.key, { parts: [TWO[0], { newDate: '2026-05-15', newAmount: '90' }] }).expect(422);
            expect(sum.body).toMatchObject({ code: 'SPLIT_AMOUNTS_MISMATCH', details: { total: '290.00', expected: '300.00' } });
            expect((await split(s.id, 'item.999999', { parts: TWO }).expect(404)).body).toMatchObject({ code: 'TARGET_MISSING', details: { key: 'item.999999' } });
            const settled = await split(s.id, paid.key, { parts: [{ newDate: TODAY, newAmount: '25' }, { newDate: '2026-04-01', newAmount: '25' }] }).expect(409);
            expect(settled.body).toMatchObject({ code: 'TARGET_SETTLED', details: { key: paid.key, status: 'paid' } });
            expect((await split(applied.id, item.key, { parts: TWO }).expect(409)).body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
            await split(999999, item.key, { parts: TWO }).expect(404);
            expect(await snapshot()).toEqual(before);
        });

        test('a split: the anchor adjust (part 1) and one add per further part in one group; "80" sums as "80.00"; audited', async () => {
            const s = await makeScenario();
            const item = await makeItem({ name: 'Insurance', counterparty: 'Aviva', amount: '300.00', dueDate: '2026-04-15' });
            const res = await split(s.id, item.key, {
                parts: [{ newDate: '2026-04-15', newAmount: '220.00' }, { newDate: '2026-05-15', newAmount: '80' }], note: 'in two',
            }).expect(201);
            const { splitGroup, adjustments } = res.body;
            expect(Object.keys(res.body).sort()).toEqual(['adjustments', 'splitGroup']);
            expect(adjustments).toHaveLength(2);
            const [anchor, part] = adjustments;
            expect(splitGroup).toBe(anchor.id);
            expect(anchor).toMatchObject({
                itemKey: item.key, targetKind: 'item', targetId: String(item.id), kind: 'adjust', newDate: null, newAmount: '220.00',
                baseDate: '2026-04-15', baseAmount: '300.00', note: 'in two', splitGroup: anchor.id, accountId: null, name: null,
                rowVersion: 0, stale: null,
                current: { date: '2026-04-15', amount: '300.00', status: 'expected', name: 'Insurance', currency: 'GBP' },
            });
            expect(part).toMatchObject({
                itemKey: `new.${part.id}`, targetKind: 'new', targetId: String(part.id), kind: 'add', newDate: '2026-05-15',
                newAmount: '80.00', baseDate: null, baseAmount: null, note: 'in two', accountId: main.id, categoryId: costs.id,
                direction: 'out', name: 'Insurance', counterparty: 'Aviva', currency: 'GBP', splitGroup: anchor.id,
                stale: null, current: null,
            });
            for (const a of adjustments) expect(Object.keys(a).sort()).toEqual([...ADJ_KEYS, 'current', 'stale'].sort());
            expect(await h.audit('scenario_adjustment', anchor.id)).toEqual([
                expect.objectContaining({ action: 'create', before: null, after: expect.objectContaining({ splitGroup: anchor.id, newAmount: '220.00' }) }),
            ]);
            expect(await h.audit('scenario_adjustment', part.id)).toEqual([
                expect.objectContaining({ action: 'create', after: expect.objectContaining({ splitGroup: anchor.id, itemKey: `new.${part.id}` }) }),
            ]);
            const read = await detail(s.id);
            expect(read.adjustments.map((a) => [a.itemKey, a.splitGroup, a.stale])).toEqual([[item.key, anchor.id, null], [part.itemKey, anchor.id, null]]);

            // A first part on another date moves the line: the anchor carries newDate.
            const moved = await makeItem({ amount: '300.00', dueDate: '2026-04-15' });
            const three = (await split(s.id, moved.key, {
                parts: [{ newDate: '2026-04-20', newAmount: '100' }, { newDate: '2026-05-20', newAmount: '100' }, { newDate: '2026-06-20', newAmount: '100' }],
            }).expect(201)).body;
            expect(three.adjustments.map((a) => [a.kind, a.newDate, a.newAmount, a.splitGroup])).toEqual([
                ['adjust', '2026-04-20', '100.00', three.splitGroup],
                ['add', '2026-05-20', '100.00', three.splitGroup],
                ['add', '2026-06-20', '100.00', three.splitGroup],
            ]);
        });

        test('a split replaces the key\'s adjustment and its old group; PUT on the anchor keeps its group; baseVersion', async () => {
            const s = await makeScenario();
            const item = await makeItem({ amount: '300.00', dueDate: '2026-04-15' });
            const plain = (await putAdj(s.id, item.key, { kind: 'exclude' }).expect(201)).body;
            expect((await split(s.id, item.key, { parts: TWO, baseVersion: 5 }).expect(409)).body)
                .toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });

            const first = (await split(s.id, item.key, { parts: TWO, baseVersion: 0 }).expect(201)).body;
            expect(first.splitGroup).toBe(plain.id);                  // the existing adjustment became the anchor
            expect(first.adjustments[0]).toMatchObject({ id: plain.id, kind: 'adjust', newAmount: '200.00', newDate: null, rowVersion: 1 });
            expect((await h.audit('scenario_adjustment', plain.id))[0]).toMatchObject({
                action: 'update', before: { kind: 'exclude', splitGroup: null, newAmount: null }, after: { kind: 'adjust', splitGroup: plain.id, newAmount: '200.00' },
            });
            const oldPart = first.adjustments[1];

            const second = (await split(s.id, item.key, {
                parts: [{ newDate: '2026-04-20', newAmount: '100' }, { newDate: '2026-05-20', newAmount: '100' }, { newDate: '2026-06-20', newAmount: '100' }],
            }).expect(201)).body;
            expect(second.splitGroup).toBe(plain.id);
            expect(second.adjustments.map((a) => a.kind)).toEqual(['adjust', 'add', 'add']);
            expect(second.adjustments[0]).toMatchObject({ newDate: '2026-04-20', newAmount: '100.00', rowVersion: 2 });
            expect((await h.audit('scenario_adjustment', oldPart.id))[0]).toMatchObject({ action: 'delete', after: null });
            expect((await adjRows(s.id)).map((r) => [r.id, r.kind, r.split_group])).toEqual([
                [plain.id, 'adjust', plain.id], [second.adjustments[1].id, 'add', plain.id], [second.adjustments[2].id, 'add', plain.id],
            ]);

            const edited = (await putAdj(s.id, item.key, { kind: 'adjust', newAmount: '150.00' }).expect(200)).body;
            expect(edited).toMatchObject({ id: plain.id, splitGroup: plain.id, newAmount: '150.00', newDate: null });
        });

        test('/forecast shows the parts in their buckets flagged split; deleting a part removes it alone, the anchor reverts the split', async () => {
            const s = await makeScenario({ companyId: fc.id });
            const vat = (await post('/items', { accountId: fcMain.id, categoryId: costs.id, name: 'VAT', amount: '900.00', dueDate: '2026-03-31' }).expect(201)).body;
            const res = (await split(s.id, vat.key, {
                parts: [{ newDate: '2026-03-31', newAmount: '300' }, { newDate: '2026-04-30', newAmount: '300' }, { newDate: '2026-05-29', newAmount: '300' }],
            }).expect(201)).body;
            const [anchor, p1, p2] = res.adjustments;
            const query = { companyId: fc.id, from: TODAY, to: '2026-05-31', bucket: 'month', scenarioId: s.id };   // 0 = Mar, 1 = Apr, 2 = May
            const f = (await get('/forecast', query).expect(200)).body;
            expect(lineOf(f, vat.key)).toMatchObject({
                kind: 'item', bucketIndex: 0, amountMinor: 30000, flags: ['adjusted', 'split'], splitGroup: anchor.id,
                baseline: { date: '2026-03-31', amountMinor: 90000 },
            });
            expect(lineOf(f, p1.itemKey)).toMatchObject({ kind: 'new', bucketIndex: 1, amountMinor: 30000, flags: ['added', 'split'], splitGroup: anchor.id, baseline: null });
            expect(lineOf(f, p2.itemKey)).toMatchObject({ kind: 'new', bucketIndex: 2, flags: ['added', 'split'], splitGroup: anchor.id });
            expect(f.scenario.deltaByBucket.map((d) => d.outflow)).toEqual([-60000, 30000, 30000]);
            expect(f.summary.outflow).toBe(f.scenario.baselineSummary.outflow);

            await delAdj(s.id, p2.itemKey).expect(204);                       // a part goes alone
            expect((await adjRows(s.id)).map((r) => r.id)).toEqual([anchor.id, p1.id]);
            await delAdj(s.id, vat.key).expect(204);                          // the anchor takes its group
            expect(await adjRows(s.id)).toEqual([]);
            for (const id of [p2.id, p1.id, anchor.id]) {
                expect((await h.audit('scenario_adjustment', id))[0]).toMatchObject({ action: 'delete', after: null });
            }
            const after = (await get('/forecast', query).expect(200)).body;
            expect(lineOf(after, vat.key)).toMatchObject({ amountMinor: 90000, flags: [], splitGroup: null });
            expect(lines(after).filter((l) => l.kind === 'new')).toEqual([]);
        });

        test('a schedule instance and a stock payment split too: the parts copy the line\'s category, name and counterparty', async () => {
            const s = await makeScenario();
            const sched = await makeSchedule({ name: 'Office rent', counterparty: 'Landlord' });
            const key = `sched.${sched.id}.2026-05-01`;
            const inst = (await split(s.id, key, { parts: [{ newDate: '2026-05-01', newAmount: '600' }, { newDate: '2026-05-15', newAmount: '400' }] }).expect(201)).body;
            expect(inst.adjustments[0]).toMatchObject({ itemKey: key, targetKind: 'sched', targetDate: '2026-05-01', newDate: null, newAmount: '600.00', baseAmount: '1000.00' });
            expect(inst.adjustments[1]).toMatchObject({
                kind: 'add', accountId: main.id, categoryId: costs.id, direction: 'out', name: 'Office rent', counterparty: 'Landlord',
                currency: 'GBP', newDate: '2026-05-15', newAmount: '400.00', splitGroup: inst.splitGroup,
            });

            const ship = await insertShip('bal-9-s1');
            const shipKey = `ship.${ship.ext_id}`;
            const parts = (await split(s.id, shipKey, { parts: [{ newDate: '2026-04-10', newAmount: '600' }, { newDate: '2026-05-10', newAmount: '400' }] }).expect(201)).body;
            expect(parts.adjustments[0]).toMatchObject({ itemKey: shipKey, targetKind: 'ship', baseDate: '2026-04-10', baseAmount: '1000.00', newAmount: '600.00' });
            expect(parts.adjustments[1]).toMatchObject({
                kind: 'add', accountId: shipAcct.id, categoryId: stockPayments.id, direction: 'out', name: 'Acme · PO-9 · balance',
                counterparty: 'Acme', currency: 'GBP', newDate: '2026-05-10', newAmount: '400.00', splitGroup: parts.splitGroup,
            });
        });
    });

    describe('apply with adds (D39, D41, §10.9)', () => {
        test('apply inserts each add\'s one-off, applies splits end to end and records applied_state on every row (never served)', async () => {
            const s = await makeScenario();
            const moved = await makeItem({ amount: '250.00', dueDate: '2026-04-15' });
            const halved = await makeItem({ name: 'Insurance', counterparty: 'Aviva', amount: '300.00', dueDate: '2026-04-20' });
            const sched = await makeSchedule({ name: 'Rent' });
            const instKey = `sched.${sched.id}.2026-05-01`;
            await putAdj(s.id, moved.key, { kind: 'adjust', newDate: '2026-04-30', newAmount: '260.00' }).expect(201);
            const fine = (await addTo(s.id, addBody({ counterparty: 'HMRC', note: 'paid late' })).expect(201)).body;
            const itemSplit = (await split(s.id, halved.key, { parts: [{ newDate: '2026-04-20', newAmount: '200' }, { newDate: '2026-05-20', newAmount: '100' }] }).expect(201)).body;
            const instSplit = (await split(s.id, instKey, { parts: [{ newDate: '2026-05-01', newAmount: '600' }, { newDate: '2026-05-15', newAmount: '400' }] }).expect(201)).body;
            const versions = (await adjRows(s.id)).map((r) => r.row_version);

            const out = (await apply(s.id).expect(200)).body;
            expect(out.scenario).toMatchObject({ status: 'applied', appliedBy: USER });
            const created = await h.sql('SELECT * FROM cash_items WHERE source_scenario_id = ? AND id NOT IN (?, ?) ORDER BY id', [s.id, moved.id, halved.id]);
            expect(created).toHaveLength(3);
            const [fineItem, halfItem, instItem] = created;
            const [override] = await h.sql('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ?', [sched.id, '2026-05-01']);
            expect(out.applied).toEqual([
                { itemKey: moved.key, kind: 'adjust', wrote: 'cash_item', entityId: moved.id },
                { itemKey: fine.itemKey, kind: 'add', wrote: 'cash_item', entityId: fineItem.id },
                { itemKey: halved.key, kind: 'adjust', wrote: 'cash_item', entityId: halved.id },
                { itemKey: itemSplit.adjustments[1].itemKey, kind: 'add', wrote: 'cash_item', entityId: halfItem.id },
                { itemKey: instKey, kind: 'adjust', wrote: 'schedule_override', entityId: override.id },
                { itemKey: instSplit.adjustments[1].itemKey, kind: 'add', wrote: 'cash_item', entityId: instItem.id },
            ]);
            expect(fineItem).toMatchObject({
                account_id: main.id, category_id: costs.id, direction: 'out', name: 'Late fee', counterparty: 'HMRC', amount: '75.00',
                currency: 'GBP', due_date: '2026-03-20', status: 'expected', settle_mode: 'auto', notes: 'paid late',
                source_scenario_id: s.id, created_by: USER, paid_on: null, paid_amount: null, deleted_at: null,
            });
            // The split applied end to end: the real lines resized, the parts real one-offs.
            expect((await h.sql('SELECT amount, due_date, source_scenario_id FROM cash_items WHERE id = ?', [halved.id]))[0])
                .toEqual({ amount: '200.00', due_date: '2026-04-20', source_scenario_id: s.id });
            expect(halfItem).toMatchObject({ name: 'Insurance', counterparty: 'Aviva', amount: '100.00', due_date: '2026-05-20', settle_mode: 'auto' });
            expect(override).toMatchObject({ amount: '600.00', due_date: null, status: null, source_scenario_id: s.id });
            expect(instItem).toMatchObject({ name: 'Rent', amount: '400.00', due_date: '2026-05-15' });
            expect((await h.audit('cash_item', fineItem.id))[0]).toMatchObject({
                action: 'apply', before: null, after: { id: fineItem.id, name: 'Late fee', sourceScenarioId: s.id },
            });

            const rows = await adjRows(s.id);
            expect(rows.map((r) => r.row_version)).toEqual(versions);     // applied_state is apply's own column
            expect(rows.map(stateOf)).toEqual([
                {
                    kind: 'item', id: moved.id,
                    before: { dueDate: '2026-04-15', amount: '250.00', status: 'expected', sourceScenarioId: null },
                    after: { dueDate: '2026-04-30', amount: '260.00', status: 'expected' },
                },
                { kind: 'add', createdItemId: fineItem.id },
                {
                    kind: 'item', id: halved.id,
                    before: { dueDate: '2026-04-20', amount: '300.00', status: 'expected', sourceScenarioId: null },
                    after: { dueDate: '2026-04-20', amount: '200.00', status: 'expected' },
                },
                { kind: 'add', createdItemId: halfItem.id },
                { kind: 'sched', overrideId: override.id, created: true, before: null, after: { dueDate: null, amount: '600.00', status: null } },
                { kind: 'add', createdItemId: instItem.id },
            ]);
            const read = await detail(s.id);
            for (const a of read.adjustments) {
                expect(Object.keys(a).sort()).toEqual([...ADJ_KEYS, 'current', 'stale'].sort());
                expect([a.stale, a.current]).toEqual([null, null]);
            }
        });

        test('a stale add refuses the apply — its account switched off, its date passed — writing nothing', async () => {
            const s = await makeScenario();
            const dormant = await makeAccount(jfa.id, 'Soon dormant');
            const off = (await addTo(s.id, addBody({ accountId: dormant.id, newDate: '2026-03-20' })).expect(201)).body;
            const soon = (await addTo(s.id, addBody({ newDate: '2026-03-12' })).expect(201)).body;
            await put(`/accounts/${dormant.id}`, { isActive: false }).expect(200);
            const before = await snapshot();
            const res = await apply(s.id, {}, LATER).expect(409);
            expect(res.body).toMatchObject({
                code: 'SCENARIO_STALE',
                details: { stale: [{ itemKey: off.itemKey, reason: 'TARGET_MISSING' }, { itemKey: soon.itemKey, reason: 'DATE_PASSED' }] },
            });
            expect(await snapshot()).toEqual(before);
        });
    });

    describe('un-apply (D41, §10.13)', () => {
        test('SCENARIO_NOT_APPLIED on a draft or an archived scenario; 404; STALE_WRITE', async () => {
            const s = await makeScenario();
            expect((await unapply(s.id).expect(409)).body).toMatchObject({ code: 'SCENARIO_NOT_APPLIED', details: { status: 'draft' } });
            await put(`/scenarios/${s.id}`, { status: 'archived' }).expect(200);
            expect((await unapply(s.id).expect(409)).body).toMatchObject({ code: 'SCENARIO_NOT_APPLIED', details: { status: 'archived' } });
            await unapply(999999).expect(404);
            await unapply('abc').expect(404);
            const t = await makeScenario();
            await apply(t.id).expect(200);
            expect((await unapply(t.id, { baseVersion: 0 }).expect(409)).body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 1 } });
            await unapply(t.id, { baseVersion: 'x' }).expect(400);
        });

        test('a full restore: items, an override apply created (deleted) and one it updated, an add\'s one-off (soft-deleted); audited; a draft that applies again', async () => {
            const s = await makeScenario();
            const moved = await makeItem({ amount: '250.00', dueDate: '2026-04-15' });
            const skipped = await makeItem({ amount: '120.00', dueDate: '2026-04-16' });
            const sched = await makeSchedule({ name: 'Office' });
            await put(`/schedules/${sched.id}/instances/2026-06-01`, { amount: '983.00', note: 'tuned' }).expect(200);
            const [tuned] = await h.sql('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ?', [sched.id, '2026-06-01']);
            const mayKey = `sched.${sched.id}.2026-05-01`;
            const junKey = `sched.${sched.id}.2026-06-01`;
            await putAdj(s.id, moved.key, { kind: 'adjust', newDate: '2026-04-30', newAmount: '260.00' }).expect(201);
            await putAdj(s.id, skipped.key, { kind: 'exclude' }).expect(201);
            await putAdj(s.id, mayKey, { kind: 'adjust', newDate: '2026-05-05' }).expect(201);
            await putAdj(s.id, junKey, { kind: 'adjust', newAmount: '990.00' }).expect(201);
            const fine = (await addTo(s.id, addBody({ newDate: '2026-03-25' })).expect(201)).body;

            const real = async () => ({
                items: await h.sql('SELECT id, due_date, amount, status, source_scenario_id, deleted_at FROM cash_items WHERE id IN (?, ?) ORDER BY id', [moved.id, skipped.id]),
                overrides: await h.sql(
                    'SELECT id, natural_date, amount, due_date, status, note, source_scenario_id FROM schedule_overrides WHERE schedule_id = ? ORDER BY natural_date',
                    [sched.id]
                ),
            });
            const before = await real();
            const applied = (await apply(s.id).expect(200)).body;
            const fineId = applied.applied.find((a) => a.itemKey === fine.itemKey).entityId;
            const [mayOverride] = await h.sql('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ?', [sched.id, '2026-05-01']);
            expect(stateOf((await adjRows(s.id))[3])).toMatchObject({
                kind: 'sched', overrideId: tuned.id, created: false,
                before: { dueDate: null, amount: '983.00', status: null, sourceScenarioId: null }, after: { amount: '990.00' },
            });

            const out = (await unapply(s.id, { baseVersion: 1 }).expect(200)).body;
            expect(out.scenario).toMatchObject({ id: s.id, status: 'draft', appliedAt: null, appliedBy: null, rowVersion: 2 });
            expect(out.unapplied).toEqual(applied.applied);           // applied[]'s shape, entry for entry (D42)
            expect(await real()).toEqual(before);
            expect(await h.sql('SELECT id FROM schedule_overrides WHERE id = ?', [mayOverride.id])).toEqual([]);
            const [gone] = await h.sql('SELECT deleted_at, source_scenario_id FROM cash_items WHERE id = ?', [fineId]);
            expect(gone.deleted_at).not.toBeNull();
            expect(gone.source_scenario_id).toBe(s.id);
            await get(`/items/${fineId}`).expect(404);

            expect((await h.audit('cash_item', moved.id))[0]).toMatchObject({
                action: 'unapply', before: { dueDate: '2026-04-30', amount: '260.00', sourceScenarioId: s.id },
                after: { dueDate: '2026-04-15', amount: '250.00', sourceScenarioId: null },
            });
            expect((await h.audit('cash_item', skipped.id))[0]).toMatchObject({ action: 'unapply', before: { status: 'skipped' }, after: { status: 'expected' } });
            expect((await h.audit('schedule_override', mayOverride.id))[0]).toMatchObject({
                action: 'delete', after: null,
                before: { id: mayOverride.id, naturalDate: '2026-05-01', dueDate: '2026-05-05', amount: null, sourceScenarioId: s.id },
            });
            expect((await h.audit('schedule_override', tuned.id))[0]).toMatchObject({
                action: 'unapply', before: { amount: '990.00', sourceScenarioId: s.id }, after: { amount: '983.00', sourceScenarioId: null },
            });
            expect((await h.audit('cash_item', fineId))[0]).toMatchObject({ action: 'unapply', before: { deletedAt: null } });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({
                action: 'unapply', before: { status: 'applied', appliedBy: USER }, after: { status: 'draft', appliedAt: null, appliedBy: null },
            });
            expect((await adjRows(s.id)).map((r) => [r.applied_state, r.row_version])).toEqual([[null, 0], [null, 0], [null, 0], [null, 0], [null, 0]]);

            // The bases equal the real data again: the draft reads up to date, and applies again.
            expect((await detail(s.id)).adjustments.map((a) => a.stale)).toEqual([null, null, null, null, null]);
            const again = (await apply(s.id).expect(200)).body;
            expect(again.applied.find((a) => a.itemKey === fine.itemKey).entityId).not.toBe(fineId);   // a fresh one-off
        });

        test('a ship. target: the overlay is put back from its before image, planned_at included', async () => {
            const ship = await insertShip('bal-10-s1');
            const key = `ship.${ship.ext_id}`;
            await put(`/external-items/${key}`, { plannedDate: '2026-04-12', note: 'by hand' }).expect(200);
            const [hand] = await h.sql('SELECT * FROM external_items WHERE id = ?', [ship.id]);
            const s = await makeScenario();
            await putAdj(s.id, key, { kind: 'adjust', newAmount: '900.00' }).expect(201);
            await apply(s.id).expect(200);
            const [mid] = await h.sql('SELECT * FROM external_items WHERE id = ?', [ship.id]);
            expect(mid).toMatchObject({ planned_date: '2026-04-12', planned_amount: '900.00', planned_base_amount: '1000.00', source_scenario_id: s.id });
            expect(stateOf((await adjRows(s.id))[0])).toEqual({
                kind: 'ship', id: ship.id,
                before: {
                    plannedDate: '2026-04-12', plannedAmount: null, plannedBaseAmount: null, plannedSkipped: false,
                    sourceScenarioId: null, plannedBy: USER, plannedAt: hand.planned_at.toISOString(),
                },
                after: { plannedDate: '2026-04-12', plannedAmount: '900.00', plannedSkipped: false },
            });

            const out = (await unapply(s.id).expect(200)).body;
            expect(out.unapplied).toEqual([{ itemKey: key, kind: 'adjust', wrote: 'external_item', entityId: ship.id }]);
            const [back] = await h.sql('SELECT * FROM external_items WHERE id = ?', [ship.id]);
            expect(pick(back, OVERLAY)).toEqual(pick(hand, OVERLAY));
            expect(back.row_version).toBe(mid.row_version + 1);
            expect((await h.audit('external_item', ship.id))[0]).toMatchObject({
                action: 'unapply', before: { plannedAmount: '900.00', sourceScenarioId: s.id }, after: { key, plannedAmount: null, sourceScenarioId: null },
            });
        });

        test('SCENARIO_UNAPPLY_BLOCKED: TARGET_SETTLED, CHANGED, TARGET_MISSING, NO_RECORD in row order — nothing written', async () => {
            const s = await makeScenario();
            const paidLater = await makeItem({ amount: '100.00', dueDate: '2026-04-01' });
            const edited = await makeItem({ amount: '100.00', dueDate: '2026-04-02' });
            const recordless = await makeItem({ amount: '100.00', dueDate: '2026-04-03' });
            await putAdj(s.id, paidLater.key, { kind: 'adjust', newDate: '2026-04-10' }).expect(201);
            await putAdj(s.id, edited.key, { kind: 'adjust', newAmount: '110.00' }).expect(201);
            const fine = (await addTo(s.id, addBody({ newDate: '2026-03-26' })).expect(201)).body;
            await putAdj(s.id, recordless.key, { kind: 'exclude' }).expect(201);
            const applied = (await apply(s.id).expect(200)).body;
            const fineId = applied.applied.find((a) => a.itemKey === fine.itemKey).entityId;

            await post(`/items/${paidLater.id}/pay`, { paidOn: TODAY }).expect(200);          // TARGET_SETTLED
            await put(`/items/${edited.id}`, { amount: '115.00' }).expect(200);               // CHANGED
            await del(`/items/${fineId}`).expect(204);                                        // TARGET_MISSING
            await h.sql('UPDATE scenario_adjustments SET applied_state = NULL WHERE scenario_id = ? AND item_key = ?', [s.id, recordless.key]);   // NO_RECORD

            const blocked = async (expected) => {
                const before = await snapshot();
                const res = await unapply(s.id).expect(409);
                expect(res.body).toMatchObject({ code: 'SCENARIO_UNAPPLY_BLOCKED', details: { blocked: expected } });
                expect(res.body.details.blocked).toEqual(expected);
                expect(await snapshot()).toEqual(before);
            };
            await blocked([
                { itemKey: paidLater.key, reason: 'TARGET_SETTLED' },
                { itemKey: edited.key, reason: 'CHANGED' },
                { itemKey: fine.itemKey, reason: 'TARGET_MISSING' },
                { itemKey: recordless.key, reason: 'NO_RECORD' },
            ]);
            // Each reason stands alone: undo two of them and the other two still block.
            await post(`/items/${paidLater.id}/unpay`, {}).expect(200);
            await put(`/items/${edited.id}`, { amount: '110.00' }).expect(200);
            await blocked([
                { itemKey: fine.itemKey, reason: 'TARGET_MISSING' },
                { itemKey: recordless.key, reason: 'NO_RECORD' },
            ]);
            expect((await detail(s.id)).status).toBe('applied');
        });
    });

    describe('rebase and duplicate (D39–D41)', () => {
        test('rebase never rebases an add; dropStale drops a stale one (date passed, account off) and keeps a live one', async () => {
            const s = await makeScenario();
            const dormant = await makeAccount(jfa.id, 'Off later');
            const soon = (await addTo(s.id, addBody({ newDate: '2026-03-12' })).expect(201)).body;
            const off = (await addTo(s.id, addBody({ accountId: dormant.id, newDate: '2026-04-01' })).expect(201)).body;
            const live = (await addTo(s.id, addBody({ newDate: '2026-04-01' })).expect(201)).body;
            await put(`/accounts/${dormant.id}`, { isActive: false }).expect(200);

            const view = (r) => r.adjustments.map((a) => [a.itemKey, a.rebased, a.stale, a.dropped, a.current]);
            const kept = (await post(`/scenarios/${s.id}/rebase`, {}, LATER).expect(200)).body;
            expect(view(kept)).toEqual([
                [soon.itemKey, false, 'DATE_PASSED', false, null],
                [off.itemKey, false, 'TARGET_MISSING', false, null],
                [live.itemKey, false, null, false, null],
            ]);
            expect(await h.audit('scenario_adjustment', live.id)).toHaveLength(1);      // create only: nothing to rebase
            const dropped = (await post(`/scenarios/${s.id}/rebase`, { dropStale: true }, LATER).expect(200)).body;
            expect(view(dropped)).toEqual([
                [soon.itemKey, false, 'DATE_PASSED', true, null],
                [off.itemKey, false, 'TARGET_MISSING', true, null],
                [live.itemKey, false, null, false, null],
            ]);
            expect((await adjRows(s.id)).map((r) => r.id)).toEqual([live.id]);
            for (const id of [soon.id, off.id]) expect((await h.audit('scenario_adjustment', id))[0]).toMatchObject({ action: 'delete', after: null });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'rebase', after: { rebased: 0, dropped: 2, stale: 2, dropStale: true } });
        });

        test('dropStale on a stale split anchor drops its parts too (D40): nothing of the group is left', async () => {
            const s = await makeScenario();
            const item = await makeItem({ amount: '300.00', dueDate: '2026-04-15' });
            const lone = (await addTo(s.id, addBody({ newDate: '2026-04-01' })).expect(201)).body;
            const group = (await split(s.id, item.key, {
                parts: [{ newDate: '2026-04-15', newAmount: '100.00' }, { newDate: '2026-05-15', newAmount: '200.00' }],
            }).expect(201)).body;
            const [anchor, part] = group.adjustments;
            expect(part).toMatchObject({ kind: 'add', splitGroup: anchor.id });
            // The real item is paid in full: the anchor reads TARGET_SETTLED; the part, an add, is live on its own.
            await post(`/items/${item.id}/pay`, { paidOn: TODAY }).expect(200);

            const view = (r) => r.adjustments.map((a) => [a.itemKey, a.stale, a.dropped]);
            const kept = (await post(`/scenarios/${s.id}/rebase`, {}).expect(200)).body;
            expect(view(kept)).toEqual([[lone.itemKey, null, false], [anchor.itemKey, 'TARGET_SETTLED', false], [part.itemKey, null, false]]);
            expect((await adjRows(s.id)).map((r) => r.id)).toEqual([lone.id, anchor.id, part.id]);

            const dropped = (await post(`/scenarios/${s.id}/rebase`, { dropStale: true }).expect(200)).body;
            expect(view(dropped)).toEqual([[lone.itemKey, null, false], [anchor.itemKey, 'TARGET_SETTLED', true], [part.itemKey, null, true]]);
            expect((await adjRows(s.id)).map((r) => r.id)).toEqual([lone.id]);
            for (const id of [anchor.id, part.id]) expect((await h.audit('scenario_adjustment', id))[0]).toMatchObject({ action: 'delete', after: null });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'rebase', after: { rebased: 0, dropped: 2, stale: 1, dropStale: true } });
        });

        test('duplicate copies adds under fresh keys and re-points a split group at the copied anchor; applied_state is not copied', async () => {
            const s = await makeScenario();
            const item = await makeItem({ amount: '300.00', dueDate: '2026-04-15' });
            await addTo(s.id, addBody({ counterparty: 'HMRC', note: 'solo' })).expect(201);
            await split(s.id, item.key, {
                parts: [{ newDate: '2026-04-15', newAmount: '100' }, { newDate: '2026-05-15', newAmount: '100' }, { newDate: '2026-06-15', newAmount: '100' }],
            }).expect(201);
            await apply(s.id).expect(200);

            const copy = (await post(`/scenarios/${s.id}/duplicate`, {}).expect(201)).body;
            expect(copy).toMatchObject({ status: 'draft', adjustmentCount: 4 });
            const src = await adjRows(s.id);
            const dup = await adjRows(copy.id);
            expect(src.every((r) => r.applied_state !== null)).toBe(true);
            expect(dup.map((r) => r.applied_state)).toEqual([null, null, null, null]);
            expect(dup.map((r) => r.kind)).toEqual(['add', 'adjust', 'add', 'add']);
            const [solo, anchor, p1, p2] = dup;
            for (const r of [solo, p1, p2]) {
                expect(r).toMatchObject({ item_key: `new.${r.id}`, target_kind: 'new', target_id: String(r.id), base_date: null, base_amount: null });
            }
            const sourceKeys = new Set(src.map((r) => r.item_key));
            for (const r of [solo, p1, p2]) expect(sourceKeys.has(r.item_key)).toBe(false);     // fresh keys
            expect(anchor).toMatchObject({ item_key: item.key, target_kind: 'item', split_group: anchor.id });
            expect([solo.split_group, p1.split_group, p2.split_group]).toEqual([null, anchor.id, anchor.id]);
            const fields = (r) => pick(r, [
                'kind', 'target_date', 'new_date', 'new_amount', 'base_date', 'base_amount', 'note', 'account_id', 'category_id',
                'direction', 'name', 'counterparty', 'currency',
            ]);
            expect(dup.map(fields)).toEqual(src.map(fields));
            for (const r of dup) {
                expect(await h.audit('scenario_adjustment', r.id)).toEqual([
                    expect.objectContaining({ action: 'create', before: null, after: expect.objectContaining({ itemKey: r.item_key, splitGroup: r.split_group }) }),
                ]);
            }
            // The copy is a draft whose adds read live and whose group the forecast and DELETE know.
            const read = await detail(copy.id);
            expect(read.adjustments.filter((a) => a.kind === 'add').map((a) => [a.stale, a.current])).toEqual([[null, null], [null, null], [null, null]]);
            await delAdj(copy.id, item.key).expect(204);
            expect((await adjRows(copy.id)).map((r) => r.id)).toEqual([solo.id]);
            expect((await adjRows(s.id)).length).toBe(4);
        });
    });
});
