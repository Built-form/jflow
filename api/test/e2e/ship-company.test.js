'use strict';

// A company chosen in JFlow for a stock payment shipping gives none (Dev, 2026-10-15;
// CONTRACT §3.4, §6.12, §10.11a), end to end against a per-run jflow_test_<runid> schema and
// an in-process stand-in for the shipping source (test/helpers/shippingSourceStub.js).
//
// Pinned here:
//   · PUT /external-items/:key/company — sets and clears assigned_company_id with its stamps,
//     audited `assign_company`, feed columns untouched; the row then resolves to the chosen
//     company and its account, leaves SHIP_UNMAPPED and is placed on the forecast;
//   · shipping's company wins: once the feed gives the row a company, the choice is ignored
//     (kept, and clearable), and setting one is 409 SHIP_COMPANY_IN_SHIPPING;
//   · a refresh never touches the choice;
//   · GET /external-items?noCompany=1 lists exactly the rows still needing one;
//   · refusals writing nothing.

const { startHarness } = require('./harness');
const { stubShippingSource, feedItem, feedBody } = require('../helpers/shippingSourceStub');

jest.setTimeout(240000);

const TODAY = '2026-09-29';
const A = '2026-09-20';
const USER = 'local@dev';

let h;
let stub;

beforeAll(async () => {
    h = await startHarness();
    stub = stubShippingSource();
});

afterAll(async () => {
    if (stub) stub.restore();
    if (h) await h.stop();
});

let warnSpy;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { if (warnSpy) warnSpy.mockRestore(); });

const api = () => h.api();
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });
const put = (path, body = {}) => api().put(`/api/v1${path}`).query({ today: TODAY }).send(body);
const post = (path, body = {}) => api().post(`/api/v1${path}`).query({ today: TODAY }).send(body);
const choose = (key, body) => put(`/external-items/${key}/company`, body);

const feed = new Map();
const setFeed = (id, over = {}) => feed.set(id, feedItem(id, { ...(feed.get(id) || {}), ...over }));
async function refresh() {
    await h.sql("UPDATE external_sync SET last_attempt_at = NULL WHERE source = 'ship'");
    stub.reset();
    stub.respond(feedBody([...feed.values()]));
    const res = await post('/external/refresh');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
}

const row = async (extId) => (await h.sql("SELECT * FROM external_items WHERE source = 'ship' AND ext_id = ?", [extId]))[0];
const FEED_KEEP = ['feed_hash', 'feed_status', 'due_date', 'amount', 'paid_on', 'gone_at', 'shipping_company_id'];
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));
const auditCount = async () => Number((await h.sql('SELECT COUNT(*) AS n FROM audit_log'))[0].n);
const forecast = async (query = {}) => (await get('/forecast', { companyId: 'all', ...query }).expect(200)).body;
const unmappedOf = (body) => body.warnings.filter((w) => w.code === 'SHIP_UNMAPPED');
const lineOf = (body, key) => body.rows.flatMap((r) => r.items).find((l) => l.key === key);

let jfa;
let hw;
let jfaUsd;

beforeAll(async () => {
    jfa = (await api().post('/api/v1/companies').send({ code: 'SCA', name: 'Ship company A' }).expect(201)).body;
    hw = (await api().post('/api/v1/companies').send({ code: 'SCB', name: 'Ship company B' }).expect(201)).body;
    await api().put(`/api/v1/companies/${jfa.id}`).send({ shippingCompanyId: 1 }).expect(200);
    jfaUsd = (await api().post('/api/v1/accounts').send({ companyId: jfa.id, name: 'A dollars', currency: 'USD', isDefault: true }).expect(201)).body;
    await put(`/accounts/${jfaUsd.id}/balances/${A}`, { balance: '100000.00' }).expect(200);
    await api().post('/api/v1/fx-rates').send({ currency: 'USD', rateToGbp: '0.786543', effectiveFrom: '2026-09-01' }).expect(201);

    setFeed('bal-900-s1', { companyId: null, poId: 900, poNumber: 'PO-900', dueDate: '2026-10-15', amount: '1000.00' });
    setFeed('bal-901-s1', { companyId: null, poId: 901, poNumber: 'PO-901', dueDate: '2026-10-16', amount: '2000.00' });
    setFeed('bal-902-s1', { companyId: 1, poId: 902, poNumber: 'PO-902', dueDate: '2026-10-17', amount: '3000.00' });
    await refresh();
});

describe('PUT /external-items/:key/company (§10.11a)', () => {
    test('before any choice: both rows with no company are SHIP_UNMAPPED and listed by noCompany=1', async () => {
        expect(unmappedOf(await forecast())).toEqual([{ code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 2, reason: 'company' }]);
        const listed = (await get('/external-items', { noCompany: '1' }).expect(200)).body.data.map((r) => r.extId);
        expect(listed).toEqual(['bal-900-s1', 'bal-901-s1']);
    });

    test('sets the company: stamped, audited, feed untouched; the row lands on the company\'s account and leaves SHIP_UNMAPPED', async () => {
        const before = await row('bal-900-s1');
        const res = await choose('ship.bal-900-s1', { companyId: jfa.id, baseVersion: before.row_version }).expect(200);
        expect(res.body).toMatchObject({
            key: 'ship.bal-900-s1', shippingCompanyId: null, assignedCompanyId: jfa.id, companySetBy: USER,
            companyId: jfa.id, accountId: jfaUsd.id, derivedStatus: 'expected', rowVersion: before.row_version + 1,
        });
        const after = await row('bal-900-s1');
        expect(pick(after, FEED_KEEP)).toEqual(pick(before, FEED_KEEP));
        const [audit] = await h.audit('external_item', after.id);
        expect(audit).toMatchObject({ action: 'assign_company', user_email: USER });
        expect(JSON.parse(audit.after_json)).toEqual({ key: 'ship.bal-900-s1', assignedCompanyId: jfa.id });

        const body = await forecast();
        expect(unmappedOf(body)).toEqual([{ code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' }]);
        expect(lineOf(body, 'ship.bal-900-s1')).toMatchObject({ accountId: jfaUsd.id });
        expect((await get('/external-items', { noCompany: '1' }).expect(200)).body.data.map((r) => r.extId)).toEqual(['bal-901-s1']);
    });

    test("a company with no account to land on: SHIP_UNMAPPED 'account' under shippingCompanyId null", async () => {
        await choose('ship.bal-901-s1', { companyId: hw.id }).expect(200);
        expect(unmappedOf(await forecast())).toEqual([
            { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'account', companyId: hw.id, currencies: ['USD'] },
        ]);
        const cleared = await choose('ship.bal-901-s1', { companyId: null }).expect(200);
        expect(cleared.body).toMatchObject({ assignedCompanyId: null, companySetBy: null, companySetAt: null, companyId: null });
    });

    test('a refresh keeps the choice; once shipping gives a company, shipping\'s wins and setting one is refused', async () => {
        await refresh();
        expect(Number((await row('bal-900-s1')).assigned_company_id)).toBe(jfa.id);

        setFeed('bal-900-s1', { companyId: 7 });         // shipping now names a company JFlow does not map
        await refresh();
        const listedRow = (await get('/external-items/ship.bal-900-s1').expect(200)).body;
        expect(listedRow).toMatchObject({ shippingCompanyId: 7, assignedCompanyId: jfa.id, companyId: null, accountId: null });

        const n = await auditCount();
        const res = await choose('ship.bal-900-s1', { companyId: jfa.id }).expect(409);
        expect(res.body).toMatchObject({ code: 'SHIP_COMPANY_IN_SHIPPING', details: { key: 'ship.bal-900-s1', shippingCompanyId: 7 } });
        expect(await auditCount()).toBe(n);
        await choose('ship.bal-900-s1', { companyId: null }).expect(200);         // clearing is always allowed
    });

    test('refusals, each writing nothing', async () => {
        const n = await auditCount();
        await choose('ship.bal-901-s1', {}).expect(400);
        await choose('ship.bal-901-s1', { companyId: 'x' }).expect(400);
        await choose('ship.bal-901-s1', { companyId: true }).expect(400);
        await choose('ship.bal-901-s1', { companyId: 999999 }).expect(400);
        await choose('ship.bal-999-s1', { companyId: jfa.id }).expect(404);
        expect((await choose('ship.bal-901-s1', { companyId: jfa.id, baseVersion: 0 }).expect(409)).body.code).toBe('STALE_WRITE');
        expect(await auditCount()).toBe(n);
    });
});
