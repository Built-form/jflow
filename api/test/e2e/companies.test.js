'use strict';

// Companies (CONTRACT §6.2), end to end against a per-run jflow_test_<runid>
// schema: the seed, validation, the live-code rule, list params, optimistic
// locking, the in-use guard, soft delete, and one audit row per mutation.

const { startHarness } = require('./harness');

jest.setTimeout(120000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();

const ROW_KEYS = ['code', 'createdAt', 'createdBy', 'deletedAt', 'id', 'name', 'rowVersion', 'sortOrder', 'updatedAt'];

describe('companies', () => {
    let jfa;
    let hw;
    let acme;

    test('the two seeded companies list first, sorted by sort_order', async () => {
        const res = await api().get('/api/v1/companies').expect(200);
        expect(res.body).toMatchObject({ page: 1, limit: 100, total: 2 });
        expect(res.body.data.map((c) => [c.code, c.name, c.sortOrder])).toEqual([
            ['JFA', 'JFA', 1], ['HW', 'Hangerworld', 2],
        ]);
        [jfa, hw] = res.body.data;
        expect(Object.keys(jfa).sort()).toEqual(ROW_KEYS);
        expect(jfa).toMatchObject({ rowVersion: 0, deletedAt: null });
    });

    test('create validates the body', async () => {
        const bad = [
            [{ name: 'No code' }, /code/],
            [{ code: 'a-b', name: 'Dash' }, /code/],
            [{ code: 'X'.repeat(17), name: 'Long' }, /code/],
            [{ code: 'OK', name: '   ' }, /name/],
            [{ code: 'OK', name: 'x'.repeat(256) }, /name/],
            [{ code: 'OK', name: 'Ok', sortOrder: 'first' }, /sortOrder/],
            [{ code: 'OK', name: 'Ok', sortOrder: 1.5 }, /sortOrder/],
        ];
        for (const [body, msg] of bad) {
            const res = await api().post('/api/v1/companies').send(body).expect(400);
            expect(res.body.error).toMatch(msg);
            expect(res.body.code).toBeUndefined();
        }
    });

    test('create trims and upper-cases the code, and writes an audit row', async () => {
        const res = await api().post('/api/v1/companies').send({ code: ' acme_1 ', name: ' Acme ', sortOrder: 3 }).expect(201);
        acme = res.body;
        expect(acme).toMatchObject({ code: 'ACME_1', name: 'Acme', sortOrder: 3, rowVersion: 0, createdBy: 'local@dev', deletedAt: null });
        const trail = await h.audit('company', acme.id);
        expect(trail).toHaveLength(1);
        expect(trail[0]).toMatchObject({ action: 'create', userEmail: 'local@dev', before: null });
        expect(trail[0].after).toMatchObject({ id: acme.id, code: 'ACME_1', name: 'Acme' });
    });

    test('a code held by a live company is refused, naming the holder', async () => {
        const res = await api().post('/api/v1/companies').send({ code: 'jfa', name: 'Clash' }).expect(409);
        expect(res.body).toMatchObject({ code: 'COMPANY_CODE_TAKEN', details: { companyId: jfa.id } });
    });

    test('list params: q over code and name, paging, total', async () => {
        const byName = (await api().get('/api/v1/companies').query({ q: 'anger' }).expect(200)).body;
        expect(byName.data.map((c) => c.code)).toEqual(['HW']);
        const byCode = (await api().get('/api/v1/companies').query({ q: 'acme' }).expect(200)).body;
        expect(byCode.data.map((c) => c.code)).toEqual(['ACME_1']);
        const page2 = (await api().get('/api/v1/companies').query({ limit: 1, page: 2 }).expect(200)).body;
        expect(page2).toMatchObject({ page: 2, limit: 1, total: 3 });
        expect(page2.data.map((c) => c.code)).toEqual(['HW']);
    });

    test('single read; a malformed or unknown id is 404', async () => {
        const res = await api().get(`/api/v1/companies/${hw.id}`).expect(200);
        expect(res.body).toEqual(hw);
        await api().get('/api/v1/companies/abc').expect(404);
        await api().get('/api/v1/companies/0').expect(404);
        await api().get('/api/v1/companies/999999').expect(404);
    });

    test('update: validation, baseVersion, audit, and a no-op writes nothing', async () => {
        await api().put(`/api/v1/companies/${acme.id}`).send({}).expect(400);
        await api().put(`/api/v1/companies/${acme.id}`).send({ baseVersion: 0 }).expect(400);
        await api().put(`/api/v1/companies/${acme.id}`).send({ name: '' }).expect(400);
        await api().put(`/api/v1/companies/${acme.id}`).send({ name: 'A', baseVersion: 'x' }).expect(400);
        await api().put('/api/v1/companies/999999').send({ name: 'Ghost' }).expect(404);

        const stale = await api().put(`/api/v1/companies/${acme.id}`).send({ name: 'Acme Ltd', baseVersion: 7 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });

        const ok = await api().put(`/api/v1/companies/${acme.id}`).send({ name: 'Acme Ltd', baseVersion: 0 }).expect(200);
        expect(ok.body).toMatchObject({ name: 'Acme Ltd', code: 'ACME_1', rowVersion: 1 });

        const trail = await h.audit('company', acme.id);
        expect(trail).toHaveLength(2);
        expect(trail[0]).toMatchObject({ action: 'update' });
        expect(trail[0].before).toMatchObject({ name: 'Acme', rowVersion: 0 });
        expect(trail[0].after).toMatchObject({ name: 'Acme Ltd', rowVersion: 1 });

        // Same values again (the code in another case too): nothing changes.
        const same = await api().put(`/api/v1/companies/${acme.id}`).send({ name: 'Acme Ltd', code: 'acme_1' }).expect(200);
        expect(same.body.rowVersion).toBe(1);
        expect(await h.audit('company', acme.id)).toHaveLength(2);
    });

    test('update refuses a code another live company holds; its own code is fine', async () => {
        const res = await api().put(`/api/v1/companies/${acme.id}`).send({ code: 'hw' }).expect(409);
        expect(res.body).toMatchObject({ code: 'COMPANY_CODE_TAKEN', details: { companyId: hw.id } });
        const renamed = await api().put(`/api/v1/companies/${acme.id}`).send({ code: 'ACME' }).expect(200);
        expect(renamed.body).toMatchObject({ code: 'ACME', rowVersion: 2 });
    });

    test('delete is refused while a live account belongs to the company', async () => {
        const account = (await api().post('/api/v1/accounts')
            .send({ companyId: acme.id, name: 'Acme current', currency: 'GBP' }).expect(201)).body;
        const res = await api().delete(`/api/v1/companies/${acme.id}`).expect(409);
        expect(res.body).toMatchObject({ code: 'COMPANY_IN_USE', details: { accountIds: [account.id] } });
        await api().delete(`/api/v1/accounts/${account.id}`).expect(204);
    });

    test('delete: stale baseVersion, then a soft delete with its audit row', async () => {
        const stale = await api().delete(`/api/v1/companies/${acme.id}`).send({ baseVersion: 0 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 2 } });

        await api().delete(`/api/v1/companies/${acme.id}`).send({ baseVersion: 2 }).expect(204);
        await api().get(`/api/v1/companies/${acme.id}`).expect(404);
        await api().delete(`/api/v1/companies/${acme.id}`).expect(404);
        await api().put(`/api/v1/companies/${acme.id}`).send({ name: 'Zombie' }).expect(404);

        const gone = (await api().get(`/api/v1/companies/${acme.id}`).query({ includeDeleted: 1 }).expect(200)).body;
        expect(gone.deletedAt).not.toBeNull();
        expect(gone.rowVersion).toBe(3);

        const live = (await api().get('/api/v1/companies').expect(200)).body;
        expect(live.data.map((c) => c.code)).toEqual(['JFA', 'HW']);
        const all = (await api().get('/api/v1/companies').query({ includeDeleted: 1 }).expect(200)).body;
        expect(all.total).toBe(3);

        const [del] = await h.audit('company', acme.id);
        expect(del).toMatchObject({ action: 'delete', userEmail: 'local@dev' });
        expect(del.before).toMatchObject({ deletedAt: null });
        expect(del.after.deletedAt).toBeTruthy();
    });

    test("a deleted company's code can be reused", async () => {
        const res = await api().post('/api/v1/companies').send({ code: 'ACME', name: 'Acme again' }).expect(201);
        expect(res.body.id).not.toBe(acme.id);
    });
});
