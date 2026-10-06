'use strict';

// Overlay routes and `ship.` scenarios (Phase 2 step 21; CONTRACT §6.11, §6.12, §10.1,
// §10.7–10.9, §10.11; P6, P7, P11), end to end against a per-run jflow_test_<runid> schema
// and an in-process stand-in for the shipping source (test/helpers/shippingSourceStub.js). The feed reaches
// external_items only through the real refresh; no real shipping call is made.
//
// Pinned here:
//   · PUT /external-items/:key — the merge, the stamps, planned_base_amount = the feed amount
//     (P6), skipped, the row JSON with derivedStatus, and every refusal (ITEM_KEY_INVALID, a
//     non-ship or absent key, TARGET_MISSING, TARGET_SETTLED, PLANNED_DATE_IN_PAST, grammar,
//     nothing to plan, STALE_WRITE) writing nothing;
//   · DELETE /external-items/:key — the revert (unplan), on a gone row too;
//   · ship. adjustments: bases with the overlay, `current` with the ship name, the refusals;
//   · apply: a stamped planned_date (wrote external_item) that a refresh moving the feed date
//     leaves alone; new_amount with its base, exclude → planned_skipped (P7); SHIP_PLAN_STALE
//     after the feed amount moves; gone / paid / skipped → SCENARIO_STALE writing nothing;
//     drift → BASE_CHANGED → rebase → apply;
//   · two connections: external_items is locked after cash_items and before
//     schedule_overrides (P11); a refresh UPDATE during an apply waits, or is skipped after
//     its 5 s lock wait, and never touches planned_*; the re-check reads what committed while
//     it waited on the ship row;
//   · an audit row per mutation.

const mysql = require('mysql2/promise');
const { startHarness } = require('./harness');
const { stubShippingSource, feedItem, feedBody } = require('../helpers/shippingSourceStub');

jest.setTimeout(240000);

const TODAY = '2026-09-29';
const A = '2026-09-20';
const USER = 'local@dev';
const USD = '0.786543';
const SHIP_NAME = 'Acme Textiles · PO-812 · balance';
const ER_LOCK_NOWAIT = 3572;

const ROW_KEYS = [
    'key', 'id', 'source', 'extId', 'feedKind', 'feedStatus', 'supplier', 'shippingCompanyId', 'companyId',
    'accountId', 'poId', 'poNumber', 'shipmentId', 'containerRef', 'currency', 'amount', 'dueDate', 'paidOn',
    'settles', 'dateBasis', 'amountBasis', 'blocked', 'flags', 'dueSet', 'dueDatePrev', 'dueDateMovedAt', 'goneAt',
    'plannedDate', 'plannedAmount',
    'plannedSkipped', 'plannedBaseAmount', 'plannedNote', 'sourceScenarioId', 'plannedBy', 'plannedAt',
    'effectiveDate', 'effectiveAmount', 'planStale', 'derivedStatus', 'dateMoved', 'rowVersion', 'createdBy', 'createdAt',
    'updatedAt',
];
const OVERLAY = [
    'planned_date', 'planned_amount', 'planned_skipped', 'planned_base_amount', 'planned_note',
    'source_scenario_id', 'planned_by', 'planned_at',
];
const FEED_KEEP = ['feed_hash', 'feed_status', 'due_date', 'amount', 'paid_on', 'gone_at'];

let h;
let stub;
let other;          // a second connection, for NOWAIT probes and held locks outside the harness

beforeAll(async () => {
    h = await startHarness();
    stub = stubShippingSource();
    other = await mysql.createConnection({
        host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: h.schema, ssl: { rejectUnauthorized: false },
        dateStrings: ['DATE'], timezone: 'Z',
    });
});

afterAll(async () => {
    if (other) await other.end();
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
    if (warnSpy) warnSpy.mockRestore();
    if (errorSpy) errorSpy.mockRestore();
});

const api = () => h.api();
const withToday = (req, today) => req.query({ today });
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });
const put = (path, body = {}, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const post = (path, body = {}, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const del = (path, body = {}, today = TODAY) => withToday(api().delete(`/api/v1${path}`), today).send(body);
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const itemPath = (key) => `/external-items/${key}`;
const plan = (key, body, today) => put(itemPath(key), body, today);
const unplan = (key, body, today) => del(itemPath(key), body, today);
const adjPath = (sid, key) => `/scenarios/${sid}/adjustments/${key}`;
const makeScenario = async (name) => (await post('/scenarios', { name }).expect(201)).body;
const detail = async (sid) => (await get(`/scenarios/${sid}`).expect(200)).body;

// The feed the stub serves: every row belongs to shipping company 1 (→ the test company).
const feed = new Map();
const setFeed = (id, over = {}) => feed.set(id, feedItem(id, { ...(feed.get(id) || {}), ...over }));
const releaseClaim = () => h.sql("UPDATE external_sync SET last_attempt_at = NULL WHERE source = 'ship'");
/** Lift the claim and have the stub serve the current feed (the next run fetches it). */
async function serveFeed() {
    await releaseClaim();
    stub.reset();
    stub.respond(feedBody([...feed.values()]));
}
/** One forced refresh through the route. */
async function refresh() {
    await serveFeed();
    const res = await post('/external/refresh');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
}
/** One run through the service, for its counts (serveFeed first). */
const runRefresh = () => require('../../src/services/shippingRefresh').runRefresh({ today: TODAY });

const row = async (extId) => (await h.sql("SELECT * FROM external_items WHERE source = 'ship' AND ext_id = ?", [extId]))[0];
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));
const auditCount = async () => Number((await h.sql('SELECT COUNT(*) AS n FROM audit_log'))[0].n);
const auditOf = async (extId) => h.audit('external_item', (await row(extId)).id);

/** Every row a ship write could touch, plus the audit count — "nothing written" is equality. */
async function snapshot() {
    const out = {};
    for (const t of ['external_items', 'scenarios', 'scenario_adjustments', 'cash_items', 'schedule_overrides']) {
        out[t] = await h.sql(`SELECT * FROM ${t} ORDER BY id`);
    }
    out.audit = await auditCount();
    return JSON.parse(JSON.stringify(out));
}

/** True when another transaction holds the external_items row (a NOWAIT probe on `other`). */
async function shipRowLocked(extId) {
    const { id } = await row(extId);
    try {
        await other.query('SELECT id FROM external_items WHERE id = ? FOR UPDATE NOWAIT', [id]);
        return false;
    } catch (err) {
        if (err.errno === ER_LOCK_NOWAIT) return true;
        throw err;
    }
}
async function untilShipRowLocked(extId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await shipRowLocked(extId))) {
        if (Date.now() > deadline) throw new Error(`[e2e] ${extId} was never locked`);
        await pause(100);
    }
}

/** Track a promise's settlement so a test can assert it is still waiting. */
function track(promise) {
    const t = { settled: false };
    t.promise = promise.then((v) => { t.settled = true; return v; }, (e) => { t.settled = true; throw e; });
    return t;
}

let co;
let gbp;
let usd;
let costs;

const forecast = async (query = {}) => (await get('/forecast', { companyId: co.id, ...query }).expect(200)).body;
const linesOf = (body) => body.rows.flatMap((r) => r.items);
const lineOf = (body, key) => linesOf(body).find((l) => l.key === key);
const listed = async (extId) => (await get('/external-items', { includeGone: '1', limit: 500 }).expect(200))
    .body.data.find((r) => r.extId === extId);

beforeAll(async () => {
    co = (await api().post('/api/v1/companies').send({ code: 'SHO', name: 'Ship overlay' }).expect(201)).body;
    await api().put(`/api/v1/companies/${co.id}`).send({ shippingCompanyId: 1 }).expect(200);
    const account = async (name, currency, isDefault) => {
        const acct = (await api().post('/api/v1/accounts').send({ companyId: co.id, name, currency, isDefault }).expect(201)).body;
        await put(`/accounts/${acct.id}/balances/${A}`, { balance: '100000.00' }).expect(200);
        return acct;
    };
    gbp = await account('Sterling', 'GBP', true);
    usd = await account('Dollars', 'USD', false);
    await api().post('/api/v1/fx-rates').send({ currency: 'USD', rateToGbp: USD, effectiveFrom: '2026-09-01' }).expect(201);
    costs = (await api().post('/api/v1/categories').send({ name: 'Costs', direction: 'out' }).expect(201)).body;

    const open = (id, dueDate, amount) => setFeed(id, { dueDate, amount });
    open('bal-100-s1', '2026-10-15', '1000.00');      // the overlay PUT / DELETE row
    setFeed('bal-101-n', { dueDate: null, dateBasis: 'undated', amount: '500.00' });   // dated through the overlay
    setFeed('pay-1-bal100', { status: 'paid', paidOn: '2026-09-25', dueDate: null, amount: '100.00', settles: 'bal-100-s1' });
    open('dep-102', '2026-10-18', '700.00');          // goes gone with an overlay on it
    open('bal-103-s1', '2026-10-19', '800.00');       // never planned
    setFeed('pi-104-s1', { dueDate: null, dateBasis: 'undated', amount: '900.00' });   // stays undated
    open('bal-105-s1', '2026-10-20', '950.00');       // skipped by hand
    open('bal-110-s1', '2026-10-15', '2000.00');      // scenario bases with an overlay
    open('bal-111-s1', '2026-10-20', '2000.00');      // apply moves its date; the feed moves too
    open('bal-112-s1', '2026-10-21', '3000.00');      // apply sets an amount; then the feed amount moves
    open('bal-113-s1', '2026-10-24', '3300.00');      // drift → rebase → apply
    open('bal-114-s1', '2026-10-25', '1400.00');      // goes gone before apply
    open('bal-115-s1', '2026-10-26', '1500.00');      // turns paid before apply
    open('bal-116-s1', '2026-10-27', '1600.00');      // excluded by apply (P7)
    open('bal-117-s1', '2026-10-28', '1700.00');      // skipped by hand before apply
    open('bal-120-s1', '2026-10-16', '1200.00');      // a refresh waits on apply
    open('bal-121-s1', '2026-10-17', '1210.00');      // a refresh gives up on apply
    open('bal-122-s1', '2026-10-18', '1220.00');      // moves while apply waits on cash_items
    open('bal-123-s1', '2026-10-19', '1230.00');      // re-planned while apply waits on it
    open('bal-124-s1', '2026-10-20', '1240.00');      // re-planned while an adjustment write waits on it
    await refresh();

    // dep-102: planned, then gone — an orphaned overlay (SHIP_PLAN_ORPHANED).
    await plan('ship.dep-102', { note: 'held at port' }).expect(200);
    feed.delete('dep-102');
    await refresh();
});

describe('PUT /external-items/:key (§6.12, §10.11)', () => {
    test('plannedDate and note: the row JSON with derivedStatus, stamped, audited `plan`, feed columns untouched', async () => {
        const before = await row('bal-100-s1');
        const res = await plan('ship.bal-100-s1', { plannedDate: '2026-10-30', note: '  wait for the LC  ' }).expect(200);
        expect(Object.keys(res.body)).toEqual(ROW_KEYS);
        expect(res.body).toMatchObject({
            key: 'ship.bal-100-s1', id: before.id, extId: 'bal-100-s1', feedStatus: 'open', companyId: co.id,
            accountId: usd.id, currency: 'USD', amount: '1000.00', dueDate: '2026-10-15', plannedDate: '2026-10-30',
            plannedAmount: null, plannedSkipped: false, plannedBaseAmount: null, plannedNote: 'wait for the LC',
            sourceScenarioId: null, plannedBy: USER, effectiveDate: '2026-10-30', effectiveAmount: '1000.00',
            planStale: false, derivedStatus: 'expected', rowVersion: before.row_version + 1, createdBy: 'shipping-feed',
        });
        expect(new Date(res.body.plannedAt).toISOString()).toBe(res.body.plannedAt);

        const after = await row('bal-100-s1');
        expect(pick(after, FEED_KEEP)).toEqual(pick(before, FEED_KEEP));
        const [audit] = await auditOf('bal-100-s1');
        expect(audit).toMatchObject({
            entityType: 'external_item', entityId: before.id, action: 'plan', userEmail: USER,
            before: { plannedDate: null, plannedNote: null, plannedBy: null, plannedAt: null },
            after: { key: 'ship.bal-100-s1', plannedDate: '2026-10-30', plannedNote: 'wait for the LC', plannedBy: USER },
        });

        const line = lineOf(await forecast(), 'ship.bal-100-s1');
        expect(line).toMatchObject({ date: '2026-10-30', dueDate: '2026-10-30', flags: ['planned'] });
        expect(await listed('bal-100-s1')).toEqual(res.body);
    });

    test('plannedAmount stores its base = the feed amount (P6); a feed amount change makes it stale; re-sending re-bases', async () => {
        const res = await plan('ship.bal-100-s1', { plannedAmount: '900' }).expect(200);
        expect(res.body).toMatchObject({
            plannedAmount: '900.00', plannedBaseAmount: '1000.00', effectiveAmount: '900.00', planStale: false,
            plannedDate: '2026-10-30', plannedNote: 'wait for the LC',          // the merge kept them
        });
        expect((await auditOf('bal-100-s1'))[0]).toMatchObject({
            action: 'plan', before: { plannedAmount: null, plannedBaseAmount: null },
            after: { key: 'ship.bal-100-s1', plannedAmount: '900.00', plannedBaseAmount: '1000.00' },
        });
        expect(lineOf(await forecast(), 'ship.bal-100-s1')).toMatchObject({ amountMinor: 90000 });

        setFeed('bal-100-s1', { amount: '1100.00' });
        await refresh();
        expect((await row('bal-100-s1')).planned_amount).toBe('900.00');          // the refresh never writes planned_*
        const body = await forecast();
        expect(body.warnings).toContainEqual({ code: 'SHIP_PLAN_STALE', key: 'ship.bal-100-s1' });
        expect(lineOf(body, 'ship.bal-100-s1')).toMatchObject({ amountMinor: 110000 });
        // The warning's key is the forecast line's key, exactly (the web matches on it).
        for (const w of body.warnings.filter((x) => x.code === 'SHIP_PLAN_STALE')) {
            expect(linesOf(body).filter((l) => l.key === w.key)).toHaveLength(1);
        }
        expect(await listed('bal-100-s1')).toMatchObject({ planStale: true, effectiveAmount: '1100.00' });

        const again = await plan('ship.bal-100-s1', { plannedAmount: '900.00' }).expect(200);
        expect(again.body).toMatchObject({ plannedAmount: '900.00', plannedBaseAmount: '1100.00', planStale: false, effectiveAmount: '900.00' });
        expect((await forecast()).warnings).not.toContainEqual({ code: 'SHIP_PLAN_STALE', key: 'ship.bal-100-s1' });
    });

    test('the merge: absent keeps, null clears (the amount with its base); skipped; plannedDate = today is fine; a no-op writes nothing', async () => {
        let r = (await plan('ship.bal-100-s1', { plannedAmount: null }).expect(200)).body;
        expect(r).toMatchObject({ plannedAmount: null, plannedBaseAmount: null, plannedDate: '2026-10-30', effectiveAmount: '1100.00' });

        r = (await plan('ship.bal-100-s1', { skipped: true }).expect(200)).body;
        expect(r).toMatchObject({ plannedSkipped: true, derivedStatus: 'skipped', plannedDate: '2026-10-30' });
        expect(lineOf(await forecast(), 'ship.bal-100-s1')).toBeUndefined();

        r = (await plan('ship.bal-100-s1', { skipped: false, plannedDate: null }).expect(200)).body;
        expect(r).toMatchObject({
            plannedSkipped: false, plannedDate: null, plannedNote: 'wait for the LC', effectiveDate: '2026-10-15',
            derivedStatus: 'expected',
        });

        r = (await plan('ship.bal-100-s1', { plannedDate: TODAY }).expect(200)).body;
        expect(r).toMatchObject({ plannedDate: TODAY, effectiveDate: TODAY, derivedStatus: 'expected' });

        const audits = await auditCount();
        const same = (await plan('ship.bal-100-s1', { note: 'wait for the LC', plannedDate: TODAY, skipped: false }).expect(200)).body;
        expect(same.rowVersion).toBe(r.rowVersion);
        expect(same.plannedAt).toBe(r.plannedAt);
        expect(await auditCount()).toBe(audits);
    });

    test('an undated row is dated through the overlay (and leaves the undated count)', async () => {
        const before = await forecast();
        expect(lineOf(before, 'ship.bal-101-n')).toBeUndefined();
        const r = (await plan('ship.bal-101-n', { plannedDate: '2026-11-02' }).expect(200)).body;
        expect(r).toMatchObject({ dueDate: null, plannedDate: '2026-11-02', effectiveDate: '2026-11-02', derivedStatus: 'expected' });
        const after = await forecast();
        expect(lineOf(after, 'ship.bal-101-n')).toMatchObject({ date: '2026-11-02', amountMinor: 50000 });
        expect(after.shipping.undatedCount).toBe(before.shipping.undatedCount - 1);
    });

    test('refusals, each writing nothing', async () => {
        const before = await snapshot();
        for (const key of ['ship.a:b', 'ship.', 'bogus', 'item.01', `ship.${'x'.repeat(65)}`]) {
            const res = await plan(key, { plannedDate: '2026-11-01' }).expect(422);
            expect(res.body).toMatchObject({ code: 'ITEM_KEY_INVALID', details: { key } });
        }
        // A grammatical key that names no external_items row: 404 with no code.
        for (const key of ['item.5', 'sched.5.2026-10-01', 'ship.no-such-row', 'ship.BAL-103-S1']) {
            const res = await plan(key, { plannedDate: '2026-11-01' }).expect(404);
            expect(res.body.code).toBeUndefined();
        }
        const gone = await plan('ship.dep-102', { plannedDate: '2026-11-01' }).expect(404);
        expect(gone.body).toMatchObject({ code: 'TARGET_MISSING', details: { key: 'ship.dep-102' } });
        const paid = await plan('ship.pay-1-bal100', { plannedDate: '2026-11-01' }).expect(409);
        expect(paid.body).toMatchObject({ code: 'TARGET_SETTLED', details: { key: 'ship.pay-1-bal100', status: 'paid' } });
        const past = await plan('ship.bal-103-s1', { plannedDate: '2026-09-28' }).expect(422);
        expect(past.body).toMatchObject({ code: 'PLANNED_DATE_IN_PAST', details: { plannedDate: '2026-09-28', today: TODAY } });

        for (const body of [
            {},
            { plannedDate: '2026-02-30' }, { plannedDate: 20261101 }, { plannedDate: '2026-11-1' },
            { plannedAmount: '0' }, { plannedAmount: '0.00' }, { plannedAmount: '-5.00' }, { plannedAmount: 12 },
            { plannedAmount: '1.234' }, { plannedAmount: 'abc' },
            { skipped: 'yes' }, { skipped: 1 }, { skipped: null },
            { note: 'x'.repeat(501) }, { note: 5 },
            { plannedDate: '2026-11-01', baseVersion: -1 },
        ]) {
            const res = await plan('ship.bal-103-s1', body);
            expect({ body, status: res.status }).toEqual({ body, status: 400 });
        }
        // Nothing to plan after the merge: 400, and DELETE is the way back.
        const nothing = await plan('ship.bal-103-s1', { plannedDate: null, skipped: false }).expect(400);
        expect(nothing.body.error).toMatch(/DELETE/);

        const version = (await row('bal-103-s1')).row_version;
        const stale = await plan('ship.bal-103-s1', { plannedDate: '2026-11-01', baseVersion: version + 5 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: version } });

        expect(await snapshot()).toEqual(before);
    });

    test('the refresh bumps row_version: a PUT with a baseVersion read before the feed moved is STALE_WRITE', async () => {
        const read = await listed('bal-103-s1');
        setFeed('bal-103-s1', { dueDate: '2026-10-22' });
        await refresh();
        const res = await plan('ship.bal-103-s1', { plannedDate: '2026-11-01', baseVersion: read.rowVersion }).expect(409);
        expect(res.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: read.rowVersion + 1 } });
        const ok = await plan('ship.bal-103-s1', { plannedDate: '2026-11-01', baseVersion: read.rowVersion + 1 }).expect(200);
        expect(ok.body).toMatchObject({ dueDate: '2026-10-22', plannedDate: '2026-11-01', rowVersion: read.rowVersion + 2 });
    });
});

describe('DELETE /external-items/:key (§10.11)', () => {
    test('reverts to the feed: every planned_* column, planned_skipped and source_scenario_id cleared; the row JSON; audited `unplan`', async () => {
        await plan('ship.bal-100-s1', { plannedDate: '2026-11-05', plannedAmount: '950.00', skipped: true }).expect(200);
        await h.sql("UPDATE external_items SET source_scenario_id = 42, row_version = row_version + 1 WHERE ext_id = 'bal-100-s1'");
        const before = await row('bal-100-s1');
        expect(before).toMatchObject({ planned_skipped: 1, planned_base_amount: '1100.00', source_scenario_id: 42 });

        const stale = await unplan('ship.bal-100-s1', { baseVersion: before.row_version - 1 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: before.row_version } });

        const reverted = await unplan('ship.bal-100-s1', { baseVersion: before.row_version }).expect(200);
        const after = await row('bal-100-s1');
        // The full row JSON, as PUT answers (the web replaces its row from it).
        expect(Object.keys(reverted.body)).toEqual(ROW_KEYS);
        expect(reverted.body).toMatchObject({
            key: 'ship.bal-100-s1', plannedDate: null, plannedAmount: null, plannedSkipped: false, plannedBaseAmount: null,
            plannedNote: null, sourceScenarioId: null, plannedBy: null, plannedAt: null, effectiveDate: '2026-10-15',
            effectiveAmount: '1100.00', derivedStatus: 'expected', rowVersion: before.row_version + 1,
        });
        expect(await listed('bal-100-s1')).toEqual(reverted.body);
        expect(pick(after, OVERLAY)).toEqual({
            planned_date: null, planned_amount: null, planned_skipped: 0, planned_base_amount: null, planned_note: null,
            source_scenario_id: null, planned_by: null, planned_at: null,
        });
        expect(after.row_version).toBe(before.row_version + 1);
        expect(pick(after, FEED_KEEP)).toEqual(pick(before, FEED_KEEP));
        expect((await auditOf('bal-100-s1'))[0]).toMatchObject({
            action: 'unplan', userEmail: USER,
            before: { plannedDate: '2026-11-05', plannedAmount: '950.00', plannedSkipped: true, plannedNote: 'wait for the LC', sourceScenarioId: 42 },
            after: { key: 'ship.bal-100-s1', plannedDate: null, plannedAmount: null, plannedSkipped: false, sourceScenarioId: null, plannedBy: null },
        });
        expect(lineOf(await forecast(), 'ship.bal-100-s1')).toMatchObject({ date: '2026-10-15', amountMinor: 110000, flags: [] });

        // Nothing left to revert, no row, a bad key: refused, nothing written.
        const snap = await snapshot();
        expect((await unplan('ship.bal-100-s1').expect(404)).body.code).toBeUndefined();
        await unplan('ship.no-such-row').expect(404);
        await unplan('item.5').expect(404);
        expect((await unplan('ship.a:b').expect(422)).body).toMatchObject({ code: 'ITEM_KEY_INVALID', details: { key: 'ship.a:b' } });
        await unplan('ship.bal-100-s1', { baseVersion: 'x' }).expect(400);
        expect(await snapshot()).toEqual(snap);
    });

    test('works on a gone row (the orphaned overlay is cleaned up) and on a paid one', async () => {
        expect((await forecast()).warnings).toContainEqual({ code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-102' });
        const gone = (await unplan('ship.dep-102').expect(200)).body;
        expect(gone).toMatchObject({ key: 'ship.dep-102', goneAt: expect.any(String), plannedNote: null, derivedStatus: null });
        expect((await row('dep-102')).planned_note).toBeNull();
        expect((await forecast()).warnings).not.toContainEqual({ code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-102' });
        expect((await auditOf('dep-102'))[0]).toMatchObject({ action: 'unplan', before: { plannedNote: 'held at port' } });

        await h.sql("UPDATE external_items SET planned_note = 'by hand', row_version = row_version + 1 WHERE ext_id = 'pay-1-bal100'");
        const paid = (await unplan('ship.pay-1-bal100').expect(200)).body;
        expect(paid).toMatchObject({ feedStatus: 'paid', plannedNote: null, derivedStatus: 'paid' });
        expect((await row('pay-1-bal100')).planned_note).toBeNull();
    });
});

describe('GET /external-items/:key (the plan dialog\'s read)', () => {
    test('one row, un-encoded key: the full row JSON with rowVersion, the overlay and derivedStatus; gone rows too', async () => {
        await plan('ship.bal-103-s1', { note: 'call the mill' }).expect(200);
        const res = await get(itemPath('ship.bal-103-s1')).expect(200);
        expect(Object.keys(res.body)).toEqual(ROW_KEYS);
        expect(res.body).toEqual(await listed('bal-103-s1'));
        expect(res.body).toMatchObject({
            key: 'ship.bal-103-s1', plannedNote: 'call the mill', plannedDate: '2026-11-01', plannedSkipped: false,
            rowVersion: (await row('bal-103-s1')).row_version, derivedStatus: 'expected', dueDate: '2026-10-22',
        });
        // Its rowVersion is the baseVersion a PUT sends.
        await plan('ship.bal-103-s1', { note: 'called', baseVersion: res.body.rowVersion }).expect(200);

        expect((await get(itemPath('ship.dep-102')).expect(200)).body).toMatchObject({ goneAt: expect.any(String), derivedStatus: null });
        expect((await get(itemPath('ship.pay-1-bal100')).expect(200)).body).toMatchObject({ derivedStatus: 'paid' });
        for (const key of ['ship.no-such-row', 'item.5', 'ship.BAL-103-S1']) {
            expect((await get(itemPath(key)).expect(404)).body.code).toBeUndefined();
        }
        expect((await get(itemPath('ship.a:b')).expect(422)).body).toMatchObject({ code: 'ITEM_KEY_INVALID', details: { key: 'ship.a:b' } });
    });
});

describe('ship. adjustments (§10.7, §10.8)', () => {
    test('the bases are the effective values, overlay included; `current` carries the ship name and currency', async () => {
        await plan('ship.bal-110-s1', { plannedDate: '2026-10-22' }).expect(200);
        const s = await makeScenario('Ship dates');
        const res = await put(adjPath(s.id, 'ship.bal-110-s1'), { kind: 'adjust', newDate: '2026-11-05' }).expect(201);
        expect(res.body).toMatchObject({
            itemKey: 'ship.bal-110-s1', targetKind: 'ship', targetId: 'bal-110-s1', targetDate: null, kind: 'adjust',
            newDate: '2026-11-05', newAmount: null, baseDate: '2026-10-22', baseAmount: '2000.00', stale: null,
            current: { date: '2026-10-22', amount: '2000.00', status: 'expected', name: SHIP_NAME, currency: 'USD' },
        });
        expect((await h.audit('scenario_adjustment', res.body.id))[0]).toMatchObject({ action: 'create' });
        const [adj] = (await detail(s.id)).adjustments;
        expect(adj).toMatchObject({ stale: null, current: res.body.current });

        const body = await forecast({ scenarioId: s.id });
        expect(lineOf(body, 'ship.bal-110-s1')).toMatchObject({
            date: '2026-11-05', flags: ['planned', 'adjusted'], baseline: expect.objectContaining({ date: '2026-10-22' }),
        });
        // Nothing reached the row: the scenario is a sandbox until apply.
        expect((await row('bal-110-s1')).planned_date).toBe('2026-10-22');
    });

    test('refusals: gone, undated or absent → 404 TARGET_MISSING; paid or skipped → 409 TARGET_SETTLED; nothing written', async () => {
        await plan('ship.bal-105-s1', { skipped: true }).expect(200);
        const s = await makeScenario('Refused');
        const before = await snapshot();
        for (const key of ['ship.dep-102', 'ship.pi-104-s1', 'ship.no-such-row']) {
            const res = await put(adjPath(s.id, key), { kind: 'exclude' }).expect(404);
            expect(res.body).toMatchObject({ code: 'TARGET_MISSING', details: { key } });
        }
        for (const [key, status] of [['ship.pay-1-bal100', 'paid'], ['ship.bal-105-s1', 'skipped']]) {
            const res = await put(adjPath(s.id, key), { kind: 'adjust', newDate: '2026-11-01' }).expect(409);
            expect(res.body).toMatchObject({ code: 'TARGET_SETTLED', details: { key, status } });
        }
        expect(await snapshot()).toEqual(before);
    });
});

describe('ship. apply (§10.9)', () => {
    test('apply writes a stamped planned_date (wrote external_item); a refresh that moves the feed date leaves it', async () => {
        const s = await makeScenario('Move a balance');
        await put(adjPath(s.id, 'ship.bal-111-s1'), { kind: 'adjust', newDate: '2026-11-02' }).expect(201);
        const before = await row('bal-111-s1');

        const res = await post(`/scenarios/${s.id}/apply`).expect(200);
        expect(res.body.scenario).toMatchObject({ id: s.id, status: 'applied' });
        expect(res.body.applied).toEqual([{ itemKey: 'ship.bal-111-s1', kind: 'adjust', wrote: 'external_item', entityId: before.id }]);

        const after = await row('bal-111-s1');
        expect(pick(after, OVERLAY)).toEqual({
            planned_date: '2026-11-02', planned_amount: null, planned_skipped: 0, planned_base_amount: null,
            planned_note: null, source_scenario_id: s.id, planned_by: USER, planned_at: expect.any(Date),
        });
        expect(after.row_version).toBe(before.row_version + 1);
        expect(pick(after, FEED_KEEP)).toEqual(pick(before, FEED_KEEP));
        const [audit] = await auditOf('bal-111-s1');
        expect(audit).toMatchObject({
            action: 'apply', userEmail: USER,
            before: { plannedDate: null, sourceScenarioId: null, plannedBy: null, plannedAt: null },
            after: { key: 'ship.bal-111-s1', plannedDate: '2026-11-02', sourceScenarioId: s.id, plannedBy: USER },
        });
        expect((await h.audit('scenario', s.id))[0]).toMatchObject({ action: 'apply' });
        expect(lineOf(await forecast(), 'ship.bal-111-s1')).toMatchObject({ date: '2026-11-02', flags: ['planned', 'fromScenario'] });

        // The ETA drifts in shipping: the feed moves, the applied plan stays.
        setFeed('bal-111-s1', { dueDate: '2026-10-25' });
        await refresh();
        const drifted = await row('bal-111-s1');
        expect(drifted.due_date).toBe('2026-10-25');
        expect(pick(drifted, OVERLAY)).toEqual(pick(after, OVERLAY));
        expect(lineOf(await forecast(), 'ship.bal-111-s1')).toMatchObject({ date: '2026-11-02' });
        expect(await listed('bal-111-s1')).toMatchObject({
            dueDate: '2026-10-25', plannedDate: '2026-11-02', effectiveDate: '2026-11-02', sourceScenarioId: s.id,
        });

        const again = await post(`/scenarios/${s.id}/apply`).expect(409);
        expect(again.body).toMatchObject({ code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
    });

    test('new_amount sets planned_amount with its base (P6) and keeps a planned date; exclude sets planned_skipped (P7); the feed amount moves → SHIP_PLAN_STALE', async () => {
        await plan('ship.bal-112-s1', { plannedDate: '2026-10-23' }).expect(200);
        const s = await makeScenario('Amounts');
        const adj = await put(adjPath(s.id, 'ship.bal-112-s1'), { kind: 'adjust', newAmount: '2500.00' }).expect(201);
        expect(adj.body).toMatchObject({ baseDate: '2026-10-23', baseAmount: '3000.00' });
        await put(adjPath(s.id, 'ship.bal-116-s1'), { kind: 'exclude' }).expect(201);
        const ids = { b112: (await row('bal-112-s1')).id, b116: (await row('bal-116-s1')).id };
        const audits = await auditCount();

        const res = await post(`/scenarios/${s.id}/apply`).expect(200);
        expect(res.body.applied).toEqual([
            { itemKey: 'ship.bal-112-s1', kind: 'adjust', wrote: 'external_item', entityId: ids.b112 },
            { itemKey: 'ship.bal-116-s1', kind: 'exclude', wrote: 'external_item', entityId: ids.b116 },
        ]);
        expect(await auditCount()).toBe(audits + 3);                 // two external_item/apply + scenario/apply
        expect(pick(await row('bal-112-s1'), ['planned_date', 'planned_amount', 'planned_base_amount', 'planned_skipped', 'source_scenario_id']))
            .toEqual({ planned_date: '2026-10-23', planned_amount: '2500.00', planned_base_amount: '3000.00', planned_skipped: 0, source_scenario_id: s.id });
        expect(pick(await row('bal-116-s1'), ['planned_date', 'planned_amount', 'planned_skipped', 'source_scenario_id', 'planned_by']))
            .toEqual({ planned_date: null, planned_amount: null, planned_skipped: 1, source_scenario_id: s.id, planned_by: USER });
        expect((await auditOf('bal-116-s1'))[0]).toMatchObject({
            action: 'apply', before: { plannedSkipped: false }, after: { key: 'ship.bal-116-s1', plannedSkipped: true },
        });

        let body = await forecast();
        expect(lineOf(body, 'ship.bal-112-s1')).toMatchObject({ date: '2026-10-23', amountMinor: 250000 });
        expect(lineOf(body, 'ship.bal-116-s1')).toBeUndefined();
        expect(await listed('bal-116-s1')).toMatchObject({ plannedSkipped: true, derivedStatus: 'skipped' });

        setFeed('bal-112-s1', { amount: '3100.00' });
        await refresh();
        expect((await row('bal-112-s1')).planned_amount).toBe('2500.00');
        body = await forecast();
        expect(body.warnings).toContainEqual({ code: 'SHIP_PLAN_STALE', key: 'ship.bal-112-s1' });
        expect(lineOf(body, 'ship.bal-112-s1')).toMatchObject({ date: '2026-10-23', amountMinor: 310000 });
    });

    test('the re-check: gone → TARGET_MISSING, paid or skipped → TARGET_SETTLED; SCENARIO_STALE writes nothing; dropStale removes them', async () => {
        const s = await makeScenario('Stale ships');
        for (const key of ['ship.bal-114-s1', 'ship.bal-115-s1', 'ship.bal-117-s1']) {
            await put(adjPath(s.id, key), { kind: 'adjust', newDate: '2026-11-10' }).expect(201);
        }
        feed.delete('bal-114-s1');
        setFeed('bal-115-s1', { status: 'paid', paidOn: TODAY, dueDate: null });
        await refresh();
        await plan('ship.bal-117-s1', { skipped: true }).expect(200);

        const before = await snapshot();
        const res = await post(`/scenarios/${s.id}/apply`).expect(409);
        expect(res.body).toMatchObject({
            code: 'SCENARIO_STALE',
            details: {
                stale: [
                    { itemKey: 'ship.bal-114-s1', reason: 'TARGET_MISSING' },
                    { itemKey: 'ship.bal-115-s1', reason: 'TARGET_SETTLED' },
                    { itemKey: 'ship.bal-117-s1', reason: 'TARGET_SETTLED' },
                ],
            },
        });
        expect(await snapshot()).toEqual(before);

        const rebased = (await post(`/scenarios/${s.id}/rebase`, { dropStale: true }).expect(200)).body;
        expect(rebased.adjustments.map((a) => [a.itemKey, a.stale, a.dropped])).toEqual([
            ['ship.bal-114-s1', 'TARGET_MISSING', true],
            ['ship.bal-115-s1', 'TARGET_SETTLED', true],
            ['ship.bal-117-s1', 'TARGET_SETTLED', true],
        ]);
        expect((await detail(s.id)).adjustments).toEqual([]);
    });

    test('drift: the feed date moves → BASE_CHANGED on read and apply → rebase → apply', async () => {
        const s = await makeScenario('Drift');
        await put(adjPath(s.id, 'ship.bal-113-s1'), { kind: 'adjust', newDate: '2026-11-12' }).expect(201);
        setFeed('bal-113-s1', { dueDate: '2026-10-26', dateBasis: 'estimated', flags: ['estimated'] });
        await refresh();

        const [adj] = (await detail(s.id)).adjustments;
        expect(adj).toMatchObject({ baseDate: '2026-10-24', stale: 'BASE_CHANGED', current: { date: '2026-10-26', name: SHIP_NAME } });
        expect((await forecast({ scenarioId: s.id })).scenario.warnings)
            .toContainEqual({ code: 'STALE', key: 'ship.bal-113-s1', reason: 'BASE_CHANGED' });

        const before = await snapshot();
        const stale = await post(`/scenarios/${s.id}/apply`).expect(409);
        expect(stale.body.details.stale).toEqual([{ itemKey: 'ship.bal-113-s1', reason: 'BASE_CHANGED' }]);
        expect(await snapshot()).toEqual(before);

        const rebased = (await post(`/scenarios/${s.id}/rebase`, {}).expect(200)).body;
        expect(rebased.adjustments).toEqual([expect.objectContaining({
            itemKey: 'ship.bal-113-s1', baseDate: '2026-10-26', baseAmount: '3300.00', rebased: true, stale: null, dropped: false,
        })]);
        expect((await h.audit('scenario_adjustment', adj.id))[0]).toMatchObject({
            action: 'update', before: { baseDate: '2026-10-24' }, after: { baseDate: '2026-10-26' },
        });

        await post(`/scenarios/${s.id}/apply`).expect(200);
        expect(await row('bal-113-s1')).toMatchObject({ due_date: '2026-10-26', planned_date: '2026-11-12', source_scenario_id: s.id });
    });
});

describe('two connections (§10.1, §10.9 step 2, §10.12)', () => {
    let n = 0;
    const makeItem = async () => (await post('/items', {
        accountId: gbp.id, categoryId: costs.id, name: `Item ${++n}`, amount: '250.00', dueDate: '2026-10-20',
    }).expect(201)).body;
    /** A schedule with a tuned instance on 2026-11-01: an override row the test can hold. */
    async function tunedSchedule() {
        const sched = (await post('/schedules', {
            accountId: gbp.id, categoryId: costs.id, name: `Rent ${++n}`, amount: '1000.00', frequency: 'monthly',
            startDate: '2026-10-01',
        }).expect(201)).body;
        await put(`/schedules/${sched.id}/instances/2026-11-01`, { amount: '1010.00' }).expect(200);
        const [override] = await h.sql('SELECT id FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ?', [sched.id, '2026-11-01']);
        return { sched, key: `sched.${sched.id}.2026-11-01`, overrideId: override.id };
    }

    test('external_items is locked after cash_items: while apply waits on an item, a refresh moves the ship row, and the re-check sees it', async () => {
        const item = await makeItem();
        const s = await makeScenario('Item first');
        await put(adjPath(s.id, item.key), { kind: 'adjust', newDate: '2026-10-30' }).expect(201);
        await put(adjPath(s.id, 'ship.bal-122-s1'), { kind: 'adjust', newDate: '2026-11-03' }).expect(201);
        setFeed('bal-122-s1', { dueDate: '2026-10-21' });
        await serveFeed();

        await h.sql('START TRANSACTION');
        let apply;
        try {
            await h.sql('SELECT id FROM cash_items WHERE id = ? FOR UPDATE', [item.id]);
            apply = track(post(`/scenarios/${s.id}/apply`));
            await pause(1500);
            expect(apply.settled).toBe(false);
            expect(await shipRowLocked('bal-122-s1')).toBe(false);          // not yet: cash_items comes first

            const started = Date.now();
            const counts = (await runRefresh()).counts;
            expect(counts).toMatchObject({ updated: 1, deferred: 0 });
            expect(Date.now() - started).toBeLessThan(4000);                  // it never waited on the apply
            expect(apply.settled).toBe(false);
            await h.sql('COMMIT');
        } catch (err) {
            await h.sql('ROLLBACK');
            throw err;
        }
        const res = await apply.promise;
        expect(res.status).toBe(409);
        expect(res.body.details.stale).toEqual([{ itemKey: 'ship.bal-122-s1', reason: 'BASE_CHANGED' }]);
        expect(pick(await row('bal-122-s1'), ['due_date', 'planned_date', 'source_scenario_id']))
            .toEqual({ due_date: '2026-10-21', planned_date: null, source_scenario_id: null });
    });

    test('a refresh UPDATE during an apply waits for it, then writes the feed columns only (external_items before schedule_overrides)', async () => {
        const t = await tunedSchedule();
        const s = await makeScenario('Wait for apply');
        await put(adjPath(s.id, t.key), { kind: 'adjust', newAmount: '1020.00' }).expect(201);
        await put(adjPath(s.id, 'ship.bal-120-s1'), { kind: 'adjust', newDate: '2026-11-15' }).expect(201);
        const before = await row('bal-120-s1');
        setFeed('bal-120-s1', { dueDate: '2026-10-28' });
        await serveFeed();

        await h.sql('START TRANSACTION');
        let apply;
        let run;
        try {
            await h.sql('SELECT id FROM schedule_overrides WHERE id = ? FOR UPDATE', [t.overrideId]);
            apply = track(post(`/scenarios/${s.id}/apply`));
            await untilShipRowLocked('bal-120-s1');                           // apply holds the ship row, waits on the override
            run = track(runRefresh());
            await pause(1500);
            expect(apply.settled).toBe(false);
            expect(run.settled).toBe(false);                                  // the refresh waits on the apply
            await h.sql('COMMIT');
        } catch (err) {
            await h.sql('ROLLBACK');
            throw err;
        }
        const res = await apply.promise;
        expect(res.status).toBe(200);
        expect(res.body.applied.map((a) => [a.itemKey, a.wrote])).toEqual([
            [t.key, 'schedule_override'], ['ship.bal-120-s1', 'external_item'],
        ]);
        expect((await run.promise).counts).toMatchObject({ updated: 1, deferred: 0 });

        const after = await row('bal-120-s1');
        expect(after).toMatchObject({
            due_date: '2026-10-28', planned_date: '2026-11-15', planned_amount: null, planned_skipped: 0,
            source_scenario_id: s.id, planned_by: USER, row_version: before.row_version + 2,
        });
        expect(lineOf(await forecast(), 'ship.bal-120-s1')).toMatchObject({ date: '2026-11-15' });
    });

    test('a refresh that cannot lock the row within 5 s skips it; the apply lands; the next run brings the feed change, planned_* untouched', async () => {
        const t = await tunedSchedule();
        const s = await makeScenario('Outlast the refresh');
        await put(adjPath(s.id, t.key), { kind: 'exclude' }).expect(201);
        await put(adjPath(s.id, 'ship.bal-121-s1'), { kind: 'adjust', newDate: '2026-11-16' }).expect(201);
        setFeed('bal-121-s1', { dueDate: '2026-10-29' });
        await serveFeed();

        await h.sql('START TRANSACTION');
        let apply;
        try {
            await h.sql('SELECT id FROM schedule_overrides WHERE id = ? FOR UPDATE', [t.overrideId]);
            apply = track(post(`/scenarios/${s.id}/apply`));
            await untilShipRowLocked('bal-121-s1');
            const started = Date.now();
            const result = await runRefresh();                                // gives up on the row after 5 s
            expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
            expect(result.counts).toMatchObject({ updated: 0, deferred: 1 });
            expect(apply.settled).toBe(false);
            await h.sql('COMMIT');
        } catch (err) {
            await h.sql('ROLLBACK');
            throw err;
        }
        expect((await apply.promise).status).toBe(200);
        const applied = await row('bal-121-s1');
        expect(applied).toMatchObject({ due_date: '2026-10-17', planned_date: '2026-11-16', source_scenario_id: s.id });

        await serveFeed();
        expect((await runRefresh()).counts).toMatchObject({ updated: 1, deferred: 0 });
        const next = await row('bal-121-s1');
        expect(next.due_date).toBe('2026-10-29');
        expect(pick(next, OVERLAY)).toEqual(pick(applied, OVERLAY));
    });

    test('apply re-checks what committed while it waited on the ship row (a plan written meanwhile → BASE_CHANGED)', async () => {
        const s = await makeScenario('Planned meanwhile');
        await put(adjPath(s.id, 'ship.bal-123-s1'), { kind: 'adjust', newDate: '2026-11-18' }).expect(201);

        await h.sql('START TRANSACTION');
        let apply;
        try {
            // A hand edit in flight: the row is locked and changed, not yet committed.
            await h.sql(
                "UPDATE external_items SET planned_date = '2026-11-04', planned_by = 'e2e', row_version = row_version + 1 WHERE ext_id = 'bal-123-s1'"
            );
            apply = track(post(`/scenarios/${s.id}/apply`));
            await pause(1500);
            expect(apply.settled).toBe(false);
            await h.sql('COMMIT');
        } catch (err) {
            await h.sql('ROLLBACK');
            throw err;
        }
        const res = await apply.promise;
        expect(res.status).toBe(409);
        expect(res.body.details.stale).toEqual([{ itemKey: 'ship.bal-123-s1', reason: 'BASE_CHANGED' }]);
        expect(await row('bal-123-s1')).toMatchObject({ planned_date: '2026-11-04', source_scenario_id: null });
    });

    test('an adjustment write locks the ship row and takes its base from what committed while it waited', async () => {
        const s = await makeScenario('Write waits');
        await h.sql('START TRANSACTION');
        let write;
        try {
            await h.sql(
                "UPDATE external_items SET planned_date = '2026-11-06', planned_by = 'e2e', row_version = row_version + 1 WHERE ext_id = 'bal-124-s1'"
            );
            write = track(put(adjPath(s.id, 'ship.bal-124-s1'), { kind: 'adjust', newDate: '2026-11-20' }));
            await pause(1500);
            expect(write.settled).toBe(false);
            await h.sql('COMMIT');
        } catch (err) {
            await h.sql('ROLLBACK');
            throw err;
        }
        const res = await write.promise;
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ baseDate: '2026-11-06', baseAmount: '1240.00', stale: null });
    });
});

describe('lastSuccessAt is ISO 8601 UTC everywhere it appears', () => {
    const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    test('/external/status, /forecast shipping, the 503 details and the SHIPPING_UNAVAILABLE warning', async () => {
        const status = (await get('/external/status').expect(200)).body;
        expect(status.lastSuccessAt).toMatch(ISO_UTC);
        expect(status.lastAttemptAt).toMatch(ISO_UTC);
        const lastSuccessAt = status.lastSuccessAt;
        expect((await forecast()).shipping.lastSuccessAt).toBe(lastSuccessAt);

        try {
            await releaseClaim();
            stub.reset();
            stub.fail('source_error');
            const failed = await post('/external/refresh').expect(503);
            expect(failed.body.details).toEqual({ reason: 'source_error', lastSuccessAt });

            // Due by the TTL, and the fetch fails: /forecast answers on the snapshot, and says why.
            await h.sql("UPDATE external_sync SET last_success_at = last_success_at - INTERVAL 11 MINUTE, last_attempt_at = NULL WHERE source = 'ship'");
            const aged = (await get('/external/status').expect(200)).body.lastSuccessAt;
            expect(aged).toMatch(ISO_UTC);
            const body = await forecast();
            expect(body.warnings).toContainEqual({ code: 'SHIPPING_UNAVAILABLE', reason: 'source_error', lastSuccessAt: aged });
            expect(body.shipping.lastSuccessAt).toBe(aged);
        } finally {
            await refresh();
        }
        expect((await get('/external/status').expect(200)).body.lastSuccessAt).toMatch(ISO_UTC);
    });
});
