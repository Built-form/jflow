'use strict';

// Schedules and their instances (CONTRACT §6.8, §6.9, §10.4, §10.6; D12, D17, D19, D22,
// D23, D35, D37), end to end against a per-run jflow_test_<runid> schema, with `today`
// pinned through ?today= (local/test only, D24) and an anchor on the main account:
//   - create / update validation, direction = the category's (D14), soft delete, list;
//   - structure edits in place only while start_date > today and no override exists,
//     else SCHEDULE_STRUCTURE_LOCKED; descriptive fields always;
//   - GET …/instances: predicted vs tuned, derivedStatus, payments[], orphans[], D35;
//   - tune / revert (OVERRIDE_HAS_PAYMENT) / pay / unpay with payments as rows (D23),
//     including two part payments straddling the anchor, and the remainder date landing
//     in override.due_date;
//   - "Didn't happen" on an assumed-settled instance → overdue;
//   - the D17 deactivation guard's schedule and instance parts;
//   - loadTarget's `sched.` branch (services/forecastLoad.js).
// Split and end live in split.test.js.

const { startHarness } = require('./harness');
const { classify } = require('../../src/lib/classify');
const { instanceLine } = require('../../src/lib/lines');
const { parseKey } = require('../../src/lib/keys');

jest.setTimeout(240000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';       // a Tuesday
const A = '2026-03-01';           // the main account's anchor

const withToday = (req, today) => req.query(today ? { today } : {});
const post = (path, body, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const del = (path, body = {}, today = TODAY) => withToday(api().delete(`/api/v1${path}`), today).send(body);
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });

const inst = (id, date) => `/schedules/${id}/instances/${date}`;
const tune = (id, date, body, today) => put(inst(id, date), body, today);
const pay = (id, date, body, today) => post(`${inst(id, date)}/pay`, body, today);
const unpay = (id, date, body = {}, today) => post(`${inst(id, date)}/unpay`, body, today);
const instances = async (id, query = {}) => (await get(`/schedules/${id}/instances`, query).expect(200)).body;
const instanceAt = async (id, date) => (await instances(id, { from: date, to: date })).data[0];

const ROW_KEYS = [
    'accountId', 'activeFrom', 'amount', 'categoryId', 'companyId', 'counterparty', 'createdAt', 'createdBy',
    'currency', 'deletedAt', 'direction', 'endDate', 'frequency', 'id', 'intervalCount', 'name', 'notes',
    'occurrenceCount', 'predecessorId', 'rowVersion', 'settleMode', 'startDate', 'status', 'structureLocked',
    'successorId', 'updatedAt', 'weekendRule',
];
const INSTANCE_KEYS = [
    'amount', 'currency', 'derivedStatus', 'direction', 'dueDate', 'key', 'naturalDate', 'override', 'payments',
    'predictedDueDate', 'remainingAmount', 'scheduleId', 'settleMode', 'status', 'tuned',
];
const OVERRIDE_KEYS = [
    'amount', 'createdAt', 'createdBy', 'dueDate', 'id', 'note', 'paidAmount', 'paidOn', 'rowVersion',
    'settleMode', 'sourceScenarioId', 'status', 'updatedAt',
];

describe('schedules', () => {
    let jfa;
    let hw;
    let main;      // JFA, GBP, anchor at A
    let bare;      // JFA, GBP, no balance (D12)
    let eur;       // JFA, EUR
    let dormant;   // JFA, inactive
    let out;       // category, direction out
    let sales;     // category, direction in

    const makeSchedule = async (body = {}) => (await post('/schedules', {
        accountId: main.id, categoryId: out.id, name: 'Rent', amount: '1000.00', frequency: 'monthly',
        startDate: '2026-01-05', ...body,
    }).expect(201)).body;

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        jfa = companies.find((c) => c.code === 'JFA');
        hw = companies.find((c) => c.code === 'HW');
        const account = async (body) => (await api().post('/api/v1/accounts').send(body).expect(201)).body;
        main = await account({ companyId: jfa.id, name: 'Main', currency: 'GBP' });
        bare = await account({ companyId: jfa.id, name: 'Bare', currency: 'GBP' });
        eur = await account({ companyId: jfa.id, name: 'Euro', currency: 'EUR' });
        dormant = await account({ companyId: jfa.id, name: 'Dormant', currency: 'GBP', isActive: false });
        out = (await api().post('/api/v1/categories').send({ name: 'Suppliers', direction: 'out' }).expect(201)).body;
        sales = (await api().post('/api/v1/categories').send({ name: 'Sales', direction: 'in' }).expect(201)).body;
        await put(`/accounts/${main.id}/balances/${A}`, { balance: '1000.00' }).expect(200);
    });

    describe('CRUD', () => {
        test('create validates the body (400)', async () => {
            const good = {
                accountId: main.id, categoryId: out.id, name: 'Rent', amount: '100.00', frequency: 'monthly',
                startDate: '2026-01-05',
            };
            const bad = [
                [{ ...good, accountId: undefined }, /accountId/],
                [{ ...good, accountId: 'x' }, /accountId/],
                [{ ...good, categoryId: undefined }, /categoryId/],
                [{ ...good, name: '  ' }, /name/],
                [{ ...good, amount: undefined }, /amount/],
                [{ ...good, amount: 100 }, /amount/],
                [{ ...good, amount: '0' }, /amount/],
                [{ ...good, amount: '1.234' }, /amount/],
                [{ ...good, frequency: undefined }, /frequency/],
                [{ ...good, frequency: 'daily' }, /frequency/],
                [{ ...good, startDate: undefined }, /startDate/],
                [{ ...good, startDate: '2026-02-30' }, /startDate/],
                [{ ...good, intervalCount: 0 }, /intervalCount/],
                [{ ...good, intervalCount: 1.5 }, /intervalCount/],
                [{ ...good, intervalCount: 'two' }, /intervalCount/],
                [{ ...good, occurrenceCount: 0 }, /occurrenceCount/],
                [{ ...good, endDate: '2026-13-01' }, /endDate/],
                [{ ...good, occurrenceCount: 3, endDate: '2026-12-31' }, /occurrenceCount or endDate/],
                [{ ...good, endDate: '2026-01-04' }, /endDate/],
                [{ ...good, weekendRule: 'sometimes' }, /weekendRule/],
                [{ ...good, settleMode: 'x' }, /settleMode/],
                [{ ...good, direction: 'sideways' }, /direction/],
                [{ ...good, currency: 'gbp' }, /currency/],
                [{ ...good, counterparty: 5 }, /counterparty/],
                [{ ...good, notes: 'x'.repeat(16001) }, /notes/],
                [{ ...good, accountId: 999999 }, /not a live account/],
                [{ ...good, accountId: dormant.id }, /inactive/],
                [{ ...good, categoryId: 999999 }, /not a live category/],
                [{ ...good, direction: 'in' }, /direction must be the category's/],
            ];
            for (const [body, msg] of bad) {
                const res = await post('/schedules', body).expect(400);
                expect(res.body.error).toMatch(msg);
            }
            expect((await get('/schedules').expect(200)).body.total).toBe(0);
        });

        test('create: defaults, the row shape, the audit row; read by id; structureLocked (D37)', async () => {
            const created = (await post('/schedules', {
                accountId: eur.id, categoryId: out.id, name: ' Rent ', amount: '1000', frequency: 'monthly',
                startDate: '2026-01-05', counterparty: ' Landlord ', notes: 'n', intervalCount: '1',
            }).expect(201)).body;
            expect(Object.keys(created).sort()).toEqual(ROW_KEYS);
            expect(created).toMatchObject({
                accountId: eur.id, companyId: jfa.id, categoryId: out.id, direction: 'out', name: 'Rent',
                counterparty: 'Landlord', amount: '1000.00', currency: 'EUR', frequency: 'monthly', intervalCount: 1,
                startDate: '2026-01-05', activeFrom: null, occurrenceCount: null, endDate: null, weekendRule: 'none',
                settleMode: 'auto', predecessorId: null, successorId: null, status: 'active', notes: 'n',
                structureLocked: true, rowVersion: 0, createdBy: 'local@dev', deletedAt: null,
            });
            const [audit] = await h.audit('schedule', created.id);
            expect(audit).toMatchObject({ action: 'create', before: null });
            expect(audit.after).toMatchObject({ id: created.id, amount: '1000.00', startDate: '2026-01-05' });
            expect(audit.after).not.toHaveProperty('structureLocked');
            expect(audit.after).not.toHaveProperty('successorId');

            const future = await makeSchedule({
                startDate: '2026-04-01', frequency: 'weekly', intervalCount: 2, occurrenceCount: 6,
                weekendRule: 'previous', settleMode: 'manual', categoryId: sales.id, currency: 'USD',
            });
            expect(future).toMatchObject({
                structureLocked: false, direction: 'in', intervalCount: 2, occurrenceCount: 6,
                weekendRule: 'previous', settleMode: 'manual', currency: 'USD',
            });

            const read = (await get(`/schedules/${created.id}`).expect(200)).body;
            expect(read).toEqual({ ...created, createdAt: read.createdAt, updatedAt: read.updatedAt });
            await get('/schedules/abc').expect(404);
            await get('/schedules/999999').expect(404);
        });

        test('PUT: descriptive fields always edit in place; the category carries the direction (D14)', async () => {
            const s = await makeSchedule({ name: 'Descriptive' });
            const res = (await put(`/schedules/${s.id}`, {
                name: 'Renamed', counterparty: 'ACME', notes: 'note', categoryId: sales.id,
            }).expect(200)).body;
            expect(res).toMatchObject({
                name: 'Renamed', counterparty: 'ACME', notes: 'note', categoryId: sales.id, direction: 'in',
                rowVersion: 1, structureLocked: true,
            });
            const [audit] = await h.audit('schedule', s.id);
            expect(audit).toMatchObject({
                action: 'update', before: { name: 'Descriptive', direction: 'out' }, after: { name: 'Renamed', direction: 'in' },
            });

            // A no-op PUT writes nothing; clearing text is a change.
            expect((await put(`/schedules/${s.id}`, { name: 'Renamed', amount: '1000' }).expect(200)).body.rowVersion).toBe(1);
            expect((await h.audit('schedule', s.id)).length).toBe(2);
            expect((await put(`/schedules/${s.id}`, { counterparty: null }).expect(200)).body.counterparty).toBeNull();

            await put(`/schedules/${s.id}`, {}).expect(400);
            await put(`/schedules/${s.id}`, { direction: 'out' }).expect(400);
            await put(`/schedules/${s.id}`, { name: ' ' }).expect(400);
            await put(`/schedules/${s.id}`, { categoryId: 999999 }).expect(400);
        });

        test('PUT: structure is locked once started or tuned (SCHEDULE_STRUCTURE_LOCKED, JSON field names)', async () => {
            const started = await makeSchedule({ name: 'Started' });
            const one = await put(`/schedules/${started.id}`, { amount: '1050.00' }).expect(409);
            expect(one.body).toEqual({
                error: expect.any(String), code: 'SCHEDULE_STRUCTURE_LOCKED',
                details: { fields: ['amount'], reason: 'started', split: `/schedules/${started.id}/split` },
            });
            const many = await put(`/schedules/${started.id}`, {
                startDate: '2026-01-06', frequency: 'weekly', amount: '1.00', name: 'ignored',
            }).expect(409);
            expect(many.body.details.fields).toEqual(['amount', 'frequency', 'startDate']);
            expect((await get(`/schedules/${started.id}`).expect(200)).body).toMatchObject({ name: 'Started', rowVersion: 0 });
            // Unchanged structural values are not a change.
            await put(`/schedules/${started.id}`, {
                amount: '1000', frequency: 'monthly', startDate: '2026-01-05', currency: 'GBP', accountId: main.id,
                intervalCount: 1, occurrenceCount: null, endDate: null, weekendRule: 'none', settleMode: 'auto',
                notes: 'still editable',
            }).expect(200);

            // Not started, no override: every structural field edits in place.
            const future = await makeSchedule({ name: 'Future', startDate: '2026-04-01' });
            const edited = (await put(`/schedules/${future.id}`, {
                amount: '1100.00', frequency: 'weekly', intervalCount: 2, startDate: '2026-04-06', weekendRule: 'next',
                settleMode: 'manual', accountId: bare.id, currency: 'USD', occurrenceCount: 4,
            }).expect(200)).body;
            expect(edited).toMatchObject({
                amount: '1100.00', frequency: 'weekly', intervalCount: 2, startDate: '2026-04-06', weekendRule: 'next',
                settleMode: 'manual', accountId: bare.id, currency: 'USD', occurrenceCount: 4, structureLocked: false,
            });
            // D22 and the start/end order, on the merged row.
            const both = await put(`/schedules/${future.id}`, { endDate: '2026-12-31' }).expect(400);
            expect(both.body.error).toMatch(/occurrenceCount or endDate/);
            await put(`/schedules/${future.id}`, { occurrenceCount: null, endDate: '2026-04-05' }).expect(400);
            expect((await put(`/schedules/${future.id}`, { occurrenceCount: null, endDate: '2026-12-31' }).expect(200)).body)
                .toMatchObject({ occurrenceCount: null, endDate: '2026-12-31' });
            await put(`/schedules/${future.id}`, { accountId: dormant.id }).expect(400);
            await put(`/schedules/${future.id}`, { intervalCount: 0 }).expect(400);

            // A tune locks it too, whatever the start date.
            await tune(future.id, '2026-04-20', { note: 'tuned' }).expect(200);
            const tuned = await put(`/schedules/${future.id}`, { amount: '1.00' }).expect(409);
            expect(tuned.body.details).toEqual({ fields: ['amount'], reason: 'has_overrides', split: `/schedules/${future.id}/split` });
            expect((await get(`/schedules/${future.id}`).expect(200)).body.structureLocked).toBe(true);
        });

        test('STALE_WRITE on update and delete; soft delete, 404 afterwards, includeDeleted, audit', async () => {
            const s = await makeSchedule({ name: 'Doomed' });
            const stale = await put(`/schedules/${s.id}`, { name: 'x', baseVersion: 3 }).expect(409);
            expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });
            await put(`/schedules/${s.id}`, { name: 'Doomed 2', baseVersion: 0 }).expect(200);
            await del(`/schedules/${s.id}`, { baseVersion: 0 }).expect(409);
            await del(`/schedules/${s.id}`, { baseVersion: 'x' }).expect(400);
            await del(`/schedules/${s.id}`, { baseVersion: 1 }).expect(204);

            await get(`/schedules/${s.id}`).expect(404);
            const gone = (await get(`/schedules/${s.id}`, { includeDeleted: '1' }).expect(200)).body;
            expect(gone.deletedAt).not.toBeNull();
            expect((await h.audit('schedule', s.id))[0]).toMatchObject({ action: 'delete', before: { deletedAt: null } });
            await del(`/schedules/${s.id}`).expect(404);
            await put(`/schedules/${s.id}`, { name: 'x' }).expect(404);
            await get(`/schedules/${s.id}/instances`).expect(404);
            await tune(s.id, '2026-02-05', { note: 'x' }).expect(404);
            await pay(s.id, '2026-02-05', { paidOn: TODAY }).expect(404);
            await unpay(s.id, '2026-02-05').expect(404);
            await del(inst(s.id, '2026-02-05')).expect(404);
        });

        describe('list', () => {
            let acct;
            const ids = {};

            beforeAll(async () => {
                acct = (await api().post('/api/v1/accounts').send({ companyId: hw.id, name: 'HW list', currency: 'GBP' }).expect(201)).body;
                const mk = async (key, body = {}) => { ids[key] = (await makeSchedule({ accountId: acct.id, name: key, ...body })).id; };
                await mk('Alpha', { counterparty: 'Zed Ltd' });
                await mk('Beta', { settleMode: 'manual' });
                await mk('Gamma', { categoryId: sales.id });
                await mk('Delta');
                await mk('Epsilon');
                await h.sql("UPDATE schedules SET status = 'ended', end_date = '2026-02-28' WHERE id = ?", [ids.Delta]);
                await del(`/schedules/${ids.Epsilon}`).expect(204);
            });

            const list = async (query) => (await get('/schedules', { accountId: acct.id, ...query }).expect(200)).body;
            const names = (body) => body.data.map((s) => s.name);

            test('sorted created_at DESC, id DESC; filters; paging; includeDeleted; bad queries', async () => {
                const all = await list();
                expect(all.total).toBe(4);
                expect(names(all)).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha']);
                all.data.forEach((s) => expect(Object.keys(s).sort()).toEqual(ROW_KEYS));
                expect(names((await get('/schedules', { companyId: hw.id }).expect(200)).body)).toEqual(names(all));
                expect(names(await list({ categoryId: sales.id }))).toEqual(['Gamma']);
                expect(names(await list({ status: 'ended' }))).toEqual(['Delta']);
                expect(names(await list({ status: 'active,ended' }))).toHaveLength(4);
                expect(names(await list({ settleMode: 'manual' }))).toEqual(['Beta']);
                expect(names(await list({ q: 'zed' }))).toEqual(['Alpha']);
                expect(names(await list({ q: 'amm' }))).toEqual(['Gamma']);
                const paged = await list({ limit: 2, page: 2 });
                expect(paged).toMatchObject({ page: 2, limit: 2, total: 4 });
                expect(names(paged)).toEqual(['Beta', 'Alpha']);
                expect(names(await list({ includeDeleted: '1' }))).toEqual(['Epsilon', 'Delta', 'Gamma', 'Beta', 'Alpha']);
                for (const query of [{ accountId: 'x' }, { companyId: 0 }, { categoryId: 'a' }, { status: 'paused' }, { settleMode: 'x' }]) {
                    await get('/schedules', query).expect(400);
                }
            });
        });
    });

    describe('instances', () => {
        test('predicted vs tuned, derivedStatus against the anchor, window defaults and limits (D35)', async () => {
            // Monthly on the 5th; 5 Apr 2026 is a Sunday, moved to Monday by the weekend rule.
            const s = await makeSchedule({ name: 'Instances', weekendRule: 'next' });
            const body = await instances(s.id, { from: '2026-01-01', to: '2026-04-30' });
            expect(body.orphans).toEqual([]);
            expect(body.data.map((i) => [i.naturalDate, i.dueDate, i.derivedStatus])).toEqual([
                ['2026-01-05', '2026-01-05', 'assumedSettled'],
                ['2026-02-05', '2026-02-05', 'assumedSettled'],
                ['2026-03-05', '2026-03-05', 'assumed'],
                ['2026-04-05', '2026-04-06', 'expected'],
            ]);
            const april = body.data[3];
            expect(Object.keys(april).sort()).toEqual(INSTANCE_KEYS);
            expect(april).toEqual({
                key: `sched.${s.id}.2026-04-05`, scheduleId: s.id, naturalDate: '2026-04-05',
                predictedDueDate: '2026-04-06', dueDate: '2026-04-06', amount: '1000.00', remainingAmount: '1000.00',
                currency: 'GBP', direction: 'out', status: 'expected', settleMode: 'auto', tuned: false, override: null,
                payments: [], derivedStatus: 'expected',
            });

            // D35 defaults: today − 90 … today + 365.
            const window = await instances(s.id);
            expect(window.data[0].naturalDate).toBe('2026-01-05');
            expect(window.data[window.data.length - 1].naturalDate).toBe('2027-03-05');
            expect(window.data).toHaveLength(15);

            await get(`/schedules/${s.id}/instances`, { from: '2026-05-01', to: '2026-04-01' }).expect(400);
            await get(`/schedules/${s.id}/instances`, { from: '2026-01-01', to: '2028-01-02' }).expect(400);   // 731 days
            await get(`/schedules/${s.id}/instances`, { from: '2026-01-01', to: '2028-01-01' }).expect(200);   // 730 days
            await get(`/schedules/${s.id}/instances`, { from: 'soon' }).expect(400);
            await get('/schedules/999999/instances').expect(404);

            // D12: no anchor → nothing is assumedSettled.
            const onBare = await makeSchedule({ accountId: bare.id, name: 'No anchor' });
            expect((await instanceAt(onBare.id, '2026-02-05')).derivedStatus).toBe('assumed');
        });

        test('orphans: an override that is not an occurrence is never an instance (§5.5)', async () => {
            const s = await makeSchedule({ name: 'Orphans', endDate: '2026-04-30' });
            const off = await h.sql('INSERT INTO schedule_overrides (schedule_id, natural_date, note) VALUES (?, ?, ?)', [s.id, '2026-02-06', 'off grid']);
            const past = await h.sql('INSERT INTO schedule_overrides (schedule_id, natural_date, note) VALUES (?, ?, ?)', [s.id, '2026-05-05', 'past end']);
            const body = await instances(s.id, { from: '2026-04-01', to: '2026-04-30' });
            expect(body.data.map((i) => i.naturalDate)).toEqual(['2026-04-05']);
            expect(body.orphans).toEqual([
                { code: 'ORPHAN_OVERRIDE', scheduleId: s.id, naturalDate: '2026-02-06', overrideId: off.insertId },
                { code: 'ORPHAN_OVERRIDE', scheduleId: s.id, naturalDate: '2026-05-05', overrideId: past.insertId },
            ]);
            // An orphan is not an instance: none of the instance writers reach it.
            await tune(s.id, '2026-02-06', { note: 'x' }).expect(404);
            await del(inst(s.id, '2026-05-05')).expect(404);
        });

        test('tune: amount / dueDate / note / settleMode / status; null clears; audits; baseVersion on the override', async () => {
            const s = await makeSchedule({ name: 'Tune', startDate: '2026-01-20' });
            const date = '2026-04-20';

            const first = (await tune(s.id, date, { amount: '983', note: 'June 983' }).expect(200)).body;
            expect(Object.keys(first).sort()).toEqual(INSTANCE_KEYS);
            expect(first).toMatchObject({
                amount: '983.00', remainingAmount: '983.00', dueDate: date, tuned: true, derivedStatus: 'expected', payments: [],
            });
            expect(Object.keys(first.override).sort()).toEqual(OVERRIDE_KEYS);
            expect(first.override).toMatchObject({ amount: '983.00', note: 'June 983', dueDate: null, status: null, rowVersion: 0, createdBy: 'local@dev' });
            const overrideId = first.override.id;
            const [created] = await h.audit('schedule_override', overrideId);
            expect(created).toMatchObject({ action: 'create', before: null, after: { scheduleId: s.id, naturalDate: date, amount: '983.00' } });

            // A date is taken verbatim (Saturday 18 Apr, no weekend rule applied).
            const moved = (await tune(s.id, date, { dueDate: '2026-04-18' }).expect(200)).body;
            expect(moved).toMatchObject({ dueDate: '2026-04-18', predictedDueDate: date, amount: '983.00' });
            expect(moved.override.rowVersion).toBe(1);
            const [updated] = await h.audit('schedule_override', overrideId);
            expect(updated).toMatchObject({ action: 'update', before: { dueDate: null }, after: { dueDate: '2026-04-18' } });

            expect((await tune(s.id, date, { status: 'skipped' }).expect(200)).body).toMatchObject({ status: 'skipped', derivedStatus: 'skipped' });
            expect((await tune(s.id, date, { status: 'expected' }).expect(200)).body).toMatchObject({ status: 'expected', derivedStatus: 'expected' });
            expect((await tune(s.id, date, { amount: null }).expect(200)).body).toMatchObject({ amount: '1000.00', override: { amount: null } });

            // A no-op tune writes nothing.
            const before = (await h.audit('schedule_override', overrideId)).length;
            expect((await tune(s.id, date, { note: 'June 983' }).expect(200)).body.override.rowVersion).toBe(4);
            expect((await h.audit('schedule_override', overrideId)).length).toBe(before);

            const stale = await tune(s.id, date, { note: 'x', baseVersion: 1 }).expect(409);
            expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 4 } });

            // Everything back to the schedule's is not a tune: DELETE reverts.
            const nothing = await tune(s.id, date, { dueDate: null, note: null, status: null }).expect(400);
            expect(nothing.body.error).toMatch(/DELETE/);
            await tune(s.id, '2026-05-20', { amount: null }).expect(400);

            for (const body of [
                {}, { amount: 983 }, { amount: '0' }, { dueDate: '2026-02-30' }, { settleMode: 'x' },
                { status: 'paid' }, { status: 'part_paid' }, { note: 'x'.repeat(501) }, { note: 5 },
            ]) {
                await tune(s.id, date, body).expect(400);
            }
            await tune(s.id, '2026-04-21', { note: 'x' }).expect(404);          // not an occurrence
            await tune(s.id, '2026-04-31', { note: 'x' }).expect(400);          // not a date
            await tune(s.id, '2025-12-20', { note: 'x' }).expect(404);          // before the start
        });

        test('revert: 204 and the instance is predicted again; 404 without a tune; OVERRIDE_HAS_PAYMENT', async () => {
            const s = await makeSchedule({ name: 'Revert', startDate: '2026-01-20' });
            const tuned = (await tune(s.id, '2026-04-20', { amount: '1.00' }).expect(200)).body;
            await del(inst(s.id, '2026-04-20')).expect(204);
            expect(await instanceAt(s.id, '2026-04-20')).toMatchObject({ tuned: false, override: null, amount: '1000.00' });
            const [audit] = await h.audit('schedule_override', tuned.override.id);
            expect(audit).toMatchObject({ action: 'delete', after: null, before: { id: tuned.override.id, amount: '1.00', naturalDate: '2026-04-20' } });
            await del(inst(s.id, '2026-04-20')).expect(404);

            // Payment state: revert refused, amount and status refused, the rest editable.
            const paid = (await pay(s.id, '2026-05-20', { paidOn: TODAY, paidAmount: '100.00' }).expect(200)).body;
            const refused = await del(inst(s.id, '2026-05-20')).expect(409);
            expect(refused.body).toMatchObject({
                code: 'OVERRIDE_HAS_PAYMENT',
                details: { naturalDate: '2026-05-20', status: 'part_paid', paidAmount: '100.00', paidOn: TODAY },
            });
            for (const body of [{ amount: '500.00' }, { status: 'skipped' }, { status: null }]) {
                expect((await tune(s.id, '2026-05-20', body).expect(409)).body.code).toBe('OVERRIDE_HAS_PAYMENT');
            }
            const edited = (await tune(s.id, '2026-05-20', { dueDate: '2026-05-22', note: 'late', settleMode: 'manual', amount: null }).expect(200)).body;
            expect(edited).toMatchObject({ dueDate: '2026-05-22', status: 'part_paid', remainingAmount: '900.00', override: { note: 'late' } });
            expect(edited.override.id).toBe(paid.override.id);
        });

        test('pay / unpay: two part payments straddling the anchor, each on its own paid_on; pay to full; unpay', async () => {
            const s = await makeSchedule({ name: 'Straddle', startDate: '2026-01-20' });
            const date = '2026-03-20';

            // D23's example: 400 at A − 5, then 300 at A + 2. The override row is created by the pay.
            const p1 = (await pay(s.id, date, { paidOn: '2026-02-24', paidAmount: '400', note: 'first' }).expect(200)).body;
            expect(p1).toMatchObject({
                status: 'part_paid', amount: '1000.00', remainingAmount: '600.00', tuned: true, derivedStatus: 'expected',
                override: { status: 'part_paid', paidAmount: '400.00', paidOn: '2026-02-24', rowVersion: 1 },
            });
            expect(p1.payments).toEqual([{
                id: expect.any(Number), paidOn: '2026-02-24', amount: '400.00', note: 'first',
                createdBy: 'local@dev', createdAt: expect.any(String),
            }]);
            const overrideId = p1.override.id;
            expect((await h.audit('schedule_override', overrideId)).map((r) => r.action)).toEqual(['pay', 'create']);

            const p2 = (await pay(s.id, date, { paidOn: '2026-03-03', paidAmount: '300.00' }).expect(200)).body;
            expect(p2).toMatchObject({
                status: 'part_paid', remainingAmount: '300.00', override: { paidAmount: '700.00', paidOn: '2026-03-03', rowVersion: 2 },
            });
            expect(p2.payments.map((p) => [p.paidOn, p.amount])).toEqual([['2026-02-24', '400.00'], ['2026-03-03', '300.00']]);

            // Each payment row is classified on its own date: the first is inside the anchor, the second is not.
            const result = classify(instanceLine(p2), A, TODAY);
            expect(result.payments.map((p) => [p.band, p.amountMinor])).toEqual([['settledBeforeAnchor', 40000n], ['paid', 30000n]]);
            expect(result.owed).toMatchObject({ band: 'future', amountMinor: 30000n, remainder: true });

            // The list read agrees with the mutation response.
            expect(await instanceAt(s.id, date)).toEqual(p2);

            const full = (await pay(s.id, date, { paidOn: TODAY }).expect(200)).body;
            expect(full).toMatchObject({ status: 'paid', remainingAmount: '0.00', derivedStatus: 'paid', override: { paidAmount: '1000.00', paidOn: TODAY } });
            const none = await pay(s.id, date, { paidOn: TODAY }).expect(422);
            expect(none.body).toMatchObject({ code: 'PAID_AMOUNT_INVALID', details: { paidAmount: '0.00', remainingAmount: '0.00' } });

            const snapshots = full.payments.map((p) => ({ cashItemId: null, overrideId, paidOn: p.paidOn, amount: p.amount, note: p.note }));
            const back = (await unpay(s.id, date).expect(200)).body;
            expect(back).toMatchObject({
                status: 'expected', remainingAmount: '1000.00', payments: [], tuned: true, derivedStatus: 'expected',
                override: { id: overrideId, status: null, paidOn: null, paidAmount: null, rowVersion: 4 },
            });
            expect((await h.audit('schedule_override', overrideId)).map((r) => r.action)).toEqual(['unpay', 'pay', 'pay', 'pay', 'create']);
            for (const [i, p] of full.payments.entries()) {
                const rows = await h.audit('payment', p.id);
                expect(rows.map((r) => r.action)).toEqual(['delete', 'create']);
                expect(rows[1]).toMatchObject({ before: null, after: snapshots[i] });
                expect(rows[0]).toMatchObject({ before: snapshots[i], after: null });
            }
            expect(await h.sql('SELECT COUNT(*) AS n FROM payments WHERE override_id = ?', [overrideId])).toEqual([{ n: 0 }]);

            // Nothing to undo → unchanged, no audit; an untuned instance too.
            await unpay(s.id, date).expect(200);
            expect((await h.audit('schedule_override', overrideId)).length).toBe(5);
            expect((await unpay(s.id, '2026-06-20').expect(200)).body).toMatchObject({ tuned: false, status: 'expected' });
            await unpay(s.id, '2026-06-21').expect(404);
        });

        test('pay refusals, and the remainder date landing in override.due_date', async () => {
            const s = await makeSchedule({ name: 'Pay rules', startDate: '2026-01-05', settleMode: 'manual' });
            const future = await pay(s.id, '2026-04-05', { paidOn: '2026-03-11' }).expect(422);
            expect(future.body).toMatchObject({ code: 'PAID_ON_IN_FUTURE', details: { paidOn: '2026-03-11', today: TODAY } });
            for (const [paidAmount, remainingAmount, msg] of [['0', '1000.00', 'zero'], ['-5.00', '1000.00', 'zero'], ['1000.01', '1000.00', 'more']]) {
                const res = await pay(s.id, '2026-04-05', { paidOn: TODAY, paidAmount }).expect(422);
                expect(res.body).toMatchObject({ code: 'PAID_AMOUNT_INVALID', details: { remainingAmount } });
                expect(res.body.error).toMatch(new RegExp(msg));
            }
            for (const body of [
                { paidOn: 'today' }, {}, { paidOn: TODAY, paidAmount: 5 }, { paidOn: TODAY, paidAmount: '1.234' },
                { paidOn: TODAY, remainderDueDate: '2026-03-09' }, { paidOn: TODAY, remainderDueDate: 'x' },
                { paidOn: TODAY, note: 'x'.repeat(501) }, { paidOn: TODAY, baseVersion: -1 },
            ]) {
                await pay(s.id, '2026-04-05', body).expect(400);
            }
            // Nothing above wrote anything.
            expect(await h.sql('SELECT COUNT(*) AS n FROM schedule_overrides WHERE schedule_id = ?', [s.id])).toEqual([{ n: 0 }]);

            // 5 Mar is overdue (manual): a part payment needs a date for the rest.
            const required = await pay(s.id, '2026-03-05', { paidOn: TODAY, paidAmount: '200.00' }).expect(422);
            expect(required.body).toMatchObject({ code: 'REMAINDER_DATE_REQUIRED', details: { dueDate: '2026-03-05', today: TODAY } });
            const ok = (await pay(s.id, '2026-03-05', { paidOn: TODAY, paidAmount: '200.00', remainderDueDate: '2026-03-25' }).expect(200)).body;
            expect(ok).toMatchObject({
                status: 'part_paid', dueDate: '2026-03-25', predictedDueDate: '2026-03-05', remainingAmount: '800.00',
                derivedStatus: 'expected', override: { dueDate: '2026-03-25' },
            });
            const [audit] = await h.audit('schedule_override', ok.override.id);
            expect(audit).toMatchObject({ action: 'pay', before: { dueDate: null }, after: { dueDate: '2026-03-25' } });
            // The remainder is forced manual: once its date passes it is overdue.
            expect((await get(`/schedules/${s.id}/instances`, { from: '2026-03-05', to: '2026-03-05', today: '2026-04-01' }).expect(200))
                .body.data[0].derivedStatus).toBe('overdue');

            // A full payment of an overdue instance needs no remainder date and keeps its date.
            expect((await pay(s.id, '2026-02-05', { paidOn: TODAY }).expect(200)).body).toMatchObject({ status: 'paid', dueDate: '2026-02-05' });
            // A tuned amount is what is owed; a skipped instance may still be paid.
            await tune(s.id, '2026-04-05', { amount: '983.00', status: 'skipped' }).expect(200);
            expect((await pay(s.id, '2026-04-05', { paidOn: TODAY }).expect(200)).body)
                .toMatchObject({ status: 'paid', override: { paidAmount: '983.00', amount: '983.00' } });
            // baseVersion is the override's once one exists.
            const stale = await pay(s.id, '2026-03-05', { paidOn: TODAY, paidAmount: '1.00', baseVersion: 0 }).expect(409);
            expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 1 } });
            await pay(s.id, '2026-05-05', { paidOn: TODAY, paidAmount: '1.00', baseVersion: 7 }).expect(200);   // no override yet: ignored
            await pay(s.id, '2026-03-06', { paidOn: TODAY }).expect(404);
        });

        test('"Didn\'t happen": settleMode manual on an assumed-settled instance makes it overdue; its siblings stay auto', async () => {
            const s = await makeSchedule({ name: 'Bounced' });
            const before = await instances(s.id, { from: '2026-01-01', to: '2026-02-28' });
            expect(before.data.map((i) => i.derivedStatus)).toEqual(['assumedSettled', 'assumedSettled']);

            const feb = (await tune(s.id, '2026-02-05', { settleMode: 'manual' }).expect(200)).body;   // today − 33
            expect(feb).toMatchObject({ settleMode: 'manual', derivedStatus: 'overdue', tuned: true, override: { settleMode: 'manual' } });
            const jan = (await tune(s.id, '2026-01-05', { settleMode: 'manual' }).expect(200)).body;   // today − 64
            expect(jan.derivedStatus).toBe('unresolved');
            const after = await instances(s.id, { from: '2026-01-01', to: '2026-04-30' });
            expect(after.data.map((i) => [i.naturalDate, i.settleMode, i.derivedStatus])).toEqual([
                ['2026-01-05', 'manual', 'unresolved'],
                ['2026-02-05', 'manual', 'overdue'],
                ['2026-03-05', 'auto', 'assumed'],
                ['2026-04-05', 'auto', 'expected'],
            ]);
            // Reverting the tune makes it assumed settled again.
            await del(inst(s.id, '2026-02-05')).expect(204);
            expect((await instanceAt(s.id, '2026-02-05')).derivedStatus).toBe('assumedSettled');
        });
    });

    test('D17: deactivation counts live schedules and overdue / unresolved instances', async () => {
        const closing = (await api().post('/api/v1/accounts').send({ companyId: jfa.id, name: 'Closing', currency: 'GBP' }).expect(201)).body;
        await put(`/accounts/${closing.id}/balances/${A}`, { balance: '10.00' }).expect(200);
        const on = (body) => makeSchedule({ accountId: closing.id, ...body });
        const live = await on({ name: 'Live' });                                                              // runs on past today
        const past = await on({ name: 'Past', startDate: '2025-10-15', endDate: '2026-02-15' });              // auto, over
        const manual = await on({ name: 'Manual', startDate: '2026-01-12', endDate: '2026-03-01', settleMode: 'manual' });
        await on({ name: 'Ended auto', startDate: '2026-01-12', endDate: '2026-02-28' });                     // nothing owed
        const gone = await on({ name: 'Deleted' });
        await del(`/schedules/${gone.id}`).expect(204);
        await tune(past.id, '2026-02-15', { settleMode: 'manual' }).expect(200);                              // Didn't happen → overdue

        const refused = await put(`/accounts/${closing.id}`, { isActive: false }).expect(409);
        expect(refused.body.code).toBe('ACCOUNT_IN_USE');
        expect(refused.body.details).toEqual({
            owedItems: { count: 0, keys: [] },
            liveSchedules: { count: 1, ids: [live.id] },
            owedInstances: {
                count: 3,
                keys: [`sched.${manual.id}.2026-01-12`, `sched.${manual.id}.2026-02-12`, `sched.${past.id}.2026-02-15`],
            },
        });

        // Settle it all: delete the live one, pay one manual instance, skip the other, revert the tune.
        await del(`/schedules/${live.id}`).expect(204);
        await pay(manual.id, '2026-01-12', { paidOn: TODAY }).expect(200);
        await tune(manual.id, '2026-02-12', { status: 'skipped' }).expect(200);
        await del(inst(past.id, '2026-02-15')).expect(204);
        const off = (await put(`/accounts/${closing.id}`, { isActive: false }).expect(200)).body;
        expect(off.isActive).toBe(false);
        // Nothing new goes onto an inactive account.
        const onto = await post('/schedules', {
            accountId: closing.id, categoryId: out.id, name: 'Late', amount: '1.00', frequency: 'weekly', startDate: TODAY,
        }).expect(400);
        expect(onto.body.error).toMatch(/inactive/);
    });

    test('loadTarget: the sched. branch reads effective values under the caller\'s locks (§8)', async () => {
        const db = require('../../src/db');
        const { loadTarget } = require('../../src/services/forecastLoad');
        const load = (key) => db.withConnection((c) => loadTarget(c, parseKey(key), TODAY));

        const s = await makeSchedule({ name: 'Targets', startDate: '2026-01-20', weekendRule: 'previous' });
        await tune(s.id, '2026-04-20', { amount: '983.00' }).expect(200);
        const tuned = await load(`sched.${s.id}.2026-04-20`);
        expect(tuned).toEqual({
            kind: 'sched', id: s.id, naturalDate: '2026-04-20', status: 'expected', effectiveDate: '2026-04-20',
            effectiveAmount: '983.00', currency: 'GBP', accountId: main.id, settleMode: 'auto', hasPaymentState: false,
            overrideId: expect.any(Number),
        });
        // Predicted: the weekend-adjusted natural date (Sun 20 Sep → Fri 18 Sep), no override.
        expect(await load(`sched.${s.id}.2026-09-20`)).toMatchObject({
            effectiveDate: '2026-09-18', effectiveAmount: '1000.00', status: 'expected', hasPaymentState: false, overrideId: null,
        });
        await pay(s.id, '2026-05-20', { paidOn: TODAY, paidAmount: '1.00' }).expect(200);
        expect(await load(`sched.${s.id}.2026-05-20`)).toMatchObject({ status: 'part_paid', hasPaymentState: true });

        expect(await load(`sched.${s.id}.2026-05-21`)).toBeNull();      // not an occurrence
        expect(await load('sched.999999.2026-05-20')).toBeNull();       // no such schedule
        await del(`/schedules/${s.id}`).expect(204);
        expect(await load(`sched.${s.id}.2026-04-20`)).toBeNull();      // deleted
    });
});
