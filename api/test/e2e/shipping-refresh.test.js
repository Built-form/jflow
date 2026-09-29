'use strict';

// The shipping snapshot (CONTRACT §3.5, §6.12, §10.12; docs/PHASE2.md §4.2–4.3; step 19),
// end to end against a per-run jflow_test_<runid> schema, with shipping's data served by
// an in-process stand-in for services/shippingSource.js (test/helpers/shippingSourceStub.js).
// The real source runs against a shadow schema in shipping-source.test.js.
//
// Pinned here:
//   · the migration's tables, seed rows and guarded columns;
//   · POST /external/refresh ({ran, status} | 503 SHIPPING_UNAVAILABLE) and GET /external/status;
//   · the diff: insert, unchanged, change, gone, back — never a delete, no audit (P8);
//   · an overlay survives a refresh that changes every feed column;
//   · the 60-second claim (a second run does not run; two at once → one runs);
//   · a failed read records last_error and nothing else;
//   · paidSince, refreshIfStale's TTL, and a row lock → the row waits for the next run.

const mysql = require('mysql2/promise');
const { startHarness } = require('./harness');
const { stubShippingSource, feedItem, feedBody } = require('../helpers/shippingSourceStub');
const { FEED_COLUMNS } = require('../../src/services/shippingRefresh');

jest.setTimeout(120000);

const TODAY = '2026-09-29';
const OVERLAY_COLUMNS = [
    'planned_date', 'planned_amount', 'planned_skipped', 'planned_base_amount', 'planned_note',
    'source_scenario_id', 'planned_by', 'planned_at',
];
const STATUS_KEYS = [
    'companies', 'configured', 'feedToday', 'itemCount', 'lastAttemptAt', 'lastError', 'lastSuccessAt',
    'rejectedCount', 'source', 'updatedAt',
];

let h;
let stub;
let warnSpy;

beforeAll(async () => {
    h = await startHarness();
    stub = stubShippingSource();
});

afterAll(async () => {
    if (stub) stub.restore();
    if (h) await h.stop();
});

beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warnSpy.mockRestore());

const api = () => h.api();
const service = () => require('../../src/services/shippingRefresh');
const refresh = (today = TODAY) => api().post('/api/v1/external/refresh').query({ today });
const status = () => api().get('/api/v1/external/status');
/** Lift the 60-second claim so the next run is not skipped. */
const releaseClaim = () => h.sql("UPDATE external_sync SET last_attempt_at = NULL WHERE source = 'ship'");
const syncRow = async () => (await h.sql("SELECT * FROM external_sync WHERE source = 'ship'"))[0];
const itemRows = () => h.sql("SELECT * FROM external_items WHERE source = 'ship' ORDER BY ext_id");
const itemRow = async (extId) => (await h.sql("SELECT * FROM external_items WHERE source = 'ship' AND ext_id = ?", [extId]))[0];
const auditCount = async () => Number((await h.sql('SELECT COUNT(*) AS n FROM audit_log'))[0].n);

/** Serve `items`, lift the claim, and run one refresh through the route. Returns the status JSON. */
async function refreshWith(items, opts) {
    await releaseClaim();
    stub.reset();
    stub.respond(feedBody(items, opts));
    const res = await refresh().expect(200);
    expect(res.body.ran).toBe(true);
    return res.body.status;
}

/** The same through the service, for the per-run counts the route does not return. */
async function runWith(items) {
    await releaseClaim();
    stub.reset();
    stub.respond(feedBody(items));
    const result = await service().runRefresh({ today: TODAY });
    expect(result).toMatchObject({ status: 'ok', ran: true });
    return result.counts;
}

// Three rows the feed starts with.
const A = feedItem('bal-812-s311');
const B = feedItem('dep-812', { kind: 'deposit', amount: '5000.00', shipmentId: null, containerRef: null, dueDate: '2026-10-01' });
const B2 = { ...B, amount: '5100.00' };
const C = feedItem('pi-77-s311', { amount: '750.25', dueDate: null, dateBasis: 'undated', flags: ['projected'] });

describe('the migration (CONTRACT §3.5)', () => {
    test('external_sync is seeded with one ship row, and nothing has run', async () => {
        const rows = await h.sql('SELECT * FROM external_sync');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            source: 'ship', last_attempt_at: null, last_success_at: null, feed_today: null, last_error: null,
            item_count: 0, rejected_count: 0, companies_json: null,
        });
        expect(await itemRows()).toEqual([]);
    });

    test('the Stock payments system category is seeded once', async () => {
        const rows = await h.sql("SELECT name, direction, sort_order, system_key, deleted_at FROM categories WHERE system_key = 'ship'");
        expect(rows).toEqual([{ name: 'Stock payments', direction: 'out', sort_order: 900, system_key: 'ship', deleted_at: null }]);
    });

    test('the guarded columns and their keys exist', async () => {
        const cols = await h.sql(
            `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND ((TABLE_NAME = 'companies' AND COLUMN_NAME = 'shipping_company_id')
                  OR (TABLE_NAME = 'categories' AND COLUMN_NAME = 'system_key'))
              ORDER BY TABLE_NAME`
        );
        expect(cols).toEqual([{ t: 'categories', c: 'system_key', n: 'YES' }, { t: 'companies', c: 'shipping_company_id', n: 'YES' }]);
        const keys = await h.sql(
            `SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('idx_shipping_company', 'idx_system_key', 'uniq_source_ext')
              ORDER BY INDEX_NAME`
        );
        expect(keys).toEqual([
            { t: 'companies', i: 'idx_shipping_company' },
            { t: 'categories', i: 'idx_system_key' },
            { t: 'external_items', i: 'uniq_source_ext' },
        ]);
    });
});

describe('GET /external/status and an unusable source schema', () => {
    test('status before any run: the sync row, companies [] and configured', async () => {
        const res = await status().expect(200);
        expect(Object.keys(res.body).sort()).toEqual(STATUS_KEYS);
        expect(res.body).toMatchObject({
            source: 'ship', lastAttemptAt: null, lastSuccessAt: null, feedToday: null, lastError: null,
            itemCount: 0, rejectedCount: 0, companies: [], configured: true,
        });
    });

    test('an invalid SHIPPING_DB_SCHEMA: 503 SHIPPING_UNAVAILABLE source_schema, last_error the only record', async () => {
        const saved = process.env.SHIPPING_DB_SCHEMA;
        process.env.SHIPPING_DB_SCHEMA = 'Not-A-Schema';
        try {
            stub.reset();
            stub.passThrough();          // the real source: it refuses the name before connecting
            const before = await syncRow();
            const res = await refresh().expect(503);
            expect(res.body).toMatchObject({
                code: 'SHIPPING_UNAVAILABLE', details: { reason: 'source_schema', lastSuccessAt: null },
            });
            expect(typeof res.body.error).toBe('string');
            expect(stub.requests).toHaveLength(1);
            const after = await syncRow();
            expect(after.last_error).toMatch(/^source_schema: SHIPPING_DB_SCHEMA is not a valid schema name/);
            for (const c of ['last_success_at', 'feed_today', 'item_count', 'rejected_count', 'companies_json']) {
                expect({ c, v: after[c] }).toEqual({ c, v: before[c] });
            }
            const st = (await status().expect(200)).body;
            expect(st).toMatchObject({ configured: false, lastSuccessAt: null });
            expect(st.lastError).toMatch(/^source_schema: /);
            expect(await itemRows()).toEqual([]);
        } finally {
            process.env.SHIPPING_DB_SCHEMA = saved;
            await releaseClaim();
        }
    });
});

describe('the refresh diff (CONTRACT §10.12)', () => {
    test('insert: new ids become rows; the sync row records the run; no audit row', async () => {
        const audits = await auditCount();
        const st = await refreshWith([A, B, C, feedItem('derived:dep:9')]);
        expect(Object.keys(st).sort()).toEqual(STATUS_KEYS);
        expect(st).toMatchObject({
            source: 'ship', feedToday: TODAY, lastError: null, itemCount: 3, rejectedCount: 1, configured: true,
            companies: [{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }],
        });
        expect(st.lastSuccessAt).toEqual(expect.any(String));
        expect(st.lastAttemptAt).toEqual(expect.any(String));

        // No anchors yet: paidSince = today − 60.
        expect(stub.requests).toHaveLength(1);
        expect(stub.requests[0]).toEqual({ today: TODAY, paidSince: '2026-07-31' });

        const rows = await itemRows();
        expect(rows.map((r) => r.ext_id)).toEqual(['bal-812-s311', 'dep-812', 'pi-77-s311']);
        for (const r of rows) {
            expect(r).toMatchObject({ source: 'ship', row_version: 0, created_by: 'shipping-feed', gone_at: null });
            expect(r.feed_hash).toMatch(/^[0-9a-f]{64}$/);
            for (const c of OVERLAY_COLUMNS) expect({ c, v: r[c] }).toEqual({ c, v: c === 'planned_skipped' ? 0 : null });
        }
        expect(rows[0]).toMatchObject({
            feed_kind: 'balance', feed_status: 'open', supplier: 'Acme Textiles', shipping_company_id: 1, po_id: 812,
            po_number: 'PO-812', shipment_id: 311, container_ref: 'MSKU1234567', currency: 'USD', amount: '12345.67',
            due_date: '2026-10-15', paid_on: null, settles: null, date_basis: 'firm', amount_basis: 'stated',
            blocked: null, flags_json: [],
        });
        expect(rows[2]).toMatchObject({ due_date: null, date_basis: 'undated', flags_json: ['projected'] });
        expect(await auditCount()).toBe(audits);

        const read = (await status().expect(200)).body;
        expect(read).toEqual(st);
    });

    test('inside the 60-second claim: 200 {ran: false, status}, no request, nothing written', async () => {
        stub.reset();
        stub.respond(feedBody([A]));
        const before = await itemRows();
        const res = await refresh().expect(200);
        expect(Object.keys(res.body).sort()).toEqual(['ran', 'status']);
        expect(res.body.ran).toBe(false);
        expect(res.body.status).toMatchObject({ source: 'ship', itemCount: 3, feedToday: TODAY });
        expect(stub.requests).toHaveLength(0);
        expect(await itemRows()).toEqual(before);
    });

    test('an unchanged feed writes nothing', async () => {
        const before = await itemRows();
        expect(await runWith([A, B, C])).toEqual({
            inserted: 0, updated: 0, returned: 0, gone: 0, unchanged: 3, deferred: 0, rejected: 0,
        });
        expect(await itemRows()).toEqual(before);
    });

    test('change: only the changed row is updated, and its row_version bumped', async () => {
        await refreshWith([A, B2, C]);
        const rows = await itemRows();
        expect(rows.map((r) => [r.ext_id, r.row_version, r.amount])).toEqual([
            ['bal-812-s311', 0, '12345.67'], ['dep-812', 1, '5100.00'], ['pi-77-s311', 0, '750.25'],
        ]);
    });

    test('gone: a row missing from the feed is marked, never deleted; it stays gone without a bump', async () => {
        expect(await runWith([A, B2])).toMatchObject({ gone: 1, unchanged: 2, updated: 0 });
        const c = await itemRow('pi-77-s311');
        expect(c.gone_at).toBeInstanceOf(Date);
        expect(c.row_version).toBe(1);
        expect(await itemRows()).toHaveLength(3);

        expect(await runWith([A, B2])).toMatchObject({ gone: 0, unchanged: 2 });
        const still = await itemRow('pi-77-s311');
        expect(still.gone_at).toEqual(c.gone_at);
        expect(still.row_version).toBe(1);
    });

    test('back: a returning row clears gone_at even when its feed columns are unchanged', async () => {
        expect(await runWith([A, B2, C])).toMatchObject({ returned: 1, updated: 0, gone: 0, unchanged: 2 });
        const c = await itemRow('pi-77-s311');
        expect(c.gone_at).toBeNull();
        expect(c.row_version).toBe(2);
        expect(c.amount).toBe('750.25');
    });

    test('an overlay survives a refresh that changes every feed column, and a gone/back cycle', async () => {
        await h.sql(
            `UPDATE external_items SET planned_date = '2026-11-02', planned_amount = '999.00', planned_skipped = 1,
                    planned_base_amount = '12345.67', planned_note = 'held for QC', source_scenario_id = 42,
                    planned_by = 'dev@built-form.co.uk', planned_at = '2026-09-28 10:00:00'
              WHERE source = 'ship' AND ext_id = 'bal-812-s311'`
        );
        const before = await itemRow('bal-812-s311');
        const everything = feedItem('bal-812-s311', {
            kind: 'deposit', status: 'paid', supplier: 'Other Mill', companyId: 2, poId: 900, poNumber: 'PO-900',
            shipmentId: 400, containerRef: 'TGHU0000001', currency: 'CNY', amount: '54321.00', dueDate: '2026-10-01',
            paidOn: '2026-09-25', settles: 'dep-900', dateBasis: 'estimated', amountBasis: 'derived', blocked: 'artwork',
            flags: ['estimated'],
        });
        expect(await runWith([everything, B2, C])).toMatchObject({ updated: 1, unchanged: 2 });

        const after = await itemRow('bal-812-s311');
        for (const c of FEED_COLUMNS) {
            expect({ c, changed: JSON.stringify(after[c]) !== JSON.stringify(before[c]) }).toEqual({ c, changed: true });
        }
        expect(after.feed_hash).not.toBe(before.feed_hash);
        expect(after.row_version).toBe(before.row_version + 1);
        for (const c of OVERLAY_COLUMNS) expect({ c, v: after[c] }).toEqual({ c, v: before[c] });
        expect(after.planned_amount).toBe('999.00');
        expect(after.source_scenario_id).toBe(42);

        // Gone, then back with the original values: the overlay is still untouched.
        await refreshWith([B2, C]);
        expect((await itemRow('bal-812-s311')).gone_at).toBeInstanceOf(Date);
        await refreshWith([A, B2, C]);
        const back = await itemRow('bal-812-s311');
        expect(back.gone_at).toBeNull();
        expect(back.amount).toBe('12345.67');
        for (const c of OVERLAY_COLUMNS) expect({ c, v: back[c] }).toEqual({ c, v: before[c] });
    });
});

describe('failure and the claim', () => {
    test('a failed read records last_error only: 503, the snapshot and every other sync column kept', async () => {
        await releaseClaim();
        const syncBefore = await syncRow();
        const itemsBefore = await itemRows();
        stub.reset();
        stub.fail('source_error');
        const res = await refresh().expect(503);
        expect(res.body).toMatchObject({
            code: 'SHIPPING_UNAVAILABLE',
            details: { reason: 'source_error', lastSuccessAt: syncBefore.last_success_at.toISOString() },
        });
        const syncAfter = await syncRow();
        expect(syncAfter.last_error).toMatch(/^source_error: /);
        expect(syncAfter.last_attempt_at).toBeInstanceOf(Date);
        for (const c of ['last_success_at', 'feed_today', 'item_count', 'rejected_count', 'companies_json']) {
            expect({ c, v: syncAfter[c] }).toEqual({ c, v: syncBefore[c] });
        }
        expect(await itemRows()).toEqual(itemsBefore);

        const st = (await status().expect(200)).body;
        expect(st.lastError).toMatch(/^source_error: /);
        expect(st.lastSuccessAt).toBe(syncBefore.last_success_at.toISOString());
    });

    test.each([
        ['a column the source cannot read', (s) => s.fail('source_schema'), 'source_schema'],
        ['a body with no items array', (s) => s.respondWith(() => ({ meta: {}, companies: [] })), 'bad_response'],
    ])('%s → 503 with reason %s', async (_label, arrange, reason) => {
        await releaseClaim();
        stub.reset();
        arrange(stub);
        const res = await refresh().expect(503);
        expect(res.body.details.reason).toBe(reason);
        expect((await syncRow()).last_error).toMatch(new RegExp(`^${reason}: `));
    });

    test('the next successful run clears last_error', async () => {
        const st = await refreshWith([A, B2, C]);
        expect(st.lastError).toBeNull();
        expect((await syncRow()).last_error).toBeNull();
    });

    test('the claim blocks a concurrent run: two refreshes at once → one runs, one does not', async () => {
        await releaseClaim();
        stub.reset();
        stub.respond(feedBody([A, { ...B, amount: '5200.00' }, C]), { delayMs: 400 });
        const [r1, r2] = await Promise.all([refresh().expect(200), refresh().expect(200)]);
        expect([r1.body.ran, r2.body.ran].sort()).toEqual([false, true]);
        expect(stub.requests).toHaveLength(1);
        expect((await itemRow('dep-812')).amount).toBe('5200.00');
    });
});

describe('paidSince, refreshIfStale, and a locked row', () => {
    const B3 = { ...B, amount: '5200.00' };

    test("paidSince is the earliest of the live active accounts' latest balance dates", async () => {
        const jfa = (await api().get('/api/v1/companies').query({ q: 'JFA' }).expect(200)).body.data[0];
        const account = async (name, currency) => (await api().post('/api/v1/accounts')
            .send({ companyId: jfa.id, name, currency }).expect(201)).body;
        const balance = (acc, date) => api().put(`/api/v1/accounts/${acc.id}/balances/${date}`)
            .query({ today: TODAY }).send({ balance: '100.00' }).expect(200);

        const gbp = await account('Main GBP', 'GBP');
        const usd = await account('Main USD', 'USD');
        const idle = await account('Old EUR', 'EUR');
        const closed = await account('Closed', 'GBP');
        await balance(gbp, '2026-09-01');
        await balance(gbp, '2026-09-20');   // latest for GBP
        await balance(usd, '2026-09-25');   // latest for USD
        await balance(idle, '2026-08-01');  // inactive: ignored
        await balance(closed, '2026-07-01'); // deleted: ignored
        await h.sql('UPDATE bank_accounts SET is_active = 0 WHERE id = ?', [idle.id]);
        await h.sql('UPDATE bank_accounts SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [closed.id]);

        await refreshWith([A, B3, C]);
        expect(stub.requests[0]).toEqual({ today: TODAY, paidSince: '2026-09-20' });
    });

    test('refreshIfStale: fresh for the same today inside 10 minutes; due when today moves or the TTL passes', async () => {
        const { refreshIfStale } = service();
        await releaseClaim();
        stub.reset();
        stub.respond(feedBody([A, B3, C]));

        const fresh = await refreshIfStale({ today: TODAY });
        expect(fresh).toMatchObject({ status: 'fresh', ran: false });
        expect(fresh.sync.feed_today).toBe(TODAY);
        expect(stub.requests).toHaveLength(0);

        const moved = await refreshIfStale({ today: '2026-09-30' });
        expect(moved).toMatchObject({ status: 'ok', ran: true });
        expect(stub.requests.map((r) => r.today)).toEqual(['2026-09-30']);
        expect((await syncRow()).feed_today).toBe('2026-09-30');

        await releaseClaim();
        await h.sql("UPDATE external_sync SET last_success_at = UTC_TIMESTAMP() - INTERVAL 9 MINUTE WHERE source = 'ship'");
        expect((await refreshIfStale({ today: '2026-09-30' })).status).toBe('fresh');
        await h.sql("UPDATE external_sync SET last_success_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE WHERE source = 'ship'");
        expect((await refreshIfStale({ today: '2026-09-30' })).status).toBe('ok');
        expect(stub.requests).toHaveLength(2);

        // Due, but inside the 60-second claim: the run is skipped rather than fetched twice.
        await h.sql("UPDATE external_sync SET last_success_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE WHERE source = 'ship'");
        expect(await refreshIfStale({ today: '2026-09-30' })).toMatchObject({ status: 'skipped', ran: false });
        expect(stub.requests).toHaveLength(2);

        // A failed run reports its reason and the snapshot's age for /forecast's warning (step 20).
        await releaseClaim();
        stub.reset();
        stub.fail('source_error');
        const failed = await refreshIfStale({ today: '2026-09-30' });
        expect(failed).toMatchObject({ status: 'failed', ran: true, reason: 'source_error' });
        expect(failed.sync.last_success_at).toBeInstanceOf(Date);
    });

    test('a row another transaction holds is left for the next run after the 5s lock wait; the rest land', async () => {
        const target = await itemRow('dep-812');
        const other = await mysql.createConnection({
            host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
            password: process.env.DB_PASSWORD, database: h.schema, ssl: { rejectUnauthorized: false },
        });
        const feed = [A, { ...B, amount: '5300.00' }, C, feedItem('bal-900-n', { amount: '1.00' })];
        try {
            await other.query('START TRANSACTION');
            await other.query('SELECT id FROM external_items WHERE id = ? FOR UPDATE', [target.id]);

            const started = Date.now();
            const counts = await runWith(feed);
            const waited = Date.now() - started;
            expect(counts).toMatchObject({ inserted: 1, updated: 0, deferred: 1 });
            expect(waited).toBeGreaterThanOrEqual(4500);
            expect(waited).toBeLessThan(30000);
            expect((await itemRow('bal-900-n')).amount).toBe('1.00');
            expect((await itemRow('dep-812')).amount).toBe('5200.00');
            expect((await syncRow()).last_error).toBeNull();
        } finally {
            await other.query('ROLLBACK');
            await other.end();
        }

        expect(await runWith(feed)).toMatchObject({ updated: 1, deferred: 0 });
        expect((await itemRow('dep-812')).amount).toBe('5300.00');
    });
});
