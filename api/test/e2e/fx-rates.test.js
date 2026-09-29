'use strict';

// FX rates (CONTRACT §6.5, D1, D3), end to end against a per-run
// jflow_test_<runid> schema: validation (GBP refused, rates as DECIMAL strings),
// the (currency, effective_from) rule, list params, the current rate set, the
// immutable currency, hard delete with the before-snapshot in the audit row.

const { startHarness } = require('./harness');

jest.setTimeout(120000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();

const ROW_KEYS = ['createdAt', 'createdBy', 'currency', 'effectiveFrom', 'id', 'note', 'rateToGbp', 'rowVersion', 'updatedAt'];

describe('fx-rates', () => {
    let eurJan;
    let eurJun;
    let usdMar;

    test('create validates the body; GBP is refused (D3); a JSON number is refused (D1)', async () => {
        const good = { currency: 'EUR', rateToGbp: '0.850000', effectiveFrom: '2026-01-01' };
        const bad = [
            [{ ...good, currency: 'GBP' }, /GBP/],
            [{ ...good, currency: 'eur' }, /currency/],
            [{ ...good, currency: undefined }, /currency/],
            [{ ...good, rateToGbp: 0.85 }, /rateToGbp/],
            [{ ...good, rateToGbp: '0' }, /rateToGbp/],
            [{ ...good, rateToGbp: '0.000000' }, /rateToGbp/],
            [{ ...good, rateToGbp: '-1.2' }, /rateToGbp/],
            [{ ...good, rateToGbp: '1.1234567' }, /rateToGbp/],
            [{ ...good, rateToGbp: '1e3' }, /rateToGbp/],
            [{ ...good, effectiveFrom: '2026-02-30' }, /effectiveFrom/],
            [{ ...good, effectiveFrom: undefined }, /effectiveFrom/],
            [{ ...good, note: 'x'.repeat(501) }, /note/],
        ];
        for (const [body, msg] of bad) {
            const res = await api().post('/api/v1/fx-rates').send(body).expect(400);
            expect(res.body.error).toMatch(msg);
        }
        expect((await api().get('/api/v1/fx-rates').expect(200)).body.total).toBe(0);
    });

    test('create, with its audit row', async () => {
        eurJan = (await api().post('/api/v1/fx-rates')
            .send({ currency: 'EUR', rateToGbp: '0.85', effectiveFrom: '2026-01-01', note: ' opening ' }).expect(201)).body;
        expect(Object.keys(eurJan).sort()).toEqual(ROW_KEYS);
        expect(eurJan).toMatchObject({
            currency: 'EUR', rateToGbp: '0.850000', effectiveFrom: '2026-01-01', note: 'opening',
            rowVersion: 0, createdBy: 'local@dev',
        });
        eurJun = (await api().post('/api/v1/fx-rates').send({ currency: 'EUR', rateToGbp: '0.861234', effectiveFrom: '2026-06-01' }).expect(201)).body;
        usdMar = (await api().post('/api/v1/fx-rates').send({ currency: 'USD', rateToGbp: '0.79', effectiveFrom: '2026-03-01' }).expect(201)).body;
        expect(eurJun.note).toBeNull();

        const [row] = await h.audit('fx_rate', eurJan.id);
        expect(row).toMatchObject({ action: 'create', before: null, after: { currency: 'EUR', rateToGbp: '0.850000' } });
    });

    test('a second rate for the same currency and date is refused, naming the holder', async () => {
        const res = await api().post('/api/v1/fx-rates').send({ currency: 'EUR', rateToGbp: '0.9', effectiveFrom: '2026-01-01' }).expect(409);
        expect(res.body).toMatchObject({ code: 'FX_RATE_EXISTS', details: { fxRateId: eurJan.id } });
    });

    test('list: sorted currency → effective_from DESC; currency, from/to filters; paging', async () => {
        const all = (await api().get('/api/v1/fx-rates').expect(200)).body;
        expect(all.data.map((r) => r.id)).toEqual([eurJun.id, eurJan.id, usdMar.id]);
        const eur = (await api().get('/api/v1/fx-rates').query({ currency: 'EUR' }).expect(200)).body;
        expect(eur.data.map((r) => r.id)).toEqual([eurJun.id, eurJan.id]);
        const window = (await api().get('/api/v1/fx-rates').query({ from: '2026-02-01', to: '2026-05-31' }).expect(200)).body;
        expect(window.data.map((r) => r.id)).toEqual([usdMar.id]);
        const paged = (await api().get('/api/v1/fx-rates').query({ limit: 1, page: 3 }).expect(200)).body;
        expect(paged).toMatchObject({ page: 3, limit: 1, total: 3 });
        expect(paged.data.map((r) => r.id)).toEqual([usdMar.id]);

        await api().get('/api/v1/fx-rates').query({ currency: 'eu' }).expect(400);
        await api().get('/api/v1/fx-rates').query({ from: '2026-13-01' }).expect(400);
        expect((await api().get(`/api/v1/fx-rates/${usdMar.id}`).expect(200)).body).toEqual(usdMar);
        await api().get('/api/v1/fx-rates/abc').expect(404);
        await api().get('/api/v1/fx-rates/999999').expect(404);
    });

    test('current: the latest rate on or before `on` per currency, GBP omitted', async () => {
        const may = (await api().get('/api/v1/fx-rates/current').query({ on: '2026-05-01' }).expect(200)).body;
        expect(may).toEqual({
            on: '2026-05-01',
            rates: {
                EUR: { id: eurJan.id, rateToGbp: '0.850000', effectiveFrom: '2026-01-01' },
                USD: { id: usdMar.id, rateToGbp: '0.790000', effectiveFrom: '2026-03-01' },
            },
        });
        const boundary = (await api().get('/api/v1/fx-rates/current').query({ on: '2026-06-01' }).expect(200)).body;
        expect(boundary.rates.EUR.id).toBe(eurJun.id);
        const feb = (await api().get('/api/v1/fx-rates/current').query({ on: '2026-02-01' }).expect(200)).body;
        expect(Object.keys(feb.rates)).toEqual(['EUR']);
        const before = (await api().get('/api/v1/fx-rates/current').query({ on: '2025-12-31' }).expect(200)).body;
        expect(before).toEqual({ on: '2025-12-31', rates: {} });

        // `on` defaults to today; locally `?today=` pins it (D24).
        const pinned = (await api().get('/api/v1/fx-rates/current').query({ today: '2026-07-04' }).expect(200)).body;
        expect(pinned.on).toBe('2026-07-04');
        expect(pinned.rates.EUR.id).toBe(eurJun.id);
        const { londonToday } = require('../../src/lib/dates');
        expect((await api().get('/api/v1/fx-rates/current').expect(200)).body.on).toBe(londonToday());

        await api().get('/api/v1/fx-rates/current').query({ on: '2026-02-31' }).expect(400);
        await api().get('/api/v1/fx-rates/current').query({ today: 'yesterday' }).expect(400);
    });

    test('update: validation, immutable currency, collision, stale baseVersion, audit', async () => {
        await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({}).expect(400);
        await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({ rateToGbp: 0.9 }).expect(400);
        await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({ effectiveFrom: 'June' }).expect(400);
        await api().put('/api/v1/fx-rates/999999').send({ note: 'x' }).expect(404);

        const moved = await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({ currency: 'USD' }).expect(400);
        expect(moved.body.error).toMatch(/currency/);

        const clash = await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({ effectiveFrom: '2026-01-01' }).expect(409);
        expect(clash.body).toMatchObject({ code: 'FX_RATE_EXISTS', details: { fxRateId: eurJan.id } });

        const stale = await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({ rateToGbp: '0.87', baseVersion: 1 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });

        const ok = (await api().put(`/api/v1/fx-rates/${eurJun.id}`)
            .send({ currency: 'EUR', rateToGbp: '0.87', effectiveFrom: '2026-06-15', note: 'revised', baseVersion: 0 }).expect(200)).body;
        expect(ok).toMatchObject({ rateToGbp: '0.870000', effectiveFrom: '2026-06-15', note: 'revised', rowVersion: 1 });
        const [row] = await h.audit('fx_rate', eurJun.id);
        expect(row).toMatchObject({
            action: 'update',
            before: { rateToGbp: '0.861234', effectiveFrom: '2026-06-01', note: null, rowVersion: 0 },
            after: { rateToGbp: '0.870000', effectiveFrom: '2026-06-15', note: 'revised', rowVersion: 1 },
        });

        // The same rate written differently is not a change.
        const same = (await api().put(`/api/v1/fx-rates/${eurJun.id}`).send({ rateToGbp: '0.870' }).expect(200)).body;
        expect(same.rowVersion).toBe(1);
        expect(await h.audit('fx_rate', eurJun.id)).toHaveLength(2);
    });

    test('delete is hard, and the audit row carries the full before-snapshot', async () => {
        const stale = await api().delete(`/api/v1/fx-rates/${usdMar.id}`).send({ baseVersion: 4 }).expect(409);
        expect(stale.body.code).toBe('STALE_WRITE');
        await api().delete(`/api/v1/fx-rates/${usdMar.id}`).send({ baseVersion: 0 }).expect(204);
        await api().get(`/api/v1/fx-rates/${usdMar.id}`).expect(404);
        await api().delete(`/api/v1/fx-rates/${usdMar.id}`).expect(404);
        expect(await h.sql('SELECT id FROM fx_rates WHERE id = ?', [usdMar.id])).toHaveLength(0);

        const [del] = await h.audit('fx_rate', usdMar.id);
        expect(del.action).toBe('delete');
        expect(del.after).toBeNull();
        expect(del.before).toMatchObject({
            id: usdMar.id, currency: 'USD', rateToGbp: '0.790000', effectiveFrom: '2026-03-01', rowVersion: 0,
        });

        // The (currency, date) is free again.
        await api().post('/api/v1/fx-rates').send({ currency: 'USD', rateToGbp: '0.8', effectiveFrom: '2026-03-01' }).expect(201);
    });
});
