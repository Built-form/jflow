'use strict';

// Split and end (CONTRACT §6.8, §10.5 — PLAN's seven steps; D21, D22), end to end
// against a per-run jflow_test_<runid> schema with `today` pinned through ?today=.
// Scenario routes arrive in step 7, so draft (and non-draft) scenarios and their
// adjustments are written here directly in SQL.
//   - the refusals, in step order: SCHEDULE_HAS_PAYMENTS, SCHEDULE_HAS_OVERRIDES,
//     SCHEDULE_HAS_ADJUSTMENTS (listing only what cannot be re-keyed);
//   - an amount-only split re-keys draft adjustments to the successor after inserting
//     it; natural dates survive through active_from (monthly from 31 Jan, split at 30 Jun);
//   - a currency-only split refuses; a frequency split with both drops leaves nothing
//     for the old schedule from k, one audit row per deleted row;
//   - non-draft scenarios' adjustments are left alone; end-early mirrors the guard;
//   - two connections: a pay issued during a split waits on the schedule lock and then
//     lands or is refused, never lost; the split takes its scenario locks first.

const { startHarness } = require('./harness');
const { parseKey } = require('../../src/lib/keys');

jest.setTimeout(240000);

let h;
let db;
let splitOrEnd;
let loadTarget;
beforeAll(async () => {
    h = await startHarness();
    // After the harness: the pool reads DB_NAME, which the harness points at the run's schema.
    db = require('../../src/db');
    ({ splitOrEnd } = require('../../src/routes/schedules'));
    ({ loadTarget } = require('../../src/services/forecastLoad'));
});
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';
const A = '2026-03-01';

const withToday = (req, today) => req.query(today ? { today } : {});
const post = (path, body, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });

const split = (id, body) => post(`/schedules/${id}/split`, body);
const end = (id, body) => post(`/schedules/${id}/end`, body);
const tune = (id, date, body) => put(`/schedules/${id}/instances/${date}`, body);
const pay = (id, date, body) => post(`/schedules/${id}/instances/${date}/pay`, body);
const unpay = (id, date) => post(`/schedules/${id}/instances/${date}/unpay`, {});
const naturalDates = async (id, from, to) =>
    (await get(`/schedules/${id}/instances`, { from, to }).expect(200)).body.data.map((i) => i.naturalDate);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Start a supertest request now and watch whether it has answered. */
function track(req) {
    const state = { done: false };
    state.promise = req.then((res) => { state.done = true; return res; });
    return state;
}

// Scenarios and adjustments in SQL until step 7's routes exist.
async function scenario(name, { status = 'draft', deleted = false } = {}) {
    const res = await h.sql(
        `INSERT INTO scenarios (name, status, created_by, deleted_at) VALUES (?, ?, 'e2e', ${deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
        [name, status]
    );
    return res.insertId;
}
async function adjust(scenarioId, scheduleId, date, { kind = 'adjust', newAmount = '1100.00', baseAmount = '1000.00' } = {}) {
    const res = await h.sql(
        `INSERT INTO scenario_adjustments
            (scenario_id, item_key, target_kind, target_id, target_date, kind, new_amount, base_date, base_amount, created_by)
         VALUES (?, ?, 'sched', ?, ?, ?, ?, ?, ?, 'e2e')`,
        [scenarioId, `sched.${scheduleId}.${date}`, String(scheduleId), date, kind,
            kind === 'adjust' ? newAmount : null, date, baseAmount]
    );
    return res.insertId;
}
const adjustmentRow = async (id) => (await h.sql(
    'SELECT id, scenario_id, item_key, target_kind, target_id, target_date, base_date, base_amount, row_version FROM scenario_adjustments WHERE id = ?',
    [id]
))[0];
const adjustmentsFrom = (scheduleId, from) => h.sql(
    "SELECT id FROM scenario_adjustments WHERE target_kind = 'sched' AND target_id = ? AND target_date >= ? ORDER BY id",
    [String(scheduleId), from]
);
const overrideDates = async (scheduleId) => (await h.sql(
    'SELECT natural_date FROM schedule_overrides WHERE schedule_id = ? ORDER BY natural_date', [scheduleId]
)).map((r) => r.natural_date);

describe('split and end', () => {
    let main;
    let other;
    let dormant;
    let out;

    const makeSchedule = async (body = {}) => (await post('/schedules', {
        accountId: main.id, categoryId: out.id, name: 'Rent', amount: '1000.00', frequency: 'monthly',
        startDate: '2026-01-31', ...body,
    }).expect(201)).body;
    const readSchedule = async (id) => (await get(`/schedules/${id}`).expect(200)).body;

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        const jfa = companies.find((c) => c.code === 'JFA');
        const account = async (body) => (await api().post('/api/v1/accounts').send(body).expect(201)).body;
        main = await account({ companyId: jfa.id, name: 'Main', currency: 'GBP' });
        other = await account({ companyId: jfa.id, name: 'Other', currency: 'GBP' });
        dormant = await account({ companyId: jfa.id, name: 'Dormant', currency: 'GBP', isActive: false });
        out = (await api().post('/api/v1/categories').send({ name: 'Suppliers', direction: 'out' }).expect(201)).body;
        await put(`/accounts/${main.id}/balances/${A}`, { balance: '1000.00' }).expect(200);
    });

    test('split validation: body (400 before the transaction), k (D21) and the successor (400), 404, STALE_WRITE', async () => {
        const s = await makeSchedule({ name: 'Validation' });
        const k = '2026-06-30';
        const bodies = [
            [{}, /fromNaturalDate/],
            [{ fromNaturalDate: 'x', changes: { amount: '1.00' } }, /fromNaturalDate/],
            [{ fromNaturalDate: k }, /changes/],
            [{ fromNaturalDate: k, changes: [] }, /changes/],
            [{ fromNaturalDate: k, changes: 'amount' }, /changes/],
            [{ fromNaturalDate: k, changes: {} }, /at least one/],
            [{ fromNaturalDate: k, changes: { amount: '1.00', activeFrom: k } }, /activeFrom/],
            [{ fromNaturalDate: k, changes: { name: 'New name' } }, /name/],
            [{ fromNaturalDate: k, changes: { amount: 5 } }, /amount/],
            [{ fromNaturalDate: k, changes: { frequency: 'daily' } }, /frequency/],
            [{ fromNaturalDate: k, changes: { intervalCount: 0 } }, /intervalCount/],
            [{ fromNaturalDate: k, changes: { occurrenceCount: 2, endDate: '2026-12-31' } }, /occurrenceCount or endDate/],
            [{ fromNaturalDate: k, changes: { amount: '1.00' }, dropOverrides: 'yes' }, /dropOverrides/],
            [{ fromNaturalDate: k, changes: { amount: '1.00' }, dropAdjustments: 1 }, /dropAdjustments/],
            [{ fromNaturalDate: k, changes: { amount: '1.00' }, baseVersion: 'x' }, /baseVersion/],
            // Inside the transaction, under the locks.
            [{ fromNaturalDate: '2026-06-15', changes: { amount: '1.00' } }, /not an instance/],
            [{ fromNaturalDate: '2026-01-31', changes: { amount: '1.00' } }, /first/],
            [{ fromNaturalDate: '2025-12-31', changes: { amount: '1.00' } }, /not an instance/],
            [{ fromNaturalDate: k, changes: { startDate: '2026-06-01' } }, /startDate/],
            [{ fromNaturalDate: k, changes: { amount: '1.00', endDate: '2026-06-01' } }, /no instances/],
            [{ fromNaturalDate: k, changes: { accountId: dormant.id } }, /inactive/],
            [{ fromNaturalDate: k, changes: { accountId: 999999 } }, /not a live account/],
        ];
        for (const [body, msg] of bodies) {
            const res = await split(s.id, body).expect(400);
            expect(res.body.error).toMatch(msg);
        }
        await split(999999, { fromNaturalDate: k, changes: { amount: '1.00' } }).expect(404);
        await split('abc', { fromNaturalDate: k, changes: { amount: '1.00' } }).expect(404);
        const stale = await split(s.id, { fromNaturalDate: k, changes: { amount: '1.00' }, baseVersion: 5 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });
        // Nothing was written.
        expect(await readSchedule(s.id)).toMatchObject({ rowVersion: 0, status: 'active', endDate: null, successorId: null });
        expect(await h.sql('SELECT COUNT(*) AS n FROM schedules WHERE predecessor_id = ?', [s.id])).toEqual([{ n: 0 }]);
    });

    test('amount-only split of a monthly-from-31-Jan series at 30 Jun: the grid survives and draft adjustments re-key', async () => {
        const s = await makeSchedule({ name: 'Month end' });
        await tune(s.id, '2026-03-31', { amount: '983.00' }).expect(200);          // before k: stays behind
        const draft = await scenario('Draft one');
        const before = await adjust(draft, s.id, '2026-05-31');                     // before k: untouched
        const atK = await adjust(draft, s.id, '2026-06-30');
        const later = await adjust(draft, s.id, '2026-07-31', { kind: 'exclude' });

        const res = (await split(s.id, { fromNaturalDate: '2026-06-30', changes: { amount: '1050' } }).expect(201)).body;
        expect(Object.keys(res).sort()).toEqual(['deletedOverrides', 'droppedAdjustments', 'ended', 'rekeyedAdjustments', 'successor']);
        const next = res.successor;
        expect(res.ended).toMatchObject({
            id: s.id, endDate: '2026-06-29', occurrenceCount: null, status: 'ended', successorId: next.id, rowVersion: 1,
            amount: '1000.00', activeFrom: null,
        });
        expect(next).toMatchObject({
            predecessorId: s.id, successorId: null, startDate: '2026-01-31', activeFrom: '2026-06-30', amount: '1050.00',
            currency: 'GBP', accountId: main.id, categoryId: out.id, name: 'Month end', frequency: 'monthly',
            occurrenceCount: null, endDate: null, status: 'active', structureLocked: true, rowVersion: 0,
        });
        expect(res.deletedOverrides).toEqual([]);
        expect(res.droppedAdjustments).toEqual([]);
        expect(res.rekeyedAdjustments).toEqual([
            { scenarioId: draft, from: `sched.${s.id}.2026-06-30`, to: `sched.${next.id}.2026-06-30` },
            { scenarioId: draft, from: `sched.${s.id}.2026-07-31`, to: `sched.${next.id}.2026-07-31` },
        ]);

        // Month-end identity: 30 Jun, 31 Jul, 31 Aug, 30 Sep — and the old series stops at 31 May.
        expect(await naturalDates(next.id, '2026-01-01', '2026-09-30')).toEqual(['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']);
        const old = (await get(`/schedules/${s.id}/instances`, { from: '2026-01-01', to: '2026-12-31' }).expect(200)).body.data;
        expect(old.map((i) => i.naturalDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
        expect(old[2]).toMatchObject({ tuned: true, amount: '983.00' });

        // Re-keyed after the successor existed: new key and target_id, same natural date, bases untouched.
        expect(await adjustmentRow(atK)).toEqual({
            id: atK, scenario_id: draft, item_key: `sched.${next.id}.2026-06-30`, target_kind: 'sched',
            target_id: String(next.id), target_date: '2026-06-30', base_date: '2026-06-30', base_amount: '1000.00', row_version: 1,
        });
        expect(await adjustmentRow(later)).toMatchObject({ item_key: `sched.${next.id}.2026-07-31`, target_id: String(next.id), row_version: 1 });
        expect(await adjustmentRow(before)).toMatchObject({ item_key: `sched.${s.id}.2026-05-31`, target_id: String(s.id), row_version: 0 });

        // One audit row each: re-keys, the split on the old row, the create on the successor.
        const [rekeyAudit] = await h.audit('scenario_adjustment', atK);
        expect(rekeyAudit).toMatchObject({
            action: 'update',
            before: { itemKey: `sched.${s.id}.2026-06-30`, targetId: String(s.id) },
            after: { itemKey: `sched.${next.id}.2026-06-30`, targetId: String(next.id) },
        });
        expect((await h.audit('scenario_adjustment', before))).toEqual([]);
        const trail = await h.audit('schedule', s.id);
        expect(trail.map((r) => r.action)).toEqual(['split', 'create']);
        expect(trail[0]).toMatchObject({ before: { endDate: null, status: 'active' }, after: { endDate: '2026-06-29', status: 'ended' } });
        expect((await h.audit('schedule', next.id))[0]).toMatchObject({
            action: 'create', before: null, after: { predecessorId: s.id, activeFrom: '2026-06-30', amount: '1050.00' },
        });

        // The re-keyed adjustment now reads stale BASE_CHANGED: same date, new amount.
        const target = await db.withConnection((c) => loadTarget(c, parseKey(`sched.${next.id}.2026-07-31`), TODAY));
        expect(target).toMatchObject({ effectiveDate: '2026-07-31', effectiveAmount: '1050.00' });
        expect(target.effectiveAmount).not.toBe('1000.00');
        expect(await db.withConnection((c) => loadTarget(c, parseKey(`sched.${s.id}.2026-07-31`), TODAY))).toBeNull();
    });

    test('keepSeries with a shorter end: what the successor still generates re-keys, the rest needs dropAdjustments', async () => {
        const s = await makeSchedule({ name: 'Shorter' });
        const draft = await scenario('Short');
        const kept = await adjust(draft, s.id, '2026-07-31');
        const beyond = await adjust(draft, s.id, '2026-10-31');
        const body = { fromNaturalDate: '2026-06-30', changes: { amount: '1050.00', endDate: '2026-08-31' } };

        const refused = await split(s.id, body).expect(409);
        expect(refused.body).toMatchObject({
            code: 'SCHEDULE_HAS_ADJUSTMENTS',
            details: { adjustments: [{ scenarioId: draft, scenarioName: 'Short', itemKey: `sched.${s.id}.2026-10-31`, naturalDate: '2026-10-31' }] },
        });
        expect((await adjustmentRow(kept)).row_version).toBe(0);

        const res = (await split(s.id, { ...body, dropAdjustments: true }).expect(201)).body;
        expect(res.successor).toMatchObject({ endDate: '2026-08-31', occurrenceCount: null, activeFrom: '2026-06-30' });
        expect(res.rekeyedAdjustments).toEqual([{ scenarioId: draft, from: `sched.${s.id}.2026-07-31`, to: `sched.${res.successor.id}.2026-07-31` }]);
        expect(res.droppedAdjustments).toEqual([{ scenarioId: draft, itemKey: `sched.${s.id}.2026-10-31` }]);
        expect(await adjustmentRow(beyond)).toBeUndefined();
        expect(await naturalDates(res.successor.id, '2026-06-01', '2026-12-31')).toEqual(['2026-06-30', '2026-07-31', '2026-08-31']);
    });

    test('a currency-only split with a draft adjustment refuses SCHEDULE_HAS_ADJUSTMENTS; dropAdjustments drops it', async () => {
        const s = await makeSchedule({ name: 'Currency', startDate: '2026-01-10' });
        const draft = await scenario('Currency');
        const early = await adjust(draft, s.id, '2026-02-10');
        const target = await adjust(draft, s.id, '2026-05-10');
        const body = { fromNaturalDate: '2026-04-10', changes: { currency: 'EUR' } };

        const refused = await split(s.id, body).expect(409);
        expect(refused.body).toEqual({
            error: expect.any(String), code: 'SCHEDULE_HAS_ADJUSTMENTS',
            details: { adjustments: [{ scenarioId: draft, scenarioName: 'Currency', itemKey: `sched.${s.id}.2026-05-10`, naturalDate: '2026-05-10' }] },
        });
        expect(await readSchedule(s.id)).toMatchObject({ rowVersion: 0, status: 'active', successorId: null });

        const res = (await split(s.id, { ...body, dropAdjustments: true }).expect(201)).body;
        expect(res.successor).toMatchObject({ currency: 'EUR', startDate: '2026-01-10', activeFrom: '2026-04-10', amount: '1000.00' });
        expect(res.rekeyedAdjustments).toEqual([]);
        expect(res.droppedAdjustments).toEqual([{ scenarioId: draft, itemKey: `sched.${s.id}.2026-05-10` }]);
        expect(await adjustmentRow(target)).toBeUndefined();
        expect(await adjustmentRow(early)).toMatchObject({ item_key: `sched.${s.id}.2026-02-10`, row_version: 0 });
        const [audit] = await h.audit('scenario_adjustment', target);
        expect(audit).toMatchObject({ action: 'delete', after: null, before: { id: target, itemKey: `sched.${s.id}.2026-05-10`, scenarioId: draft } });
    });

    test('a frequency split with both drops leaves no overrides or adjustments for the old schedule from k, an audit row for each', async () => {
        const s = await makeSchedule({ name: 'Frequency', startDate: '2026-01-15' });
        const kept = (await tune(s.id, '2026-02-15', { note: 'kept' }).expect(200)).body.override.id;
        const o1 = (await tune(s.id, '2026-04-15', { amount: '900.00' }).expect(200)).body.override.id;
        const o2 = (await tune(s.id, '2026-05-15', { settleMode: 'manual' }).expect(200)).body.override.id;
        const one = await scenario('Freq one');
        const two = await scenario('Freq two');
        const early = await adjust(one, s.id, '2026-03-15');
        const a1 = await adjust(one, s.id, '2026-04-15');
        const a2 = await adjust(one, s.id, '2026-06-15', { kind: 'exclude' });
        const a3 = await adjust(two, s.id, '2026-05-15');
        const k = '2026-04-15';
        const body = { fromNaturalDate: k, changes: { frequency: 'quarterly' } };

        const overrides = await split(s.id, body).expect(409);
        expect(overrides.body).toMatchObject({ code: 'SCHEDULE_HAS_OVERRIDES', details: { naturalDates: ['2026-04-15', '2026-05-15'] } });
        const adjustments = await split(s.id, { ...body, dropOverrides: true }).expect(409);
        expect(adjustments.body).toMatchObject({
            code: 'SCHEDULE_HAS_ADJUSTMENTS',
            details: {
                adjustments: [
                    { scenarioId: one, scenarioName: 'Freq one', itemKey: `sched.${s.id}.2026-04-15`, naturalDate: '2026-04-15' },
                    { scenarioId: one, scenarioName: 'Freq one', itemKey: `sched.${s.id}.2026-06-15`, naturalDate: '2026-06-15' },
                    { scenarioId: two, scenarioName: 'Freq two', itemKey: `sched.${s.id}.2026-05-15`, naturalDate: '2026-05-15' },
                ],
            },
        });
        expect(await overrideDates(s.id)).toEqual(['2026-02-15', '2026-04-15', '2026-05-15']);   // the refusals rolled back

        const res = (await split(s.id, { ...body, dropOverrides: true, dropAdjustments: true }).expect(201)).body;
        expect(res.deletedOverrides).toEqual(['2026-04-15', '2026-05-15']);
        expect(res.rekeyedAdjustments).toEqual([]);
        expect(res.droppedAdjustments).toEqual([
            { scenarioId: one, itemKey: `sched.${s.id}.2026-04-15` },
            { scenarioId: one, itemKey: `sched.${s.id}.2026-06-15` },
            { scenarioId: two, itemKey: `sched.${s.id}.2026-05-15` },
        ]);
        expect(res.successor).toMatchObject({ frequency: 'quarterly', startDate: k, activeFrom: null, occurrenceCount: null, endDate: null });

        // Nothing is left for the old schedule from k; what came before k stays.
        expect(await overrideDates(s.id)).toEqual(['2026-02-15']);
        expect(await adjustmentsFrom(s.id, k)).toEqual([]);
        expect(await adjustmentRow(early)).toMatchObject({ item_key: `sched.${s.id}.2026-03-15`, row_version: 0 });
        expect((await h.audit('schedule_override', kept)).map((r) => r.action)).toEqual(['create']);
        for (const [id, date] of [[o1, '2026-04-15'], [o2, '2026-05-15']]) {
            const [audit] = await h.audit('schedule_override', id);
            expect(audit).toMatchObject({ action: 'delete', after: null, before: { id, scheduleId: s.id, naturalDate: date } });
        }
        for (const id of [a1, a2, a3]) {
            const [audit] = await h.audit('scenario_adjustment', id);
            expect(audit).toMatchObject({ action: 'delete', after: null, before: { id } });
        }
        expect(await naturalDates(res.successor.id, '2026-01-01', '2026-12-31')).toEqual(['2026-04-15', '2026-07-15', '2026-10-15']);
        expect(await naturalDates(s.id, '2026-01-01', '2026-12-31')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    });

    test('SCHEDULE_HAS_PAYMENTS on split and end, whatever the drops; payments before k do not block', async () => {
        const s = await makeSchedule({ name: 'Paid ahead', startDate: '2026-01-25' });
        await pay(s.id, '2026-02-25', { paidOn: '2026-02-26' }).expect(200);                        // before k
        await pay(s.id, '2026-05-25', { paidOn: TODAY, paidAmount: '100.00' }).expect(200);          // paid in advance, from k
        const body = { fromNaturalDate: '2026-04-25', changes: { amount: '1100.00' } };
        for (const extra of [{}, { dropOverrides: true, dropAdjustments: true }]) {
            const res = await split(s.id, { ...body, ...extra }).expect(409);
            expect(res.body).toMatchObject({ code: 'SCHEDULE_HAS_PAYMENTS', details: { naturalDates: ['2026-05-25'] } });
        }
        const ended = await end(s.id, { lastNaturalDate: '2026-03-25', dropOverrides: true, dropAdjustments: true }).expect(409);
        expect(ended.body).toMatchObject({ code: 'SCHEDULE_HAS_PAYMENTS', details: { naturalDates: ['2026-05-25'] } });
        expect(await readSchedule(s.id)).toMatchObject({ rowVersion: 0, status: 'active' });

        // Unpaid, the override row stays (all columns null): now it is an unpaid override.
        await unpay(s.id, '2026-05-25').expect(200);
        const res = await split(s.id, body).expect(409);
        expect(res.body).toMatchObject({ code: 'SCHEDULE_HAS_OVERRIDES', details: { naturalDates: ['2026-05-25'] } });
        const done = (await split(s.id, { ...body, dropOverrides: true }).expect(201)).body;
        expect(done.deletedOverrides).toEqual(['2026-05-25']);
        expect(await overrideDates(s.id)).toEqual(['2026-02-25']);    // the paid instance before k is untouched
    });

    test('a non-draft scenario\'s adjustments are left alone (applied, archived, deleted draft)', async () => {
        const s = await makeSchedule({ name: 'History', startDate: '2026-01-08' });
        const applied = await adjust(await scenario('Applied', { status: 'applied' }), s.id, '2026-05-08');
        const archived = await adjust(await scenario('Archived', { status: 'archived' }), s.id, '2026-06-08');
        const deleted = await adjust(await scenario('Deleted draft', { deleted: true }), s.id, '2026-05-08');
        const draft = await scenario('Live draft');
        const live = await adjust(draft, s.id, '2026-07-08');

        // Amount-only: only the live draft's adjustment is re-keyed.
        const res = (await split(s.id, { fromNaturalDate: '2026-04-08', changes: { amount: '1100.00' } }).expect(201)).body;
        expect(res.rekeyedAdjustments).toEqual([{ scenarioId: draft, from: `sched.${s.id}.2026-07-08`, to: `sched.${res.successor.id}.2026-07-08` }]);
        expect(await adjustmentRow(live)).toMatchObject({ target_id: String(res.successor.id), row_version: 1 });
        for (const [id, date] of [[applied, '2026-05-08'], [archived, '2026-06-08'], [deleted, '2026-05-08']]) {
            expect(await adjustmentRow(id)).toMatchObject({ item_key: `sched.${s.id}.${date}`, target_id: String(s.id), row_version: 0 });
            expect(await h.audit('scenario_adjustment', id)).toEqual([]);
        }

        // A frequency split would refuse a draft's adjustment; history does not block it.
        const t = await makeSchedule({ name: 'History 2', startDate: '2026-01-08' });
        const kept = await adjust(await scenario('Applied 2', { status: 'applied' }), t.id, '2026-05-08');
        const res2 = (await split(t.id, { fromNaturalDate: '2026-04-08', changes: { frequency: 'weekly' } }).expect(201)).body;
        expect(res2.droppedAdjustments).toEqual([]);
        expect(await adjustmentRow(kept)).toMatchObject({ item_key: `sched.${t.id}.2026-05-08`, row_version: 0 });
    });

    test('end early mirrors the guard: overrides, adjustments (never re-keyed), no-op when nothing follows', async () => {
        const s = await makeSchedule({ name: 'Ending', startDate: '2026-01-18' });
        const o = (await tune(s.id, '2026-05-18', { note: 'after' }).expect(200)).body.override.id;
        const draft = await scenario('End');
        const atLast = await adjust(draft, s.id, '2026-04-18');           // not after lastNaturalDate: stays
        const after = await adjust(draft, s.id, '2026-06-18');

        for (const [body, msg] of [
            [{}, /lastNaturalDate/], [{ lastNaturalDate: 'x' }, /lastNaturalDate/],
            [{ lastNaturalDate: '2026-04-18', dropOverrides: 'y' }, /dropOverrides/],
            [{ lastNaturalDate: '2026-04-19' }, /not an instance/],
        ]) {
            expect((await end(s.id, body).expect(400)).body.error).toMatch(msg);
        }
        await end(999999, { lastNaturalDate: '2026-04-18' }).expect(404);
        const stale = await end(s.id, { lastNaturalDate: '2026-04-18', baseVersion: 9 }).expect(409);
        expect(stale.body.code).toBe('STALE_WRITE');

        const overrides = await end(s.id, { lastNaturalDate: '2026-04-18' }).expect(409);
        expect(overrides.body).toMatchObject({ code: 'SCHEDULE_HAS_OVERRIDES', details: { naturalDates: ['2026-05-18'] } });
        const adjustments = await end(s.id, { lastNaturalDate: '2026-04-18', dropOverrides: true }).expect(409);
        expect(adjustments.body).toMatchObject({
            code: 'SCHEDULE_HAS_ADJUSTMENTS',
            details: { adjustments: [{ scenarioId: draft, scenarioName: 'End', itemKey: `sched.${s.id}.2026-06-18`, naturalDate: '2026-06-18' }] },
        });

        const res = (await end(s.id, { lastNaturalDate: '2026-04-18', dropOverrides: true, dropAdjustments: true }).expect(200)).body;
        expect(Object.keys(res).sort()).toEqual(['deletedOverrides', 'droppedAdjustments', 'ended']);
        expect(res.ended).toMatchObject({ id: s.id, endDate: '2026-05-17', occurrenceCount: null, status: 'ended', successorId: null, rowVersion: 1 });
        expect(res.deletedOverrides).toEqual(['2026-05-18']);
        expect(res.droppedAdjustments).toEqual([{ scenarioId: draft, itemKey: `sched.${s.id}.2026-06-18` }]);
        expect(await naturalDates(s.id, '2026-01-01', '2026-12-31')).toEqual(['2026-01-18', '2026-02-18', '2026-03-18', '2026-04-18']);
        expect(await adjustmentRow(after)).toBeUndefined();
        expect(await adjustmentRow(atLast)).toMatchObject({ row_version: 0 });
        expect((await h.audit('schedule', s.id))[0]).toMatchObject({
            action: 'end', before: { endDate: null, status: 'active' }, after: { endDate: '2026-05-17', status: 'ended' },
        });
        expect((await h.audit('schedule_override', o))[0]).toMatchObject({ action: 'delete', before: { naturalDate: '2026-05-18' } });
        expect((await h.audit('scenario_adjustment', after))[0]).toMatchObject({ action: 'delete' });

        // Nothing follows the last instance: 200, the row unchanged, nothing written.
        const noop = (await end(s.id, { lastNaturalDate: '2026-04-18' }).expect(200)).body;
        expect(noop).toEqual({ ended: res.ended, deletedOverrides: [], droppedAdjustments: [] });
        expect((await h.audit('schedule', s.id)).length).toBe(2);

        // An occurrence_count end becomes an end_date (D22).
        const counted = await makeSchedule({ name: 'Counted', startDate: '2026-01-18', occurrenceCount: 6 });
        expect((await end(counted.id, { lastNaturalDate: '2026-03-18' }).expect(200)).body.ended)
            .toMatchObject({ endDate: '2026-04-17', occurrenceCount: null, status: 'ended' });
    });

    test('a split can move the series to another account; the successor keeps the category and the text', async () => {
        const s = await makeSchedule({ name: 'Moving', startDate: '2026-01-12', counterparty: 'ACME', notes: 'n' });
        const res = (await split(s.id, { fromNaturalDate: '2026-04-12', changes: { accountId: other.id, settleMode: 'manual' } }).expect(201)).body;
        expect(res.successor).toMatchObject({
            accountId: other.id, settleMode: 'manual', categoryId: out.id, direction: 'out', name: 'Moving',
            counterparty: 'ACME', notes: 'n', startDate: '2026-01-12', activeFrom: '2026-04-12',
        });
        // The successor is born structure-locked: an in-place structural edit points at split.
        const locked = await put(`/schedules/${res.successor.id}`, { amount: '5.00' }).expect(409);
        expect(locked.body.code).toBe('SCHEDULE_STRUCTURE_LOCKED');
    });

    describe('two connections', () => {
        test('a pay issued during a split waits on the schedule lock, then is refused from k or lands before k — never lost', async () => {
            const s = await makeSchedule({ name: 'Race', startDate: '2026-01-22' });
            const conn = await db.getPool().getConnection();
            let late;
            let early;
            try {
                await conn.beginTransaction();
                const held = await splitOrEnd(conn, {
                    action: 'split', scheduleId: s.id, date: '2026-04-22', changes: { amount: '1100.00' },
                    today: TODAY, userEmail: 'local@dev',
                });
                expect(held.successor).toMatchObject({ amount: '1100.00', activeFrom: '2026-04-22' });
                // The split's transaction is open and holds the schedule row.
                late = track(pay(s.id, '2026-05-22', { paidOn: TODAY, paidAmount: '100.00' }));
                early = track(pay(s.id, '2026-03-22', { paidOn: TODAY }));
                await sleep(1500);
                expect([late.done, early.done]).toEqual([false, false]);
                await conn.commit();
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
            const [lateRes, earlyRes] = await Promise.all([late.promise, early.promise]);
            // From k the date is no longer an instance of the ended schedule: refused, so the caller knows.
            expect(lateRes.status).toBe(404);
            // Before k it is still the old schedule's: the pay lands there.
            expect(earlyRes.status).toBe(200);
            expect(earlyRes.body).toMatchObject({ scheduleId: s.id, naturalDate: '2026-03-22', status: 'paid' });

            const successor = (await readSchedule(s.id)).successorId;
            expect(await overrideDates(s.id)).toEqual(['2026-03-22']);
            expect(await overrideDates(successor)).toEqual([]);
            const payments = await h.sql(
                'SELECT o.schedule_id, o.natural_date, p.amount FROM payments p JOIN schedule_overrides o ON o.id = p.override_id WHERE o.schedule_id IN (?, ?)',
                [s.id, successor]
            );
            expect(payments).toEqual([{ schedule_id: s.id, natural_date: '2026-03-22', amount: '1000.00' }]);
            // The refused pay can be re-issued on the successor's instance.
            expect((await pay(successor, '2026-05-22', { paidOn: TODAY, paidAmount: '100.00' }).expect(200)).body)
                .toMatchObject({ scheduleId: successor, status: 'part_paid', remainingAmount: '1000.00' });
        });

        test('when the split rolls back instead, the waiting pay lands on the unchanged schedule and the split then refuses', async () => {
            const s = await makeSchedule({ name: 'Race back', startDate: '2026-01-22' });
            const conn = await db.getPool().getConnection();
            let late;
            try {
                await conn.beginTransaction();
                await splitOrEnd(conn, {
                    action: 'split', scheduleId: s.id, date: '2026-04-22', changes: { amount: '1100.00' },
                    today: TODAY, userEmail: 'local@dev',
                });
                late = track(pay(s.id, '2026-05-22', { paidOn: TODAY, paidAmount: '100.00' }));
                await sleep(1500);
                expect(late.done).toBe(false);
            } finally {
                await conn.rollback();
                conn.release();
            }
            const res = await late.promise;
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ scheduleId: s.id, status: 'part_paid' });
            expect(await readSchedule(s.id)).toMatchObject({ status: 'active', endDate: null, successorId: null });
            const refused = await split(s.id, { fromNaturalDate: '2026-04-22', changes: { amount: '1100.00' } }).expect(409);
            expect(refused.body).toMatchObject({ code: 'SCHEDULE_HAS_PAYMENTS', details: { naturalDates: ['2026-05-22'] } });
        });

        test('the split takes its draft-scenario locks before the schedule lock', async () => {
            const s = await makeSchedule({ name: 'Order', startDate: '2026-01-26' });
            const holder = await scenario('Holder');
            await adjust(holder, s.id, '2026-05-26');
            const conn = await db.getPool().getConnection();
            let splitting;
            let paid;
            try {
                await conn.beginTransaction();
                await conn.query('SELECT id FROM scenarios WHERE id = ? FOR UPDATE', [holder]);
                splitting = track(split(s.id, { fromNaturalDate: '2026-04-26', changes: { amount: '1100.00' } }));
                await sleep(1000);
                expect(splitting.done).toBe(false);      // waiting on the scenario row
                // It holds no schedule lock yet, so a pay on the schedule goes straight through
                // (were it waiting behind the split, this would time out instead).
                let timer;
                paid = await Promise.race([
                    pay(s.id, '2026-05-26', { paidOn: TODAY, paidAmount: '50.00' }).then((r) => r),
                    new Promise((resolve) => { timer = setTimeout(() => resolve('timed out'), 15000); }),
                ]);
                clearTimeout(timer);
                expect(paid).not.toBe('timed out');
                expect(paid.status).toBe(200);
                expect(splitting.done).toBe(false);
                await conn.commit();
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
            // Then it proceeds under both locks, and its payment guard sees the pay.
            const res = await splitting.promise;
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'SCHEDULE_HAS_PAYMENTS', details: { naturalDates: ['2026-05-26'] } });
        });

        test('an adjustment written while the split waits for the schedule is still re-keyed (the split restarts, never locks out of order)', async () => {
            const s = await makeSchedule({ name: 'Late adjustment', startDate: '2026-01-28' });
            const conn = await db.getPool().getConnection();
            let splitting;
            let lateScenario;
            let lateAdjustment;
            try {
                await conn.beginTransaction();
                // An adjustment writer holds the schedule (§10.7 step 3) while the split has
                // already made its step-1 read and waits for the same row.
                await conn.query('SELECT id FROM schedules WHERE id = ? FOR UPDATE', [s.id]);
                splitting = track(split(s.id, { fromNaturalDate: '2026-04-28', changes: { amount: '1100.00' } }));
                await sleep(1000);
                expect(splitting.done).toBe(false);
                const [sc] = await conn.query("INSERT INTO scenarios (name, status, created_by) VALUES ('Late', 'draft', 'e2e')");
                lateScenario = sc.insertId;
                const [adj] = await conn.query(
                    `INSERT INTO scenario_adjustments
                        (scenario_id, item_key, target_kind, target_id, target_date, kind, new_amount, base_date, base_amount, created_by)
                     VALUES (?, ?, 'sched', ?, '2026-05-28', 'adjust', '1200.00', '2026-05-28', '1000.00', 'e2e')`,
                    [lateScenario, `sched.${s.id}.2026-05-28`, String(s.id)]
                );
                lateAdjustment = adj.insertId;
                await conn.commit();
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
            const res = await splitting.promise;
            expect(res.status).toBe(201);
            const successor = res.body.successor.id;
            expect(res.body.rekeyedAdjustments).toEqual([
                { scenarioId: lateScenario, from: `sched.${s.id}.2026-05-28`, to: `sched.${successor}.2026-05-28` },
            ]);
            expect(await adjustmentRow(lateAdjustment)).toMatchObject({ item_key: `sched.${successor}.2026-05-28`, target_id: String(successor) });
            expect(await adjustmentsFrom(s.id, '2026-04-28')).toEqual([]);
        });
    });
});
