'use strict';

// Bank accounts (CONTRACT §6.3, §10.2, D15-D17), end to end against a per-run
// jflow_test_<runid> schema: validation, one default per company, the anchor
// fields, list params, currency and deactivation guards, soft delete, audit.

const { startHarness, insertItem, insertSchedule } = require('./harness');

jest.setTimeout(120000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const PAST = '2026-01-15';

const ROW_KEYS = [
    'companyId', 'createdAt', 'createdBy', 'currency', 'deletedAt', 'id', 'isActive', 'isDefault',
    'name', 'rowVersion', 'sortOrder', 'updatedAt',
];

describe('accounts', () => {
    let jfa;
    let hw;
    let category;
    let a1;
    let a2;
    let hwMain;

    beforeAll(async () => {
        const companies = (await api().get('/api/v1/companies').expect(200)).body.data;
        jfa = companies.find((c) => c.code === 'JFA');
        hw = companies.find((c) => c.code === 'HW');
        category = (await api().post('/api/v1/categories').send({ name: 'Suppliers', direction: 'out' }).expect(201)).body;
    });

    test('create validates the body', async () => {
        const good = { companyId: jfa.id, name: 'Main', currency: 'GBP' };
        const bad = [
            [{ ...good, companyId: undefined }, /companyId/],
            [{ ...good, companyId: 'x' }, /companyId/],
            [{ ...good, companyId: true }, /companyId/],
            [{ ...good, companyId: 999999 }, /not a live company/],
            [{ ...good, name: ' ' }, /name/],
            [{ ...good, currency: 'gbp' }, /currency/],
            [{ ...good, currency: 'GBPX' }, /currency/],
            [{ ...good, currency: undefined }, /currency/],
            [{ ...good, sortOrder: 'x' }, /sortOrder/],
            [{ ...good, isActive: 'yes' }, /isActive/],
            [{ ...good, isDefault: 1 }, /isDefault/],
        ];
        for (const [body, msg] of bad) {
            const res = await api().post('/api/v1/accounts').send(body).expect(400);
            expect(res.body.error).toMatch(msg);
        }
        expect((await api().get('/api/v1/accounts').expect(200)).body.total).toBe(0);
    });

    test('create, with its audit row; the mutation response carries no anchor', async () => {
        const res = await api().post('/api/v1/accounts')
            .send({ companyId: jfa.id, name: 'JFA current', currency: 'GBP', sortOrder: 2, isDefault: true }).expect(201);
        a1 = res.body;
        expect(Object.keys(a1).sort()).toEqual(ROW_KEYS);
        expect(a1).toMatchObject({
            companyId: jfa.id, name: 'JFA current', currency: 'GBP', sortOrder: 2,
            isActive: true, isDefault: true, rowVersion: 0, createdBy: 'local@dev', deletedAt: null,
        });
        const [row] = await h.audit('bank_account', a1.id);
        expect(row).toMatchObject({ action: 'create', before: null });
        expect(row.after).toMatchObject({ id: a1.id, isDefault: true });

        hwMain = (await api().post('/api/v1/accounts')
            .send({ companyId: hw.id, name: 'HW main', currency: 'GBP', isDefault: true }).expect(201)).body;
    });

    test("a second default clears the company's first, audited; other companies are untouched", async () => {
        a2 = (await api().post('/api/v1/accounts')
            .send({ companyId: jfa.id, name: 'JFA euro', currency: 'EUR', sortOrder: 1, isDefault: true }).expect(201)).body;
        expect(a2.isDefault).toBe(true);

        const first = (await api().get(`/api/v1/accounts/${a1.id}`).expect(200)).body;
        expect(first).toMatchObject({ isDefault: false, rowVersion: 1 });
        const [cleared] = await h.audit('bank_account', a1.id);
        expect(cleared).toMatchObject({ action: 'update', before: { isDefault: true }, after: { isDefault: false } });

        expect((await api().get(`/api/v1/accounts/${hwMain.id}`).expect(200)).body.isDefault).toBe(true);

        // And back: PUT isDefault on the first clears the second.
        const back = (await api().put(`/api/v1/accounts/${a1.id}`).send({ isDefault: true, baseVersion: 1 }).expect(200)).body;
        expect(back).toMatchObject({ isDefault: true, rowVersion: 2 });
        const list = (await api().get('/api/v1/accounts').query({ companyId: jfa.id }).expect(200)).body.data;
        expect(list.filter((a) => a.isDefault).map((a) => a.id)).toEqual([a1.id]);
    });

    test('list: sorted company → sort_order → name, with the anchor fields; filters and paging', async () => {
        const all = (await api().get('/api/v1/accounts').expect(200)).body;
        expect(all.total).toBe(3);
        // JFA (sort 1) before HW (sort 2); inside JFA sort_order 1 (euro) before 2.
        expect(all.data.map((a) => a.id)).toEqual([a2.id, a1.id, hwMain.id]);
        expect(all.data[0]).toMatchObject({ anchorDate: null, anchorBalance: null });

        await api().put(`/api/v1/accounts/${a1.id}/balances/2026-01-10`).query({ today: PAST }).send({ balance: '100.00' }).expect(200);
        await api().put(`/api/v1/accounts/${a1.id}/balances/2026-01-12`).query({ today: PAST }).send({ balance: '-5.5' }).expect(200);
        const one = (await api().get(`/api/v1/accounts/${a1.id}`).expect(200)).body;
        expect(one).toMatchObject({ anchorDate: '2026-01-12', anchorBalance: '-5.50' });

        const hwOnly = (await api().get('/api/v1/accounts').query({ companyId: hw.id }).expect(200)).body;
        expect(hwOnly.data.map((a) => a.id)).toEqual([hwMain.id]);
        const q = (await api().get('/api/v1/accounts').query({ q: 'euro' }).expect(200)).body;
        expect(q.data.map((a) => a.id)).toEqual([a2.id]);
        const paged = (await api().get('/api/v1/accounts').query({ limit: 2, page: 2 }).expect(200)).body;
        expect(paged).toMatchObject({ page: 2, limit: 2, total: 3 });
        expect(paged.data.map((a) => a.id)).toEqual([hwMain.id]);

        await api().get('/api/v1/accounts').query({ companyId: 'x' }).expect(400);
        await api().get('/api/v1/accounts').query({ isActive: 'maybe' }).expect(400);
        await api().get('/api/v1/accounts/abc').expect(404);
        await api().get('/api/v1/accounts/999999').expect(404);
    });

    test('update: validation, immutable company, stale baseVersion, no-op', async () => {
        await api().put(`/api/v1/accounts/${a2.id}`).send({}).expect(400);
        await api().put(`/api/v1/accounts/${a2.id}`).send({ currency: 'eur' }).expect(400);
        await api().put(`/api/v1/accounts/${a2.id}`).send({ isActive: 0 }).expect(400);
        await api().put('/api/v1/accounts/999999').send({ name: 'Ghost' }).expect(404);

        const moved = await api().put(`/api/v1/accounts/${a2.id}`).send({ companyId: hw.id }).expect(400);
        expect(moved.body.error).toMatch(/companyId/);
        // Sending the company it already has is not a change.
        const same = (await api().put(`/api/v1/accounts/${a2.id}`).send({ companyId: jfa.id, name: 'JFA euro' }).expect(200)).body;
        const version = same.rowVersion;
        expect((await h.audit('bank_account', a2.id))).toHaveLength(2); // create + the default it lost

        const stale = await api().put(`/api/v1/accounts/${a2.id}`).send({ name: 'x', baseVersion: version + 5 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: version } });

        const renamed = (await api().put(`/api/v1/accounts/${a2.id}`).send({ name: 'JFA EUR', sortOrder: 5, baseVersion: version }).expect(200)).body;
        expect(renamed).toMatchObject({ name: 'JFA EUR', sortOrder: 5, rowVersion: version + 1 });
        expect(renamed.anchorDate).toBeUndefined();
    });

    test('currency change: allowed while unreferenced, refused once a balance exists', async () => {
        const changed = (await api().put(`/api/v1/accounts/${a2.id}`).send({ currency: 'USD' }).expect(200)).body;
        expect(changed.currency).toBe('USD');

        const res = await api().put(`/api/v1/accounts/${a1.id}`).send({ currency: 'EUR' }).expect(409);
        expect(res.body).toMatchObject({
            code: 'ACCOUNT_IN_USE', details: { itemCount: 0, scheduleCount: 0, balanceCount: 2 },
        });
        // An unchanged currency in the body is not a change.
        await api().put(`/api/v1/accounts/${a1.id}`).send({ currency: 'GBP', name: 'JFA current' }).expect(200);
    });

    test('deactivation is refused while the account has owed items or live schedules (D17)', async () => {
        const owed = await insertItem(h, { accountId: a2.id, categoryId: category.id, status: 'expected' });
        const part = await insertItem(h, { accountId: a2.id, categoryId: category.id, status: 'part_paid' });
        await insertItem(h, { accountId: a2.id, categoryId: category.id, status: 'paid' });
        await insertItem(h, { accountId: a2.id, categoryId: category.id, status: 'skipped' });
        await insertItem(h, { accountId: a2.id, categoryId: category.id, status: 'expected', deleted: true });
        const sched = await insertSchedule(h, { accountId: a2.id, categoryId: category.id });
        await insertSchedule(h, { accountId: a2.id, categoryId: category.id, deleted: true });

        const res = await api().put(`/api/v1/accounts/${a2.id}`).send({ isActive: false }).expect(409);
        expect(res.body.code).toBe('ACCOUNT_IN_USE');
        expect(res.body.details).toEqual({
            owedItems: { count: 2, keys: [`item.${owed}`, `item.${part}`] },
            liveSchedules: { count: 1, ids: [sched] },
            owedInstances: { count: 0, keys: [] },
        });
        expect((await api().get(`/api/v1/accounts/${a2.id}`).expect(200)).body.isActive).toBe(true);

        // Other edits still go through while in use.
        await api().put(`/api/v1/accounts/${a2.id}`).send({ sortOrder: 6 }).expect(200);
    });

    test('deactivation goes through once nothing is owed; inactive filter; reactivation', async () => {
        await h.sql('UPDATE cash_items SET deleted_at = UTC_TIMESTAMP() WHERE account_id = ?', [a2.id]);
        await h.sql('UPDATE schedules SET deleted_at = UTC_TIMESTAMP() WHERE account_id = ?', [a2.id]);

        const off = (await api().put(`/api/v1/accounts/${a2.id}`).send({ isActive: false }).expect(200)).body;
        expect(off.isActive).toBe(false);
        const [row] = await h.audit('bank_account', a2.id);
        expect(row).toMatchObject({ action: 'update', before: { isActive: true }, after: { isActive: false } });

        const inactive = (await api().get('/api/v1/accounts').query({ isActive: 'false' }).expect(200)).body;
        expect(inactive.data.map((a) => a.id)).toEqual([a2.id]);
        const active = (await api().get('/api/v1/accounts').query({ isActive: 1 }).expect(200)).body;
        expect(active.data.map((a) => a.id)).not.toContain(a2.id);

        expect((await api().put(`/api/v1/accounts/${a2.id}`).send({ isActive: true }).expect(200)).body.isActive).toBe(true);
    });

    test('delete is refused while items, schedules or balances reference the account', async () => {
        const res = await api().delete(`/api/v1/accounts/${a1.id}`).expect(409);
        expect(res.body).toMatchObject({
            code: 'ACCOUNT_IN_USE', details: { itemCount: 0, scheduleCount: 0, balanceCount: 2 },
        });
        const item = await insertItem(h, { accountId: hwMain.id, categoryId: category.id });
        const sched = await insertSchedule(h, { accountId: hwMain.id, categoryId: category.id });
        const both = await api().delete(`/api/v1/accounts/${hwMain.id}`).expect(409);
        expect(both.body.details).toEqual({ itemCount: 1, scheduleCount: 1, balanceCount: 0 });
        await h.sql('UPDATE cash_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [item]);
        await h.sql('UPDATE schedules SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [sched]);
    });

    test('soft delete: baseVersion, 404 afterwards, includeDeleted, audit', async () => {
        const current = (await api().get(`/api/v1/accounts/${hwMain.id}`).expect(200)).body;
        const stale = await api().delete(`/api/v1/accounts/${hwMain.id}`).send({ baseVersion: current.rowVersion + 1 }).expect(409);
        expect(stale.body.code).toBe('STALE_WRITE');

        await api().delete(`/api/v1/accounts/${hwMain.id}`).send({ baseVersion: current.rowVersion }).expect(204);
        await api().get(`/api/v1/accounts/${hwMain.id}`).expect(404);
        await api().delete(`/api/v1/accounts/${hwMain.id}`).expect(404);
        const gone = (await api().get(`/api/v1/accounts/${hwMain.id}`).query({ includeDeleted: '1' }).expect(200)).body;
        expect(gone.deletedAt).not.toBeNull();
        expect((await api().get('/api/v1/accounts').expect(200)).body.total).toBe(2);
        expect((await api().get('/api/v1/accounts').query({ includeDeleted: 1 }).expect(200)).body.total).toBe(3);

        const [del] = await h.audit('bank_account', hwMain.id);
        expect(del).toMatchObject({ action: 'delete', before: { deletedAt: null } });

        // The company it belonged to can now go too.
        await api().delete(`/api/v1/companies/${hw.id}`).expect(204);
        const orphan = await api().post('/api/v1/accounts').send({ companyId: hw.id, name: 'Late', currency: 'GBP' }).expect(400);
        expect(orphan.body.error).toMatch(/not a live company/);
    });
});
