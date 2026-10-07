'use strict';

// Forecast engine (CONTRACT §9, §6.10, §8's engineInput; BUILD_PLAN step 6). Pinned here:
//
//  - anchors: mixed anchors, each account rolled from its own; A == today; absorbed[] and
//    today's opening; NO_ANCHOR;
//  - classification through lib/classify.js: the ±45-day boundary, unresolved[] (a 200-day
//    one-off, a never-marked manual schedule, the 730-day manual scan), part-paid
//    remainders (auto schedule, remainder older than min(A)), part payments straddling A,
//    a per-instance settle_mode override;
//  - overrides: moving an instance into / out of the window, ORPHAN_OVERRIDE;
//  - scenarios: adjustments before classification (overdue cleared in the scenario only),
//    an out-of-window target moved in, the four stale reasons, ADJUSTMENT_OUT_OF_SCOPE,
//    exclude (D30), baselineClosing (D34), baseline on each row item;
//  - money: the rounding invariant at 1.234567 and 0.005234, item → GBP → account currency,
//    FX_RATE_MISSING;
//  - the window: from clamped, to capped at 730 days, day / week (Monday, clipped) / month
//    buckets, minClosing from the daily series, include=summary;
//  - flags and editable per §6.10.
//
// Every run goes through `forecast()`, which freezes the input (the engine must not mutate
// it) and asserts the structural invariants on the result: opening + net = closing at
// every level, cells sum to totals, every figure an integer.

const fs = require('fs');

const {
    run, clampWindow, currenciesInScope, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS, BUCKETS, INCLUDES,
} = require('../../src/lib/engine');
const { parseKey } = require('../../src/lib/keys');
const { toGbp, fromGbp, parseRate } = require('../../src/lib/money');
const { addDays, diffDays } = require('../../src/lib/dates');

const TODAY = '2026-09-29'; // a Tuesday
const A = '2026-09-20';
const TO = '2026-10-31';

const CATEGORIES = [
    { id: 10, name: 'Sales', direction: 'in', sortOrder: 1 },
    { id: 20, name: 'Rent', direction: 'out', sortOrder: 1 },
    { id: 21, name: 'Payroll', direction: 'out', sortOrder: 2 },
];

// ── Fixtures: engineInput rows (camelCase JSON, money as DECIMAL strings) ────────────────

const account = (over = {}) => ({
    id: 1, companyId: 1, name: 'Main', currency: 'GBP', anchorDate: A, anchorBalance: '1000.00', ...over,
});

function item(id, over = {}) {
    const direction = over.direction || 'out';
    return {
        id, accountId: 1, companyId: 1, categoryId: direction === 'in' ? 10 : 20, direction,
        name: `Item ${id}`, counterparty: null, amount: '100.00', currency: 'GBP', dueDate: TODAY,
        status: 'expected', paidOn: null, paidAmount: null, settleMode: 'auto', sourceScenarioId: null,
        inScope: true, ...over,
    };
}

function schedule(id, over = {}) {
    const direction = over.direction || 'out';
    return {
        id, accountId: 1, companyId: 1, categoryId: direction === 'in' ? 10 : 21, direction,
        name: `Schedule ${id}`, counterparty: null, amount: '100.00', currency: 'GBP',
        frequency: 'monthly', intervalCount: 1, startDate: '2026-07-15', activeFrom: null,
        occurrenceCount: null, endDate: null, weekendRule: 'none', settleMode: 'auto', status: 'active',
        inScope: true, ...over,
    };
}

const override = (id, scheduleId, naturalDate, over = {}) => ({
    id, scheduleId, naturalDate, amount: null, dueDate: null, status: null, settleMode: null,
    paidOn: null, paidAmount: null, note: null, sourceScenarioId: null, ...over,
});

const payment = (id, over = {}) => ({
    id, cashItemId: null, overrideId: null, paidOn: TODAY, amount: '100.00', note: null, ...over,
});

function adjustment(id, itemKey, over = {}) {
    const p = parseKey(itemKey);
    return {
        id, scenarioId: 7, itemKey, targetKind: p.targetKind, targetId: p.targetId, targetDate: p.targetDate,
        kind: 'adjust', newDate: null, newAmount: null, baseDate: TODAY, baseAmount: '100.00', note: null,
        ...over,
    };
}

const DRAFT = { id: 7, name: 'What if', status: 'draft', companyId: 1 };

function input(over = {}) {
    return {
        today: TODAY, from: TODAY, to: TO, bucket: 'day', include: 'grid', companyId: 1,
        accounts: [account()], rates: {}, categories: CATEGORIES,
        items: [], schedules: [], overrides: [], payments: [], adjustments: [], externalItems: [],
        shipping: null, scenario: null, warnings: [],
        ...over,
    };
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

function thrown(fn) {
    try { fn(); } catch (err) { return err; }
    throw new Error('expected a throw');
}

// ── Reading a response ───────────────────────────────────────────────────────────────────

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const signed = (e, field) => (e.direction === 'in' ? e[field] : -e[field]);
const allLines = (res) => res.rows.flatMap((r) => r.items);
const linesOf = (res, key) => allLines(res).filter((l) => l.key === key);
function lineOf(res, key) {
    const found = linesOf(res, key);
    expect(found).toHaveLength(1);
    return found[0];
}
const accountOf = (res, id) => res.accounts.find((a) => a.accountId === id);
const dayOf = (res, date) => res.days.find((d) => d.date === date);
const absorbedKeys = (res, id = 1) => accountOf(res, id).absorbed.map((e) => e.key);

function expectAllSafeIntegers(value, path = 'res') {
    if (typeof value === 'bigint') throw new Error(`${path} is a bigint`);
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${path} = ${value} is not an integer`);
    if (Array.isArray(value)) value.forEach((v, i) => expectAllSafeIntegers(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => expectAllSafeIntegers(v, `${path}.${k}`));
}

/** §9.8, §9.9, §9.12, §6.10: the invariants every response must satisfy. */
function expectInvariants(res) {
    expectAllSafeIntegers(res);
    expect(() => JSON.stringify(res)).not.toThrow();
    const { days, buckets, summary } = res;

    // days: one per date in [from, to], chained, opening + net = closing
    expect(days[0].date).toBe(res.meta.from);
    expect(days[days.length - 1].date).toBe(res.meta.to);
    days.forEach((d, i) => {
        expect(d.net).toBe(d.inflow - d.outflow);
        expect(d.closing).toBe(d.opening + d.net);
        if (i > 0) {
            expect(d.date).toBe(addDays(days[i - 1].date, 1));
            expect(d.opening).toBe(days[i - 1].closing);
        }
    });

    // accounts: opening = anchor + Σ absorbed, in GBP and in the account's currency
    for (const a of res.accounts) {
        expect(a.anchorAgeDays).toBe(diffDays(res.meta.today, a.anchorDate));
        expect(a.openingGbp).toBe(a.anchorGbp + sum(a.absorbed.map((e) => signed(e, 'gbpMinor'))));
        expect(a.openingNative).toBe(a.anchorNative + sum(a.absorbed.map((e) => signed(e, 'accountMinor'))));
    }
    if (res.meta.from === res.meta.today) expect(days[0].opening).toBe(sum(res.accounts.map((a) => a.openingGbp)));

    // buckets partition the days; figures come from the daily series
    let di = 0;
    for (const b of buckets) {
        const inB = [];
        while (di < days.length && days[di].date <= b.end) inB.push(days[di++]);
        expect(inB.length).toBeGreaterThan(0);
        expect(inB[0].date).toBe(b.start);
        expect(inB[inB.length - 1].date).toBe(b.end);
        expect(b.opening).toBe(inB[0].opening);
        expect(b.closing).toBe(inB[inB.length - 1].closing);
        expect(b.inflow).toBe(sum(inB.map((d) => d.inflow)));
        expect(b.outflow).toBe(sum(inB.map((d) => d.outflow)));
        expect(b.net).toBe(b.inflow - b.outflow);
        expect(b.closing).toBe(b.opening + b.net);
        const min = Math.min(...inB.map((d) => d.closing));
        expect(b.minClosing).toBe(min);
        expect(b.minDate).toBe(inB.find((d) => d.closing === min).date);
    }
    expect(di).toBe(days.length);

    // rows: cells sum to totals, and per bucket the rows sum to inflow / outflow
    if (res.rows) {
        const ins = buckets.map(() => 0);
        const outs = buckets.map(() => 0);
        for (const row of res.rows) {
            expect(row.totals).toHaveLength(buckets.length);
            row.totals.forEach((t, i) => {
                const cell = row.items.filter((l) => l.bucketIndex === i && !l.flags.includes('excluded') && !l.flags.includes('hidden'));
                expect(t).toBe(sum(cell.map((l) => l.gbpMinor)));
                if (row.direction === 'in') ins[i] += t; else outs[i] += t;
            });
            expect(row.total).toBe(sum(row.totals));
            for (const l of row.items) {
                const b = buckets[l.bucketIndex];
                expect(l.date >= b.start && l.date <= b.end).toBe(true);
            }
        }
        buckets.forEach((b, i) => {
            expect(ins[i]).toBe(b.inflow);
            expect(outs[i]).toBe(b.outflow);
        });
    }

    // summary
    expect(summary.opening).toBe(days[0].opening);
    expect(summary.closing).toBe(days[days.length - 1].closing);
    expect(summary.inflow).toBe(sum(buckets.map((b) => b.inflow)));
    expect(summary.outflow).toBe(sum(buckets.map((b) => b.outflow)));
    expect(summary.net).toBe(summary.inflow - summary.outflow);
    expect(summary.closing).toBe(summary.opening + summary.net);
    const min = Math.min(...days.map((d) => d.closing));
    expect(summary.minClosing).toBe(min);
    expect(summary.minDate).toBe(days.find((d) => d.closing === min).date);
    expect(summary.absorbedCount).toBe(sum(res.accounts.map((a) => a.absorbed.length)));
    expect(summary.unresolvedCount).toBe(res.unresolved.length);
    expect(summary.unresolvedTotal).toBe(sum(res.unresolved.map((u) => u.gbpMinor)));

    // scenario: baselineClosing on every day (D34), deltas = scenario − baseline
    if (res.scenario) {
        days.forEach((d) => expect(Number.isSafeInteger(d.baselineClosing)).toBe(true));
        expect(res.scenario.deltaByBucket).toHaveLength(buckets.length);
        res.scenario.deltaByBucket.forEach((dl, i) => {
            expect([dl.start, dl.end]).toEqual([buckets[i].start, buckets[i].end]);
            expect(dl.net).toBe(dl.inflow - dl.outflow);
            const last = dayOf(res, buckets[i].end);
            expect(dl.closing).toBe(last.closing - last.baselineClosing);
        });
        expect(res.scenario.baselineSummary.closing).toBe(days[days.length - 1].baselineClosing);
    } else {
        days.forEach((d) => expect('baselineClosing' in d).toBe(false));
    }
}

/** Run the engine on a frozen input and assert the invariants. */
function forecast(over = {}) {
    const res = run(deepFreeze(input(over)));
    expectInvariants(res);
    return res;
}

// ── Anchors ──────────────────────────────────────────────────────────────────────────────

describe('anchors: each account from its own (§9.2, §9.9)', () => {
    test('mixed anchors: one account absorbs what the other already holds', () => {
        const res = forecast({
            accounts: [
                account({ id: 1, anchorDate: '2026-09-19', anchorBalance: '1000.00' }),
                account({ id: 2, name: 'Second', anchorDate: '2026-09-27', anchorBalance: '500.00' }),
            ],
            items: [
                item(1, { accountId: 1, dueDate: '2026-09-24' }),                           // [A1, today) → absorbed
                item(2, { accountId: 2, dueDate: '2026-09-24', amount: '50.00' }),          // < A2 → assumed settled
                item(3, { accountId: 2, dueDate: '2026-09-28', amount: '20.00', direction: 'in' }), // [A2, today)
                item(4, { accountId: 1, dueDate: '2026-09-30', amount: '30.00', direction: 'in' }), // future
            ],
        });
        expect(accountOf(res, 1)).toEqual({
            accountId: 1, name: 'Main', companyId: 1, currency: 'GBP', rateToGbp: '1.000000',
            anchorDate: '2026-09-19', anchorAgeDays: 10, anchorNative: 100000, anchorGbp: 100000,
            openingNative: 90000, openingGbp: 90000,
            absorbed: [{
                key: 'item.1', name: 'Item 1', categoryId: 20, date: '2026-09-24', currency: 'GBP',
                amountMinor: 10000, accountMinor: 10000, gbpMinor: 10000, direction: 'out', flags: ['assumed'],
            }],
        });
        expect(accountOf(res, 2).anchorAgeDays).toBe(2);
        expect(absorbedKeys(res, 2)).toEqual(['item.3']);
        expect(accountOf(res, 2).openingGbp).toBe(52000);
        expect(res.days[0].opening).toBe(142000);
        expect(res.summary.absorbedCount).toBe(2);
        expect(linesOf(res, 'item.2')).toEqual([]);
        expect(res.unresolved).toEqual([]);
        expect(lineOf(res, 'item.4')).toMatchObject({ date: '2026-09-30', bucketIndex: 1 });
        expect(dayOf(res, '2026-09-30').inflow).toBe(3000);
    });

    test('A == today keeps today\'s items in today\'s bucket', () => {
        const res = forecast({
            accounts: [account({ anchorDate: TODAY })],
            items: [
                item(1, { dueDate: TODAY }),                                          // today → today's bucket
                item(2, { dueDate: '2026-09-28', amount: '40.00' }),                  // auto < A → settled
                item(3, { dueDate: '2026-09-28', amount: '25.00', settleMode: 'manual' }), // overdue at today
            ],
        });
        const a = accountOf(res, 1);
        expect(a.absorbed).toEqual([]);
        expect(a.anchorAgeDays).toBe(0);
        expect(a.openingGbp).toBe(100000);
        expect(lineOf(res, 'item.1')).toMatchObject({ date: TODAY, dueDate: TODAY, bucketIndex: 0, flags: [] });
        expect(lineOf(res, 'item.3')).toMatchObject({ date: TODAY, dueDate: '2026-09-28', bucketIndex: 0, flags: ['overdue'] });
        expect(linesOf(res, 'item.2')).toEqual([]);
        expect(res.days[0]).toMatchObject({ opening: 100000, outflow: 12500, closing: 87500 });
    });

    test('an auto item in [A, today) is absorbed and moves today\'s opening; one before A is not', () => {
        const res = forecast({
            items: [
                item(1, { dueDate: '2026-09-25', amount: '250.00', direction: 'in' }),
                item(2, { dueDate: A, amount: '10.00', direction: 'in' }),            // A itself: absorbed
                item(3, { dueDate: addDays(A, -1), amount: '99.00' }),                // A − 1: already in the balance
            ],
        });
        const a = accountOf(res, 1);
        expect(a.absorbed.map((e) => [e.key, e.date, e.flags])).toEqual([
            ['item.2', A, ['assumed']],
            ['item.1', '2026-09-25', ['assumed']],
        ]);
        expect(a.openingNative).toBe(100000 + 25000 + 1000);
        expect(res.days[0].opening).toBe(126000);
        expect(res.rows).toEqual([]);
        expect(res.unresolved).toEqual([]);
    });

    test('NO_ANCHOR: the account is excluded and warned once, even when the loader warned too', () => {
        const spare = account({ id: 2, name: 'Spare', anchorDate: null, anchorBalance: null });
        const items = [item(1, { dueDate: '2026-10-01' }), item(2, { accountId: 2, dueDate: '2026-10-01' })];
        for (const warnings of [[], [{ code: 'NO_ANCHOR', accountId: 2 }]]) {
            const res = forecast({ accounts: [account(), spare], items, warnings });
            expect(res.warnings).toEqual([{ code: 'NO_ANCHOR', accountId: 2 }]);
            expect(res.accounts.map((a) => a.accountId)).toEqual([1]);
            expect(allLines(res).map((l) => l.key)).toEqual(['item.1']);
        }
    });

    test('no account has an anchor: an empty forecast with one warning per account', () => {
        const res = forecast({
            accounts: [account({ anchorDate: null, anchorBalance: null }), account({ id: 2, anchorDate: null, anchorBalance: null })],
        });
        expect(res.warnings).toEqual([{ code: 'NO_ANCHOR', accountId: 1 }, { code: 'NO_ANCHOR', accountId: 2 }]);
        expect(res.accounts).toEqual([]);
        expect(res.rows).toEqual([]);
        expect(res.days.every((d) => d.opening === 0 && d.closing === 0)).toBe(true);
        expect(res.summary).toMatchObject({ opening: 0, closing: 0, minClosing: 0, minDate: TODAY });
    });
});

// ── Classification through classify.js ──────────────────────────────────────────────────

describe('owed lines: overdue and unresolved (§9.6, D9)', () => {
    test('a manual item at today−44 (and −45) is overdue at today; at today−46 it is unresolved', () => {
        const res = forecast({
            items: [
                item(44, { dueDate: addDays(TODAY, -44), settleMode: 'manual' }),
                item(45, { dueDate: addDays(TODAY, -45), settleMode: 'manual' }),
                item(46, { dueDate: addDays(TODAY, -46), settleMode: 'manual' }),
            ],
        });
        expect(lineOf(res, 'item.44')).toMatchObject({ date: TODAY, dueDate: '2026-08-16', bucketIndex: 0, flags: ['overdue'] });
        expect(lineOf(res, 'item.45')).toMatchObject({ date: TODAY, dueDate: '2026-08-15', flags: ['overdue'] });
        expect(linesOf(res, 'item.46')).toEqual([]);
        expect(res.unresolved).toEqual([{
            key: 'item.46', kind: 'item', name: 'Item 46', categoryId: 20, accountId: 1, currency: 'GBP',
            amountMinor: 10000, gbpMinor: 10000, direction: 'out', date: '2026-08-14', ageDays: 46, settleMode: 'manual',
        }]);
        expect(res.summary).toMatchObject({ unresolvedCount: 1, unresolvedTotal: 10000 });
        expect(res.days[0].outflow).toBe(20000);
    });

    test('a manual one-off 200 days old and a never-marked manual schedule are both unresolved', () => {
        const res = forecast({
            items: [item(9, { dueDate: addDays(TODAY, -200), settleMode: 'manual' })],
            schedules: [schedule(6, { startDate: '2026-03-01', amount: '50.00', settleMode: 'manual' })],
        });
        expect(res.unresolved.map((u) => [u.key, u.ageDays])).toEqual([
            ['sched.6.2026-03-01', 212],
            ['item.9', 200],
            ['sched.6.2026-04-01', 181],
            ['sched.6.2026-05-01', 151],
            ['sched.6.2026-06-01', 120],
            ['sched.6.2026-07-01', 90],
            ['sched.6.2026-08-01', 59],
        ]);
        expect(res.unresolved[0]).toMatchObject({ kind: 'sched', amountMinor: 5000, date: '2026-03-01', settleMode: 'manual' });
        expect(lineOf(res, 'sched.6.2026-09-01')).toMatchObject({ date: TODAY, flags: ['overdue'], naturalDate: '2026-09-01' });
        expect(lineOf(res, 'sched.6.2026-10-01')).toMatchObject({ date: '2026-10-01', flags: [] });
        expect(res.summary).toMatchObject({ unresolvedCount: 7, unresolvedTotal: 10000 + 6 * 5000 });
    });

    test('a manual schedule is scanned back to max(start_date, today − 730 days), not further (§8 rule 5)', () => {
        const res = forecast({ schedules: [schedule(8, { startDate: '2024-01-10', settleMode: 'manual' })] });
        const keys = res.unresolved.map((u) => u.key);
        expect(keys[0]).toBe('sched.8.2024-10-10');                 // today − 730 = 2024-09-29
        expect(keys).not.toContain('sched.8.2024-09-10');
        expect(keys).toHaveLength(23);                             // 2024-10-10 … 2026-08-10
        expect(lineOf(res, 'sched.8.2026-09-10').flags).toEqual(['overdue']);
    });

    test('a part-paid remainder on an auto schedule is overdue; its payment is absorbed', () => {
        const res = forecast({
            schedules: [schedule(5, { startDate: '2026-06-10', amount: '1000.00' })],
            overrides: [override(50, 5, '2026-09-10', {
                status: 'part_paid', paidAmount: '400.00', paidOn: '2026-09-22', dueDate: '2026-09-25',
            })],
            payments: [payment(71, { overrideId: 50, paidOn: '2026-09-22', amount: '400.00' })],
        });
        expect(accountOf(res, 1).absorbed).toEqual([{
            key: 'sched.5.2026-09-10', name: 'Schedule 5', categoryId: 21, date: '2026-09-22', currency: 'GBP',
            amountMinor: 40000, accountMinor: 40000, gbpMinor: 40000, direction: 'out', paymentId: 71,
            flags: ['paid', 'partial'],
        }]);
        expect(lineOf(res, 'sched.5.2026-09-10')).toMatchObject({
            kind: 'sched', id: 5, scheduleId: 5, naturalDate: '2026-09-10', amountMinor: 60000,
            date: TODAY, dueDate: '2026-09-25', status: 'part_paid', flags: ['tuned', 'remainder', 'overdue'], editable: false,
        });
        expect(lineOf(res, 'sched.5.2026-10-10')).toMatchObject({ date: '2026-10-10', flags: [], settleMode: 'auto' });
        expect(linesOf(res, 'sched.5.2026-08-10')).toEqual([]);   // auto, before A: assumed settled
    });

    test('a part-paid override whose remainder date is older than min(A) is still owed', () => {
        const res = forecast({
            accounts: [account(), account({ id: 2, name: 'Second', anchorDate: '2026-09-25' })],
            schedules: [schedule(5, { startDate: '2026-06-10', amount: '1000.00' })],
            // its payment (2026-08-25) is before min(A), so the loader does not hand it over
            overrides: [override(50, 5, '2026-08-10', {
                status: 'part_paid', paidAmount: '300.00', paidOn: '2026-08-25', dueDate: '2026-08-30',
            })],
        });
        expect(lineOf(res, 'sched.5.2026-08-10')).toMatchObject({
            amountMinor: 70000, date: TODAY, dueDate: '2026-08-30', flags: ['tuned', 'remainder', 'overdue'],
        });
        expect(accountOf(res, 1).absorbed).toEqual([]);
        expect(accountOf(res, 1).openingGbp).toBe(100000);
    });

    test('two part payments straddling the anchor: only the post-anchor one moves the opening', () => {
        const res = forecast({
            items: [item(9, {
                amount: '1000.00', dueDate: '2026-09-10', status: 'part_paid', paidAmount: '700.00', paidOn: '2026-09-22',
            })],
            payments: [
                payment(1, { cashItemId: 9, paidOn: '2026-09-15', amount: '400.00' }), // A − 5: inside the anchor
                payment(2, { cashItemId: 9, paidOn: '2026-09-22', amount: '300.00' }), // A + 2: absorbed
            ],
        });
        const a = accountOf(res, 1);
        expect(a.absorbed.map((e) => [e.key, e.paymentId, e.amountMinor, e.flags])).toEqual([
            ['item.9', 2, 30000, ['paid', 'partial']],
        ]);
        expect(a.openingGbp).toBe(70000);
        expect(lineOf(res, 'item.9')).toMatchObject({ amountMinor: 30000, date: TODAY, flags: ['remainder', 'overdue'] });
    });

    test('an override with settle_mode manual makes one instance overdue; its siblings stay auto', () => {
        const res = forecast({
            accounts: [account({ anchorDate: '2026-09-01' })],
            schedules: [schedule(5, { frequency: 'weekly', startDate: '2026-09-01', amount: '10.00' })],
            overrides: [override(50, 5, '2026-09-15', { settleMode: 'manual' })],
        });
        expect(absorbedKeys(res)).toEqual(['sched.5.2026-09-01', 'sched.5.2026-09-08', 'sched.5.2026-09-22']);
        expect(accountOf(res, 1).absorbed.every((e) => e.flags.join() === 'assumed')).toBe(true);
        expect(lineOf(res, 'sched.5.2026-09-15')).toMatchObject({
            date: TODAY, dueDate: '2026-09-15', settleMode: 'manual', flags: ['tuned', 'overdue'],
        });
        expect(lineOf(res, 'sched.5.2026-09-29')).toMatchObject({ date: TODAY, settleMode: 'auto', flags: [] });
    });
});

// ── Overrides ────────────────────────────────────────────────────────────────────────────

describe('overrides (§5.3, §5.5, D31)', () => {
    test('an override moves one instance out of the window and another into it', () => {
        const res = forecast({
            to: '2026-11-30',
            schedules: [schedule(5)],
            overrides: [
                override(51, 5, '2026-10-15', { dueDate: '2027-01-05' }), // out
                override(52, 5, '2027-02-15', { dueDate: '2026-11-20' }), // in
            ],
        });
        expect(allLines(res).map((l) => l.key)).toEqual(['sched.5.2026-11-15', 'sched.5.2027-02-15']);
        expect(lineOf(res, 'sched.5.2027-02-15')).toMatchObject({
            naturalDate: '2027-02-15', date: '2026-11-20', dueDate: '2026-11-20', flags: ['tuned'],
        });
    });

    test('an override past the schedule\'s end or off its grid → ORPHAN_OVERRIDE, not projected', () => {
        const res = forecast({
            to: '2026-11-30',
            schedules: [schedule(5, { endDate: '2026-10-31' })],
            overrides: [
                override(60, 5, '2026-11-15', { dueDate: '2026-11-16' }),
                override(61, 5, '2026-10-16', { amount: '5.00' }),
            ],
        });
        expect(res.warnings).toEqual([
            { code: 'ORPHAN_OVERRIDE', scheduleId: 5, naturalDate: '2026-10-16', overrideId: 61 },
            { code: 'ORPHAN_OVERRIDE', scheduleId: 5, naturalDate: '2026-11-15', overrideId: 60 },
        ]);
        expect(allLines(res).map((l) => [l.key, l.amountMinor])).toEqual([['sched.5.2026-10-15', 10000]]);
    });

    test('the weekend rule moves a natural date across the window edge; an override date bypasses it', () => {
        // 2026-10-31 is a Saturday: with 'previous' it lands on Friday 30th, inside a window
        // ending on the 30th, although its natural date is outside it.
        const res = forecast({
            to: '2026-10-30',
            schedules: [schedule(5, { startDate: '2026-07-31', weekendRule: 'previous' })],
            overrides: [override(53, 5, '2026-08-31', { dueDate: '2026-10-04' })],   // a Sunday, kept verbatim
        });
        expect(lineOf(res, 'sched.5.2026-10-31')).toMatchObject({ date: '2026-10-30', naturalDate: '2026-10-31' });
        expect(lineOf(res, 'sched.5.2026-08-31')).toMatchObject({ date: '2026-10-04', flags: ['tuned'] });
    });
});

// ── Scenarios ────────────────────────────────────────────────────────────────────────────

describe('scenario adjustments, applied before classification (§9.5)', () => {
    test('moving an overdue item forward clears overdue in the scenario set only', () => {
        const over = {
            items: [item(3, { dueDate: '2026-09-19', settleMode: 'manual' })],
        };
        const baseline = forecast(over);
        expect(lineOf(baseline, 'item.3')).toMatchObject({ date: TODAY, flags: ['overdue'] });
        expect('baseline' in lineOf(baseline, 'item.3')).toBe(false);

        const res = forecast({
            ...over,
            scenario: DRAFT,
            adjustments: [adjustment(1, 'item.3', { newDate: '2026-10-06', baseDate: '2026-09-19' })],
        });
        expect(lineOf(res, 'item.3')).toMatchObject({
            date: '2026-10-06', dueDate: '2026-10-06', bucketIndex: 7, flags: ['adjusted'], editable: true,
            baseline: { date: TODAY, amountMinor: 10000, gbpMinor: 10000, flags: ['overdue'] },
        });
        expect(res.days[0]).toMatchObject({ outflow: 0, closing: 100000, baselineClosing: 90000 });
        expect(res.scenario).toMatchObject({ id: 7, name: 'What if', status: 'draft', warnings: [] });
        expect(res.scenario.deltaByBucket[0]).toMatchObject({ outflow: -10000, closing: 10000 });
        expect(res.scenario.deltaByBucket[7]).toMatchObject({ outflow: 10000, closing: 0 });
        expect(res.scenario.baselineSummary).toEqual(baseline.summary);
    });

    test('an adjustment moving an out-of-window instance into the window appears', () => {
        const over = { to: '2026-11-30', schedules: [schedule(5)] };
        expect(linesOf(forecast(over), 'sched.5.2027-03-15')).toEqual([]);
        const res = forecast({
            ...over,
            scenario: DRAFT,
            adjustments: [adjustment(1, 'sched.5.2027-03-15', {
                newDate: '2026-11-02', newAmount: '120.00', baseDate: '2027-03-15', baseAmount: '100.00',
            })],
        });
        expect(lineOf(res, 'sched.5.2027-03-15')).toMatchObject({
            naturalDate: '2027-03-15', date: '2026-11-02', amountMinor: 12000, gbpMinor: 12000, flags: ['adjusted'],
            baseline: { date: '2027-03-15', amountMinor: 10000, gbpMinor: 10000, flags: [] },
        });
        expect(dayOf(res, '2026-11-02').outflow).toBe(12000);
        expect(res.scenario.baselineSummary.outflow).toBe(res.summary.outflow - 12000);
    });

    test('each stale reason is flagged and not applied', () => {
        const res = forecast({
            items: [
                item(11, { dueDate: '2026-10-05' }),
                item(12, { dueDate: '2026-09-25', status: 'paid', paidAmount: '100.00', paidOn: TODAY }),
                item(14, { dueDate: '2026-10-08' }),
            ],
            payments: [payment(81, { cashItemId: 12, paidOn: TODAY })],
            schedules: [schedule(5)],
            overrides: [override(55, 5, '2026-10-15', { amount: '120.00' })],   // a tune after the adjustment (D11)
            scenario: DRAFT,
            adjustments: [
                adjustment(1, 'item.11', { newDate: '2026-10-12', baseDate: '2026-10-05', baseAmount: '90.00' }),
                adjustment(2, 'item.12', { kind: 'exclude', baseDate: '2026-09-25' }),
                adjustment(3, 'item.999', { kind: 'exclude' }),
                adjustment(4, 'ship.PO-1', { kind: 'exclude' }),
                adjustment(5, 'sched.5.2026-10-16', { newAmount: '1.00', baseDate: '2026-10-16' }),
                adjustment(6, 'item.14', { newDate: '2026-09-28', baseDate: '2026-10-08' }),
                adjustment(7, 'sched.5.2026-10-15', { newDate: '2026-10-20', baseDate: '2026-10-15' }),
            ],
        });
        expect(res.scenario.warnings).toEqual([
            { code: 'STALE', key: 'item.11', reason: 'BASE_CHANGED' },
            { code: 'STALE', key: 'item.12', reason: 'TARGET_SETTLED' },
            { code: 'STALE', key: 'item.999', reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'ship.PO-1', reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'sched.5.2026-10-16', reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'item.14', reason: 'DATE_PASSED' },
            { code: 'STALE', key: 'sched.5.2026-10-15', reason: 'BASE_CHANGED' },
        ]);
        expect(lineOf(res, 'item.11')).toMatchObject({ date: '2026-10-05', amountMinor: 10000, flags: ['stale'] });
        expect(lineOf(res, 'item.12')).toMatchObject({ date: TODAY, paymentId: 81, flags: ['paid', 'stale'], editable: false });
        expect(lineOf(res, 'item.14')).toMatchObject({ date: '2026-10-08', flags: ['stale'] });
        expect(lineOf(res, 'sched.5.2026-10-15')).toMatchObject({ date: '2026-10-15', amountMinor: 12000, flags: ['tuned', 'stale'] });
        expect(res.summary).toEqual(res.scenario.baselineSummary);
        expect(res.scenario.deltaByBucket.every((d) => d.inflow === 0 && d.outflow === 0 && d.closing === 0)).toBe(true);
    });

    test('a target outside the requested scope → ADJUSTMENT_OUT_OF_SCOPE, in neither set; a stale one reads STALE', () => {
        const res = forecast({
            items: [
                item(8, { accountId: 2, dueDate: '2026-10-05', inScope: false }),
                item(9, { accountId: 2, dueDate: '2026-10-06', inScope: false }),
            ],
            scenario: DRAFT,
            adjustments: [
                adjustment(1, 'item.8', { kind: 'exclude', baseDate: '2026-10-05' }),
                adjustment(2, 'item.9', { newDate: '2026-10-10', baseDate: '2026-10-01' }),
            ],
        });
        expect(res.scenario.warnings).toEqual([
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: 'item.8' },
            { code: 'STALE', key: 'item.9', reason: 'BASE_CHANGED' },
        ]);
        expect(res.rows).toEqual([]);
        expect(res.summary).toEqual(res.scenario.baselineSummary);
    });

    test('an excluded item stays in rows flagged excluded and counts nothing (D30)', () => {
        const res = forecast({
            items: [item(21, { dueDate: '2026-10-05' })],
            scenario: DRAFT,
            adjustments: [adjustment(1, 'item.21', { kind: 'exclude', baseDate: '2026-10-05' })],
        });
        expect(lineOf(res, 'item.21')).toMatchObject({
            date: '2026-10-05', amountMinor: 10000, gbpMinor: 10000, flags: ['excluded'], editable: true,
            baseline: { date: '2026-10-05', amountMinor: 10000, gbpMinor: 10000, flags: [] },
        });
        expect(res.rows[0].totals.every((t) => t === 0)).toBe(true);
        expect(res.summary.outflow).toBe(0);
        expect(res.scenario.baselineSummary.outflow).toBe(10000);
        expect(dayOf(res, '2026-10-05')).toMatchObject({ outflow: 0, closing: 100000, baselineClosing: 90000 });
    });

    test('excluding an absorbed or an unresolved item removes it from the scenario\'s opening and list only (D30)', () => {
        const res = forecast({
            items: [
                item(22, { dueDate: '2026-09-25' }),                           // assumed, absorbed
                item(23, { dueDate: '2026-06-01', settleMode: 'manual' }),     // unresolved
            ],
            scenario: DRAFT,
            adjustments: [
                adjustment(1, 'item.22', { kind: 'exclude', baseDate: '2026-09-25' }),
                adjustment(2, 'item.23', { kind: 'exclude', baseDate: '2026-06-01' }),
            ],
        });
        expect(accountOf(res, 1)).toMatchObject({ absorbed: [], openingGbp: 100000 });
        expect(res.unresolved).toEqual([]);
        expect(res.rows).toEqual([]);
        expect(res.summary).toMatchObject({ opening: 100000, absorbedCount: 0, unresolvedCount: 0 });
        expect(res.scenario.baselineSummary).toMatchObject({ opening: 90000, absorbedCount: 1, unresolvedCount: 1, unresolvedTotal: 10000 });
        expect(res.days[0].baselineClosing).toBe(90000);
    });

    test('an adjustment that moves an unresolved item to the future removes it from the scenario\'s list only', () => {
        const res = forecast({
            items: [item(4, { dueDate: '2026-06-01', settleMode: 'manual' })],
            scenario: DRAFT,
            adjustments: [adjustment(1, 'item.4', { newDate: '2026-10-02', baseDate: '2026-06-01' })],
        });
        expect(res.unresolved).toEqual([]);
        expect(res.scenario.baselineSummary).toMatchObject({ unresolvedCount: 1, unresolvedTotal: 10000 });
        expect(lineOf(res, 'item.4')).toMatchObject({
            date: '2026-10-02', flags: ['adjusted'],
            baseline: { date: '2026-06-01', amountMinor: 10000, gbpMinor: 10000, flags: ['unresolved'] },
        });
    });

    test('days[].baselineClosing is present with a scenario and absent without (D34)', () => {
        const items = [item(1, { dueDate: '2026-10-01' })];
        expect(forecast({ items }).days.some((d) => 'baselineClosing' in d)).toBe(false);
        expect(forecast({ items }).scenario).toBeNull();
        const res = forecast({ items, scenario: DRAFT });
        expect(res.days.every((d) => d.baselineClosing === d.closing)).toBe(true);
    });
});

// ── Money ────────────────────────────────────────────────────────────────────────────────

describe('FX and the rounding invariant (§9.7, §9.8)', () => {
    const RATES = {
        EUR: { rateToGbp: '1.234567', effectiveFrom: '2026-09-01' },
        JPY: { rateToGbp: '0.005234', effectiveFrom: '2026-08-15' },
    };
    const rateOf = (cur) => (cur === 'GBP' ? 1000000n : parseRate(RATES[cur].rateToGbp));

    const over = {
        rates: RATES,
        accounts: [
            account({ id: 1, currency: 'EUR', anchorBalance: '1000.00' }),
            account({ id: 2, name: 'Sterling', currency: 'GBP', anchorBalance: '-250.55' }),
        ],
        items: [
            item(1, { currency: 'EUR', amount: '0.01', dueDate: '2026-10-01', direction: 'in' }),
            item(2, { currency: 'EUR', amount: '0.01', dueDate: '2026-10-01', direction: 'in' }),
            item(3, { currency: 'EUR', amount: '0.01', dueDate: '2026-10-01', direction: 'in' }),
            item(4, { currency: 'JPY', amount: '1000.00', dueDate: '2026-10-02' }),              // item → GBP → EUR
            item(5, { currency: 'EUR', amount: '333.33', dueDate: '2026-10-03' }),
            item(6, { currency: 'EUR', amount: '12345.67', dueDate: '2026-09-25', direction: 'in' }), // absorbed
            item(7, { currency: 'JPY', amount: '0.50', dueDate: '2026-09-22', direction: 'in' }),     // absorbed, rounds to 0
            item(8, { currency: 'JPY', amount: '95.54', dueDate: '2026-09-23', direction: 'in' }),    // absorbed
            item(9, { accountId: 2, currency: 'JPY', amount: '777.77', dueDate: '2026-10-02' }),
            item(10, { accountId: 2, amount: '0.99', dueDate: TODAY, direction: 'in' }),
            item(11, { accountId: 2, currency: 'EUR', amount: '0.05', dueDate: '2026-10-15' }),
            item(12, { accountId: 2, currency: 'EUR', amount: '41.07', dueDate: '2026-10-20', status: 'part_paid', paidAmount: '13.33', paidOn: '2026-09-24' }),
        ],
        payments: [payment(90, { cashItemId: 12, paidOn: '2026-09-24', amount: '13.33' })],
        schedules: [schedule(5, { currency: 'EUR', frequency: 'weekly', startDate: '2026-09-22', amount: '19.99', direction: 'in' })],
    };

    test.each(BUCKETS)('%s buckets: opening + net = closing everywhere, cells sum to totals, integer sums', (bucket) => {
        const res = forecast({ ...over, bucket });
        const accountCurrency = { 1: 'EUR', 2: 'GBP' };
        const lines = [...allLines(res), ...res.accounts.flatMap((a) => a.absorbed.map((e) => ({ ...e, accountId: a.accountId })))];
        expect(lines.length).toBeGreaterThan(15);
        for (const l of lines) {
            const gbp = toGbp(BigInt(l.amountMinor), rateOf(l.currency));
            expect(BigInt(l.gbpMinor)).toBe(gbp);
            const acctCur = accountCurrency[l.accountId];
            expect(BigInt(l.accountMinor)).toBe(l.currency === acctCur ? BigInt(l.amountMinor) : fromGbp(gbp, rateOf(acctCur)));
        }
        // the whole window reconciles with the per-line GBP values, never a re-conversion
        const dirOf = (key) => (key.startsWith('sched.') ? 'in' : over.items.find((i) => `item.${i.id}` === key).direction);
        const flows = sum(allLines(res).map((l) => signed({ ...l, direction: dirOf(l.key) }, 'gbpMinor')));
        expect(res.summary.closing).toBe(sum(res.accounts.map((a) => a.openingGbp)) + flows);
    });

    test('pinned values: rounded once per line, per step', () => {
        const res = forecast(over);
        const eur = accountOf(res, 1);
        expect(eur).toMatchObject({ currency: 'EUR', rateToGbp: '1.234567', anchorNative: 100000, anchorGbp: 123457 });
        expect(accountOf(res, 2)).toMatchObject({ anchorNative: -25055, anchorGbp: -25055, rateToGbp: '1.000000' });
        expect(lineOf(res, 'item.4')).toMatchObject({ currency: 'JPY', amountMinor: 100000, gbpMinor: 523, accountMinor: 424 });
        expect(lineOf(res, 'item.5')).toMatchObject({ amountMinor: 33333, gbpMinor: 41152, accountMinor: 33333 });
        expect(lineOf(res, 'item.9')).toMatchObject({ amountMinor: 77777, gbpMinor: 407, accountMinor: 407 });
        expect(lineOf(res, 'item.11')).toMatchObject({ amountMinor: 5, gbpMinor: 6, accountMinor: 6 });
        // three 0.01 EUR lines are 1p each: the day's inflow is 3, not toGbp(3) = 4
        expect(dayOf(res, '2026-10-01').inflow).toBe(3);
        const absorbed = Object.fromEntries(eur.absorbed.map((e) => [e.key, e]));
        expect(absorbed['item.6']).toMatchObject({ amountMinor: 1234567, gbpMinor: 1524156, accountMinor: 1234567 });
        expect(absorbed['item.7']).toMatchObject({ amountMinor: 50, gbpMinor: 0, accountMinor: 0 });
        expect(absorbed['item.8']).toMatchObject({ amountMinor: 9554, gbpMinor: 50, accountMinor: 41 });
        expect(absorbed['sched.5.2026-09-22']).toMatchObject({ amountMinor: 1999, gbpMinor: 2468 });
        expect(eur.openingGbp).toBe(123457 + 1524156 + 0 + 50 + 2468);
        expect(eur.openingNative).toBe(100000 + 1234567 + 0 + 41 + 1999);
        // the remainder of a part_paid EUR item on the GBP account: 41.07 − 13.33 = 27.74 EUR
        expect(lineOf(res, 'item.12')).toMatchObject({ amountMinor: 2774, gbpMinor: 3425, accountMinor: 3425, flags: ['remainder'] });
        expect(res.meta.ratesUsed).toEqual({
            EUR: { rateToGbp: '1.234567', effectiveFrom: '2026-09-01' },
            GBP: { rateToGbp: '1.000000', effectiveFrom: null },
            JPY: { rateToGbp: '0.005234', effectiveFrom: '2026-08-15' },
        });
    });

    test('FX_RATE_MISSING: the engine throws for a currency in scope with no rate', () => {
        const cases = [
            [{ accounts: [account({ currency: 'EUR' })] }, ['EUR']],
            [{ items: [item(1, { currency: 'USD' })] }, ['USD']],
            [{ schedules: [schedule(5, { currency: 'JPY' })], rates: { EUR: RATES.EUR } }, ['JPY']],
            // an out-of-scope adjustment target is a currency in scope too (§3.4)
            [{ items: [item(8, { accountId: 3, currency: 'CHF', inScope: false })], scenario: DRAFT }, ['CHF']],
        ];
        for (const [over2, currencies] of cases) {
            const err = thrown(() => run(input(over2)));
            expect(err).toMatchObject({ code: 'FX_RATE_MISSING', status: 422, isApiError: true, details: { currencies } });
        }
    });

    test('currenciesInScope: accounts ∪ items ∪ schedules, sorted', () => {
        expect(currenciesInScope(input({
            accounts: [account({ currency: 'GBP' }), account({ id: 2, currency: 'EUR' })],
            items: [item(1, { currency: 'USD' })],
            schedules: [schedule(5, { currency: 'CHF' })],
        }))).toEqual(['CHF', 'EUR', 'GBP', 'USD']);
    });
});

// ── The window and its buckets ──────────────────────────────────────────────────────────

describe('window (§9.10, §9.11, D7, D25) and buckets (D6, §9.12)', () => {
    test('from in the past is clamped to today; to is capped at today + 730 days', () => {
        const res = forecast({ from: '2026-09-01', to: addDays(TODAY, 800), bucket: 'month' });
        expect(res.meta).toMatchObject({ today: TODAY, from: TODAY, to: '2028-09-28', fromClamped: true, toClamped: true });
        expect(res.days).toHaveLength(731);
        expect(MAX_WINDOW_DAYS).toBe(730);
    });

    test('defaults: from today, to today + 90, week buckets, grid; nothing clamped', () => {
        const res = forecast({ from: undefined, to: undefined, bucket: undefined, include: undefined });
        expect(res.meta).toMatchObject({
            from: TODAY, to: addDays(TODAY, DEFAULT_WINDOW_DAYS), bucket: 'week', include: 'grid',
            fromClamped: false, toClamped: false, companyId: 1, scenarioId: null,
        });
        expect(DEFAULT_WINDOW_DAYS).toBe(90);
        expect(res.rows).toEqual([]);
        expect(forecast({ to: addDays(TODAY, 730) }).meta.toClamped).toBe(false);
    });

    test('clampWindow refuses a window that ends before today', () => {
        expect(() => clampWindow(TODAY, TODAY, addDays(TODAY, -1))).toThrow(RangeError);
        expect(clampWindow(TODAY, '2026-01-01', TODAY)).toEqual({ from: TODAY, to: TODAY, fromClamped: true, toClamped: false });
    });

    test('week buckets start on Monday and the first and last are clipped', () => {
        const res = forecast({
            to: '2026-10-21', bucket: 'week',
            items: [
                item(1, { dueDate: '2026-10-04' }),
                item(2, { dueDate: '2026-10-05' }),
                item(3, { dueDate: '2026-10-21' }),
            ],
        });
        expect(res.buckets.map((b) => [b.start, b.end])).toEqual([
            ['2026-09-29', '2026-10-04'],
            ['2026-10-05', '2026-10-11'],
            ['2026-10-12', '2026-10-18'],
            ['2026-10-19', '2026-10-21'],
        ]);
        expect(allLines(res).map((l) => l.bucketIndex)).toEqual([0, 1, 3]);
        expect(res.rows[0].totals).toEqual([10000, 10000, 0, 10000]);
    });

    test('day and month buckets', () => {
        const days = forecast({ to: '2026-10-03', bucket: 'day' });
        expect(days.buckets.map((b) => [b.start, b.end])).toEqual(days.days.map((d) => [d.date, d.date]));
        const months = forecast({ to: '2026-11-30', bucket: 'month' });
        expect(months.buckets.map((b) => [b.start, b.end])).toEqual([
            ['2026-09-29', '2026-09-30'],
            ['2026-10-01', '2026-10-31'],
            ['2026-11-01', '2026-11-30'],
        ]);
    });

    test('the minimum inside a month bucket comes from the daily series', () => {
        const res = forecast({
            to: '2026-11-30', bucket: 'month',
            items: [
                item(1, { dueDate: '2026-10-10', amount: '800.00' }),
                item(2, { dueDate: '2026-10-20', amount: '900.00', direction: 'in' }),
            ],
        });
        expect(res.buckets[1]).toMatchObject({
            opening: 100000, closing: 110000, minClosing: 20000, minDate: '2026-10-10',
        });
        expect(res.summary).toMatchObject({ minClosing: 20000, minDate: '2026-10-10' });
    });

    test('include=summary omits rows and keeps everything else', () => {
        const res = forecast({ include: 'summary', items: [item(1, { dueDate: '2026-10-01' })] });
        expect('rows' in res).toBe(false);
        expect(Object.keys(res)).toEqual(['meta', 'accounts', 'days', 'buckets', 'summary', 'scenario', 'hidden', 'unresolved', 'shipping', 'warnings']);
        expect(res.summary.outflow).toBe(10000);
        expect(INCLUDES).toEqual(['summary', 'grid']);
        expect(Object.keys(forecast({}))).toEqual(['meta', 'accounts', 'days', 'buckets', 'rows', 'summary', 'scenario', 'hidden', 'unresolved', 'shipping', 'warnings']);
    });
});

// ── Rows, flags and editable (§6.10) ────────────────────────────────────────────────────

describe('rows[], flags and editable (§6.10)', () => {
    const over = {
        items: [
            item(1, { dueDate: '2026-10-02', direction: 'in', counterparty: 'Acme' }),
            item(2, { dueDate: '2026-10-03', sourceScenarioId: 3 }),
            item(30, { amount: '500.00', dueDate: '2026-10-10', status: 'part_paid', paidAmount: '200.00', paidOn: TODAY }),
            item(31, { dueDate: '2026-09-25', status: 'paid', paidAmount: '100.00', paidOn: TODAY }),
        ],
        payments: [
            payment(91, { cashItemId: 30, amount: '200.00' }),
            payment(92, { cashItemId: 31, amount: '100.00' }),
        ],
        schedules: [schedule(5)],
        overrides: [override(55, 5, '2026-10-15', { amount: '150.00' })],
    };

    test('flags, editable, status and the line shape', () => {
        const res = forecast(over);
        expect(res.rows.map((r) => [r.categoryId, r.categoryName, r.direction, r.sortOrder])).toEqual([
            [10, 'Sales', 'in', 1], [20, 'Rent', 'out', 1], [21, 'Payroll', 'out', 2],
        ]);
        expect(lineOf(res, 'item.1')).toEqual({
            key: 'item.1', kind: 'item', id: 1, name: 'Item 1', counterparty: 'Acme', accountId: 1, currency: 'GBP',
            amountMinor: 10000, accountMinor: 10000, gbpMinor: 10000, date: '2026-10-02', dueDate: '2026-10-02',
            bucketIndex: 3, status: 'expected', settleMode: 'auto', flags: [], editable: true,
        });
        expect(lineOf(res, 'item.2')).toMatchObject({ flags: ['fromScenario'], editable: true });
        expect(linesOf(res, 'item.30')).toEqual([
            expect.objectContaining({ date: TODAY, dueDate: '2026-10-10', amountMinor: 20000, paymentId: 91, status: 'part_paid', flags: ['paid', 'partial'], editable: false }),
            expect.objectContaining({ date: '2026-10-10', amountMinor: 30000, status: 'part_paid', flags: ['remainder'], editable: false }),
        ]);
        expect('paymentId' in linesOf(res, 'item.30')[1]).toBe(false);
        expect(lineOf(res, 'item.31')).toMatchObject({ date: TODAY, paymentId: 92, status: 'paid', flags: ['paid'], editable: false });
        expect(lineOf(res, 'sched.5.2026-10-15')).toEqual({
            key: 'sched.5.2026-10-15', kind: 'sched', id: 5, scheduleId: 5, naturalDate: '2026-10-15',
            name: 'Schedule 5', counterparty: null, accountId: 1, currency: 'GBP',
            amountMinor: 15000, accountMinor: 15000, gbpMinor: 15000, date: '2026-10-15', dueDate: '2026-10-15',
            bucketIndex: 16, status: 'expected', settleMode: 'auto', flags: ['tuned'], editable: true,
        });
        expect(linesOf(res, 'sched.5.2026-09-15')).toEqual([]);   // auto, before A: assumed settled
        expect(res.rows[1].items.map((l) => l.key)).toEqual(['item.30', 'item.31', 'item.2', 'item.30']);
    });

    test('with a draft scenario expected lines stay editable; with an applied one nothing is', () => {
        const draft = forecast({ ...over, scenario: DRAFT });
        expect(lineOf(draft, 'item.1')).toMatchObject({ editable: true, baseline: { date: '2026-10-02', amountMinor: 10000, gbpMinor: 10000, flags: [] } });
        const applied = forecast({ ...over, scenario: { ...DRAFT, status: 'applied' } });
        expect(allLines(applied).every((l) => l.editable === false)).toBe(true);
        expect(applied.meta.scenarioId).toBe(7);
    });
});

// ── Phase 2: ship lines (§9.3.1, §6.10, P5–P9) ──────────────────────────────────────────

describe('ship lines (Phase 2, §9.3.1)', () => {
    const STOCK = { id: 90, name: 'Stock payments', direction: 'out', sortOrder: 900, systemKey: 'ship' };
    const SYNC = { lastSuccessAt: '2026-09-29T08:00:00.000Z', feedToday: TODAY, unmappedCounts: [] };
    const GONE = '2026-09-28T10:00:00.000Z';
    const NAME = 'Acme Textiles · PO-812 · balance';

    /** An external_items row as §8 rule 11 hands it over: open, dated, mapped to account 1. */
    const shipRow = (extId, over = {}) => ({
        id: 500, source: 'ship', extId, feedKind: 'balance', feedStatus: 'open', supplier: 'Acme Textiles',
        shippingCompanyId: 11, poId: 812, poNumber: 'PO-812', shipmentId: 311, containerRef: 'MSKU1234567',
        currency: 'GBP', amount: '100.00', dueDate: '2026-10-05', paidOn: null, settles: null,
        dateBasis: 'firm', amountBasis: 'stated', blocked: null, flags: [], goneAt: null,
        plannedDate: null, plannedAmount: null, plannedSkipped: false, plannedBaseAmount: null, plannedNote: null,
        sourceScenarioId: null, accountId: 1, companyId: 1, inScope: true, ...over,
    });
    const paidRow = (extId, paidOn, over = {}) => shipRow(extId, { feedStatus: 'paid', dueDate: null, paidOn, ...over });
    const ship = (over = {}) => forecast({ categories: [...CATEGORIES, STOCK], shipping: SYNC, ...over });
    const shipWarnings = (res) => res.warnings.filter((w) => w.code.startsWith('SHIP'));

    test('open lines: future, overdue at −44/−45, unresolved at −46, never assumed; undated counted', () => {
        const res = ship({
            externalItems: [
                shipRow('bal-1'),
                shipRow('bal-44', { dueDate: addDays(TODAY, -44) }),
                shipRow('bal-45', { dueDate: addDays(TODAY, -45) }),
                shipRow('bal-46', { dueDate: addDays(TODAY, -46) }),
                shipRow('dep-2', { feedKind: 'deposit', dueDate: addDays(A, -1) }),    // before A: owed, not assumed settled
                shipRow('dep-3', { feedKind: 'deposit', dueDate: addDays(TODAY, -3) }), // [A, today): owed, not absorbed
                shipRow('pi-9', { dueDate: null, dateBasis: 'undated', amount: '250.00' }),
            ],
        });
        expect(lineOf(res, 'ship.bal-1')).toEqual({
            key: 'ship.bal-1', kind: 'ship', id: 'bal-1', name: NAME, counterparty: 'Acme Textiles',
            accountId: 1, currency: 'GBP', amountMinor: 10000, accountMinor: 10000, gbpMinor: 10000,
            date: '2026-10-05', dueDate: '2026-10-05', bucketIndex: 6, status: 'expected', settleMode: 'manual',
            flags: [], editable: true,
            ship: {
                kind: 'balance', poNumber: 'PO-812', containerRef: 'MSKU1234567', dateBasis: 'firm',
                amountBasis: 'stated', blocked: null, feedDate: '2026-10-05', feedAmountMinor: 10000,
                dueSet: null, dateMovedFrom: null, dateMovedAt: null,
            },
        });
        for (const key of ['ship.bal-44', 'ship.bal-45', 'ship.dep-2', 'ship.dep-3']) {
            expect(lineOf(res, key)).toMatchObject({ date: TODAY, bucketIndex: 0, flags: ['overdue'], settleMode: 'manual' });
        }
        expect(lineOf(res, 'ship.bal-45').dueDate).toBe('2026-08-15');
        expect(lineOf(res, 'ship.dep-2')).toMatchObject({ name: 'Acme Textiles · PO-812 · deposit', dueDate: '2026-09-19' });
        expect(linesOf(res, 'ship.bal-46')).toEqual([]);
        expect(res.unresolved).toEqual([{
            key: 'ship.bal-46', kind: 'ship', name: NAME, categoryId: 90, accountId: 1, currency: 'GBP',
            amountMinor: 10000, gbpMinor: 10000, direction: 'out', date: '2026-08-14', ageDays: 46, settleMode: 'manual',
        }]);
        expect(linesOf(res, 'ship.pi-9')).toEqual([]);
        expect(accountOf(res, 1).absorbed).toEqual([]);
        expect(res.days[0].outflow).toBe(40000);
        expect(res.rows).toEqual([expect.objectContaining({
            categoryId: 90, categoryName: 'Stock payments', direction: 'out', sortOrder: 900,
        })]);
        expect(res.shipping).toEqual({
            lastSuccessAt: SYNC.lastSuccessAt, feedToday: TODAY, openCount: 7, undatedCount: 1, undatedGbp: 25000, unmappedCount: 0,
        });
        expect(res.warnings).toEqual([]);
    });

    test('a date set by hand in ShipLine: flag due_set and the story on ship.dueSet; a recent move: flag date_moved with where from and when', () => {
        const dueSet = { by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-11-01', scope: 'item', note: 'agreed' };
        const res = ship({
            externalItems: [
                shipRow('bal-set', { dueDate: '2026-10-20', dueSet, flags: ['due_set'] }),
                shipRow('bal-moved', { dueDate: '2026-10-21', dueDatePrev: '2026-10-05', dueDateMovedAt: new Date(`${addDays(TODAY, -14)}T10:00:00Z`) }),
                shipRow('bal-old-move', { dueDate: '2026-10-22', dueDatePrev: '2026-10-05', dueDateMovedAt: `${addDays(TODAY, -15)}T10:00:00.000Z` }),
                shipRow('bal-both', { dueDate: '2026-10-23', dueSet, dueDatePrev: null, dueDateMovedAt: `${TODAY}T07:00:00.000Z`, plannedDate: '2026-10-28' }),
            ],
        });
        expect(lineOf(res, 'ship.bal-set')).toMatchObject({
            date: '2026-10-20', flags: ['due_set'],
            ship: { feedDate: '2026-10-20', dueSet, dateMovedFrom: null, dateMovedAt: null },
        });
        expect(lineOf(res, 'ship.bal-moved')).toMatchObject({
            flags: ['date_moved'],
            ship: { dueSet: null, dateMovedFrom: '2026-10-05', dateMovedAt: `${addDays(TODAY, -14)}T10:00:00.000Z` },
        });
        expect(lineOf(res, 'ship.bal-old-move')).toMatchObject({ flags: [], ship: { dateMovedFrom: null, dateMovedAt: null } });
        // a JFlow plan still wins the date; the marks and the feed's story ride along
        expect(lineOf(res, 'ship.bal-both')).toMatchObject({
            date: '2026-10-28', flags: ['planned', 'due_set', 'date_moved'],
            ship: { feedDate: '2026-10-23', dueSet, dateMovedFrom: null, dateMovedAt: `${TODAY}T07:00:00.000Z` },
        });
    });

    test('the re-pin (77577a1): a forwarder\'s shipment cost sits in the Freight category, named by payee and label; an extra riding a balance, a QC unit and a top-up stay in Stock payments, named by their label; no Freight category → Stock payments', () => {
        const FREIGHT = { id: 91, name: 'Freight and forwarders', direction: 'out', sortOrder: 910, systemKey: 'freight' };
        const rows = [
            shipRow('ext-45', { feedKind: 'extra', supplier: 'Fast Forwarders Ltd', poId: null, poNumber: null, containerRef: '268', label: 'Freight', amount: '1200.00', dueDate: '2026-10-20', flags: ['shipment_cost'] }),
            shipRow('ext-44', { feedKind: 'extra', containerRef: '268', label: 'Mould cost', amount: '300.00', dueDate: '2026-10-20', flags: ['extra_charge'] }),
            shipRow('qc-81202', { feedKind: 'qc', containerRef: '268', label: 'QC units JF-ABC', amount: '32.90', dueDate: '2026-10-20', flags: ['qc_unit'] }),
            shipRow('top-817-s322', { feedKind: 'balance', containerRef: '270', label: 'Top-up', amount: '1000.00', dueDate: '2026-10-20', flags: ['top_up', 'box_paid'] }),
            shipRow('bal-812-s311', { feedKind: 'balance', containerRef: '268', amount: '1495.00', dueDate: '2026-10-20', flags: ['credit_netted'] }),
        ];
        const res = ship({ externalItems: rows, categories: [...CATEGORIES, STOCK, FREIGHT] });
        const stock = res.rows.find((r) => r.categoryId === 90);
        const freight = res.rows.find((r) => r.categoryId === 91);
        expect(freight).toMatchObject({ categoryName: 'Freight and forwarders', direction: 'out', sortOrder: 910 });
        expect(freight.items.map((i) => i.key)).toEqual(['ship.ext-45']);
        expect(lineOf(res, 'ship.ext-45')).toMatchObject({ name: 'Fast Forwarders Ltd · Freight', counterparty: 'Fast Forwarders Ltd', ship: expect.objectContaining({ kind: 'extra', containerRef: '268' }) });
        expect(stock.items.map((i) => i.key).sort()).toEqual(['ship.bal-812-s311', 'ship.ext-44', 'ship.qc-81202', 'ship.top-817-s322']);
        expect(lineOf(res, 'ship.ext-44').name).toBe('Acme Textiles · PO-812 · Mould cost');
        expect(lineOf(res, 'ship.qc-81202').name).toBe('Acme Textiles · PO-812 · QC units JF-ABC');
        expect(lineOf(res, 'ship.top-817-s322').name).toBe('Acme Textiles · PO-812 · Top-up');
        expect(lineOf(res, 'ship.bal-812-s311').name).toBe('Acme Textiles · PO-812 · balance');
        expect(freight.total + stock.total).toBe(120000 + 30000 + 3290 + 100000 + 149500);

        // No freight category seeded yet: everything in Stock payments.
        const fallback = ship({ externalItems: rows });
        expect(fallback.rows.find((r) => r.categoryId === 91)).toBeUndefined();
        expect(fallback.rows.find((r) => r.categoryId === 90).items.map((i) => i.key)).toContain('ship.ext-45');
    });

    test('paid rows: at A−1 excluded, at A absorbed (flags [paid], no paymentId), today in today\'s bucket', () => {
        const res = ship({
            externalItems: [
                paidRow('pay-1-bal812', addDays(A, -1), { amount: '11.00' }),
                paidRow('pay-2-bal812', A, { amount: '22.00' }),
                paidRow('pay-3-bal812', TODAY, { amount: '33.00' }),
            ],
        });
        expect(accountOf(res, 1).absorbed).toEqual([{
            key: 'ship.pay-2-bal812', name: NAME, categoryId: 90, date: A, currency: 'GBP',
            amountMinor: 2200, accountMinor: 2200, gbpMinor: 2200, direction: 'out', flags: ['paid'],
        }]);
        expect(accountOf(res, 1).openingGbp).toBe(97800);
        expect(linesOf(res, 'ship.pay-1-bal812')).toEqual([]);
        const today = lineOf(res, 'ship.pay-3-bal812');
        expect(today).toMatchObject({
            date: TODAY, dueDate: TODAY, bucketIndex: 0, status: 'paid', settleMode: 'manual', flags: ['paid'], editable: false,
            ship: expect.objectContaining({ feedDate: null, feedAmountMinor: 3300 }),
        });
        expect('paymentId' in today).toBe(false);
        expect(res.days[0]).toMatchObject({ opening: 97800, outflow: 3300, closing: 94500 });
        expect(res.shipping).toMatchObject({ openCount: 0, undatedCount: 0, undatedGbp: 0 });
    });

    test('overlays: planned_date moves the line, planned_amount applies while its base holds, skipped drops it', () => {
        const res = ship({
            externalItems: [
                shipRow('bal-p', { plannedDate: '2026-10-12' }),
                shipRow('bal-a', { dueDate: '2026-10-06', plannedAmount: '80.00', plannedBaseAmount: '100.00' }),
                shipRow('bal-s', { dueDate: '2026-10-07', amount: '120.00', plannedAmount: '80.00', plannedBaseAmount: '100.00' }),
                shipRow('bal-k', { dueDate: '2026-10-08', plannedSkipped: true }),
                shipRow('pi-u', { dueDate: null, dateBasis: 'undated', plannedAmount: '40.00', plannedBaseAmount: '100.00' }),
            ],
        });
        expect(lineOf(res, 'ship.bal-p')).toMatchObject({
            date: '2026-10-12', dueDate: '2026-10-12', amountMinor: 10000, flags: ['planned'],
            ship: expect.objectContaining({ feedDate: '2026-10-05', feedAmountMinor: 10000 }),
        });
        expect(lineOf(res, 'ship.bal-a')).toMatchObject({
            date: '2026-10-06', amountMinor: 8000, gbpMinor: 8000, flags: ['planned'],
            ship: expect.objectContaining({ feedAmountMinor: 10000 }),
        });
        // the feed amount moved from 100 to 120: the plan is ignored and warned about (P6)
        expect(lineOf(res, 'ship.bal-s')).toMatchObject({
            amountMinor: 12000, flags: ['planned'], ship: expect.objectContaining({ feedAmountMinor: 12000 }),
        });
        expect(linesOf(res, 'ship.bal-k')).toEqual([]);
        expect(shipWarnings(res)).toEqual([{ code: 'SHIP_PLAN_STALE', key: 'ship.bal-s' }]);
        expect(res.shipping).toMatchObject({ openCount: 5, undatedCount: 1, undatedGbp: 4000 });
        expect(res.days.find((d) => d.date === '2026-10-08').outflow).toBe(0);
    });

    test('SHIP_PLAN_ORPHANED: an overlay on a gone row warns; the row is never projected', () => {
        const res = ship({
            externalItems: [
                shipRow('dep-812', { goneAt: GONE, plannedDate: '2026-10-10' }),
                shipRow('dep-813', { goneAt: GONE }),                                        // gone, no overlay
                shipRow('dep-814', { goneAt: GONE, plannedSkipped: true }),
                shipRow('dep-815', { goneAt: GONE, plannedNote: 'held', accountId: 2, inScope: false }), // another scope
            ],
        });
        expect(res.rows).toEqual([]);
        expect(res.unresolved).toEqual([]);
        expect(shipWarnings(res)).toEqual([
            { code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-812' },
            { code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-814' },
        ]);
        expect(res.shipping).toMatchObject({ openCount: 0, undatedCount: 0 });
    });

    test('flags estimated / blocked / planned / fromScenario never change a band; a derived amount wears no flag (projected retired 2026-10-06)', () => {
        const res = ship({
            externalItems: [
                shipRow('bal-e', { dueDate: addDays(TODAY, -10), dateBasis: 'estimated', flags: ['estimated'] }),
                shipRow('bal-d', { amountBasis: 'derived', blocked: 'shipment', flags: ['projected'] }),
                shipRow('bal-f', { dueDate: '2026-10-06', plannedDate: '2026-10-06', sourceScenarioId: 7 }),
                shipRow('bal-o', { dueDate: addDays(TODAY, -60), dateBasis: 'estimated', blocked: 'pi' }),
            ],
        });
        expect(lineOf(res, 'ship.bal-e')).toMatchObject({ date: TODAY, flags: ['estimated', 'overdue'] });
        expect(lineOf(res, 'ship.bal-d')).toMatchObject({
            date: '2026-10-05', flags: ['blocked'],
            ship: expect.objectContaining({ amountBasis: 'derived', blocked: 'shipment' }),
        });
        expect(lineOf(res, 'ship.bal-f').flags).toEqual(['planned', 'fromScenario']);
        expect(res.unresolved.map((u) => [u.key, u.ageDays])).toEqual([['ship.bal-o', 60]]);
    });

    describe('the rounding invariant with USD and CNY lines (§9.8)', () => {
        const RATES = {
            USD: { rateToGbp: '0.786543', effectiveFrom: '2026-09-01' },
            CNY: { rateToGbp: '0.108765', effectiveFrom: '2026-09-15' },
        };
        const rateOf = (cur) => (cur === 'GBP' ? 1000000n : parseRate(RATES[cur].rateToGbp));
        const over = {
            rates: RATES,
            accounts: [account({ id: 1 }), account({ id: 2, name: 'Dollars', currency: 'USD', anchorBalance: '5000.00' })],
            externalItems: [
                shipRow('bal-u1', { accountId: 2, currency: 'USD', amount: '12345.67', dueDate: '2026-10-02' }),
                shipRow('bal-u2', { accountId: 2, currency: 'USD', amount: '0.01', dueDate: '2026-10-02' }),
                shipRow('bal-u3', { accountId: 2, currency: 'USD', amount: '0.01', dueDate: '2026-10-02' }),
                shipRow('bal-c1', { currency: 'CNY', amount: '98765.43', dueDate: '2026-10-03' }),          // CNY on the GBP default
                shipRow('bal-c2', { accountId: 2, currency: 'CNY', amount: '0.05', dueDate: '2026-10-03' }), // CNY → GBP → USD
                shipRow('bal-c3', { currency: 'CNY', amount: '4.44', dueDate: addDays(TODAY, -5) }),         // overdue
                paidRow('pay-u', '2026-09-25', { accountId: 2, currency: 'USD', amount: '333.33' }),          // absorbed
                paidRow('pay-c', '2026-09-22', { currency: 'CNY', amount: '777.77' }),                       // absorbed
                paidRow('pay-t', TODAY, { accountId: 2, currency: 'CNY', amount: '19.99' }),                  // today
                shipRow('pi-u', { accountId: 2, currency: 'USD', amount: '1000.01', dueDate: null }),         // undated
            ],
        };

        test.each(BUCKETS)('%s buckets: per-line GBP once, account currency through GBP, integer sums', (bucket) => {
            const res = ship({ ...over, bucket });
            const accountCurrency = { 1: 'GBP', 2: 'USD' };
            const lines = [...allLines(res), ...res.accounts.flatMap((a) => a.absorbed.map((e) => ({ ...e, accountId: a.accountId })))];
            expect(lines).toHaveLength(9);
            for (const l of lines) {
                const gbp = toGbp(BigInt(l.amountMinor), rateOf(l.currency));
                expect(BigInt(l.gbpMinor)).toBe(gbp);
                const acctCur = accountCurrency[l.accountId];
                expect(BigInt(l.accountMinor)).toBe(l.currency === acctCur ? BigInt(l.amountMinor) : fromGbp(gbp, rateOf(acctCur)));
            }
            const flows = sum(allLines(res).map((l) => -l.gbpMinor));
            expect(res.summary.closing).toBe(sum(res.accounts.map((a) => a.openingGbp)) + flows);
            expect(res.shipping.undatedGbp).toBe(Number(toGbp(100001n, rateOf('USD'))));
        });

        test('pinned values', () => {
            const res = ship(over);
            expect(lineOf(res, 'ship.bal-u1')).toMatchObject({ amountMinor: 1234567, gbpMinor: 971040, accountMinor: 1234567 });
            expect(lineOf(res, 'ship.bal-c1')).toMatchObject({ amountMinor: 9876543, gbpMinor: 1074222, accountMinor: 1074222 });
            expect(lineOf(res, 'ship.bal-c2')).toMatchObject({ amountMinor: 5, gbpMinor: 1, accountMinor: 1 });
            expect(lineOf(res, 'ship.bal-c3')).toMatchObject({ amountMinor: 444, gbpMinor: 48, date: TODAY, flags: ['overdue'] });
            expect(lineOf(res, 'ship.pay-t')).toMatchObject({ amountMinor: 1999, gbpMinor: 217, accountMinor: 276, flags: ['paid'] });
            // two 0.01 USD lines are rounded once each (1p + 1p), never as one 0.02 USD sum
            expect(lineOf(res, 'ship.bal-u2')).toMatchObject({ gbpMinor: 1, accountMinor: 1 });
            expect(dayOf(res, '2026-10-02').outflow).toBe(971040 + 1 + 1);
            const usd = accountOf(res, 2);
            expect(usd.absorbed.map((e) => [e.key, e.amountMinor, e.gbpMinor, e.accountMinor])).toEqual([
                ['ship.pay-u', 33333, 26218, 33333],
            ]);
            expect(accountOf(res, 1).absorbed.map((e) => [e.key, e.amountMinor, e.gbpMinor, e.accountMinor])).toEqual([
                ['ship.pay-c', 77777, 8459, 8459],
            ]);
            expect(res.meta.ratesUsed).toEqual({
                CNY: RATES.CNY, GBP: { rateToGbp: '1.000000', effectiveFrom: null }, USD: RATES.USD,
            });
        });
    });

    test('ship. adjustments: applied, exclude, and each stale reason through the same check (§9.5)', () => {
        const res = ship({
            externalItems: [
                shipRow('bal-1'),
                shipRow('bal-2', { dueDate: '2026-10-09', dateBasis: 'estimated' }),              // the ETA drifted from 10-06
                shipRow('bal-3', { dueDate: '2026-10-06', plannedDate: '2026-10-20', plannedAmount: '90.00', plannedBaseAmount: '100.00' }),
                shipRow('bal-4', { dueDate: '2026-10-07' }),
                paidRow('pay-5', TODAY),
                shipRow('bal-6', { dueDate: '2026-10-08', plannedSkipped: true }),
                shipRow('dep-7', { goneAt: GONE }),
                shipRow('pi-8', { dueDate: null }),
                shipRow('bal-9', { accountId: null, companyId: null, inScope: false }),             // unmapped target
                shipRow('bal-10', { dueDate: '2026-10-07', amount: '120.00', plannedAmount: '80.00', plannedBaseAmount: '100.00' }),
                shipRow('bal-11', { dueDate: '2026-10-09' }),
            ],
            scenario: DRAFT,
            adjustments: [
                adjustment(1, 'ship.bal-1', { newDate: '2026-10-12', newAmount: '150.00', baseDate: '2026-10-05' }),
                adjustment(2, 'ship.bal-2', { newDate: '2026-10-15', baseDate: '2026-10-06' }),
                adjustment(3, 'ship.bal-3', { newDate: '2026-10-21', baseDate: '2026-10-20', baseAmount: '90.00' }),
                adjustment(4, 'ship.bal-4', { kind: 'exclude', baseDate: '2026-10-07' }),
                adjustment(5, 'ship.pay-5', { kind: 'exclude', baseDate: TODAY }),
                adjustment(6, 'ship.bal-6', { kind: 'exclude', baseDate: '2026-10-08' }),
                adjustment(7, 'ship.dep-7', { kind: 'exclude' }),
                adjustment(8, 'ship.pi-8', { kind: 'exclude' }),
                adjustment(9, 'ship.bal-9', { kind: 'exclude', baseDate: '2026-10-05' }),
                adjustment(10, 'ship.bal-10', { newDate: '2026-10-09', baseDate: '2026-10-07', baseAmount: '80.00' }),
                adjustment(11, 'ship.bal-11', { newDate: '2026-09-28', baseDate: '2026-10-09' }),
            ],
        });
        expect(res.scenario.warnings).toEqual([
            { code: 'STALE', key: 'ship.bal-2', reason: 'BASE_CHANGED' },
            { code: 'STALE', key: 'ship.pay-5', reason: 'TARGET_SETTLED' },
            { code: 'STALE', key: 'ship.bal-6', reason: 'TARGET_SETTLED' },
            { code: 'STALE', key: 'ship.dep-7', reason: 'TARGET_MISSING' },
            { code: 'STALE', key: 'ship.pi-8', reason: 'TARGET_MISSING' },
            { code: 'ADJUSTMENT_OUT_OF_SCOPE', key: 'ship.bal-9' },
            { code: 'STALE', key: 'ship.bal-10', reason: 'BASE_CHANGED' },
            { code: 'STALE', key: 'ship.bal-11', reason: 'DATE_PASSED' },
        ]);
        expect(lineOf(res, 'ship.bal-1')).toMatchObject({
            date: '2026-10-12', dueDate: '2026-10-12', amountMinor: 15000, flags: ['adjusted'], editable: true,
            baseline: { date: '2026-10-05', amountMinor: 10000, gbpMinor: 10000, flags: [] },
            ship: expect.objectContaining({ feedDate: '2026-10-05', feedAmountMinor: 10000 }),
        });
        expect(lineOf(res, 'ship.bal-2')).toMatchObject({ date: '2026-10-09', flags: ['estimated', 'stale'] });
        // the base is the overlay-adjusted value (as D11), so the adjustment applies
        expect(lineOf(res, 'ship.bal-3')).toMatchObject({ date: '2026-10-21', amountMinor: 9000, flags: ['planned', 'adjusted'] });
        expect(lineOf(res, 'ship.bal-4')).toMatchObject({ flags: ['excluded'] });
        expect(lineOf(res, 'ship.pay-5')).toMatchObject({ flags: ['paid', 'stale'], editable: false });
        expect(lineOf(res, 'ship.bal-10')).toMatchObject({ date: '2026-10-07', amountMinor: 12000, flags: ['planned', 'stale'] });
        expect(lineOf(res, 'ship.bal-11')).toMatchObject({ date: '2026-10-09', flags: ['stale'] });
        expect(linesOf(res, 'ship.bal-9')).toEqual([]);
        expect(res.scenario.deltaByBucket.find((d) => d.start === '2026-10-05')).toMatchObject({ outflow: -10000 });
        expect(res.scenario.deltaByBucket.find((d) => d.start === '2026-10-12')).toMatchObject({ outflow: 15000 });
        expect(shipWarnings(res)).toEqual([{ code: 'SHIP_PLAN_STALE', key: 'ship.bal-10' }]);
    });

    test('FX_RATE_MISSING for a ship currency, undated rows included; gone rows need no rate', () => {
        const err = thrown(() => run(input({
            categories: [...CATEGORIES, STOCK],
            externalItems: [shipRow('bal-1', { currency: 'USD' }), shipRow('pi-2', { currency: 'CNY', dueDate: null })],
        })));
        expect(err).toMatchObject({ code: 'FX_RATE_MISSING', status: 422, details: { currencies: ['CNY', 'USD'] } });
        expect(currenciesInScope(input({
            externalItems: [
                shipRow('bal-1', { currency: 'USD' }),
                shipRow('pi-2', { currency: 'CNY', dueDate: null }),
                shipRow('dep-3', { currency: 'HKD', goneAt: GONE }),
                shipRow('dep-4', { currency: 'EUR', inScope: false, accountId: null }),
            ],
        }))).toEqual(['CNY', 'EUR', 'GBP', 'USD']);
        const res = ship({ externalItems: [shipRow('dep-3', { currency: 'HKD', goneAt: GONE, plannedDate: '2026-10-10' })] });
        expect(res.meta.ratesUsed).toEqual({ GBP: { rateToGbp: '1.000000', effectiveFrom: null } });
    });

    test('SHIP_UNMAPPED once per shipping company and reason; SHIPPING_UNAVAILABLE passes through; the warning order', () => {
        const res = ship({
            accounts: [account(), account({ id: 2, anchorDate: null, anchorBalance: null })],
            shipping: {
                ...SYNC,
                unmappedCounts: [
                    { shippingCompanyId: null, count: 2, reason: 'company' },
                    { shippingCompanyId: 7, count: 3, reason: 'company' },
                    { shippingCompanyId: 8, count: 4, reason: 'account', companyId: 21, currencies: ['EUR', 'USD'] },
                ],
            },
            warnings: [{ code: 'SHIPPING_UNAVAILABLE', reason: 'timeout', lastSuccessAt: SYNC.lastSuccessAt }],
            schedules: [schedule(5, { endDate: '2026-10-31' })],
            overrides: [override(60, 5, '2026-10-16', { amount: '5.00' })],
            externalItems: [
                shipRow('dep-1', { goneAt: GONE, plannedNote: 'x' }),
                shipRow('bal-2', { amount: '1.00', plannedAmount: '2.00', plannedBaseAmount: '3.00' }),
            ],
        });
        expect(res.warnings).toEqual([
            { code: 'NO_ANCHOR', accountId: 2 },
            { code: 'SHIPPING_UNAVAILABLE', reason: 'timeout', lastSuccessAt: SYNC.lastSuccessAt },
            { code: 'ORPHAN_OVERRIDE', scheduleId: 5, naturalDate: '2026-10-16', overrideId: 60 },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 2, reason: 'company' },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 7, count: 3, reason: 'company' },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 8, count: 4, reason: 'account', companyId: 21, currencies: ['EUR', 'USD'] },
            { code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-1' },
            { code: 'SHIP_PLAN_STALE', key: 'ship.bal-2' },
        ]);
        expect(res.shipping).toEqual({
            lastSuccessAt: SYNC.lastSuccessAt, feedToday: TODAY, openCount: 1, undatedCount: 0, undatedGbp: 0, unmappedCount: 9,
        });
        // A count with no reason is malformed input.
        expect(() => ship({ shipping: { ...SYNC, unmappedCounts: [{ shippingCompanyId: 1, count: 1 }] } })).toThrow(TypeError);
    });

    test('no successful feed yet: shipping is null; include=summary keeps the block', () => {
        expect(forecast({}).shipping).toBeNull();
        const res = ship({ include: 'summary', externalItems: [shipRow('bal-1'), shipRow('pi-2', { dueDate: null })] });
        expect('rows' in res).toBe(false);
        expect(res.shipping).toMatchObject({ openCount: 2, undatedCount: 1, undatedGbp: 10000 });
        expect(res.summary.outflow).toBe(10000);
    });

    test('rows out of scope or on an account with no anchor are neither projected nor counted', () => {
        const res = ship({
            accounts: [account(), account({ id: 2, anchorDate: null, anchorBalance: null })],
            externalItems: [
                shipRow('bal-1', { accountId: 3, companyId: 2, inScope: false }),
                shipRow('bal-2', { accountId: 2 }),
                shipRow('pi-3', { accountId: 2, dueDate: null }),
                shipRow('bal-4', { accountId: 1 }),
            ],
        });
        expect(allLines(res).map((l) => l.key)).toEqual(['ship.bal-4']);
        expect(res.shipping).toMatchObject({ openCount: 1, undatedCount: 0 });
    });

    test('ship rows with no systemKey ship category, or a bad feed status, are refused', () => {
        expect(() => run(input({ externalItems: [shipRow('bal-1')] }))).toThrow(TypeError);
        expect(() => run(input({ categories: [...CATEGORIES, STOCK], externalItems: [shipRow('bal-1', { feedStatus: 'late' })] })))
            .toThrow(TypeError);
    });
});

// ── Purity ───────────────────────────────────────────────────────────────────────────────

describe('purity', () => {
    test('engine.js reads no DB, service or clock, and leaves every band to classify.js', () => {
        const src = fs.readFileSync(require.resolve('../../src/lib/engine'), 'utf8');
        expect(src).not.toMatch(/require\([^)]*(db|services)/);
        expect(src).not.toMatch(/new Date|Date\.now/);
        expect(src).toMatch(/require\('\.\/classify'\)/);
        expect(src).not.toMatch(/OVERDUE_WINDOW_DAYS|\b45\b/);
    });

    test('malformed options throw', () => {
        expect(() => run(input({ bucket: 'year' }))).toThrow(TypeError);
        expect(() => run(input({ include: 'all' }))).toThrow(TypeError);
        expect(BUCKETS).toEqual(['day', 'week', 'month']);
    });

    test('the same input gives the same output', () => {
        const a = forecast({ items: [item(1, { dueDate: '2026-10-01' })], scenario: DRAFT });
        const b = forecast({ items: [item(1, { dueDate: '2026-10-01' })], scenario: DRAFT });
        expect(a).toEqual(b);
    });
});

// ── Hide (§6.10 `hide` / `hideCategories`, Dev 2026-10-07) ───────────────────────────────

describe('hide: lines left out of one read, nothing stored', () => {
    const hide = (over = {}) => ({ keys: [], categoryIds: [], ...over });

    test('no hide → hidden is null and no day carries fullClosing', () => {
        const res = forecast({ items: [item(31, { dueDate: '2026-10-05' })] });
        expect(res.hidden).toBeNull();
        res.days.forEach((d) => expect('fullClosing' in d).toBe(false));
        expect(forecast({ items: [item(31, { dueDate: '2026-10-05' })], hide: hide() }).hidden).toBeNull();
    });

    test('a hidden key stays in rows flagged hidden, counts nothing, and the answer says what went', () => {
        const res = forecast({
            items: [item(31, { dueDate: '2026-10-05' }), item(32, { dueDate: '2026-10-06', direction: 'in', amount: '250.00' })],
            hide: hide({ keys: ['item.31'] }),
        });
        expect(lineOf(res, 'item.31')).toMatchObject({ gbpMinor: 10000, flags: ['hidden'], editable: true });
        expect(lineOf(res, 'item.32').flags).toEqual([]);
        expect(res.rows.find((r) => r.categoryId === 20).total).toBe(0);
        expect(res.summary).toMatchObject({ inflow: 25000, outflow: 0, closing: 125000 });
        expect(dayOf(res, '2026-10-05')).toMatchObject({ outflow: 0, closing: 100000, fullClosing: 90000 });
        expect(dayOf(res, '2026-10-06')).toMatchObject({ closing: 125000, fullClosing: 115000 });
        expect(res.hidden).toMatchObject({
            count: 1, inflow: 0, outflow: 10000,
            fullSummary: { inflow: 25000, outflow: 10000, closing: 115000, minClosing: 90000, minDate: '2026-10-05' },
        });
        expect(res.scenario).toBeNull();
    });

    test('a hidden category hides every line in it — one-offs and schedule instances alike', () => {
        const res = forecast({
            items: [item(33, { dueDate: '2026-10-05', categoryId: 21 }), item(34, { dueDate: '2026-10-07' })],
            schedules: [schedule(5)],                       // Payroll (21), 15th of the month
            hide: hide({ categoryIds: [21] }),
        });
        expect(lineOf(res, 'item.33').flags).toEqual(['hidden']);
        expect(lineOf(res, 'sched.5.2026-10-15').flags).toEqual(['hidden']);
        expect(lineOf(res, 'item.34').flags).toEqual([]);
        expect(res.summary.outflow).toBe(10000);
        expect(res.hidden).toMatchObject({ count: 2, inflow: 0, outflow: 20000 });
    });

    test('what is already in today\'s opening stays there: hiding an absorbed line changes nothing', () => {
        const res = forecast({ items: [item(35, { dueDate: '2026-09-25' })], hide: hide({ keys: ['item.35'] }) });
        expect(accountOf(res, 1)).toMatchObject({ openingGbp: 90000 });
        expect(absorbedKeys(res)).toEqual(['item.35']);
        expect(res.hidden).toMatchObject({ count: 0, inflow: 0, outflow: 0 });
    });

    test('a key or category with nothing behind it hides nothing', () => {
        const res = forecast({ items: [item(36, { dueDate: '2026-10-05' })], hide: hide({ keys: ['item.999'], categoryIds: [77] }) });
        expect(lineOf(res, 'item.36').flags).toEqual([]);
        expect(res.hidden).toMatchObject({ count: 0, outflow: 0 });
        expect(res.summary).toEqual(res.hidden.fullSummary);
    });

    test('with a scenario: the hide sits on the scenario set; baselineClosing is still the real plan', () => {
        const res = forecast({
            items: [item(37, { dueDate: '2026-10-05' }), item(38, { dueDate: '2026-10-05', amount: '40.00' })],
            scenario: DRAFT,
            adjustments: [adjustment(1, 'item.37', { newAmount: '60.00', baseDate: '2026-10-05' })],
            hide: hide({ keys: ['item.38'] }),
        });
        expect(lineOf(res, 'item.37').flags).toEqual(['adjusted']);
        expect(lineOf(res, 'item.38').flags).toEqual(['hidden']);
        // real plan 1000 − 100 − 40; scenario 1000 − 60 − 40; scenario with item.38 hidden 1000 − 60
        expect(dayOf(res, '2026-10-05')).toMatchObject({ closing: 94000, fullClosing: 90000, baselineClosing: 86000 });
        expect(res.hidden).toMatchObject({ count: 1, outflow: 4000, fullSummary: { closing: 90000 } });
        expect(res.scenario.baselineSummary.closing).toBe(86000);
    });

    test('a line the scenario already left out is not counted as hidden money', () => {
        const res = forecast({
            items: [item(39, { dueDate: '2026-10-05' })],
            scenario: DRAFT,
            adjustments: [adjustment(1, 'item.39', { kind: 'exclude', baseDate: '2026-10-05' })],
            hide: hide({ keys: ['item.39'] }),
        });
        expect(lineOf(res, 'item.39').flags).toEqual(['excluded', 'hidden']);
        expect(res.hidden).toMatchObject({ count: 0, outflow: 0 });
    });
});
