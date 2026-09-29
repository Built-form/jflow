'use strict';

// One-off items (CONTRACT §6.7, §9.6, §10.3; D10, D12, D14, D17, D19, D23), end
// to end against a per-run jflow_test_<runid> schema, with `today` pinned
// through ?today= (local/test only, D24) and an anchor recorded on the main
// account:
//   - create / update validation, direction = the category's (D14), soft delete;
//   - every derivedStatus value against the anchor, no anchor (D12), and
//     "Didn't happen" (settleMode manual on an assumedSettled item);
//   - status expected ↔ skipped only (D19), ITEM_NOT_EDITABLE;
//   - the pay / unpay state machine: two part payments straddling the anchor,
//     each classified on its own paid_on (D23), pay to full → paid, unpay;
//   - PAID_ON_IN_FUTURE, PAID_AMOUNT_INVALID (≤ 0, > remaining, nothing left),
//     REMAINDER_DATE_REQUIRED and the remainder date moving due_date;
//   - an audit row for every mutation, one per payment row;
//   - STALE_WRITE; list params; the D17 guard ignoring assumedSettled one-offs.

const { startHarness } = require('./harness');
const { classify } = require('../../src/lib/classify');
const { itemLine } = require('../../src/lib/lines');

jest.setTimeout(180000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const api = () => h.api();
const TODAY = '2026-03-10';
const A = '2026-03-01';           // the main account's anchor

const withToday = (req, today) => req.query(today ? { today } : {});
const post = (path, body, today = TODAY) => withToday(api().post(`/api/v1${path}`), today).send(body);
const put = (path, body, today = TODAY) => withToday(api().put(`/api/v1${path}`), today).send(body);
const del = (path, body = {}) => api().delete(`/api/v1${path}`).send(body);
const get = (path, query = {}) => api().get(`/api/v1${path}`).query({ today: TODAY, ...query });
const pay = (id, body, today = TODAY) => post(`/items/${id}/pay`, body, today);
const unpay = (id, body = {}, today = TODAY) => post(`/items/${id}/unpay`, body, today);

const ROW_KEYS = [
    'accountId', 'amount', 'categoryId', 'companyId', 'counterparty', 'createdAt', 'createdBy', 'currency',
    'deletedAt', 'derivedStatus', 'direction', 'dueDate', 'id', 'key', 'name', 'notes', 'paidAmount', 'paidOn',
    'payments', 'remainingAmount', 'rowVersion', 'settleMode', 'sourceScenarioId', 'status', 'updatedAt',
];

describe('items', () => {
    let jfa;
    let hw;
    let main;      // JFA, GBP, anchor at A
    let bare;      // JFA, GBP, no balance (D12)
    let eur;       // JFA, EUR
    let dormant;   // JFA, inactive
    let out;       // category, direction out
    let sales;     // category, direction in

    const makeItem = async (body = {}) => (await post('/items', {
        accountId: main.id, categoryId: out.id, name: 'Item', amount: '100.00', dueDate: '2026-03-15', ...body,
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
        await put(`/accounts/${main.id}/balances/2026-02-22`, { balance: '900.00' }).expect(200);
        await put(`/accounts/${main.id}/balances/${A}`, { balance: '1000.00' }).expect(200);
    });

    test('create validates the body; a direction other than the category\'s is 400 (D14)', async () => {
        const good = { accountId: main.id, categoryId: out.id, name: 'Rent', amount: '100.00', dueDate: '2026-03-15' };
        const bad = [
            [{ ...good, accountId: undefined }, /accountId/],
            [{ ...good, accountId: 'x' }, /accountId/],
            [{ ...good, categoryId: undefined }, /categoryId/],
            [{ ...good, name: '  ' }, /name/],
            [{ ...good, amount: 100 }, /amount/],
            [{ ...good, amount: '0' }, /amount/],
            [{ ...good, amount: '-1.00' }, /amount/],
            [{ ...good, amount: '1.234' }, /amount/],
            [{ ...good, dueDate: '2026-02-30' }, /dueDate/],
            [{ ...good, dueDate: undefined }, /dueDate/],
            [{ ...good, direction: 'sideways' }, /direction/],
            [{ ...good, currency: 'gbp' }, /currency/],
            [{ ...good, settleMode: 'sometimes' }, /settleMode/],
            [{ ...good, counterparty: 5 }, /counterparty/],
            [{ ...good, notes: 'x'.repeat(16001) }, /notes/],
            [{ ...good, accountId: 999999 }, /not a live account/],
            [{ ...good, accountId: dormant.id }, /inactive/],
            [{ ...good, categoryId: 999999 }, /not a live category/],
            [{ ...good, direction: 'in' }, /direction must be the category's/],
        ];
        for (const [body, msg] of bad) {
            const res = await post('/items', body).expect(400);
            expect(res.body.error).toMatch(msg);
        }
        const d14 = await post('/items', { ...good, categoryId: sales.id, direction: 'out' }).expect(400);
        expect(d14.body.details).toEqual({ direction: 'out', categoryDirection: 'in' });
        await post('/items', good, 'not-a-date').expect(400);
        expect((await get('/items').expect(200)).body.total).toBe(0);
    });

    test('create: defaults from the account and category, the row shape, the audit row; read by id', async () => {
        const res = await post('/items', {
            accountId: eur.id, categoryId: out.id, name: ' Invoice 42 ', amount: '1024', dueDate: '2026-03-20',
            direction: 'out', counterparty: ' ACME ', notes: 'net 30',
        }).expect(201);
        const item = res.body;
        expect(Object.keys(item).sort()).toEqual(ROW_KEYS);
        expect(item).toMatchObject({
            key: `item.${item.id}`, accountId: eur.id, companyId: jfa.id, categoryId: out.id, direction: 'out',
            name: 'Invoice 42', counterparty: 'ACME', amount: '1024.00', currency: 'EUR', dueDate: '2026-03-20',
            status: 'expected', paidOn: null, paidAmount: null, remainingAmount: '1024.00', payments: [],
            settleMode: 'auto', notes: 'net 30', sourceScenarioId: null, derivedStatus: 'expected',
            rowVersion: 0, createdBy: 'local@dev', deletedAt: null,
        });
        const [audit] = await h.audit('cash_item', item.id);
        expect(audit).toMatchObject({ action: 'create', before: null });
        expect(audit.after).toMatchObject({ id: item.id, key: item.key, amount: '1024.00', currency: 'EUR', status: 'expected' });
        expect(audit.after).not.toHaveProperty('payments');
        expect(audit.after).not.toHaveProperty('derivedStatus');

        // Direction follows the category when omitted; an explicit currency and settle mode stick.
        const income = (await post('/items', {
            accountId: bare.id, categoryId: sales.id, name: 'Sale', amount: '5.5', dueDate: '2026-03-20',
            currency: 'USD', settleMode: 'manual',
        }).expect(201)).body;
        expect(income).toMatchObject({ direction: 'in', currency: 'USD', amount: '5.50', settleMode: 'manual', counterparty: null });

        const read = (await get(`/items/${item.id}`).expect(200)).body;
        expect(read).toEqual({ ...item, updatedAt: read.updatedAt, createdAt: read.createdAt });
        await get('/items/abc').expect(404);
        await get('/items/999999').expect(404);
    });

    test('derivedStatus: every value against the recorded anchor, at a pinned today', async () => {
        const cases = [
            ['expected', { dueDate: '2026-03-15' }],
            ['expected', { dueDate: TODAY }],                                    // row 7: today is future
            ['expected', { dueDate: '2026-03-12', settleMode: 'manual' }],
            ['assumed', { dueDate: '2026-03-05' }],                              // row 6
            ['assumed', { dueDate: A }],                                         // A itself is not inside the anchor
            ['assumedSettled', { dueDate: '2026-02-28' }],                       // row 5: A − 1
            ['overdue', { dueDate: '2026-03-05', settleMode: 'manual' }],        // row 8
            ['overdue', { dueDate: '2026-01-24', settleMode: 'manual' }],        // today − 45 (D9)
            ['unresolved', { dueDate: '2026-01-23', settleMode: 'manual' }],     // today − 46
        ];
        const made = [];
        for (const [expected, body] of cases) {
            const item = await makeItem({ ...body, name: `derived ${expected}` });
            expect(item.derivedStatus).toBe(expected);
            made.push([item.id, expected]);
        }
        const skipped = await makeItem({ dueDate: '2026-02-20', name: 'derived skipped' });
        expect((await put(`/items/${skipped.id}`, { status: 'skipped' }).expect(200)).body.derivedStatus).toBe('skipped');
        made.push([skipped.id, 'skipped']);
        const paid = await makeItem({ dueDate: '2026-02-20', name: 'derived paid' });
        expect((await pay(paid.id, { paidOn: '2026-02-19' }).expect(200)).body.derivedStatus).toBe('paid');
        made.push([paid.id, 'paid']);

        // The list and the single read agree with the mutation responses.
        const listed = new Map((await get('/items', { accountId: main.id, limit: 500 }).expect(200)).body.data
            .map((i) => [i.id, i.derivedStatus]));
        for (const [id, expected] of made) {
            expect(listed.get(id)).toBe(expected);
            expect((await get(`/items/${id}`).expect(200)).body.derivedStatus).toBe(expected);
        }
        expect(new Set(made.map(([, s]) => s))).toEqual(new Set(
            ['expected', 'overdue', 'unresolved', 'assumed', 'assumedSettled', 'paid', 'skipped'],
        ));
    });

    test('derivedStatus with no anchor (D12), and the anchor as of a pinned today', async () => {
        const old = await makeItem({ accountId: bare.id, dueDate: '2026-01-01' });
        expect(old.derivedStatus).toBe('assumed');                   // never assumedSettled without a balance
        expect((await makeItem({ accountId: bare.id, dueDate: '2026-03-12' })).derivedStatus).toBe('expected');
        expect((await makeItem({ accountId: bare.id, dueDate: '2026-03-05', settleMode: 'manual' })).derivedStatus)
            .toBe('overdue');

        // On main, an item on 20 Feb is assumedSettled today (A = 1 Mar)...
        const feb = await makeItem({ dueDate: '2026-02-20' });
        expect(feb.derivedStatus).toBe('assumedSettled');
        // ...on 25 Feb the anchor is the 22 Feb balance, so it is still settled...
        expect((await get(`/items/${feb.id}`, { today: '2026-02-25' }).expect(200)).body.derivedStatus).toBe('assumedSettled');
        // ...and on 21 Feb, before any balance, it is 'assumed' (D12): a balance after today is no anchor.
        expect((await get(`/items/${feb.id}`, { today: '2026-02-21' }).expect(200)).body.derivedStatus).toBe('assumed');
        await get(`/items/${feb.id}`, { today: 'yesterday' }).expect(400);
    });

    test('"Didn\'t happen": settleMode manual on an assumedSettled one-off makes it overdue or unresolved', async () => {
        const recent = await makeItem({ dueDate: '2026-02-20', name: 'Refund due' });   // today − 18
        const old = await makeItem({ dueDate: '2026-01-01', name: 'Old refund' });      // today − 68
        expect([recent.derivedStatus, old.derivedStatus]).toEqual(['assumedSettled', 'assumedSettled']);

        const r = (await put(`/items/${recent.id}`, { settleMode: 'manual' }).expect(200)).body;
        expect(r).toMatchObject({ settleMode: 'manual', status: 'expected', derivedStatus: 'overdue', rowVersion: 1 });
        const o = (await put(`/items/${old.id}`, { settleMode: 'manual' }).expect(200)).body;
        expect(o.derivedStatus).toBe('unresolved');
        const [audit] = await h.audit('cash_item', recent.id);
        expect(audit).toMatchObject({ action: 'update', before: { settleMode: 'auto' }, after: { settleMode: 'manual' } });

        // And back: auto again is assumed settled again (nothing was written but the mode).
        expect((await put(`/items/${recent.id}`, { settleMode: 'auto' }).expect(200)).body.derivedStatus).toBe('assumedSettled');
    });

    test('update: validation, moves, direction follows the category, a no-op writes nothing', async () => {
        const item = await makeItem({ name: 'Original', amount: '50.00', counterparty: 'Someone' });
        await put(`/items/${item.id}`, {}).expect(400);
        await put(`/items/${item.id}`, { unknown: 1 }).expect(400);
        const bad = [
            { name: ' ' }, { amount: 50 }, { amount: '0' }, { amount: '-2.00' }, { currency: 'eu' },
            { dueDate: '2026-13-01' }, { settleMode: 'never' }, { status: 'paid' }, { status: 'part_paid' },
            { direction: 'up' }, { accountId: 'x' }, { categoryId: 0 }, { counterparty: 5 }, { baseVersion: -1 },
        ];
        for (const body of bad) await put(`/items/${item.id}`, body).expect(400);
        await put('/items/abc', { name: 'x' }).expect(404);
        await put('/items/999999', { name: 'x' }).expect(404);
        expect((await put(`/items/${item.id}`, { accountId: dormant.id }).expect(400)).body.error).toMatch(/inactive/);
        expect((await put(`/items/${item.id}`, { accountId: 999999 }).expect(400)).body.error).toMatch(/not a live account/);
        expect((await put(`/items/${item.id}`, { categoryId: 999999 }).expect(400)).body.error).toMatch(/not a live category/);

        // A category of the other direction carries the item's direction with it (D14).
        const moved = (await put(`/items/${item.id}`, { categoryId: sales.id }).expect(200)).body;
        expect(moved).toMatchObject({ categoryId: sales.id, direction: 'in', rowVersion: 1 });
        expect((await put(`/items/${item.id}`, { direction: 'out' }).expect(400)).body.error).toMatch(/direction/);
        await put(`/items/${item.id}`, { categoryId: out.id, direction: 'in' }).expect(400);
        const back = (await put(`/items/${item.id}`, { categoryId: out.id, direction: 'out' }).expect(200)).body;
        expect(back).toMatchObject({ categoryId: out.id, direction: 'out', rowVersion: 2 });

        const edited = (await put(`/items/${item.id}`, {
            accountId: bare.id, name: 'Edited', counterparty: null, amount: '75.5', currency: 'EUR',
            dueDate: '2026-04-01', notes: 'moved',
        }).expect(200)).body;
        expect(edited).toMatchObject({
            accountId: bare.id, name: 'Edited', counterparty: null, amount: '75.50', currency: 'EUR',
            dueDate: '2026-04-01', notes: 'moved', remainingAmount: '75.50', rowVersion: 3,
        });
        const [audit] = await h.audit('cash_item', item.id);
        expect(audit).toMatchObject({
            action: 'update',
            before: { accountId: main.id, name: 'Original', counterparty: 'Someone', amount: '50.00' },
            after: { accountId: bare.id, name: 'Edited', counterparty: null, amount: '75.50' },
        });

        // Sending what is already stored is not a change: no version bump, no audit row.
        const trail = (await h.audit('cash_item', item.id)).length;
        const same = (await put(`/items/${item.id}`, {
            accountId: bare.id, categoryId: out.id, direction: 'out', name: 'Edited', amount: '75.50', currency: 'EUR',
        }).expect(200)).body;
        expect(same.rowVersion).toBe(3);
        expect(await h.audit('cash_item', item.id)).toHaveLength(trail);
    });

    test('status moves only between expected and skipped (D19)', async () => {
        const item = await makeItem({ dueDate: '2026-03-05' });
        expect(item.derivedStatus).toBe('assumed');
        const skipped = (await put(`/items/${item.id}`, { status: 'skipped' }).expect(200)).body;
        expect(skipped).toMatchObject({ status: 'skipped', derivedStatus: 'skipped' });
        const back = (await put(`/items/${item.id}`, { status: 'expected' }).expect(200)).body;
        expect(back).toMatchObject({ status: 'expected', derivedStatus: 'assumed' });
        await put(`/items/${item.id}`, { status: 'paid' }).expect(400);

        // A skipped item may still be paid (§10.3 step 5).
        await put(`/items/${item.id}`, { status: 'skipped' }).expect(200);
        expect((await pay(item.id, { paidOn: TODAY }).expect(200)).body.status).toBe('paid');
    });

    test('pay / unpay: two part payments straddling the anchor, each on its own paid_on; pay to full; unpay', async () => {
        const item = await makeItem({ name: 'Straddle', amount: '1000.00', dueDate: '2026-03-20' });

        // D23's example: 400 at A − 5, then 300 at A + 2.
        const p1 = (await pay(item.id, { paidOn: '2026-02-24', paidAmount: '400', note: 'first' }).expect(200)).body;
        expect(p1).toMatchObject({
            status: 'part_paid', paidOn: '2026-02-24', paidAmount: '400.00', remainingAmount: '600.00',
            dueDate: '2026-03-20', derivedStatus: 'expected', rowVersion: 1,
        });
        expect(p1.payments).toEqual([{
            id: expect.any(Number), paidOn: '2026-02-24', amount: '400.00', note: 'first',
            createdBy: 'local@dev', createdAt: expect.any(String),
        }]);

        const p2 = (await pay(item.id, { paidOn: '2026-03-03', paidAmount: '300.00' }).expect(200)).body;
        expect(p2).toMatchObject({
            status: 'part_paid', paidOn: '2026-03-03', paidAmount: '700.00', remainingAmount: '300.00',
            derivedStatus: 'expected', rowVersion: 2,
        });
        expect(p2.payments.map((p) => [p.paidOn, p.amount, p.note])).toEqual([
            ['2026-02-24', '400.00', 'first'], ['2026-03-03', '300.00', null],
        ]);

        // Each payment row is classified on its own paid_on — the row before the
        // anchor is inside the balance, the one after is not — and the remainder is owed.
        const classified = classify(itemLine(p2), A, TODAY);
        expect(classified.payments.map((p) => [p.paymentId, p.band, p.date, p.amountMinor])).toEqual([
            [p2.payments[0].id, 'settledBeforeAnchor', '2026-02-24', 40000n],
            [p2.payments[1].id, 'paid', '2026-03-03', 30000n],
        ]);
        expect(classified.owed).toEqual({ band: 'future', date: '2026-03-20', amountMinor: 30000n, remainder: true });
        // Moving the anchor before both payments puts both after it.
        expect(classify(itemLine(p2), '2026-02-22', TODAY).payments.map((p) => p.band)).toEqual(['paid', 'paid']);

        const listed = (await get('/items', { accountId: main.id, limit: 500 }).expect(200)).body.data
            .find((i) => i.id === item.id);
        expect(listed).toMatchObject({ status: 'part_paid', paidAmount: '700.00', derivedStatus: 'expected' });
        expect(listed.payments).toEqual(p2.payments);

        // paidAmount defaults to what remains: paid in full.
        const p3 = (await pay(item.id, { paidOn: TODAY }).expect(200)).body;
        expect(p3).toMatchObject({
            status: 'paid', paidOn: TODAY, paidAmount: '1000.00', remainingAmount: '0.00',
            derivedStatus: 'paid', rowVersion: 3,
        });
        expect(p3.payments.map((p) => p.amount)).toEqual(['400.00', '300.00', '300.00']);

        const none = await pay(item.id, { paidOn: TODAY }).expect(422);
        expect(none.body).toMatchObject({
            code: 'PAID_AMOUNT_INVALID', details: { paidAmount: '0.00', remainingAmount: '0.00' },
        });

        // Unpay removes every payment row and resets the cache and status; due_date stays.
        const u = (await unpay(item.id).expect(200)).body;
        expect(u).toMatchObject({
            status: 'expected', paidOn: null, paidAmount: null, remainingAmount: '1000.00', payments: [],
            dueDate: '2026-03-20', derivedStatus: 'expected', rowVersion: 4,
        });
        expect(await h.sql('SELECT id FROM payments WHERE cash_item_id = ?', [item.id])).toEqual([]);
        // Idempotent on an expected item: unchanged, no version bump.
        expect((await unpay(item.id).expect(200)).body.rowVersion).toBe(4);
        // And it can be paid again.
        expect((await pay(item.id, { paidOn: TODAY, paidAmount: '1.00' }).expect(200)).body)
            .toMatchObject({ status: 'part_paid', paidAmount: '1.00', rowVersion: 5 });
    });

    test('pay refusals: PAID_ON_IN_FUTURE, PAID_AMOUNT_INVALID (≤ 0 and > remaining), the 400s and 404s', async () => {
        const item = await makeItem({ amount: '1000.00', dueDate: '2026-03-15' });

        const future = await pay(item.id, { paidOn: '2026-03-11' }).expect(422);
        expect(future.body).toEqual({
            error: expect.any(String), code: 'PAID_ON_IN_FUTURE', details: { paidOn: '2026-03-11', today: TODAY },
        });

        for (const [paidAmount, shown] of [['0', '0.00'], ['0.00', '0.00'], ['-5.00', '-5.00'], ['1000.01', '1000.01']]) {
            const res = await pay(item.id, { paidOn: TODAY, paidAmount }).expect(422);
            expect(res.body).toMatchObject({
                code: 'PAID_AMOUNT_INVALID', details: { paidAmount: shown, remainingAmount: '1000.00' },
            });
        }
        // After a part payment the ceiling is the remainder.
        await pay(item.id, { paidOn: TODAY, paidAmount: '600.00' }).expect(200);
        const over = await pay(item.id, { paidOn: TODAY, paidAmount: '400.01' }).expect(422);
        expect(over.body.details).toEqual({ paidAmount: '400.01', remainingAmount: '400.00' });

        const bad = [
            {}, { paidOn: '2026-3-1' }, { paidOn: TODAY, paidAmount: 5 }, { paidOn: TODAY, paidAmount: 'abc' },
            { paidOn: TODAY, remainderDueDate: '2026-02-30' }, { paidOn: TODAY, remainderDueDate: '2026-03-09' },
            { paidOn: TODAY, note: 'x'.repeat(501) }, { paidOn: TODAY, baseVersion: 'x' },
        ];
        for (const body of bad) await pay(item.id, body).expect(400);
        await pay(999999, { paidOn: TODAY }).expect(404);
        await pay('abc', { paidOn: TODAY }).expect(404);
        await unpay(999999).expect(404);

        // No refusal wrote anything: one payment row, the one that went through.
        const now = (await get(`/items/${item.id}`).expect(200)).body;
        expect(now).toMatchObject({ paidAmount: '600.00', rowVersion: 1 });
        expect(now.payments).toHaveLength(1);
    });

    test('REMAINDER_DATE_REQUIRED, and the remainder date moving due_date', async () => {
        const due = await makeItem({ amount: '500.00', dueDate: '2026-03-05' });   // before today
        const refused = await pay(due.id, { paidOn: TODAY, paidAmount: '200.00' }).expect(422);
        expect(refused.body).toMatchObject({
            code: 'REMAINDER_DATE_REQUIRED', details: { dueDate: '2026-03-05', today: TODAY },
        });
        expect((await get(`/items/${due.id}`).expect(200)).body).toMatchObject({ status: 'expected', payments: [], rowVersion: 0 });

        const ok = (await pay(due.id, { paidOn: TODAY, paidAmount: '200.00', remainderDueDate: '2026-03-20' }).expect(200)).body;
        expect(ok).toMatchObject({
            status: 'part_paid', dueDate: '2026-03-20', paidAmount: '200.00', remainingAmount: '300.00',
            derivedStatus: 'expected',
        });
        const [audit] = await h.audit('cash_item', due.id);
        expect(audit).toMatchObject({ action: 'pay', before: { dueDate: '2026-03-05' }, after: { dueDate: '2026-03-20' } });
        // The remainder is forced manual (D10): once its date passes it is overdue, never assumed.
        expect((await get(`/items/${due.id}`, { today: '2026-03-25' }).expect(200)).body.derivedStatus).toBe('overdue');

        // Today is a valid remainder date.
        const early = await makeItem({ amount: '50.00', dueDate: A });
        expect((await pay(early.id, { paidOn: A, paidAmount: '1.00', remainderDueDate: TODAY }).expect(200)).body.dueDate)
            .toBe(TODAY);
        // A full payment of an overdue item needs no remainder date, and keeps its date.
        const overdue = await makeItem({ amount: '80.00', dueDate: '2026-03-02', settleMode: 'manual' });
        expect(overdue.derivedStatus).toBe('overdue');
        expect((await pay(overdue.id, { paidOn: TODAY }).expect(200)).body).toMatchObject({ status: 'paid', dueDate: '2026-03-02' });
        // Nor does a part payment of an item due today.
        const dueToday = await makeItem({ amount: '80.00', dueDate: TODAY });
        expect((await pay(dueToday.id, { paidOn: TODAY, paidAmount: '10.00' }).expect(200)).body)
            .toMatchObject({ status: 'part_paid', dueDate: TODAY });
    });

    test('ITEM_NOT_EDITABLE: status, amount and currency belong to pay / unpay on a paid or part_paid item', async () => {
        const item = await makeItem({ amount: '100.00', dueDate: '2026-03-20' });
        await pay(item.id, { paidOn: TODAY, paidAmount: '40.00' }).expect(200);
        for (const body of [{ status: 'skipped' }, { status: 'expected' }, { amount: '120.00' }, { currency: 'EUR' }]) {
            const res = await put(`/items/${item.id}`, body).expect(409);
            expect(res.body).toMatchObject({ code: 'ITEM_NOT_EDITABLE', details: { status: 'part_paid' } });
        }
        // Unchanged values are not a change, and everything else stays editable.
        const edited = (await put(`/items/${item.id}`, {
            amount: '100', currency: 'GBP', name: 'Renamed', dueDate: '2026-04-01', settleMode: 'manual',
        }).expect(200)).body;
        expect(edited).toMatchObject({ name: 'Renamed', dueDate: '2026-04-01', settleMode: 'manual', status: 'part_paid' });

        await pay(item.id, { paidOn: TODAY }).expect(200);
        const paid = await put(`/items/${item.id}`, { amount: '1.00' }).expect(409);
        expect(paid.body).toMatchObject({ code: 'ITEM_NOT_EDITABLE', details: { status: 'paid' } });
    });

    test('STALE_WRITE on update, pay, unpay and delete', async () => {
        const item = await makeItem();
        const stale = await put(`/items/${item.id}`, { name: 'x', baseVersion: 5 }).expect(409);
        expect(stale.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 0 } });
        expect((await put(`/items/${item.id}`, { name: 'y', baseVersion: 0 }).expect(200)).body.rowVersion).toBe(1);

        const stalePay = await pay(item.id, { paidOn: TODAY, paidAmount: '1.00', baseVersion: 0 }).expect(409);
        expect(stalePay.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 1 } });
        expect((await pay(item.id, { paidOn: TODAY, paidAmount: '1.00', baseVersion: 1 }).expect(200)).body.rowVersion).toBe(2);

        const staleUnpay = await unpay(item.id, { baseVersion: 1 }).expect(409);
        expect(staleUnpay.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 2 } });
        expect((await unpay(item.id, { baseVersion: 2 }).expect(200)).body.rowVersion).toBe(3);

        const staleDelete = await del(`/items/${item.id}`, { baseVersion: 2 }).expect(409);
        expect(staleDelete.body).toMatchObject({ code: 'STALE_WRITE', details: { currentVersion: 3 } });
        await del(`/items/${item.id}`, { baseVersion: 3 }).expect(204);
    });

    test('an audit row for every mutation, and one per payment row inserted or deleted', async () => {
        const item = await makeItem({ amount: '90.00', dueDate: '2026-03-20' });
        await put(`/items/${item.id}`, { name: 'Audited' }).expect(200);
        await pay(item.id, { paidOn: '2026-02-28', paidAmount: '30.00', note: 'deposit' }).expect(200);
        const paid = (await pay(item.id, { paidOn: TODAY }).expect(200)).body;
        await unpay(item.id).expect(200);
        await del(`/items/${item.id}`).expect(204);

        const trail = await h.audit('cash_item', item.id);
        expect(trail.map((r) => r.action)).toEqual(['delete', 'unpay', 'pay', 'pay', 'update', 'create']);
        const [deleted, unpaid, secondPay, firstPay] = trail;
        expect(firstPay).toMatchObject({
            before: { status: 'expected', paidOn: null, paidAmount: null, remainingAmount: '90.00' },
            after: { status: 'part_paid', paidOn: '2026-02-28', paidAmount: '30.00', remainingAmount: '60.00' },
        });
        expect(secondPay).toMatchObject({
            before: { status: 'part_paid', paidOn: '2026-02-28', paidAmount: '30.00' },
            after: { status: 'paid', paidOn: TODAY, paidAmount: '90.00' },
        });
        expect(unpaid).toMatchObject({
            before: { status: 'paid', paidOn: TODAY, paidAmount: '90.00' },
            after: { status: 'expected', paidOn: null, paidAmount: null },
        });
        expect(deleted).toMatchObject({ before: { deletedAt: null } });
        expect(deleted.after.deletedAt).not.toBeNull();

        const snapshots = [
            { cashItemId: item.id, overrideId: null, paidOn: '2026-02-28', amount: '30.00', note: 'deposit' },
            { cashItemId: item.id, overrideId: null, paidOn: TODAY, amount: '60.00', note: null },
        ];
        expect(paid.payments.map((p) => p.amount)).toEqual(['30.00', '60.00']);
        for (const [i, p] of paid.payments.entries()) {
            const rows = await h.audit('payment', p.id);
            expect(rows.map((r) => r.action)).toEqual(['delete', 'create']);
            expect(rows[1]).toMatchObject({ before: null, after: snapshots[i], userEmail: 'local@dev' });
            expect(rows[0]).toMatchObject({ before: snapshots[i], after: null });
        }

        // Nothing changed → nothing audited: a no-op PUT and an unpay with nothing to undo.
        const quiet = await makeItem({ name: 'Quiet' });
        await put(`/items/${quiet.id}`, { name: 'Quiet' }).expect(200);
        await unpay(quiet.id).expect(200);
        expect((await h.audit('cash_item', quiet.id)).map((r) => r.action)).toEqual(['create']);
    });

    describe('list and delete', () => {
        let acct;
        const ids = {};

        beforeAll(async () => {
            acct = (await api().post('/api/v1/accounts').send({ companyId: hw.id, name: 'HW list', currency: 'GBP' }).expect(201)).body;
            const mk = async (key, body) => {
                ids[key] = (await makeItem({ accountId: acct.id, name: key, ...body })).id;
            };
            await mk('Alpha', { dueDate: '2026-04-03', counterparty: 'Zed Ltd' });
            await mk('Beta', { dueDate: '2026-04-01', settleMode: 'manual' });
            await mk('Gamma', { dueDate: '2026-04-01' });
            await mk('Delta', { dueDate: '2026-04-05', categoryId: sales.id });
            await mk('Epsilon', { dueDate: '2026-04-07' });
            await mk('Zeta', { dueDate: '2026-04-02' });
            await put(`/items/${ids.Epsilon}`, { status: 'skipped' }).expect(200);
            await del(`/items/${ids.Zeta}`).expect(204);
        });

        const list = async (query) => (await get('/items', { accountId: acct.id, ...query }).expect(200)).body;
        const names = (body) => body.data.map((i) => i.name);

        test('sorted by due_date then id; filters; paging; includeDeleted', async () => {
            const all = await list();
            expect(all.total).toBe(5);
            expect(names(all)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta', 'Epsilon']);
            all.data.forEach((i) => expect(Object.keys(i).sort()).toEqual(ROW_KEYS));

            expect(names(await get('/items', { companyId: hw.id }).then((r) => r.body))).toEqual(names(all));
            expect(names(await list({ categoryId: sales.id }))).toEqual(['Delta']);
            expect(names(await list({ status: 'skipped' }))).toEqual(['Epsilon']);
            expect(names(await list({ status: 'expected,skipped' }))).toHaveLength(5);
            expect(names(await list({ settleMode: 'manual' }))).toEqual(['Beta']);
            expect(names(await list({ from: '2026-04-02', to: '2026-04-04' }))).toEqual(['Alpha']);
            expect(names(await list({ q: 'zed' }))).toEqual(['Alpha']);
            expect(names(await list({ q: 'amm' }))).toEqual(['Gamma']);
            const paged = await list({ limit: 2, page: 2 });
            expect(paged).toMatchObject({ page: 2, limit: 2, total: 5 });
            expect(names(paged)).toEqual(['Alpha', 'Delta']);
            const withDeleted = await list({ includeDeleted: '1' });
            expect(withDeleted.total).toBe(6);
            expect(names(withDeleted)).toContain('Zeta');

            for (const query of [
                { accountId: 'x' }, { companyId: 0 }, { categoryId: 'a' }, { status: 'owed' },
                { settleMode: 'x' }, { from: '2026-04-31' }, { to: 'soon' }, { today: '2026/03/10' },
            ]) {
                await get('/items', query).expect(400);
            }
        });

        test('soft delete: any status, 404 afterwards, includeDeleted, audit', async () => {
            await pay(ids.Gamma, { paidOn: TODAY }).expect(200);
            await del(`/items/${ids.Gamma}`).expect(204);
            await get(`/items/${ids.Gamma}`).expect(404);
            const gone = (await get(`/items/${ids.Gamma}`, { includeDeleted: '1' }).expect(200)).body;
            expect(gone).toMatchObject({ status: 'paid', derivedStatus: 'paid' });
            expect(gone.deletedAt).not.toBeNull();
            await del(`/items/${ids.Gamma}`).expect(404);
            await put(`/items/${ids.Gamma}`, { name: 'x' }).expect(404);
            await pay(ids.Gamma, { paidOn: TODAY }).expect(404);
            await unpay(ids.Gamma).expect(404);
            await del('/items/abc').expect(404);
            await del(`/items/${ids.Alpha}`, { baseVersion: 'x' }).expect(400);
            expect((await h.audit('cash_item', ids.Gamma))[0]).toMatchObject({ action: 'delete', before: { deletedAt: null } });
            expect((await list()).total).toBe(4);
        });
    });

    test('D17: deactivation ignores assumedSettled one-offs and counts the rest', async () => {
        const closing = (await api().post('/api/v1/accounts').send({ companyId: jfa.id, name: 'Closing', currency: 'GBP' }).expect(201)).body;
        await put(`/accounts/${closing.id}/balances/${A}`, { balance: '10.00' }).expect(200);
        const settled = await makeItem({ accountId: closing.id, dueDate: '2026-02-20' });
        const assumed = await makeItem({ accountId: closing.id, dueDate: '2026-03-05' });
        const part = await makeItem({ accountId: closing.id, amount: '100.00', dueDate: '2026-03-20' });
        await pay(part.id, { paidOn: TODAY, paidAmount: '40.00' }).expect(200);
        expect([settled.derivedStatus, assumed.derivedStatus]).toEqual(['assumedSettled', 'assumed']);

        const refused = await put(`/accounts/${closing.id}`, { isActive: false }).expect(409);
        expect(refused.body).toMatchObject({ code: 'ACCOUNT_IN_USE' });
        expect(refused.body.details).toEqual({
            owedItems: { count: 2, keys: [assumed.key, part.key] },
            liveSchedules: { count: 0, ids: [] },
            owedInstances: { count: 0, keys: [] },
        });

        // "Didn't happen" brings the assumed-settled one back into what is owed.
        await put(`/items/${settled.id}`, { settleMode: 'manual' }).expect(200);
        const again = await put(`/accounts/${closing.id}`, { isActive: false }).expect(409);
        expect(again.body.details.owedItems).toEqual({ count: 3, keys: [settled.key, assumed.key, part.key] });

        // Settle the rest: back to auto, skip one, pay the part-paid one in full.
        await put(`/items/${settled.id}`, { settleMode: 'auto' }).expect(200);
        await put(`/items/${assumed.id}`, { status: 'skipped' }).expect(200);
        await pay(part.id, { paidOn: TODAY }).expect(200);
        const off = (await put(`/accounts/${closing.id}`, { isActive: false }).expect(200)).body;
        expect(off.isActive).toBe(false);
        // The assumed-settled item is still there, unchanged.
        expect((await get(`/items/${settled.id}`).expect(200)).body).toMatchObject({ status: 'expected', derivedStatus: 'assumedSettled' });
        // Nothing new goes onto an inactive account.
        const onto = await post('/items', { accountId: closing.id, categoryId: out.id, name: 'Late', amount: '1.00', dueDate: TODAY }).expect(400);
        expect(onto.body.error).toMatch(/inactive/);
    });
});
