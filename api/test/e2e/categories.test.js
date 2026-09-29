'use strict';

// Categories (CONTRACT §6.4, D14, D15), end to end against a per-run
// jflow_test_<runid> schema: validation, list params, the direction lock while
// in use, the in-use delete guard, soft delete, audit.

const { startHarness, insertItem, insertSchedule } = require('./harness');

jest.setTimeout(120000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();

const ROW_KEYS = ['createdAt', 'createdBy', 'deletedAt', 'direction', 'id', 'name', 'rowVersion', 'sortOrder', 'updatedAt'];

describe('categories', () => {
    let sales;
    let payroll;
    let rent;
    let account;

    beforeAll(async () => {
        const jfa = (await api().get('/api/v1/companies').query({ q: 'JFA' }).expect(200)).body.data[0];
        account = (await api().post('/api/v1/accounts').send({ companyId: jfa.id, name: 'Main', currency: 'GBP' }).expect(201)).body;
    });

    test('create validates the body', async () => {
        const bad = [
            [{ direction: 'in' }, /name/],
            [{ name: '  ', direction: 'in' }, /name/],
            [{ name: 'Sales' }, /direction/],
            [{ name: 'Sales', direction: 'IN' }, /direction/],
            [{ name: 'Sales', direction: 'sideways' }, /direction/],
            [{ name: 'Sales', direction: 'in', sortOrder: 'x' }, /sortOrder/],
        ];
        for (const [body, msg] of bad) {
            const res = await api().post('/api/v1/categories').send(body).expect(400);
            expect(res.body.error).toMatch(msg);
        }
    });

    test('create, with its audit row', async () => {
        sales = (await api().post('/api/v1/categories').send({ name: ' Sales ', direction: 'in', sortOrder: 1 }).expect(201)).body;
        expect(Object.keys(sales).sort()).toEqual(ROW_KEYS);
        expect(sales).toMatchObject({ name: 'Sales', direction: 'in', sortOrder: 1, rowVersion: 0, createdBy: 'local@dev', deletedAt: null });
        payroll = (await api().post('/api/v1/categories').send({ name: 'Payroll', direction: 'out', sortOrder: 2 }).expect(201)).body;
        rent = (await api().post('/api/v1/categories').send({ name: 'Rent', direction: 'out', sortOrder: 1 }).expect(201)).body;

        const [row] = await h.audit('category', sales.id);
        expect(row).toMatchObject({ action: 'create', before: null, after: { name: 'Sales', direction: 'in' } });
    });

    test('list: sorted direction → sort_order → name; direction and q filters; paging', async () => {
        const all = (await api().get('/api/v1/categories').expect(200)).body;
        expect(all.total).toBe(3);
        expect(all.data.map((c) => c.name)).toEqual(['Sales', 'Rent', 'Payroll']);

        const outs = (await api().get('/api/v1/categories').query({ direction: 'out' }).expect(200)).body;
        expect(outs.data.map((c) => c.name)).toEqual(['Rent', 'Payroll']);
        await api().get('/api/v1/categories').query({ direction: 'both' }).expect(400);

        const q = (await api().get('/api/v1/categories').query({ q: 'roll' }).expect(200)).body;
        expect(q.data.map((c) => c.id)).toEqual([payroll.id]);
        const paged = (await api().get('/api/v1/categories').query({ limit: 2, page: 2 }).expect(200)).body;
        expect(paged).toMatchObject({ page: 2, limit: 2, total: 3 });
        expect(paged.data.map((c) => c.id)).toEqual([payroll.id]);

        expect((await api().get(`/api/v1/categories/${rent.id}`).expect(200)).body).toEqual(rent);
        await api().get('/api/v1/categories/abc').expect(404);
        await api().get('/api/v1/categories/999999').expect(404);
    });

    test('update: validation, stale baseVersion, rename with audit, direction while unused', async () => {
        await api().put(`/api/v1/categories/${rent.id}`).send({}).expect(400);
        await api().put(`/api/v1/categories/${rent.id}`).send({ direction: 'up' }).expect(400);
        await api().put(`/api/v1/categories/${rent.id}`).send({ name: '' }).expect(400);
        await api().put('/api/v1/categories/999999').send({ name: 'Ghost' }).expect(404);

        const stale = await api().put(`/api/v1/categories/${rent.id}`).send({ name: 'Office rent', baseVersion: 3 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });

        const renamed = (await api().put(`/api/v1/categories/${rent.id}`).send({ name: 'Office rent', baseVersion: 0 }).expect(200)).body;
        expect(renamed).toMatchObject({ name: 'Office rent', rowVersion: 1 });
        const [row] = await h.audit('category', rent.id);
        expect(row).toMatchObject({ action: 'update', before: { name: 'Rent' }, after: { name: 'Office rent' } });

        const flipped = (await api().put(`/api/v1/categories/${rent.id}`).send({ direction: 'in' }).expect(200)).body;
        expect(flipped).toMatchObject({ direction: 'in', rowVersion: 2 });
        await api().put(`/api/v1/categories/${rent.id}`).send({ direction: 'out' }).expect(200);

        const noop = (await api().put(`/api/v1/categories/${rent.id}`).send({ name: 'Office rent', direction: 'out' }).expect(200)).body;
        expect(noop.rowVersion).toBe(3);
        expect(await h.audit('category', rent.id)).toHaveLength(4);
    });

    test('direction is locked while a live item or schedule uses the category', async () => {
        const item = await insertItem(h, { accountId: account.id, categoryId: payroll.id });
        await insertItem(h, { accountId: account.id, categoryId: payroll.id, deleted: true });
        const res = await api().put(`/api/v1/categories/${payroll.id}`).send({ direction: 'in' }).expect(409);
        expect(res.body).toMatchObject({ code: 'CATEGORY_IN_USE', details: { itemCount: 1, scheduleCount: 0 } });
        // Name and order stay editable; the same direction is not a change.
        await api().put(`/api/v1/categories/${payroll.id}`).send({ name: 'Wages', direction: 'out' }).expect(200);
        await h.sql('UPDATE cash_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [item]);

        const sched = await insertSchedule(h, { accountId: account.id, categoryId: payroll.id });
        const again = await api().put(`/api/v1/categories/${payroll.id}`).send({ direction: 'in' }).expect(409);
        expect(again.body.details).toEqual({ itemCount: 0, scheduleCount: 1 });
        await h.sql('UPDATE schedules SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [sched]);
    });

    test('delete is refused while in use, then soft-deletes with an audit row', async () => {
        const item = await insertItem(h, { accountId: account.id, categoryId: sales.id });
        const sched = await insertSchedule(h, { accountId: account.id, categoryId: sales.id });
        const res = await api().delete(`/api/v1/categories/${sales.id}`).expect(409);
        expect(res.body).toMatchObject({ code: 'CATEGORY_IN_USE', details: { itemCount: 1, scheduleCount: 1 } });

        await h.sql('UPDATE cash_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [item]);
        await h.sql('UPDATE schedules SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [sched]);
        const stale = await api().delete(`/api/v1/categories/${sales.id}`).send({ baseVersion: 9 }).expect(409);
        expect(stale.body.code).toBe('STALE_WRITE');
        await api().delete(`/api/v1/categories/${sales.id}`).send({ baseVersion: 0 }).expect(204);

        await api().get(`/api/v1/categories/${sales.id}`).expect(404);
        await api().delete(`/api/v1/categories/${sales.id}`).expect(404);
        const gone = (await api().get(`/api/v1/categories/${sales.id}`).query({ includeDeleted: 1 }).expect(200)).body;
        expect(gone.deletedAt).not.toBeNull();
        expect((await api().get('/api/v1/categories').expect(200)).body.total).toBe(2);
        expect((await api().get('/api/v1/categories').query({ includeDeleted: 1 }).expect(200)).body.total).toBe(3);

        const [del] = await h.audit('category', sales.id);
        expect(del).toMatchObject({ action: 'delete', before: { deletedAt: null } });
    });
});
