'use strict';

// The headline flow (PLAN.md "Verification", BUILD_PLAN step 7), end to end against a
// per-run jflow_test_<runid> schema with `today` pinned through ?today= (D24):
//   a monthly schedule of 1000 × 12; June tuned to 983 and July to 1024 (instance PUT);
//   a scenario that shifts July's date; /forecast baseline vs scenario delta; apply;
//   overrides written with source_scenario_id; a second apply refused SCENARIO_NOT_DRAFT,
//   and an adjustment edit on the applied scenario too.
// It needs step 5 (schedules, instances) and step 6 (/forecast) as well as step 7.

const { startHarness } = require('./harness');

jest.setTimeout(240000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';
const A = '2026-03-01';
const TO = '2027-03-31';

const withToday = (req) => req.query({ today: TODAY });
const post = (path, body = {}) => withToday(api().post(`/api/v1${path}`)).send(body);
const put = (path, body = {}) => withToday(api().put(`/api/v1${path}`)).send(body);
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });

// Month buckets over [today, TO]: 0 = 10–31 Mar 2026, 1 = Apr, 2 = May, 3 = Jun, 4 = Jul, 5 = Aug, … 12 = Mar 2027.
const JUN = 3;
const JUL = 4;
const AUG = 5;

test('1000 × 12, tune June 983 / July 1024, shift July in a scenario, delta, apply, overrides, re-apply refused', async () => {
    const jfa = (await api().get('/api/v1/companies').expect(200)).body.data.find((c) => c.code === 'JFA');
    const account = (await api().post('/api/v1/accounts').send({ companyId: jfa.id, name: 'Current', currency: 'GBP' }).expect(201)).body;
    const rent = (await api().post('/api/v1/categories').send({ name: 'Rent', direction: 'out' }).expect(201)).body;
    await put(`/accounts/${account.id}/balances/${A}`, { balance: '20000.00' }).expect(200);

    // 1000 × 12, monthly from 1 Apr 2026.
    const sched = (await post('/schedules', {
        accountId: account.id, categoryId: rent.id, name: 'Office rent', amount: '1000.00', frequency: 'monthly',
        startDate: '2026-04-01', occurrenceCount: 12,
    }).expect(201)).body;
    const key = (date) => `sched.${sched.id}.${date}`;

    // Tune June to 983 and July to 1024.
    await put(`/schedules/${sched.id}/instances/2026-06-01`, { amount: '983.00' }).expect(200);
    await put(`/schedules/${sched.id}/instances/2026-07-01`, { amount: '1024.00' }).expect(200);

    const forecast = async (query = {}) => (await get('/forecast', {
        companyId: jfa.id, from: TODAY, to: TO, bucket: 'month', ...query,
    }).expect(200)).body;

    const baseline = await forecast();
    expect(baseline.scenario).toBeNull();
    expect(baseline.buckets).toHaveLength(13);
    expect(baseline.buckets.map((b) => b.outflow)).toEqual([0, 100000, 100000, 98300, 102400, ...Array(8).fill(100000)]);
    expect(baseline.summary).toMatchObject({ opening: 2000000, outflow: 1200700, closing: 799300 });

    // A scenario that shifts July's payment to 20 Aug. Its base is the tuned 1024 (D11).
    const scenario = (await post('/scenarios', { name: 'Hold July rent', companyId: jfa.id }).expect(201)).body;
    const adj = (await put(`/scenarios/${scenario.id}/adjustments/${key('2026-07-01')}`, {
        kind: 'adjust', newDate: '2026-08-20',
    }).expect(201)).body;
    expect(adj).toMatchObject({ baseDate: '2026-07-01', baseAmount: '1024.00', stale: null });

    // Baseline vs scenario.
    const what = await forecast({ scenarioId: scenario.id });
    expect(what.scenario).toMatchObject({ id: scenario.id, status: 'draft', warnings: [] });
    expect(what.buckets.map((b) => b.outflow)).toEqual([0, 100000, 100000, 98300, 0, 202400, ...Array(7).fill(100000)]);
    expect(what.scenario.deltaByBucket[JUN]).toMatchObject({ outflow: 0, closing: 0 });
    expect(what.scenario.deltaByBucket[JUL]).toMatchObject({ outflow: -102400, net: 102400, closing: 102400 });
    expect(what.scenario.deltaByBucket[AUG]).toMatchObject({ outflow: 102400, net: -102400, closing: 0 });
    what.scenario.deltaByBucket.forEach((d, i) => {
        if (i !== JUL && i !== AUG) expect(d).toMatchObject({ inflow: 0, outflow: 0, net: 0, closing: 0 });
    });
    expect(what.summary).toMatchObject({ outflow: 1200700, closing: 799300 });
    expect(what.scenario.baselineSummary).toEqual(baseline.summary);
    const july = what.rows.flatMap((r) => r.items).find((i) => i.key === key('2026-07-01'));
    expect(july).toMatchObject({ date: '2026-08-20', amountMinor: 102400, editable: true, baseline: { date: '2026-07-01', amountMinor: 102400 } });
    expect(july.flags).toEqual(expect.arrayContaining(['adjusted', 'tuned']));
    // The real data has not moved.
    expect((await forecast()).buckets).toEqual(baseline.buckets);

    // Apply.
    const applied = (await post(`/scenarios/${scenario.id}/apply`, { baseVersion: scenario.rowVersion }).expect(200)).body;
    expect(applied.scenario).toMatchObject({ status: 'applied', appliedBy: 'local@dev' });
    const overrides = await h.sql(
        'SELECT id, natural_date, amount, due_date, status, source_scenario_id FROM schedule_overrides WHERE schedule_id = ? ORDER BY natural_date',
        [sched.id]
    );
    expect(overrides).toEqual([
        { id: expect.any(Number), natural_date: '2026-06-01', amount: '983.00', due_date: null, status: null, source_scenario_id: null },
        { id: expect.any(Number), natural_date: '2026-07-01', amount: '1024.00', due_date: '2026-08-20', status: null, source_scenario_id: scenario.id },
    ]);
    expect(applied.applied).toEqual([{ itemKey: key('2026-07-01'), kind: 'adjust', wrote: 'schedule_override', entityId: overrides[1].id }]);
    expect((await h.audit('schedule_override', overrides[1].id))[0]).toMatchObject({
        action: 'apply', after: { dueDate: '2026-08-20', sourceScenarioId: scenario.id },
    });
    expect((await h.audit('scenario', scenario.id))[0]).toMatchObject({ action: 'apply', after: { status: 'applied' } });

    // The real forecast is now what the scenario showed.
    const after = await forecast();
    expect(after.buckets).toEqual(what.buckets);
    const moved = after.rows.flatMap((r) => r.items).find((i) => i.key === key('2026-07-01'));
    expect(moved).toMatchObject({ date: '2026-08-20', amountMinor: 102400 });
    expect(moved.flags).toEqual(expect.arrayContaining(['tuned', 'fromScenario']));

    // Re-apply refused; the adjustments are now history.
    const again = await post(`/scenarios/${scenario.id}/apply`, {}).expect(409);
    expect(again.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
    const edit = await put(`/scenarios/${scenario.id}/adjustments/${key('2026-07-01')}`, { kind: 'adjust', newDate: '2026-09-01' }).expect(409);
    expect(edit.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
    expect((await h.sql('SELECT new_date, row_version FROM scenario_adjustments WHERE id = ?', [adj.id]))[0])
        .toEqual({ new_date: '2026-08-20', row_version: 0 });
});
