'use strict';

// Scenarios (CONTRACT §6.11, §10.7–10.10; D4, D8, D11, D18, D20, D33, D36, D38), end to end
// against a per-run jflow_test_<runid> schema, `today` pinned through ?today= (D24):
//   - scenario CRUD: validation, list filters and order, archive (D36) as a terminal
//     status, soft delete keeping the adjustments, STALE_WRITE;
//   - adjustment PUT / DELETE: ITEM_KEY_INVALID, TARGET_MISSING (incl. a `ship.` key with no row),
//     TARGET_SETTLED, ADJUSTMENT_DATE_IN_PAST, bases from the loader never the body, the PUT
//     as a full replace, `current` with name and currency, SCENARIO_NOT_DRAFT;
//   - GET's stale/current on a draft (all four reasons, DATE_PASSED via ?today=), null otherwise;
//   - apply all-or-nothing: a target paid at the same amount and date → SCENARIO_STALE
//     (TARGET_SETTLED) with no row changed; rebase then apply succeeds; the writes stamped
//     with source_scenario_id; a second apply → SCENARIO_NOT_DRAFT;
//   - rebase: dropStale removes only the settled / missing / date-passed ones and rebases
//     BASE_CHANGED;
//   - duplicate: a fresh draft with the bases copied as-is;
//   - schedule-instance targets: a key sent un-encoded through HTTP reaches the right row,
//     D11 bases, a non-occurrence is TARGET_MISSING, apply upserts overrides;
//   - one audit row per mutation throughout.
// The headline flow (1000 × 12, tune, shift, /forecast delta, apply) is scenario-headline.test.js.

const { startHarness } = require('./harness');

jest.setTimeout(240000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';       // a Tuesday
const A = '2026-03-01';           // the main account's anchor

const withToday = (req, today) => req.query(today ? { today } : {});
const post = (path, body = {}, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body = {}, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const del = (path, body = {}, today = TODAY) => withToday(api().delete(`/api/v1${path}`), today).send(body);
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });

const adjPath = (sid, key) => `/scenarios/${sid}/adjustments/${key}`;
const putAdj = (sid, key, body, today) => put(adjPath(sid, key), body, today);
const delAdj = (sid, key, body, today) => del(adjPath(sid, key), body, today);
const detail = async (sid, query = {}) => (await get(`/scenarios/${sid}`, query).expect(200)).body;
const byKey = (scenario, key) => scenario.adjustments.find((a) => a.itemKey === key);

const ROW_KEYS = [
    'adjustmentCount', 'appliedAt', 'appliedBy', 'companyId', 'createdAt', 'createdBy', 'deletedAt', 'description',
    'id', 'name', 'rowVersion', 'status', 'updatedAt',
];
const ADJ_KEYS = [
    'baseAmount', 'baseDate', 'createdAt', 'createdBy', 'id', 'itemKey', 'kind', 'newAmount', 'newDate', 'note',
    'rowVersion', 'scenarioId', 'targetDate', 'targetId', 'targetKind', 'updatedAt',
];

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Hold a row lock on the harness's own connection, start `request` (which must block on
 * it), run `meanwhile` inside the same transaction, commit, and return the response. The
 * request must still be pending when `meanwhile` runs: that is what proves it waited.
 */
async function whileLocked(lockSql, params, request, meanwhile) {
    await h.sql('START TRANSACTION');
    let pending;
    try {
        await h.sql(lockSql, params);
        let settled = false;
        pending = request().then((r) => { settled = true; return r; });
        await pause(1500);
        expect(settled).toBe(false);
        await meanwhile();
        await h.sql('COMMIT');
    } catch (err) {
        await h.sql('ROLLBACK');
        throw err;
    }
    return pending;
}

/** Every row a scenario write could touch, plus the audit count — "nothing written" is equality. */
async function snapshot() {
    const out = {};
    for (const t of ['cash_items', 'schedules', 'schedule_overrides', 'payments', 'scenarios', 'scenario_adjustments']) {
        out[t] = await h.sql(`SELECT * FROM ${t} ORDER BY id`);
    }
    out.audit = Number((await h.sql('SELECT COUNT(*) AS n FROM audit_log'))[0].n);
    return JSON.parse(JSON.stringify(out));
}

describe('scenarios', () => {
    let jfa;
    let hw;
    let main;       // JFA, GBP, anchored at A
    let costs;      // category, out

    let n = 0;
    const makeItem = async (body = {}) => (await post('/items', {
        accountId: main.id, categoryId: costs.id, name: `Item ${++n}`, amount: '250.00', dueDate: '2026-04-15', ...body,
    }).expect(201)).body;
    const makeScenario = async (body = {}) => (await post('/scenarios', { name: `Scenario ${++n}`, ...body }).expect(201)).body;

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        jfa = companies.find((c) => c.code === 'JFA');
        hw = companies.find((c) => c.code === 'HW');
        main = (await api().post('/api/v1/accounts').send({ companyId: jfa.id, name: 'Main', currency: 'GBP' }).expect(201)).body;
        costs = (await api().post('/api/v1/categories').send({ name: 'Costs', direction: 'out' }).expect(201)).body;
        await put(`/accounts/${main.id}/balances/${A}`, { balance: '10000.00' }).expect(200);
    });

    describe('CRUD', () => {
        test('create: a draft with the row shape, validated, audited', async () => {
            for (const [body, re] of [
                [{}, /name/],
                [{ name: '   ' }, /name/],
                [{ name: 'x'.repeat(256) }, /name/],
                [{ name: 'Ok', companyId: 'x' }, /companyId/],
                [{ name: 'Ok', companyId: 999999 }, /companyId/],
                [{ name: 'Ok', description: 5 }, /description/],
            ]) {
                const res = await post('/scenarios', body).expect(400);
                expect(res.body.error).toMatch(re);
            }
            const s = (await post('/scenarios', { name: '  Hire two  ', description: 'Q3 plan', companyId: jfa.id }).expect(201)).body;
            expect(Object.keys(s).sort()).toEqual(ROW_KEYS);
            expect(s).toMatchObject({
                name: 'Hire two', description: 'Q3 plan', companyId: jfa.id, status: 'draft', appliedAt: null,
                appliedBy: null, adjustmentCount: 0, rowVersion: 0, createdBy: 'local@dev', deletedAt: null,
            });
            const [audit] = await h.audit('scenario', s.id);
            expect(audit).toMatchObject({ action: 'create', before: null, after: { id: s.id, name: 'Hire two', status: 'draft' } });
            expect(await detail(s.id)).toMatchObject({ id: s.id, adjustments: [] });
        });

        test('GET /scenarios/:id: 404 for a malformed or absent id', async () => {
            await get('/scenarios/abc').expect(404);
            await get('/scenarios/999999').expect(404);
        });

        test('list: filters, q, order created_at DESC then id DESC, status validated', async () => {
            const a = await makeScenario({ name: 'Listed alpha', companyId: hw.id });
            const b = await makeScenario({ name: 'Listed beta' });
            await put(`/scenarios/${b.id}`, { status: 'archived' }).expect(200);
            const list = (await get('/scenarios', { q: 'Listed' }).expect(200)).body;
            expect(list).toMatchObject({ page: 1, limit: 100, total: 2 });
            expect(list.data.map((s) => s.id)).toEqual([b.id, a.id]);
            expect(list.data[0]).toHaveProperty('adjustmentCount', 0);
            const archived = (await get('/scenarios', { q: 'Listed', status: 'archived' }).expect(200)).body;
            expect(archived.data.map((s) => s.id)).toEqual([b.id]);
            const both = (await get('/scenarios', { q: 'Listed', status: 'draft,archived' }).expect(200)).body;
            expect(both.total).toBe(2);
            const hwOnly = (await get('/scenarios', { q: 'Listed', companyId: hw.id }).expect(200)).body;
            expect(hwOnly.data.map((s) => s.id)).toEqual([a.id]);
            await get('/scenarios', { status: 'draft,bogus' }).expect(400);
            await get('/scenarios', { companyId: 'x' }).expect(400);
        });

        test('PUT: name, description and companyId in any status; status only → archived from draft/applied (D36)', async () => {
            const s = await makeScenario({ companyId: jfa.id });
            await put(`/scenarios/${s.id}`, {}).expect(400);
            await put(`/scenarios/${s.id}`, { name: '' }).expect(400);
            await put(`/scenarios/${s.id}`, { companyId: 999999 }).expect(400);
            await put(`/scenarios/${s.id}`, { status: 'bogus' }).expect(400);
            await put(`/scenarios/${s.id}`, { status: 'applied' }).expect(400);    // apply is its own route
            await put('/scenarios/999999', { name: 'x' }).expect(404);

            const edited = (await put(`/scenarios/${s.id}`, { name: 'Renamed', description: 'Why', companyId: null }).expect(200)).body;
            expect(edited).toMatchObject({ name: 'Renamed', description: 'Why', companyId: null, rowVersion: 1, adjustmentCount: 0 });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({
                action: 'update', before: { name: s.name, companyId: jfa.id }, after: { name: 'Renamed', companyId: null },
            });
            // The same value is no change: no version bump, no audit row.
            const same = (await put(`/scenarios/${s.id}`, { name: 'Renamed', status: 'draft' }).expect(200)).body;
            expect(same.rowVersion).toBe(1);
            expect(await h.audit('scenario', s.id)).toHaveLength(2);

            const stale = await put(`/scenarios/${s.id}`, { name: 'Late', baseVersion: 0 }).expect(409);
            expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 1 } });

            const archived = (await put(`/scenarios/${s.id}`, { status: 'archived', baseVersion: 1 }).expect(200)).body;
            expect(archived).toMatchObject({ status: 'archived', rowVersion: 2 });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'update', before: { status: 'draft' }, after: { status: 'archived' } });
            // Terminal: no way back; the text still edits.
            await put(`/scenarios/${s.id}`, { status: 'draft' }).expect(400);
            expect((await put(`/scenarios/${s.id}`, { name: 'Archived one' }).expect(200)).body).toMatchObject({ name: 'Archived one', status: 'archived' });

            // An archived scenario is not a draft: no adjustment write, rebase or apply.
            const item = await makeItem();
            for (const res of [
                await putAdj(s.id, item.key, { kind: 'exclude' }).expect(409),
                await delAdj(s.id, item.key).expect(409),
                await post(`/scenarios/${s.id}/rebase`, {}).expect(409),
                await post(`/scenarios/${s.id}/apply`, {}).expect(409),
            ]) {
                expect(res.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'archived' } });
            }
        });

        test('DELETE is a soft delete that keeps the adjustments; audited', async () => {
            const item = await makeItem();
            const s = await makeScenario();
            await putAdj(s.id, item.key, { kind: 'exclude' }).expect(201);
            await del(`/scenarios/${s.id}`, { baseVersion: 7 }).expect(409);
            await del(`/scenarios/${s.id}`, { baseVersion: 0 }).expect(204);
            await get(`/scenarios/${s.id}`).expect(404);
            await del(`/scenarios/${s.id}`).expect(404);
            expect((await get('/scenarios', { q: s.name }).expect(200)).body.total).toBe(0);
            expect((await get('/scenarios', { q: s.name, includeDeleted: 1 }).expect(200)).body.total).toBe(1);

            const kept = await detail(s.id, { includeDeleted: 1 });
            expect(kept.deletedAt).not.toBeNull();
            expect(kept.adjustments.map((a) => a.itemKey)).toEqual([item.key]);
            expect(await h.sql('SELECT item_key FROM scenario_adjustments WHERE scenario_id = ?', [s.id])).toEqual([{ item_key: item.key }]);
            const [audit] = await h.audit('scenario', s.id);
            expect(audit).toMatchObject({ action: 'delete', before: { deletedAt: null } });
            expect(audit.after.deletedAt).not.toBeNull();
            // A deleted scenario takes no adjustment writes.
            await putAdj(s.id, item.key, { kind: 'exclude' }).expect(404);
        });
    });

    describe('adjustments', () => {
        test('ITEM_KEY_INVALID (422) on PUT and DELETE for anything lib/keys.js rejects', async () => {
            const s = await makeScenario();
            for (const key of ['item.01', 'item.-1', 'foo', 'item', 'item.1.2', 'sched.1', 'sched.1.2026-02-30', 'sched.01.2026-06-01', 'ship.a%20b', 'item.1:2']) {
                const res = await putAdj(s.id, key, { kind: 'exclude' }).expect(422);
                expect(res.body).toMatchObject({ code: 'ITEM_KEY_INVALID' });
                expect(res.body.details).toHaveProperty('key');
                expect((await delAdj(s.id, key).expect(422)).body.code).toBe('ITEM_KEY_INVALID');
            }
        });

        test('TARGET_MISSING (404): no such item, a deleted item, a ship. key with no external_items row', async () => {
            const s = await makeScenario();
            const gone = await makeItem();
            await del(`/items/${gone.id}`).expect(204);
            for (const key of ['item.999999', gone.key, 'ship.PO-778']) {
                const res = await putAdj(s.id, key, { kind: 'exclude' }).expect(404);
                expect(res.body).toMatchObject({ code: 'TARGET_MISSING', details: { key } });
            }
            expect(await h.sql('SELECT id FROM scenario_adjustments WHERE scenario_id = ?', [s.id])).toEqual([]);
            // Nothing to delete either.
            await delAdj(s.id, 'ship.PO-778').expect(404);
        });

        test('TARGET_SETTLED (409) on a paid, part-paid or skipped target (D33)', async () => {
            const s = await makeScenario();
            const paid = await makeItem({ dueDate: TODAY });
            await post(`/items/${paid.id}/pay`, { paidOn: TODAY }).expect(200);
            const part = await makeItem({ dueDate: '2026-04-01' });
            await post(`/items/${part.id}/pay`, { paidOn: TODAY, paidAmount: '1.00' }).expect(200);
            const skipped = await makeItem();
            await put(`/items/${skipped.id}`, { status: 'skipped' }).expect(200);
            for (const [item, status] of [[paid, 'paid'], [part, 'part_paid'], [skipped, 'skipped']]) {
                const res = await putAdj(s.id, item.key, { kind: 'adjust', newAmount: '9.00' }).expect(409);
                expect(res.body).toMatchObject({ code: 'TARGET_SETTLED', details: { key: item.key, status } });
            }
        });

        test('body validation (400) and ADJUSTMENT_DATE_IN_PAST (422)', async () => {
            const s = await makeScenario();
            const item = await makeItem();
            for (const [body, re] of [
                [{}, /kind/],
                [{ kind: 'move' }, /kind/],
                [{ kind: 'adjust' }, /newDate or newAmount/],
                [{ kind: 'adjust', newDate: null, newAmount: null }, /newDate or newAmount/],
                [{ kind: 'exclude', newDate: '2026-05-01' }, /exclude/],
                [{ kind: 'exclude', newAmount: '1.00' }, /exclude/],
                [{ kind: 'adjust', newDate: '2026-13-01' }, /newDate/],
                [{ kind: 'adjust', newAmount: 100 }, /newAmount/],
                [{ kind: 'adjust', newAmount: '0' }, /newAmount/],
                [{ kind: 'adjust', newAmount: '1.234' }, /newAmount/],
                [{ kind: 'adjust', newAmount: '-5.00' }, /newAmount/],
                [{ kind: 'exclude', note: 'x'.repeat(501) }, /note/],
                [{ kind: 'exclude', baseVersion: 'x' }, /baseVersion/],
            ]) {
                const res = await putAdj(s.id, item.key, body).expect(400);
                expect(res.body.error).toMatch(re);
            }
            const past = await putAdj(s.id, item.key, { kind: 'adjust', newDate: '2026-03-09' }).expect(422);
            expect(past.body).toMatchObject({ code: 'ADJUSTMENT_DATE_IN_PAST', details: { newDate: '2026-03-09', today: TODAY } });
            // Today itself is fine.
            await putAdj(s.id, item.key, { kind: 'adjust', newDate: TODAY }).expect(201);
            // 404 for the scenario path id before anything else.
            await putAdj('abc', item.key, { kind: 'exclude' }).expect(404);
            await putAdj(999999, item.key, { kind: 'exclude' }).expect(404);
        });

        test('PUT creates (201) then replaces (200); bases come from the loader, never the body; audited', async () => {
            const s = await makeScenario();
            const item = await makeItem({ name: 'Insurance', amount: '480.00', dueDate: '2026-04-20' });
            const created = await putAdj(s.id, item.key, {
                kind: 'adjust', newDate: '2026-05-04', note: 'push a fortnight', baseDate: '2020-01-01', baseAmount: '1.00',
            }).expect(201);
            expect(Object.keys(created.body).sort()).toEqual([...ADJ_KEYS, 'current', 'stale'].sort());
            expect(created.body).toMatchObject({
                scenarioId: s.id, itemKey: item.key, targetKind: 'item', targetId: String(item.id), targetDate: null,
                kind: 'adjust', newDate: '2026-05-04', newAmount: null, baseDate: '2026-04-20', baseAmount: '480.00',
                note: 'push a fortnight', rowVersion: 0, createdBy: 'local@dev', stale: null,
                current: { date: '2026-04-20', amount: '480.00', status: 'expected', name: 'Insurance', currency: 'GBP' },
            });
            const adjId = created.body.id;
            expect((await h.audit('scenario_adjustment', adjId))[0]).toMatchObject({
                action: 'create', before: null, after: { itemKey: item.key, baseAmount: '480.00', newDate: '2026-05-04' },
            });

            // A full replace: the omitted newDate and note are cleared (the web always sends the whole adjustment).
            const replaced = await putAdj(s.id, item.key, { kind: 'adjust', newAmount: '500.00', baseVersion: 0 }).expect(200);
            expect(replaced.body).toMatchObject({ id: adjId, newDate: null, newAmount: '500.00', note: null, rowVersion: 1 });
            expect((await h.audit('scenario_adjustment', adjId))[0]).toMatchObject({
                action: 'update', before: { newDate: '2026-05-04', newAmount: null }, after: { newDate: null, newAmount: '500.00' },
            });
            const stale = await putAdj(s.id, item.key, { kind: 'exclude', baseVersion: 0 }).expect(409);
            expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 1 } });
            // The same body again changes nothing: no bump, no audit row.
            const same = await putAdj(s.id, item.key, { kind: 'adjust', newAmount: '500.00' }).expect(200);
            expect(same.body.rowVersion).toBe(1);
            expect(await h.audit('scenario_adjustment', adjId)).toHaveLength(2);

            // The base follows the target: rewriting after an item edit takes the new values.
            await put(`/items/${item.id}`, { amount: '490.00' }).expect(200);
            const rebased = await putAdj(s.id, item.key, { kind: 'exclude' }).expect(200);
            expect(rebased.body).toMatchObject({ kind: 'exclude', newAmount: null, baseAmount: '490.00', rowVersion: 2 });
            expect((await detail(s.id)).adjustmentCount).toBe(1);
        });

        test('DELETE: hard, 204, audited; 404 when there is none', async () => {
            const s = await makeScenario();
            const item = await makeItem();
            const adj = (await putAdj(s.id, item.key, { kind: 'exclude' }).expect(201)).body;
            await delAdj(s.id, item.key, { baseVersion: 3 }).expect(409);
            await delAdj(s.id, item.key, { baseVersion: 0 }).expect(204);
            expect(await h.sql('SELECT id FROM scenario_adjustments WHERE id = ?', [adj.id])).toEqual([]);
            expect((await h.audit('scenario_adjustment', adj.id))[0]).toMatchObject({
                action: 'delete', after: null, before: { id: adj.id, itemKey: item.key },
            });
            await delAdj(s.id, item.key).expect(404);
            await delAdj(999999, item.key).expect(404);
        });
    });

    describe('stale, rebase and apply', () => {
        test('GET resolves stale and current on a draft: all four reasons, DATE_PASSED via ?today=', async () => {
            const s = await makeScenario();
            const fresh = await makeItem({ dueDate: '2026-04-01' });
            const settled = await makeItem({ dueDate: TODAY });
            const missing = await makeItem();
            const changed = await makeItem({ amount: '100.00' });
            const moving = await makeItem({ dueDate: '2026-04-10' });
            await putAdj(s.id, fresh.key, { kind: 'exclude' }).expect(201);
            await putAdj(s.id, settled.key, { kind: 'adjust', newAmount: '1.00' }).expect(201);
            await putAdj(s.id, missing.key, { kind: 'exclude' }).expect(201);
            await putAdj(s.id, changed.key, { kind: 'adjust', newAmount: '50.00' }).expect(201);
            await putAdj(s.id, moving.key, { kind: 'adjust', newDate: '2026-03-20' }).expect(201);
            // Nothing is stale yet.
            expect((await detail(s.id)).adjustments.map((a) => a.stale)).toEqual([null, null, null, null, null]);

            await post(`/items/${settled.id}/pay`, { paidOn: TODAY }).expect(200);
            await del(`/items/${missing.id}`).expect(204);
            await put(`/items/${changed.id}`, { amount: '120.00' }).expect(200);
            const read = await detail(s.id);
            expect(read.adjustments.map((a) => [a.itemKey, a.stale])).toEqual([
                [fresh.key, null], [settled.key, 'TARGET_SETTLED'], [missing.key, 'TARGET_MISSING'],
                [changed.key, 'BASE_CHANGED'], [moving.key, null],
            ]);
            expect(byKey(read, settled.key).current).toMatchObject({ status: 'paid', amount: '250.00', date: TODAY });
            expect(byKey(read, missing.key).current).toBeNull();
            expect(byKey(read, changed.key).current).toMatchObject({ amount: '120.00', name: changed.name, currency: 'GBP' });

            // Moved past its new_date: DATE_PASSED (D38).
            const later = await detail(s.id, { today: '2026-03-21' });
            expect(byKey(later, moving.key).stale).toBe('DATE_PASSED');
        });

        test('apply with a target paid at the same amount and date → SCENARIO_STALE (TARGET_SETTLED), nothing written', async () => {
            const s = await makeScenario();
            const target = await makeItem({ dueDate: TODAY, amount: '250.00' });
            const other = await makeItem({ dueDate: '2026-04-02' });
            await putAdj(s.id, target.key, { kind: 'adjust', newDate: '2026-03-20' }).expect(201);
            await putAdj(s.id, other.key, { kind: 'exclude' }).expect(201);
            // Paid in full, on its own due date: neither the date nor the amount moved.
            await post(`/items/${target.id}/pay`, { paidOn: TODAY, paidAmount: '250.00' }).expect(200);

            const before = await snapshot();
            const res = await post(`/scenarios/${s.id}/apply`, {}).expect(409);
            expect(res.body).toMatchObject({
                code: 'SCENARIO_STALE', details: { stale: [{ itemKey: target.key, reason: 'TARGET_SETTLED' }] },
            });
            expect(await snapshot()).toEqual(before);
            expect((await detail(s.id)).status).toBe('draft');
        });

        test('BASE_CHANGED refuses apply; rebase then apply succeeds and stamps source_scenario_id; re-apply refused', async () => {
            const s = await makeScenario();
            const moved = await makeItem({ dueDate: '2026-04-15', amount: '300.00' });
            const dropped = await makeItem({ dueDate: '2026-04-16' });
            const resized = await makeItem({ dueDate: '2026-04-17', amount: '75.00' });
            const a1 = (await putAdj(s.id, moved.key, { kind: 'adjust', newDate: '2026-05-01' }).expect(201)).body;
            const a2 = (await putAdj(s.id, dropped.key, { kind: 'exclude' }).expect(201)).body;
            const a3 = (await putAdj(s.id, resized.key, { kind: 'adjust', newAmount: '80.00' }).expect(201)).body;
            await put(`/items/${moved.id}`, { amount: '310.00' }).expect(200);
            await put(`/items/${resized.id}`, { dueDate: '2026-04-18' }).expect(200);

            const before = await snapshot();
            const refused = await post(`/scenarios/${s.id}/apply`, {}).expect(409);
            expect(refused.body.details.stale).toEqual([
                { itemKey: moved.key, reason: 'BASE_CHANGED' },
                { itemKey: resized.key, reason: 'BASE_CHANGED' },
            ]);
            expect(await snapshot()).toEqual(before);

            const rebased = (await post(`/scenarios/${s.id}/rebase`, {}).expect(200)).body;
            expect(rebased.scenario).toMatchObject({ id: s.id, status: 'draft', adjustmentCount: 3 });
            expect(rebased.adjustments.map((a) => [a.itemKey, a.rebased, a.stale, a.dropped])).toEqual([
                [moved.key, true, null, false], [dropped.key, false, null, false], [resized.key, true, null, false],
            ]);
            expect(rebased.adjustments[0]).toMatchObject({ baseAmount: '310.00', baseDate: '2026-04-15', rowVersion: 1, current: { amount: '310.00' } });
            expect(rebased.adjustments[2]).toMatchObject({ baseAmount: '75.00', baseDate: '2026-04-18', rowVersion: 1 });
            expect((await h.audit('scenario_adjustment', a1.id))[0]).toMatchObject({ action: 'update', before: { baseAmount: '300.00' }, after: { baseAmount: '310.00' } });
            expect(await h.audit('scenario_adjustment', a2.id)).toHaveLength(1);        // create only: nothing to rebase
            expect((await h.audit('scenario_adjustment', a3.id))[0]).toMatchObject({ action: 'update', before: { baseDate: '2026-04-17' }, after: { baseDate: '2026-04-18' } });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'rebase', after: { rebased: 2, dropped: 0, stale: 0 } });

            const applied = (await post(`/scenarios/${s.id}/apply`, { baseVersion: 0 }).expect(200)).body;
            expect(applied.scenario).toMatchObject({ id: s.id, status: 'applied', appliedBy: 'local@dev', rowVersion: 1 });
            expect(applied.scenario.appliedAt).not.toBeNull();
            expect(applied.applied).toEqual([
                { itemKey: moved.key, kind: 'adjust', wrote: 'cash_item', entityId: moved.id },
                { itemKey: dropped.key, kind: 'exclude', wrote: 'cash_item', entityId: dropped.id },
                { itemKey: resized.key, kind: 'adjust', wrote: 'cash_item', entityId: resized.id },
            ]);
            const rows = await h.sql('SELECT id, due_date, amount, status, source_scenario_id, row_version FROM cash_items WHERE id IN (?, ?, ?) ORDER BY id',
                [moved.id, dropped.id, resized.id]);
            expect(rows).toEqual([
                { id: moved.id, due_date: '2026-05-01', amount: '310.00', status: 'expected', source_scenario_id: s.id, row_version: 2 },
                { id: dropped.id, due_date: '2026-04-16', amount: '250.00', status: 'skipped', source_scenario_id: s.id, row_version: 1 },
                { id: resized.id, due_date: '2026-04-18', amount: '80.00', status: 'expected', source_scenario_id: s.id, row_version: 2 },
            ]);
            expect((await h.audit('cash_item', moved.id))[0]).toMatchObject({
                action: 'apply', before: { dueDate: '2026-04-15', sourceScenarioId: null }, after: { dueDate: '2026-05-01', sourceScenarioId: s.id },
            });
            expect((await h.audit('cash_item', dropped.id))[0]).toMatchObject({ action: 'apply', after: { status: 'skipped' } });
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'apply', before: { status: 'draft' }, after: { status: 'applied' } });
            // The item JSON reports where it came from.
            expect((await get(`/items/${moved.id}`).expect(200)).body.sourceScenarioId).toBe(s.id);

            // Applied: immutable, and history rather than a live comparison.
            const again = await post(`/scenarios/${s.id}/apply`, {}).expect(409);
            expect(again.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
            const edit = await putAdj(s.id, moved.key, { kind: 'exclude' }).expect(409);
            expect(edit.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
            expect((await delAdj(s.id, moved.key).expect(409)).body.code).toBe('SCENARIO_NOT_DRAFT');
            expect((await post(`/scenarios/${s.id}/rebase`, { dropStale: true }).expect(409)).body.code).toBe('SCENARIO_NOT_DRAFT');
            const history = await detail(s.id);
            expect(history.adjustments.map((a) => [a.stale, a.current])).toEqual([[null, null], [null, null], [null, null]]);
            // Archive from applied (D36).
            expect((await put(`/scenarios/${s.id}`, { status: 'archived' }).expect(200)).body.status).toBe('archived');
        });

        test('rebase dropStale removes only the settled, missing and date-passed ones; BASE_CHANGED is rebased', async () => {
            const s = await makeScenario();
            const fresh = await makeItem({ dueDate: '2026-04-01' });
            const settled = await makeItem({ dueDate: TODAY });
            const missing = await makeItem();
            const changed = await makeItem({ amount: '100.00' });
            const passing = await makeItem({ dueDate: '2026-04-10' });
            const adjs = {};
            adjs.fresh = (await putAdj(s.id, fresh.key, { kind: 'adjust', newDate: '2026-04-30' }).expect(201)).body;
            adjs.settled = (await putAdj(s.id, settled.key, { kind: 'exclude' }).expect(201)).body;
            adjs.missing = (await putAdj(s.id, missing.key, { kind: 'exclude' }).expect(201)).body;
            adjs.changed = (await putAdj(s.id, changed.key, { kind: 'adjust', newAmount: '90.00' }).expect(201)).body;
            adjs.passing = (await putAdj(s.id, passing.key, { kind: 'adjust', newDate: '2026-03-12', newAmount: '1.00' }).expect(201)).body;
            // A ship. key with no external_items row (put there by hand) reads TARGET_MISSING; ship-overlay.test.js covers real ones.
            const [ship] = await h.sql(
                `INSERT INTO scenario_adjustments (scenario_id, item_key, target_kind, target_id, kind, base_date, base_amount, created_by)
                 VALUES (?, 'ship.PO-1', 'ship', 'PO-1', 'exclude', '2026-04-01', '10.00', 'e2e')`, [s.id]
            ).then((r) => [r.insertId]);

            await post(`/items/${settled.id}/pay`, { paidOn: TODAY }).expect(200);
            await del(`/items/${missing.id}`).expect(204);
            await put(`/items/${changed.id}`, { amount: '110.00' }).expect(200);
            await put(`/items/${passing.id}`, { amount: '260.00' }).expect(200);     // its base changed too

            const LATER = '2026-03-15';        // past `passing`'s new_date, before `fresh`'s
            const staleNow = await detail(s.id, { today: LATER });
            expect(staleNow.adjustments.map((a) => a.stale)).toEqual([
                null, 'TARGET_SETTLED', 'TARGET_MISSING', 'BASE_CHANGED', 'BASE_CHANGED', 'TARGET_MISSING',
            ]);
            // Without dropStale the stale ones stay; DATE_PASSED is reported even though the base changed too.
            const kept = (await post(`/scenarios/${s.id}/rebase`, {}, LATER).expect(200)).body;
            expect(kept.adjustments.map((a) => [a.itemKey, a.rebased, a.stale, a.dropped])).toEqual([
                [fresh.key, false, null, false],
                [settled.key, false, 'TARGET_SETTLED', false],
                [missing.key, false, 'TARGET_MISSING', false],
                [changed.key, true, null, false],
                [passing.key, false, 'DATE_PASSED', false],
                ['ship.PO-1', false, 'TARGET_MISSING', false],
            ]);
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'rebase', after: { rebased: 1, dropped: 0, stale: 4 } });

            const dropped = (await post(`/scenarios/${s.id}/rebase`, { dropStale: true }, LATER).expect(200)).body;
            expect(dropped.adjustments.map((a) => [a.itemKey, a.rebased, a.stale, a.dropped])).toEqual([
                [fresh.key, false, null, false],
                [settled.key, false, 'TARGET_SETTLED', true],
                [missing.key, false, 'TARGET_MISSING', true],
                [changed.key, false, null, false],           // rebased the first time round
                [passing.key, false, 'DATE_PASSED', true],
                ['ship.PO-1', false, 'TARGET_MISSING', true],
            ]);
            expect(dropped.scenario.adjustmentCount).toBe(2);
            const left = await h.sql('SELECT id, base_amount FROM scenario_adjustments WHERE scenario_id = ? ORDER BY id', [s.id]);
            expect(left).toEqual([{ id: adjs.fresh.id, base_amount: '250.00' }, { id: adjs.changed.id, base_amount: '110.00' }]);
            for (const id of [adjs.settled.id, adjs.missing.id, adjs.passing.id, ship]) {
                expect((await h.audit('scenario_adjustment', id))[0]).toMatchObject({ action: 'delete', after: null });
            }
            expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'rebase', after: { rebased: 0, dropped: 4, stale: 4, dropStale: true } });
            await post(`/scenarios/${s.id}/rebase`, { dropStale: 'yes' }).expect(400);

            // What is left applies on the later day.
            await post(`/scenarios/${s.id}/apply`, {}, LATER).expect(200);
        });

        test('apply waits on an item target\'s lock and re-checks what committed meanwhile', async () => {
            const s = await makeScenario();
            const item = await makeItem({ dueDate: TODAY });
            await putAdj(s.id, item.key, { kind: 'adjust', newDate: '2026-03-20' }).expect(201);
            const res = await whileLocked('SELECT id FROM cash_items WHERE id = ? FOR UPDATE', [item.id],
                () => post(`/scenarios/${s.id}/apply`, {}),
                // A pay lands while apply waits (by hand, as the pay route writes it under the same lock).
                () => h.sql("UPDATE cash_items SET status = 'paid', paid_on = ?, paid_amount = amount, row_version = row_version + 1 WHERE id = ?", [TODAY, item.id]));
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'SCENARIO_STALE', details: { stale: [{ itemKey: item.key, reason: 'TARGET_SETTLED' }] } });
        });

        test('apply refuses DATE_PASSED under a later ?today=, writing nothing', async () => {
            const s = await makeScenario();
            const item = await makeItem({ dueDate: '2026-04-10' });
            await putAdj(s.id, item.key, { kind: 'adjust', newDate: '2026-03-12' }).expect(201);
            const before = await snapshot();
            const res = await post(`/scenarios/${s.id}/apply`, {}, '2026-03-13').expect(409);
            expect(res.body).toMatchObject({ code: 'SCENARIO_STALE', details: { stale: [{ itemKey: item.key, reason: 'DATE_PASSED' }] } });
            expect(await snapshot()).toEqual(before);
            await post(`/scenarios/${s.id}/apply`, { baseVersion: 5 }).expect(409).then((r) => expect(r.body.code).toBe('STALE_WRITE'));
            await post(`/scenarios/${s.id}/apply`, {}).expect(200);
        });

        test('duplicate: a fresh draft, every adjustment copied with its bases as-is; audited', async () => {
            const s = await makeScenario({ name: 'Original', description: 'first go', companyId: jfa.id });
            const moved = await makeItem({ dueDate: '2026-04-15' });
            const excluded = await makeItem({ dueDate: '2026-04-16' });
            await putAdj(s.id, moved.key, { kind: 'adjust', newDate: '2026-05-01', note: 'later' }).expect(201);
            await putAdj(s.id, excluded.key, { kind: 'exclude' }).expect(201);
            await post(`/scenarios/${s.id}/apply`, {}).expect(200);

            const copy = (await post(`/scenarios/${s.id}/duplicate`, {}).expect(201)).body;
            expect(Object.keys(copy).sort()).toEqual(ROW_KEYS);
            expect(copy).toMatchObject({
                name: 'Original (copy)', description: 'first go', companyId: jfa.id, status: 'draft', appliedAt: null,
                appliedBy: null, adjustmentCount: 2, rowVersion: 0,
            });
            expect(copy.id).not.toBe(s.id);
            const source = await h.sql('SELECT item_key, target_kind, target_id, target_date, kind, new_date, new_amount, base_date, base_amount, note FROM scenario_adjustments WHERE scenario_id = ? ORDER BY id', [s.id]);
            const copied = await h.sql('SELECT item_key, target_kind, target_id, target_date, kind, new_date, new_amount, base_date, base_amount, note FROM scenario_adjustments WHERE scenario_id = ? ORDER BY id', [copy.id]);
            expect(copied).toEqual(source);
            // The bases were copied, not refreshed: the apply moved `moved` and skipped `excluded`, so the first read says so.
            const read = await detail(copy.id);
            expect(read.adjustments.map((a) => [a.itemKey, a.stale])).toEqual([[moved.key, 'BASE_CHANGED'], [excluded.key, 'TARGET_SETTLED']]);

            const [dupAudit] = await h.audit('scenario', copy.id);
            expect(dupAudit).toMatchObject({ action: 'duplicate', before: null, after: { id: copy.id, status: 'draft', copiedFrom: s.id } });
            for (const a of read.adjustments) {
                expect(await h.audit('scenario_adjustment', a.id)).toEqual([expect.objectContaining({ action: 'create', before: null })]);
            }
            // The source is untouched.
            expect((await detail(s.id)).status).toBe('applied');

            const named = (await post(`/scenarios/${s.id}/duplicate`, { name: 'Second go' }).expect(201)).body;
            expect(named).toMatchObject({ name: 'Second go', status: 'draft', adjustmentCount: 2 });
            await post(`/scenarios/${s.id}/duplicate`, { name: '  ' }).expect(400);
            await post('/scenarios/999999/duplicate', {}).expect(404);
            await del(`/scenarios/${named.id}`).expect(204);
            await post(`/scenarios/${named.id}/duplicate`, {}).expect(404);
            // A long name still fits the column.
            const long = await makeScenario({ name: 'L'.repeat(255) });
            const longCopy = (await post(`/scenarios/${long.id}/duplicate`, {}).expect(201)).body;
            expect(longCopy.name).toHaveLength(255);
            expect(longCopy.name.endsWith(' (copy)')).toBe(true);
        });
    });

    // Schedule instances as targets. Needs step 5's schedule and instance routes and
    // loadTarget's `sched.` branch.
    describe('schedule-instance targets', () => {
        const makeSchedule = async (body = {}) => (await post('/schedules', {
            accountId: main.id, categoryId: costs.id, name: 'Rent', amount: '1000.00', frequency: 'monthly',
            startDate: '2026-04-01', ...body,
        }).expect(201)).body;

        test('a key sent un-encoded through HTTP reaches the right row; D11 bases; non-occurrence is TARGET_MISSING', async () => {
            const sched = await makeSchedule();
            const s = await makeScenario();
            const key = `sched.${sched.id}.2026-06-01`;
            // supertest sends the path verbatim: no percent-encoding anywhere.
            const res = await api().put(`/api/v1/scenarios/${s.id}/adjustments/sched.${sched.id}.2026-06-01`)
                .query({ today: TODAY }).send({ kind: 'adjust', newAmount: '1100.00' }).expect(201);
            expect(res.body).toMatchObject({
                itemKey: key, targetKind: 'sched', targetId: String(sched.id), targetDate: '2026-06-01',
                baseDate: '2026-06-01', baseAmount: '1000.00', current: { name: 'Rent', currency: 'GBP', status: 'expected' },
            });
            expect(await h.sql('SELECT scenario_id, item_key, target_kind, target_id, target_date FROM scenario_adjustments WHERE id = ?', [res.body.id]))
                .toEqual([{ scenario_id: s.id, item_key: key, target_kind: 'sched', target_id: String(sched.id), target_date: '2026-06-01' }]);

            // D11: a tuned instance's base is the override-adjusted value.
            await put(`/schedules/${sched.id}/instances/2026-07-01`, { amount: '983.00', dueDate: '2026-07-03' }).expect(200);
            const tuned = (await putAdj(s.id, `sched.${sched.id}.2026-07-01`, { kind: 'exclude' }).expect(201)).body;
            expect(tuned).toMatchObject({ baseDate: '2026-07-03', baseAmount: '983.00', targetDate: '2026-07-01' });

            const notOne = await putAdj(s.id, `sched.${sched.id}.2026-06-02`, { kind: 'exclude' }).expect(404);
            expect(notOne.body).toMatchObject({ code: 'TARGET_MISSING', details: { key: `sched.${sched.id}.2026-06-02` } });
            await putAdj(s.id, 'sched.999999.2026-06-01', { kind: 'exclude' }).expect(404);

            // DELETE un-encoded too; only that row goes.
            await api().delete(`/api/v1/scenarios/${s.id}/adjustments/sched.${sched.id}.2026-06-01`).query({ today: TODAY }).expect(204);
            expect((await h.sql('SELECT item_key FROM scenario_adjustments WHERE scenario_id = ?', [s.id])).map((r) => r.item_key))
                .toEqual([`sched.${sched.id}.2026-07-01`]);
        });

        test('an instance paid at the same amount and date → SCENARIO_STALE (TARGET_SETTLED), nothing written', async () => {
            const sched = await makeSchedule({ startDate: '2026-02-10' });
            const s = await makeScenario();
            const key = `sched.${sched.id}.${TODAY}`;
            await putAdj(s.id, key, { kind: 'adjust', newDate: '2026-03-25' }).expect(201);
            await putAdj(s.id, `sched.${sched.id}.2026-05-10`, { kind: 'exclude' }).expect(201);
            await post(`/schedules/${sched.id}/instances/${TODAY}/pay`, { paidOn: TODAY, paidAmount: '1000.00' }).expect(200);
            // A write against it is refused too.
            expect((await putAdj(s.id, key, { kind: 'exclude' }).expect(409)).body).toMatchObject({ code: 'TARGET_SETTLED', details: { key, status: 'paid' } });

            const before = await snapshot();
            const res = await post(`/scenarios/${s.id}/apply`, {}).expect(409);
            expect(res.body).toMatchObject({ code: 'SCENARIO_STALE', details: { stale: [{ itemKey: key, reason: 'TARGET_SETTLED' }] } });
            expect(await snapshot()).toEqual(before);
        });

        test('apply waits on the schedule lock and sees an override committed meanwhile', async () => {
            const sched = await makeSchedule({ startDate: '2026-02-10' });
            const s = await makeScenario();
            const key = `sched.${sched.id}.${TODAY}`;
            await putAdj(s.id, key, { kind: 'adjust', newDate: '2026-03-25' }).expect(201);
            const res = await whileLocked('SELECT id FROM schedules WHERE id = ? FOR UPDATE', [sched.id],
                () => post(`/scenarios/${s.id}/apply`, {}),
                // The instance is paid while apply waits: a new override row carrying payment state.
                () => h.sql(
                    `INSERT INTO schedule_overrides (schedule_id, natural_date, status, paid_on, paid_amount, created_by)
                     VALUES (?, ?, 'paid', ?, '1000.00', 'e2e')`, [sched.id, TODAY, TODAY]
                ));
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'SCENARIO_STALE', details: { stale: [{ itemKey: key, reason: 'TARGET_SETTLED' }] } });
        });

        test('apply upserts overrides stamped source_scenario_id: a new skipped row, and a tuned row re-dated', async () => {
            const sched = await makeSchedule();
            await put(`/schedules/${sched.id}/instances/2026-07-01`, { amount: '983.00' }).expect(200);
            const [tunedRow] = await h.sql('SELECT id FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ?', [sched.id, '2026-07-01']);
            const s = await makeScenario();
            await putAdj(s.id, `sched.${sched.id}.2026-05-01`, { kind: 'exclude' }).expect(201);
            await putAdj(s.id, `sched.${sched.id}.2026-07-01`, { kind: 'adjust', newDate: '2026-07-15' }).expect(201);

            const applied = (await post(`/scenarios/${s.id}/apply`, {}).expect(200)).body;
            const rows = await h.sql(
                'SELECT id, natural_date, amount, due_date, status, source_scenario_id FROM schedule_overrides WHERE schedule_id = ? ORDER BY natural_date',
                [sched.id]
            );
            expect(rows).toEqual([
                { id: expect.any(Number), natural_date: '2026-05-01', amount: null, due_date: null, status: 'skipped', source_scenario_id: s.id },
                { id: tunedRow.id, natural_date: '2026-07-01', amount: '983.00', due_date: '2026-07-15', status: null, source_scenario_id: s.id },
            ]);
            expect(applied.applied).toEqual([
                { itemKey: `sched.${sched.id}.2026-05-01`, kind: 'exclude', wrote: 'schedule_override', entityId: rows[0].id },
                { itemKey: `sched.${sched.id}.2026-07-01`, kind: 'adjust', wrote: 'schedule_override', entityId: tunedRow.id },
            ]);
            expect((await h.audit('schedule_override', rows[0].id))[0]).toMatchObject({
                action: 'apply', before: null, after: { naturalDate: '2026-05-01', status: 'skipped', sourceScenarioId: s.id },
            });
            expect((await h.audit('schedule_override', tunedRow.id))[0]).toMatchObject({
                action: 'apply', before: { dueDate: null, sourceScenarioId: null }, after: { dueDate: '2026-07-15', sourceScenarioId: s.id },
            });
            // The instance read agrees.
            const inst = (await get(`/schedules/${sched.id}/instances`, { from: '2026-05-01', to: '2026-05-01' }).expect(200)).body.data[0];
            expect(inst).toMatchObject({ status: 'skipped', override: { sourceScenarioId: s.id } });
        });
    });
});
