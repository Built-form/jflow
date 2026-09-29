'use strict';

// GET /forecast (CONTRACT §6.10, §8, §9; D7, D12, D20, D24, D25, D31; BUILD_PLAN step 6),
// end to end against a per-run jflow_test_<runid> schema with `today` pinned through
// ?today= (local/test only, D24). Every test builds its own company, so the account set
// of each request is exactly that test's data (company scope through bank_accounts).
//
// Companies, accounts, categories, balances, fx-rates and one-off items go through their
// routes; schedules, overrides, override payments, scenarios and adjustments are SQL rows
// (forecastHelpers.js), written the way step 5's and step 7's writers leave them.
//
// The agreement test compares derivedStatus from GET /items (and GET
// /schedules/:id/instances, once step 5 mounts it) with /forecast's flags and lists.

const fs = require('fs');
const path = require('path');
const { startHarness } = require('./harness');
const {
    insertSchedule, insertOverride, insertOverridePayment, insertScenario, insertAdjustment,
} = require('./forecastHelpers');
const { londonToday } = require('../../src/lib/dates');

jest.setTimeout(240000);

let h;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { if (h) await h.stop(); });

const TODAY = '2026-03-10';       // a Tuesday; today + 90 = 2026-06-08, today + 730 = 2028-03-09

const api = () => h.api();
const withToday = (req, today) => req.query(today ? { today } : {});
const post = (p, body, today = TODAY) => withToday(api().post(`/api/v1${p}`), today).send(body);
const put = (p, body, today = TODAY) => withToday(api().put(`/api/v1${p}`), today).send(body);
const forecast = (query, today = TODAY) => api().get('/api/v1/forecast').query(today ? { today, ...query } : query);
const ok = async (query, today) => {
    const res = await forecast(query, today);
    if (res.status !== 200) throw new Error(`forecast ${JSON.stringify(query)} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
};

const lines = (body) => body.rows.flatMap((r) => r.items);
const linesOf = (body, key) => lines(body).filter((l) => l.key === key);
const owedLine = (body, key) => {
    const found = linesOf(body, key).filter((l) => l.paymentId === undefined);
    if (found.length > 1) throw new Error(`two owed lines for ${key}`);
    return found[0];
};
const absorbedOf = (body) => body.accounts.flatMap((a) => a.absorbed);
const dayOf = (body, date) => body.days.find((d) => d.date === date);

// The step-5 instances route, once it is mounted (checked when the file loads).
const HANDLER_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'handlers', 'jflow.js'), 'utf8');
const INSTANCES_MOUNTED = fs.existsSync(path.join(__dirname, '..', '..', 'src', 'routes', 'schedules.js'))
    && /routes\/schedules/.test(HANDLER_SRC);
const testInstances = INSTANCES_MOUNTED ? test : test.skip;

describe('GET /forecast', () => {
    let costs;
    let sales;
    let seq = 0;

    const company = async () => (await api().post('/api/v1/companies')
        .send({ code: `FC${++seq}`, name: `Forecast ${seq}` }).expect(201)).body;
    /** An account, with a start-of-day balance at `anchor` when given. */
    const account = async (companyId, { name = 'Main', currency = 'GBP', anchor = null, balance = '1000.00' } = {}) => {
        const acct = (await api().post('/api/v1/accounts').send({ companyId, name, currency }).expect(201)).body;
        if (anchor) await put(`/accounts/${acct.id}/balances/${anchor}`, { balance }).expect(200);
        return acct;
    };
    const item = async (accountId, body, today = TODAY) => (await post('/items', {
        accountId, categoryId: costs.id, name: 'item', amount: '100.00', dueDate: TODAY, ...body,
    }, today).expect(201)).body;
    const schedule = (accountId, s) => insertSchedule(h, { accountId, categoryId: costs.id, ...s });

    beforeAll(async () => {
        costs = (await api().post('/api/v1/categories').send({ name: 'Costs', direction: 'out', sortOrder: 2 }).expect(201)).body;
        sales = (await api().post('/api/v1/categories').send({ name: 'Sales', direction: 'in', sortOrder: 1 }).expect(201)).body;
    });

    test('the response shape: every top-level key; include=summary omits rows', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: TODAY });
        const it = await item(acct.id, { dueDate: '2026-03-13', name: 'Rent' });

        const body = await ok({ companyId: co.id });
        expect(Object.keys(body)).toEqual(
            ['meta', 'accounts', 'days', 'buckets', 'rows', 'summary', 'scenario', 'unresolved', 'warnings'],
        );
        expect(body.meta).toEqual({
            today: TODAY, from: TODAY, to: '2026-06-08', bucket: 'week', fromClamped: false, toClamped: false,
            companyId: co.id, scenarioId: null, include: 'grid',
            ratesUsed: { GBP: { rateToGbp: '1.000000', effectiveFrom: null } },
            generatedAt: expect.any(String),
        });
        expect(Object.keys(body.meta).pop()).toBe('generatedAt');
        expect(new Date(body.meta.generatedAt).toISOString()).toBe(body.meta.generatedAt);
        expect(body.accounts).toHaveLength(1);
        expect(Object.keys(body.accounts[0]).sort()).toEqual([
            'absorbed', 'accountId', 'anchorAgeDays', 'anchorDate', 'anchorGbp', 'anchorNative', 'companyId',
            'currency', 'name', 'openingGbp', 'openingNative', 'rateToGbp',
        ]);
        expect(body.accounts[0]).toMatchObject({
            accountId: acct.id, companyId: co.id, currency: 'GBP', rateToGbp: '1.000000', anchorDate: TODAY,
            anchorAgeDays: 0, anchorNative: 100000, anchorGbp: 100000, openingNative: 100000, openingGbp: 100000,
            absorbed: [],
        });
        expect(body.days).toHaveLength(91);
        expect(Object.keys(body.days[0])).toEqual(['date', 'opening', 'inflow', 'outflow', 'net', 'closing']);
        for (const d of body.days) {
            for (const f of ['opening', 'inflow', 'outflow', 'net', 'closing']) expect(Number.isInteger(d[f])).toBe(true);
        }
        expect(Object.keys(body.buckets[0])).toEqual(
            ['start', 'end', 'opening', 'inflow', 'outflow', 'net', 'closing', 'minClosing', 'minDate'],
        );
        expect(body.buckets[0]).toMatchObject({ start: TODAY, end: '2026-03-15', outflow: 10000, closing: 90000 });
        expect(body.rows).toHaveLength(1);
        expect(Object.keys(body.rows[0])).toEqual(
            ['categoryId', 'categoryName', 'direction', 'sortOrder', 'totals', 'items', 'total'],
        );
        expect(body.rows[0]).toMatchObject({ categoryId: costs.id, categoryName: 'Costs', direction: 'out', total: 10000 });
        expect(body.rows[0].items).toEqual([{
            key: it.key, kind: 'item', id: it.id, name: 'Rent', counterparty: null, accountId: acct.id, currency: 'GBP',
            amountMinor: 10000, accountMinor: 10000, gbpMinor: 10000, date: '2026-03-13', dueDate: '2026-03-13',
            bucketIndex: 0, status: 'expected', settleMode: 'auto', flags: [], editable: true,
        }]);
        expect(Object.keys(body.summary)).toEqual([
            'opening', 'inflow', 'outflow', 'net', 'closing', 'minClosing', 'minDate', 'unresolvedCount',
            'unresolvedTotal', 'absorbedCount',
        ]);
        expect(body.summary).toMatchObject({ opening: 100000, outflow: 10000, closing: 90000, unresolvedCount: 0 });
        expect(body).toMatchObject({ scenario: null, unresolved: [], warnings: [] });

        const summary = await ok({ companyId: co.id, include: 'summary' });
        expect('rows' in summary).toBe(false);
        expect(Object.keys(summary)).toEqual(
            ['meta', 'accounts', 'days', 'buckets', 'summary', 'scenario', 'unresolved', 'warnings'],
        );
        expect(summary.meta.include).toBe('summary');
        expect(summary.summary).toEqual(body.summary);
    });

    test('a balance entered for today becomes the anchor, and today\'s items stay in today\'s bucket', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: '2026-03-07', balance: '800.00' });
        const today = await item(acct.id, { categoryId: sales.id, amount: '250.00', dueDate: TODAY, name: 'Takings' });
        const yesterday = await item(acct.id, { dueDate: '2026-03-09', name: 'Yesterday' });

        const before = await ok({ companyId: co.id, bucket: 'day' });
        expect(before.accounts[0]).toMatchObject({ anchorDate: '2026-03-07', anchorAgeDays: 3, openingNative: 70000 });
        expect(absorbedOf(before).map((a) => [a.key, a.flags])).toEqual([[yesterday.key, ['assumed']]]);

        await put(`/accounts/${acct.id}/balances/${TODAY}`, { balance: '1000.00' }).expect(200);
        const body = await ok({ companyId: co.id, bucket: 'day' });
        expect(body.accounts[0]).toMatchObject({
            anchorDate: TODAY, anchorAgeDays: 0, anchorNative: 100000, openingNative: 100000, openingGbp: 100000,
            absorbed: [],
        });
        // Yesterday's auto item is inside today's figure now: assumed settled, shown nowhere.
        expect(linesOf(body, yesterday.key)).toEqual([]);
        expect(body.unresolved).toEqual([]);
        // Today's item is in today's bucket, not in the anchor.
        expect(owedLine(body, today.key)).toMatchObject({ date: TODAY, dueDate: TODAY, bucketIndex: 0, flags: [] });
        expect(body.days[0]).toEqual({ date: TODAY, opening: 100000, inflow: 25000, outflow: 0, net: 25000, closing: 125000 });
        expect(body.buckets[0]).toMatchObject({ start: TODAY, end: TODAY, inflow: 25000, closing: 125000 });
        const weekly = await ok({ companyId: co.id });
        expect(owedLine(weekly, today.key).bucketIndex).toBe(0);
        expect(weekly.buckets[0].inflow).toBe(25000);
    });

    test('mixed anchors: each account rolls from its own anchor to today', async () => {
        const co = await company();
        const x = await account(co.id, { name: 'X', anchor: '2026-03-05', balance: '1000.00' });
        const y = await account(co.id, { name: 'Y', anchor: '2026-03-08', balance: '500.00' });
        const xGap = await item(x.id, { dueDate: '2026-03-07', name: 'x gap' });            // A_x <= d < today
        const yBefore = await item(y.id, { dueDate: '2026-03-07', name: 'y before' });      // d < A_y
        const yManual = await item(y.id, { dueDate: '2026-03-06', settleMode: 'manual', amount: '30.00' });

        const body = await ok({ companyId: co.id, bucket: 'day' });
        const [ax, ay] = body.accounts;
        expect(ax).toMatchObject({ accountId: x.id, anchorDate: '2026-03-05', anchorAgeDays: 5, anchorNative: 100000, openingNative: 90000 });
        expect(ax.absorbed).toEqual([{
            key: xGap.key, name: 'x gap', categoryId: costs.id, date: '2026-03-07', currency: 'GBP', amountMinor: 10000,
            accountMinor: 10000, gbpMinor: 10000, direction: 'out', flags: ['assumed'],
        }]);
        expect(ay).toMatchObject({ accountId: y.id, anchorDate: '2026-03-08', anchorAgeDays: 2, openingNative: 50000, absorbed: [] });
        expect(linesOf(body, yBefore.key)).toEqual([]);
        expect(absorbedOf(body).map((a) => a.key)).not.toContain(yBefore.key);
        // A manual item before its account's anchor is still owed: overdue at today.
        expect(owedLine(body, yManual.key)).toMatchObject({ date: TODAY, dueDate: '2026-03-06', flags: ['overdue'], editable: true });
        expect(body.days[0]).toMatchObject({ opening: 140000, outflow: 3000, closing: 137000 });
        expect(body.summary.absorbedCount).toBe(1);
    });

    test('unresolved[]: a manual one-off 200 days old and a never-marked manual schedule (no 45-day floor)', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: '2026-03-09' });
        const old = await item(acct.id, { dueDate: '2025-08-22', settleMode: 'manual', amount: '75.00', name: 'Old invoice' });
        const monthly = await schedule(acct.id, { name: 'Manual fee', amount: '40.00', startDate: '2025-11-30', settleMode: 'manual' });
        const ended = await schedule(acct.id, {
            name: 'Ended manual', amount: '40.00', startDate: '2025-01-01', endDate: '2025-06-01', settleMode: 'manual',
        });

        const body = await ok({ companyId: co.id });
        const byKey = new Map(body.unresolved.map((u) => [u.key, u]));
        expect(byKey.get(old.key)).toEqual({
            key: old.key, kind: 'item', name: 'Old invoice', categoryId: costs.id, accountId: acct.id, currency: 'GBP',
            amountMinor: 7500, gbpMinor: 7500, direction: 'out', date: '2025-08-22', ageDays: 200, settleMode: 'manual',
        });
        expect(byKey.get(`sched.${monthly}.2025-11-30`)).toMatchObject({ kind: 'sched', ageDays: 100, amountMinor: 4000 });
        expect(byKey.get(`sched.${monthly}.2025-12-30`)).toMatchObject({ ageDays: 70 });
        for (const d of ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01', '2025-06-01']) {
            expect(byKey.has(`sched.${ended}.${d}`)).toBe(true);
        }
        expect(body.unresolved).toHaveLength(9);
        expect(body.summary).toMatchObject({ unresolvedCount: 9, unresolvedTotal: 7500 + 8 * 4000 });
        // The same schedule's newer instances are overdue at today, not unresolved.
        expect(owedLine(body, `sched.${monthly}.2026-01-30`)).toMatchObject({ date: TODAY, dueDate: '2026-01-30', flags: ['overdue'] });
        expect(owedLine(body, `sched.${monthly}.2026-02-28`)).toMatchObject({ date: TODAY, flags: ['overdue'] });
        expect(owedLine(body, `sched.${monthly}.2026-03-30`)).toMatchObject({ date: '2026-03-30', flags: [] });
    });

    test('a part-paid override whose remainder date is older than minA is still loaded and owed', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: '2026-03-05' });
        const running = await schedule(acct.id, { name: 'Supplier', amount: '1000.00', startDate: '2026-01-20' });
        const o = await insertOverride(h, {
            scheduleId: running, naturalDate: '2026-02-20', status: 'part_paid', paidAmount: '400.00',
            paidOn: '2026-02-18', dueDate: '2026-02-25',
        });
        await insertOverridePayment(h, { overrideId: o, paidOn: '2026-02-18', amount: '400.00' });
        // The same on a schedule that ended before minA: only the override names it.
        const ended = await schedule(acct.id, { name: 'Old supplier', startDate: '2025-10-15', endDate: '2025-12-15' });
        const oe = await insertOverride(h, {
            scheduleId: ended, naturalDate: '2025-12-15', status: 'part_paid', paidAmount: '30.00',
            paidOn: '2025-12-10', dueDate: '2026-01-05',
        });
        await insertOverridePayment(h, { overrideId: oe, paidOn: '2025-12-10', amount: '30.00' });

        const body = await ok({ companyId: co.id });
        const key = `sched.${running}.2026-02-20`;
        // The payment (18 Feb) is inside the anchor; the remainder is forced manual and overdue.
        expect(linesOf(body, key)).toEqual([expect.objectContaining({
            key, kind: 'sched', scheduleId: running, naturalDate: '2026-02-20', amountMinor: 60000, date: TODAY,
            dueDate: '2026-02-25', status: 'part_paid', flags: ['tuned', 'remainder', 'overdue'], editable: false,
        })]);
        expect(absorbedOf(body)).toEqual([]);
        expect(owedLine(body, `sched.${running}.2026-03-20`)).toMatchObject({ amountMinor: 100000, flags: [] });
        expect(body.unresolved).toEqual([expect.objectContaining({
            key: `sched.${ended}.2025-12-15`, kind: 'sched', amountMinor: 7000, date: '2026-01-05', ageDays: 64,
        })]);
    });

    test('an amount-only override (June 983, July 1024) is visible', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: TODAY });
        const s = await schedule(acct.id, { name: 'Headline', amount: '1000.00', startDate: '2026-01-15' });
        await insertOverride(h, { scheduleId: s, naturalDate: '2026-06-15', amount: '983.00' });
        await insertOverride(h, { scheduleId: s, naturalDate: '2026-07-15', amount: '1024.00' });

        const body = await ok({ companyId: co.id, to: '2026-07-31', bucket: 'month' });
        expect(owedLine(body, `sched.${s}.2026-06-15`)).toMatchObject({
            kind: 'sched', id: s, scheduleId: s, naturalDate: '2026-06-15', amountMinor: 98300, gbpMinor: 98300,
            date: '2026-06-15', dueDate: '2026-06-15', bucketIndex: 3, status: 'expected', flags: ['tuned'], editable: true,
        });
        expect(owedLine(body, `sched.${s}.2026-07-15`)).toMatchObject({ amountMinor: 102400, flags: ['tuned'] });
        expect(owedLine(body, `sched.${s}.2026-05-15`)).toMatchObject({ amountMinor: 100000, flags: [] });
        expect(body.buckets.map((b) => b.outflow)).toEqual([100000, 100000, 100000, 98300, 102400]);
    });

    test('an override moving an instance out of the window is not projected; one moving in is', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: TODAY });
        const s = await schedule(acct.id, { name: 'Moves', amount: '500.00', startDate: '2026-03-20' });
        await insertOverride(h, { scheduleId: s, naturalDate: '2026-04-20', dueDate: '2026-07-20' });
        await insertOverride(h, { scheduleId: s, naturalDate: '2026-08-20', dueDate: '2026-05-05' });
        // A schedule that ended before the window, its last instance postponed into it.
        const ended = await schedule(acct.id, { name: 'Ended', amount: '500.00', startDate: '2025-10-15', endDate: '2025-12-15' });
        await insertOverride(h, { scheduleId: ended, naturalDate: '2025-12-15', dueDate: '2026-04-02' });

        const body = await ok({ companyId: co.id, to: '2026-06-30', bucket: 'day' });
        expect(linesOf(body, `sched.${s}.2026-04-20`)).toEqual([]);
        expect(dayOf(body, '2026-04-20').outflow).toBe(0);
        expect(owedLine(body, `sched.${s}.2026-08-20`)).toMatchObject({
            naturalDate: '2026-08-20', date: '2026-05-05', dueDate: '2026-05-05', flags: ['tuned'],
        });
        expect(dayOf(body, '2026-05-05').outflow).toBe(50000);
        expect(owedLine(body, `sched.${ended}.2025-12-15`)).toMatchObject({ date: '2026-04-02', flags: ['tuned'] });
        // In placement order: 20 Mar, 2 Apr (ended, natural 15 Dec), 5 May (natural 20 Aug), 20 May,
        // 20 Jun — nothing on 20 Apr.
        expect(lines(body).map((l) => [l.naturalDate, l.date])).toEqual([
            ['2026-03-20', '2026-03-20'], ['2025-12-15', '2026-04-02'], ['2026-08-20', '2026-05-05'],
            ['2026-05-20', '2026-05-20'], ['2026-06-20', '2026-06-20'],
        ]);
        expect(body.summary.outflow).toBe(5 * 50000);
    });

    test('the weekend rule across both window edges (§8 rule 1\'s ± 2 days)', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: '2026-03-09' });                          // a Monday; minA
        const TO = '2026-04-10';                                                             // a Friday
        const prev = await schedule(acct.id, { name: 'prev', amount: '70.00', startDate: '2026-04-11', weekendRule: 'previous' });
        const none = await schedule(acct.id, { name: 'none', amount: '70.00', startDate: '2026-04-11', weekendRule: 'none' });
        const next = await schedule(acct.id, { name: 'next', amount: '70.00', startDate: '2026-04-12', weekendRule: 'next' });
        const low = await schedule(acct.id, {
            name: 'low', amount: '20.00', startDate: '2026-02-08', endDate: '2026-03-08', weekendRule: 'next',
        });

        const body = await ok({ companyId: co.id, to: TO });
        // Saturday 11 Apr under `previous` lands on `to`, the window's last day.
        expect(owedLine(body, `sched.${prev}.2026-04-11`)).toMatchObject({
            naturalDate: '2026-04-11', date: TO, dueDate: TO, bucketIndex: body.buckets.length - 1, flags: [],
        });
        expect(body.buckets[body.buckets.length - 1]).toMatchObject({ end: TO, outflow: 7000 });
        expect(linesOf(body, `sched.${none}.2026-04-11`)).toEqual([]);
        expect(linesOf(body, `sched.${next}.2026-04-12`)).toEqual([]);
        // Sunday 8 Mar under `next` lands on the anchor day: absorbed, though the schedule ended before minA.
        expect(body.accounts[0].absorbed).toEqual([expect.objectContaining({
            key: `sched.${low}.2026-03-08`, date: '2026-03-09', amountMinor: 2000, flags: ['assumed'],
        })]);
        expect(body.accounts[0].openingNative).toBe(98000);
    });

    test('FX_RATE_MISSING before the engine runs; ratesUsed once a rate applies', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: TODAY });
        const chf = await item(acct.id, { currency: 'CHF', dueDate: '2026-03-12', name: 'Swiss' });

        let res = await forecast({ companyId: co.id }).expect(422);
        expect(res.body).toEqual({ error: expect.any(String), code: 'FX_RATE_MISSING', details: { currencies: ['CHF'] } });
        // A rate from tomorrow is not today's rate.
        await api().post('/api/v1/fx-rates').send({ currency: 'CHF', rateToGbp: '1.100000', effectiveFrom: '2026-03-11' }).expect(201);
        res = await forecast({ companyId: co.id }).expect(422);
        expect(res.body.details).toEqual({ currencies: ['CHF'] });
        await api().post('/api/v1/fx-rates').send({ currency: 'CHF', rateToGbp: '0.900000', effectiveFrom: '2026-03-01' }).expect(201);
        const body = await ok({ companyId: co.id });
        expect(body.meta.ratesUsed).toEqual({
            CHF: { rateToGbp: '0.900000', effectiveFrom: '2026-03-01' },
            GBP: { rateToGbp: '1.000000', effectiveFrom: null },
        });
        expect(owedLine(body, chf.key)).toMatchObject({ currency: 'CHF', amountMinor: 10000, accountMinor: 9000, gbpMinor: 9000 });

        // An in-scope account's currency is in scope (§3.4), anchor or not.
        const sek = await account(co.id, { name: 'Krona', currency: 'SEK' });
        res = await forecast({ companyId: co.id }).expect(422);
        expect(res.body).toMatchObject({ code: 'FX_RATE_MISSING', details: { currencies: ['SEK'] } });
        await api().delete(`/api/v1/accounts/${sek.id}`).expect(204);
        await forecast({ companyId: co.id }).expect(200);
    });

    test('NO_ANCHOR: an account with no balance is reported and left out; none at all → an empty forecast', async () => {
        const co = await company();
        const anchored = await account(co.id, { name: 'Anchored', anchor: TODAY });
        const bare = await account(co.id, { name: 'Bare' });
        const mine = await item(anchored.id, { dueDate: '2026-03-12' });
        const theirs = await item(bare.id, { dueDate: '2026-03-12', settleMode: 'manual' });

        const body = await ok({ companyId: co.id });
        expect(body.warnings).toEqual([{ code: 'NO_ANCHOR', accountId: bare.id }]);
        expect(body.accounts.map((a) => a.accountId)).toEqual([anchored.id]);
        expect(lines(body).map((l) => l.key)).toEqual([mine.key]);
        expect(linesOf(body, theirs.key)).toEqual([]);

        const empty = await company();
        const lone = await account(empty.id, { name: 'Lone' });
        await item(lone.id, { dueDate: '2026-03-12' });
        const none = await ok({ companyId: empty.id, bucket: 'month' });
        expect(none).toMatchObject({ accounts: [], rows: [], unresolved: [], scenario: null, warnings: [{ code: 'NO_ANCHOR', accountId: lone.id }] });
        expect(none.days.every((d) => d.opening === 0 && d.net === 0 && d.closing === 0)).toBe(true);
        expect(none.summary).toMatchObject({ opening: 0, closing: 0, unresolvedCount: 0, absorbedCount: 0 });
    });

    test('company scope through bank_accounts; all; inactive and deleted accounts are out', async () => {
        const coA = await company();
        const coB = await company();
        const a1 = await account(coA.id, { name: 'A1', anchor: TODAY });
        const b1 = await account(coB.id, { name: 'B1', anchor: TODAY });
        const inactive = await account(coA.id, { name: 'A dormant' });
        await api().put(`/api/v1/accounts/${inactive.id}`).send({ isActive: false }).expect(200);
        const gone = await account(coA.id, { name: 'A gone' });
        await api().delete(`/api/v1/accounts/${gone.id}`).expect(204);
        const ia = await item(a1.id, { dueDate: '2026-03-12' });
        const ib = await item(b1.id, { dueDate: '2026-03-12' });

        const a = await ok({ companyId: coA.id });
        expect(a.accounts.map((x) => x.accountId)).toEqual([a1.id]);
        expect(a.warnings).toEqual([]);
        expect(lines(a).map((l) => l.key)).toEqual([ia.key]);
        const b = await ok({ companyId: coB.id });
        expect(lines(b).map((l) => l.key)).toEqual([ib.key]);

        const all = await ok({ companyId: 'all' });
        expect(all.meta.companyId).toBe('all');
        const ids = all.accounts.map((x) => x.accountId);
        expect(ids).toEqual(expect.arrayContaining([a1.id, b1.id]));
        expect(ids).not.toContain(inactive.id);
        expect(ids).not.toContain(gone.id);
        expect(all.warnings.map((w) => w.accountId)).not.toContain(inactive.id);
        expect(lines(all).map((l) => l.key)).toEqual(expect.arrayContaining([ia.key, ib.key]));
    });

    test('the window: from in the past is clamped, to is capped at 730 days, a later from starts later', async () => {
        const co = await company();
        await account(co.id, { anchor: TODAY });

        const past = await ok({ companyId: co.id, from: '2026-02-28', to: '2026-03-31' });
        expect(past.meta).toMatchObject({ from: TODAY, to: '2026-03-31', fromClamped: true, toClamped: false });
        expect(past.days[0].date).toBe(TODAY);
        expect(past.buckets[0].start).toBe(TODAY);

        const far = await ok({ companyId: co.id, to: '2028-06-01', include: 'summary', bucket: 'month' });
        expect(far.meta).toMatchObject({ to: '2028-03-09', fromClamped: false, toClamped: true });
        expect(far.days).toHaveLength(731);

        const later = await ok({ companyId: co.id, from: '2026-03-15', to: '2026-03-30', bucket: 'day' });
        expect(later.meta).toMatchObject({ from: '2026-03-15', fromClamped: false });
        expect(later.days).toHaveLength(16);
        expect(later.days[0].date).toBe('2026-03-15');
        expect(later.buckets).toHaveLength(16);
    });

    test('a scenario: in-scope adjustments apply; an out-of-scope target → ADJUSTMENT_OUT_OF_SCOPE; stale ones flagged', async () => {
        const coIn = await company();
        const coOut = await company();
        const acctIn = await account(coIn.id, { anchor: TODAY });
        const acctOut = await account(coOut.id, { anchor: TODAY });
        const iIn = await item(acctIn.id, { dueDate: '2026-03-20', name: 'in' });
        const iOut = await item(acctOut.id, { dueDate: '2026-03-20', name: 'out' });
        const iGone = await item(acctIn.id, { dueDate: '2026-03-20', name: 'gone' });
        await api().delete(`/api/v1/items/${iGone.id}`).expect(204);
        const iBase = await item(acctIn.id, { dueDate: '2026-03-22', name: 'rebased' });
        const sOut = await schedule(acctOut.id, { name: 'sOut', amount: '200.00', startDate: '2026-01-15' });
        const sFar = await schedule(acctIn.id, { name: 'sFar', amount: '300.00', startDate: '2026-01-15' });

        const scenarioId = await insertScenario(h, { name: 'Shift', companyId: coIn.id });
        const adjust = (a) => insertAdjustment(h, { scenarioId, ...a });
        await adjust({ itemKey: iIn.key, newAmount: '150.00', baseDate: '2026-03-20', baseAmount: '100.00' });
        await adjust({ itemKey: iOut.key, newAmount: '150.00', baseDate: '2026-03-20', baseAmount: '100.00' });
        await adjust({ itemKey: `sched.${sOut}.2026-09-15`, kind: 'exclude', baseDate: '2026-09-15', baseAmount: '200.00' });
        await adjust({ itemKey: iGone.key, kind: 'exclude', baseDate: '2026-03-20', baseAmount: '100.00' });
        await adjust({ itemKey: iBase.key, newAmount: '1.00', baseDate: '2026-03-21', baseAmount: '100.00' });
        await adjust({ itemKey: `sched.${sFar}.2026-12-15`, newDate: '2026-03-30', baseDate: '2026-12-15', baseAmount: '300.00' });

        const body = await ok({ companyId: coIn.id, scenarioId, to: '2026-06-30' });
        expect(body.meta.scenarioId).toBe(scenarioId);
        expect(Object.keys(body.scenario)).toEqual(['id', 'name', 'status', 'baselineSummary', 'deltaByBucket', 'warnings']);
        expect(body.scenario).toMatchObject({ id: scenarioId, name: 'Shift', status: 'draft' });
        expect(body.scenario.warnings).toEqual([
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: iOut.key },
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: `sched.${sOut}.2026-09-15` },
            { code: 'STALE', key: iGone.key, reason: 'TARGET_MISSING' },
            { code: 'STALE', key: iBase.key, reason: 'BASE_CHANGED' },
        ]);
        expect(owedLine(body, iIn.key)).toMatchObject({
            amountMinor: 15000, flags: ['adjusted'], editable: true,
            baseline: { date: '2026-03-20', amountMinor: 10000, gbpMinor: 10000, flags: [] },
        });
        expect(owedLine(body, iBase.key)).toMatchObject({ amountMinor: 10000, flags: ['stale'] });
        expect(owedLine(body, `sched.${sFar}.2026-12-15`)).toMatchObject({
            naturalDate: '2026-12-15', date: '2026-03-30', flags: ['adjusted'], baseline: expect.objectContaining({ date: '2026-12-15' }),
        });
        expect(linesOf(body, iOut.key)).toEqual([]);
        expect(body.days.every((d) => Number.isInteger(d.baselineClosing))).toBe(true);
        expect(body.scenario.deltaByBucket.reduce((acc, b) => acc + b.outflow, 0)).toBe(5000 + 30000);
        expect(body.summary.outflow - body.scenario.baselineSummary.outflow).toBe(35000);

        // An applied scenario is read-only: nothing is editable.
        const applied = await insertScenario(h, { name: 'Done', status: 'applied' });
        const view = await ok({ companyId: coIn.id, scenarioId: applied });
        expect(view.scenario).toMatchObject({ id: applied, status: 'applied', warnings: [] });
        expect(lines(view).length).toBeGreaterThan(0);
        expect(lines(view).every((l) => l.editable === false)).toBe(true);

        // Not live → 404; malformed → 400.
        const deleted = await insertScenario(h, { name: 'Deleted', deleted: true });
        expect((await forecast({ companyId: coIn.id, scenarioId: deleted }).expect(404)).body.error).toEqual(expect.any(String));
        await forecast({ companyId: coIn.id, scenarioId: 999999 }).expect(404);
        await forecast({ companyId: coIn.id, scenarioId: 'abc' }).expect(400);
    });

    test('an applied scenario is history: no adjustments applied, no STALE, buckets = the baseline\'s', async () => {
        const co = await company();
        const acct = await account(co.id, { anchor: TODAY });
        const iA = await item(acct.id, { dueDate: '2026-03-20', name: 'amount' });
        const iB = await item(acct.id, { dueDate: '2026-03-25', name: 'date' });
        const s = await schedule(acct.id, { name: 'Monthly', amount: '200.00', startDate: '2026-01-15' });
        const sKey = `sched.${s}.2026-04-15`;

        const scenario = (await post('/scenarios', { name: 'Applied later', companyId: co.id }).expect(201)).body;
        const adjust = (key, body) => put(`/scenarios/${scenario.id}/adjustments/${key}`, body).expect((r) => {
            if (r.status !== 200 && r.status !== 201) throw new Error(`adjustment ${key} → ${r.status} ${JSON.stringify(r.body)}`);
        });
        await adjust(iA.key, { kind: 'adjust', newAmount: '150.00' });
        await adjust(iB.key, { kind: 'adjust', newDate: '2026-04-02' });
        await adjust(sKey, { kind: 'exclude' });

        const draft = await ok({ companyId: co.id, scenarioId: scenario.id });
        expect(draft.scenario).toMatchObject({ status: 'draft', warnings: [] });
        expect(owedLine(draft, iA.key).flags).toEqual(['adjusted']);
        expect(owedLine(draft, sKey).flags).toEqual(['excluded']);
        expect(draft.summary.outflow).not.toBe(draft.scenario.baselineSummary.outflow);

        await post(`/scenarios/${scenario.id}/apply`, {}).expect(200);
        const baseline = await ok({ companyId: co.id });
        const applied = await ok({ companyId: co.id, scenarioId: scenario.id });
        expect(applied.meta.scenarioId).toBe(scenario.id);
        expect(applied.scenario).toMatchObject({ id: scenario.id, status: 'applied', warnings: [] });
        expect(applied.scenario.warnings.filter((w) => w.code === 'STALE')).toEqual([]);
        expect(applied.buckets).toEqual(baseline.buckets);
        expect(applied.summary).toEqual(baseline.summary);
        expect(applied.scenario.baselineSummary).toEqual(baseline.summary);
        expect(applied.scenario.deltaByBucket.every((b) => b.inflow === 0 && b.outflow === 0 && b.net === 0 && b.closing === 0)).toBe(true);
        expect(applied.days.map((d) => d.closing)).toEqual(baseline.days.map((d) => d.closing));
        expect(applied.days.every((d) => d.baselineClosing === d.closing)).toBe(true);
        // The real rows now carry what was applied; nothing is flagged or editable in the view.
        expect(owedLine(baseline, iA.key)).toMatchObject({ amountMinor: 15000, flags: ['fromScenario'] });
        expect(owedLine(baseline, iB.key)).toMatchObject({ date: '2026-04-02', flags: ['fromScenario'] });
        expect(linesOf(baseline, sKey)).toEqual([]);
        expect(lines(applied).every((l) => l.editable === false && !l.flags.includes('adjusted') && !l.flags.includes('stale'))).toBe(true);
    });

    test('?today= is honoured under test (D24); without it, today is the London date', async () => {
        const co = await company();
        await account(co.id, { anchor: '2026-03-01' });
        expect((await ok({ companyId: co.id }, '2026-04-01')).meta.today).toBe('2026-04-01');
        expect((await ok({ companyId: co.id }, '2026-04-01')).accounts[0].anchorAgeDays).toBe(31);
        const now = await ok({ companyId: co.id }, null);
        expect(now.meta.today).toBe(londonToday());
        await forecast({ companyId: co.id }, '2026-13-01').expect(400);
    });

    test('query validation: every refusal is a message-only 400, the scenario a 404', async () => {
        const co = await company();
        await account(co.id, { anchor: TODAY });
        const dead = await company();
        await api().delete(`/api/v1/companies/${dead.id}`).expect(204);
        const bad = [
            {}, { companyId: 'abc' }, { companyId: '0' }, { companyId: '999999' }, { companyId: dead.id },
            { companyId: co.id, from: '2026-02-30' }, { companyId: co.id, to: 'soon' },
            { companyId: co.id, from: '2026-04-02', to: '2026-04-01' },
            { companyId: co.id, to: '2026-03-09' },
            { companyId: co.id, from: '2028-06-01', to: '2028-07-01' },        // starts past the 730-day cap
            { companyId: co.id, bucket: 'year' }, { companyId: co.id, include: 'all' },
            { companyId: co.id, scenarioId: '1.5' },
        ];
        for (const query of bad) {
            const res = await forecast(query);
            expect([JSON.stringify(query), res.status]).toEqual([JSON.stringify(query), 400]);
            expect(res.body).toEqual({ error: expect.any(String) });
        }
        // `to` on today is a one-day forecast.
        const one = await ok({ companyId: co.id, to: TODAY, bucket: 'month' });
        expect(one.days).toHaveLength(1);
        expect(one.buckets).toEqual([expect.objectContaining({ start: TODAY, end: TODAY })]);
    });

    describe('agreement: derivedStatus on the lists = /forecast\'s flags and lists (§9.6)', () => {
        // /forecast's view of one key: unresolved[] → unresolved; an owed line flagged
        // overdue → overdue; any other owed line → expected; absorbed ['assumed'] →
        // assumed; nothing owed anywhere → absent (assumedSettled, paid, skipped).
        const forecastStatus = (body, key) => {
            if (body.unresolved.some((u) => u.key === key)) return 'unresolved';
            const owed = owedLine(body, key);
            if (owed) return owed.flags.includes('overdue') ? 'overdue' : 'expected';
            if (absorbedOf(body).some((a) => a.key === key && a.flags.includes('assumed'))) return 'assumed';
            return 'absent';
        };
        const SEEN_AS = {
            expected: 'expected', overdue: 'overdue', unresolved: 'unresolved', assumed: 'assumed',
            assumedSettled: 'absent', paid: 'absent', skipped: 'absent',
        };
        const A = '2026-03-05';
        const TO = '2026-04-09';
        let co;
        let acct;

        beforeAll(async () => {
            co = await company();
            acct = await account(co.id, { anchor: A });
        });

        test('one-off items: GET /items derivedStatus agrees with /forecast for every value', async () => {
            await item(acct.id, { dueDate: '2026-03-13', name: 'future' });
            await item(acct.id, { dueDate: TODAY, name: 'today' });
            await item(acct.id, { dueDate: '2026-03-08', name: 'assumed' });
            await item(acct.id, { dueDate: '2026-03-02', name: 'settled' });
            await item(acct.id, { dueDate: '2026-02-28', settleMode: 'manual', name: 'overdue' });
            await item(acct.id, { dueDate: '2026-01-09', settleMode: 'manual', name: 'unresolved' });
            const partFuture = await item(acct.id, { dueDate: '2026-03-09', name: 'part, rest due later' });
            await post(`/items/${partFuture.id}/pay`, { paidOn: '2026-03-09', paidAmount: '40.00', remainderDueDate: '2026-03-12' }).expect(200);
            const partLate = await item(acct.id, { dueDate: '2026-02-20', name: 'part, rest overdue' }, '2026-02-25');
            await post(`/items/${partLate.id}/pay`,
                { paidOn: '2026-02-25', paidAmount: '30.00', remainderDueDate: '2026-02-27' }, '2026-02-25').expect(200);
            const paid = await item(acct.id, { dueDate: '2026-03-09', name: 'paid' });
            await post(`/items/${paid.id}/pay`, { paidOn: '2026-03-09' }).expect(200);
            const skipped = await item(acct.id, { dueDate: '2026-03-14', name: 'skipped' });
            await put(`/items/${skipped.id}`, { status: 'skipped' }).expect(200);
            const didnt = await item(acct.id, { dueDate: '2026-03-02', name: 'didn\'t happen' });
            await put(`/items/${didnt.id}`, { settleMode: 'manual' }).expect(200);

            const list = (await api().get('/api/v1/items').query({ companyId: co.id, today: TODAY, limit: 500 }).expect(200)).body.data;
            const body = await ok({ companyId: co.id, to: TO });
            const pairs = list.map((i) => [i.name, i.derivedStatus, SEEN_AS[i.derivedStatus], forecastStatus(body, i.key)]);
            for (const [name, derived, want, got] of pairs) expect([name, derived, got]).toEqual([name, derived, want]);
            expect(new Set(list.map((i) => i.derivedStatus)))
                .toEqual(new Set(['expected', 'overdue', 'unresolved', 'assumed', 'assumedSettled', 'paid', 'skipped']));
        });

        testInstances('schedule instances: GET /schedules/:id/instances derivedStatus agrees with /forecast', async () => {
            const s = await schedule(acct.id, { name: 'Weekly', amount: '50.00', frequency: 'weekly', startDate: '2026-01-06' });
            await insertOverride(h, { scheduleId: s, naturalDate: '2026-03-03', dueDate: '2026-03-06' });           // assumed
            await insertOverride(h, { scheduleId: s, naturalDate: '2026-02-24', settleMode: 'manual' });            // overdue
            await insertOverride(h, { scheduleId: s, naturalDate: '2026-01-13', settleMode: 'manual' });            // unresolved
            const part = await insertOverride(h, {
                scheduleId: s, naturalDate: '2026-02-17', status: 'part_paid', paidAmount: '20.00', paidOn: '2026-03-06',
                dueDate: '2026-03-12',
            });
            await insertOverridePayment(h, { overrideId: part, paidOn: '2026-03-06', amount: '20.00' });
            await insertOverride(h, { scheduleId: s, naturalDate: '2026-02-10', status: 'skipped' });
            const paid = await insertOverride(h, {
                scheduleId: s, naturalDate: '2026-01-20', status: 'paid', paidAmount: '50.00', paidOn: '2026-01-21',
            });
            await insertOverridePayment(h, { overrideId: paid, paidOn: '2026-01-21', amount: '50.00' });

            const res = await api().get(`/api/v1/schedules/${s}/instances`).query({ from: '2026-01-01', to: TO, today: TODAY }).expect(200);
            const body = await ok({ companyId: co.id, to: TO });
            const instances = res.body.data.filter((i) => i.dueDate <= TO);
            expect(instances.length).toBeGreaterThan(10);
            for (const i of instances) {
                expect([i.key, i.derivedStatus, forecastStatus(body, i.key)]).toEqual([i.key, i.derivedStatus, SEEN_AS[i.derivedStatus]]);
            }
            expect(new Set(instances.map((i) => i.derivedStatus)))
                .toEqual(new Set(['expected', 'overdue', 'unresolved', 'assumed', 'assumedSettled', 'paid', 'skipped']));
        });
    });
});
