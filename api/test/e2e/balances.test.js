'use strict';

// Bank balances (CONTRACT §6.6, §10.2), end to end against a per-run
// jflow_test_<runid> schema: PUT create-or-replace, BALANCE_DATE_IN_FUTURE
// (real today and a pinned `?today=`), validation, list params, bulk
// all-or-nothing with per-entry details, hard delete with the before-snapshot,
// and one audit row per mutated row.

const { startHarness } = require('./harness');
const { addDays, londonToday } = require('../../src/lib/dates');

jest.setTimeout(120000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';   // pinned through ?today= (local/test only, D24)
const put = (accountId, date, body, today = TODAY) =>
    api().put(`/api/v1/accounts/${accountId}/balances/${date}`).query(today ? { today } : {}).send(body);
const bulk = (body, today = TODAY) => api().post('/api/v1/balances/bulk').query({ today }).send(body);

const ROW_KEYS = ['accountId', 'balance', 'balanceDate', 'createdAt', 'enteredBy', 'id', 'note', 'rowVersion', 'updatedAt'];

describe('balances', () => {
    let jfa;
    let hw;
    let gbp;      // JFA, GBP
    let eur;      // JFA, EUR
    let hwGbp;    // HW, GBP
    let dormant;  // JFA, inactive
    let first;

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        jfa = companies.find((c) => c.code === 'JFA');
        hw = companies.find((c) => c.code === 'HW');
        const make = async (body) => (await api().post('/api/v1/accounts').send(body).expect(201)).body;
        gbp = await make({ companyId: jfa.id, name: 'JFA GBP', currency: 'GBP' });
        eur = await make({ companyId: jfa.id, name: 'JFA EUR', currency: 'EUR' });
        hwGbp = await make({ companyId: hw.id, name: 'HW GBP', currency: 'GBP' });
        dormant = await make({ companyId: jfa.id, name: 'Dormant', currency: 'GBP', isActive: false });
    });

    test('PUT validates the path and the body', async () => {
        await put(gbp.id, '2026-02-30', { balance: '1.00' }).expect(400);
        await put(gbp.id, '20260301', { balance: '1.00' }).expect(400);
        for (const balance of [1000, '1.234', '', ' 1.00', '1,000.00', '1e3', null, undefined]) {
            const res = await put(gbp.id, '2026-03-01', { balance }).expect(400);
            expect(res.body.error).toMatch(/balance/);
        }
        await put(gbp.id, '2026-03-01', { balance: '1.00', note: 'x'.repeat(501) }).expect(400);
        await put(gbp.id, '2026-03-01', { balance: '1.00', note: 5 }).expect(400);
        await put(gbp.id, '2026-03-01', { balance: '1.00', baseVersion: -1 }).expect(400);
        await put('abc', '2026-03-01', { balance: '1.00' }).expect(404);
        await put(999999, '2026-03-01', { balance: '1.00' }).expect(404);
        await put(gbp.id, '2026-03-01', { balance: '1.00' }, 'not-a-date').expect(400);
        expect((await api().get('/api/v1/balances').expect(200)).body.total).toBe(0);
    });

    test('a date after today is 422 BALANCE_DATE_IN_FUTURE — pinned today and the real one', async () => {
        const pinned = await put(gbp.id, '2026-03-11', { balance: '1.00' }).expect(422);
        expect(pinned.body).toMatchObject({
            code: 'BALANCE_DATE_IN_FUTURE', details: { balanceDate: '2026-03-11', today: TODAY },
        });
        const today = londonToday();
        const tomorrow = addDays(today, 1);
        const real = await put(gbp.id, tomorrow, { balance: '1.00' }, null).expect(422);
        expect(real.body).toMatchObject({ code: 'BALANCE_DATE_IN_FUTURE', details: { balanceDate: tomorrow, today } });
        // Today itself is fine.
        await put(gbp.id, today, { balance: '1.00' }, null).expect(200);
        await api().delete(`/api/v1/accounts/${gbp.id}/balances/${today}`).expect(204);
    });

    test('PUT creates, then replaces the same row; audit create then update', async () => {
        const created = await put(gbp.id, '2026-03-01', { balance: '1024', note: ' opening ' }).expect(200);
        first = created.body;
        expect(Object.keys(first).sort()).toEqual(ROW_KEYS);
        expect(first).toMatchObject({
            accountId: gbp.id, balanceDate: '2026-03-01', balance: '1024.00', note: 'opening',
            enteredBy: 'local@dev', rowVersion: 0,
        });

        const replaced = (await put(gbp.id, '2026-03-01', { balance: '-250.5', baseVersion: 0 }).expect(200)).body;
        expect(replaced).toMatchObject({ id: first.id, balance: '-250.50', note: 'opening', rowVersion: 1 });

        const trail = await h.audit('bank_balance', first.id);
        expect(trail.map((r) => r.action)).toEqual(['update', 'create']);
        expect(trail[0]).toMatchObject({ before: { balance: '1024.00' }, after: { balance: '-250.50' } });
        expect(trail[1].after).toMatchObject({ balance: '1024.00', balanceDate: '2026-03-01' });

        // The same value again writes nothing; null clears the note.
        expect((await put(gbp.id, '2026-03-01', { balance: '-250.50' }).expect(200)).body.rowVersion).toBe(1);
        expect(await h.audit('bank_balance', first.id)).toHaveLength(2);
        const cleared = (await put(gbp.id, '2026-03-01', { balance: '-250.50', note: null }).expect(200)).body;
        expect(cleared).toMatchObject({ note: null, rowVersion: 2 });
    });

    test('PUT honours baseVersion, including on a row that is not there', async () => {
        const stale = await put(gbp.id, '2026-03-01', { balance: '1.00', baseVersion: 0 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 2 } });
        const missing = await put(gbp.id, '2026-02-01', { balance: '1.00', baseVersion: 0 }).expect(409);
        expect(missing.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: null } });
        // A single PUT is allowed on an inactive account; bulk is not.
        await put(dormant.id, '2026-03-01', { balance: '0.00' }).expect(200);
    });

    test('bulk validates the body, reporting each bad entry at its index', async () => {
        await bulk({ entries: [{ accountId: gbp.id, balance: '1.00' }] }).expect(400);
        await bulk({ balanceDate: '2026-03-05', entries: [] }).expect(400);
        await bulk({ balanceDate: '2026-03-05', entries: 'x' }).expect(400);
        const tooMany = Array.from({ length: 201 }, (_, i) => ({ accountId: i + 1, balance: '1.00' }));
        await bulk({ balanceDate: '2026-03-05', entries: tooMany }).expect(400);

        const res = await bulk({
            balanceDate: '2026-03-05',
            entries: [
                { accountId: gbp.id, balance: '10.00' },
                { accountId: eur.id, balance: 10 },
                { accountId: 'x', balance: '1.00' },
                { accountId: gbp.id, balance: '11.00' },
                null,
            ],
        }).expect(400);
        expect(res.body.details.entries).toEqual([
            null,
            expect.stringMatching(/balance/),
            expect.stringMatching(/accountId/),
            expect.stringMatching(/more than once/),
            expect.stringMatching(/accountId/),
        ]);

        const future = await bulk({ balanceDate: '2026-03-11', entries: [{ accountId: gbp.id, balance: '1.00' }] }).expect(422);
        expect(future.body).toMatchObject({ code: 'BALANCE_DATE_IN_FUTURE', details: { balanceDate: '2026-03-11', today: TODAY } });
    });

    test('bulk is all or nothing: an inactive or unknown account writes no entry', async () => {
        const res = await bulk({
            balanceDate: '2026-03-05',
            entries: [
                { accountId: hwGbp.id, balance: '5.00' },
                { accountId: dormant.id, balance: '5.00' },
                { accountId: 999999, balance: '5.00' },
                { accountId: gbp.id, balance: '5.00' },
            ],
        }).expect(400);
        expect(res.body.details.entries).toEqual([
            null, expect.stringMatching(/inactive/), expect.stringMatching(/No live account/), null,
        ]);
        expect((await api().get('/api/v1/balances').query({ from: '2026-03-05', to: '2026-03-05' }).expect(200)).body.total).toBe(0);
    });

    test('bulk writes every entry, answers in request order, one audit row each', async () => {
        await put(eur.id, '2026-03-05', { balance: '1.00' }).expect(200);   // one replace among the creates
        const res = await bulk({
            balanceDate: '2026-03-05',
            entries: [
                { accountId: hwGbp.id, balance: '300.00', note: 'hw' },
                { accountId: gbp.id, balance: '100' },
                { accountId: eur.id, balance: '200.10' },
            ],
        }).expect(200);
        expect(res.body.data.map((r) => [r.accountId, r.balance, r.balanceDate])).toEqual([
            [hwGbp.id, '300.00', '2026-03-05'], [gbp.id, '100.00', '2026-03-05'], [eur.id, '200.10', '2026-03-05'],
        ]);
        const [hwRow, gbpRow, eurRow] = res.body.data;
        expect((await h.audit('bank_balance', hwRow.id)).map((r) => r.action)).toEqual(['create']);
        expect((await h.audit('bank_balance', gbpRow.id)).map((r) => r.action)).toEqual(['create']);
        expect((await h.audit('bank_balance', eurRow.id)).map((r) => r.action)).toEqual(['update', 'create']);
        expect(eurRow.rowVersion).toBe(1);

        // The anchor follows the latest balance.
        const account = (await api().get(`/api/v1/accounts/${gbp.id}`).expect(200)).body;
        expect(account).toMatchObject({ anchorDate: '2026-03-05', anchorBalance: '100.00' });
    });

    test('list: balance_date DESC then account; account, company and date filters; paging', async () => {
        const all = (await api().get('/api/v1/balances').expect(200)).body;
        expect(all.total).toBe(5);
        expect(all.data.map((r) => [r.balanceDate, r.accountId])).toEqual([
            ['2026-03-05', gbp.id], ['2026-03-05', eur.id], ['2026-03-05', hwGbp.id],
            ['2026-03-01', gbp.id], ['2026-03-01', dormant.id],
        ]);
        const one = (await api().get('/api/v1/balances').query({ accountId: gbp.id }).expect(200)).body;
        expect(one.data.map((r) => r.balanceDate)).toEqual(['2026-03-05', '2026-03-01']);
        const hwOnly = (await api().get('/api/v1/balances').query({ companyId: hw.id }).expect(200)).body;
        expect(hwOnly.data.map((r) => r.accountId)).toEqual([hwGbp.id]);
        const window = (await api().get('/api/v1/balances').query({ from: '2026-03-01', to: '2026-03-04' }).expect(200)).body;
        expect(window.data.map((r) => r.accountId)).toEqual([gbp.id, dormant.id]);
        const paged = (await api().get('/api/v1/balances').query({ limit: 2, page: 3 }).expect(200)).body;
        expect(paged).toMatchObject({ page: 3, limit: 2, total: 5 });
        expect(paged.data.map((r) => r.accountId)).toEqual([dormant.id]);

        await api().get('/api/v1/balances').query({ accountId: 'x' }).expect(400);
        await api().get('/api/v1/balances').query({ companyId: '0' }).expect(400);
        await api().get('/api/v1/balances').query({ from: '2026-3-1' }).expect(400);
    });

    test('delete is hard, with the full before-snapshot in its audit row', async () => {
        const url = `/api/v1/accounts/${gbp.id}/balances/2026-03-01`;
        await api().delete(`/api/v1/accounts/${gbp.id}/balances/2026-02-30`).expect(400);
        await api().delete(`/api/v1/accounts/999999/balances/2026-03-01`).expect(404);
        await api().delete(`/api/v1/accounts/${gbp.id}/balances/2026-01-01`).expect(404);
        const stale = await api().delete(url).send({ baseVersion: 0 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 2 } });

        await api().delete(url).send({ baseVersion: 2 }).expect(204);
        await api().delete(url).expect(404);
        expect(await h.sql('SELECT id FROM bank_balances WHERE id = ?', [first.id])).toHaveLength(0);

        const [del] = await h.audit('bank_balance', first.id);
        expect(del.action).toBe('delete');
        expect(del.after).toBeNull();
        expect(del.before).toMatchObject({
            id: first.id, accountId: gbp.id, balanceDate: '2026-03-01', balance: '-250.50',
            note: null, enteredBy: 'local@dev', rowVersion: 2,
        });
    });
});
