'use strict';

// lib/instances.js — a schedule's virtual instances (CONTRACT §3.4, §5.5, §6.9): the
// instance JSON built from the schedule, its natural date, the override row and the
// override's payments; the window expansion with its ORPHAN_OVERRIDE warnings; and the
// two questions the D17 deactivation guard asks of a schedule. Pure: no DB, no clock.

const fs = require('fs');

const {
    buildInstance, expandInstances, hasOccurrenceOnOrAfter, owedCandidateDates, OWED_SCAN_DAYS,
} = require('../../src/lib/instances');

const TODAY = '2026-03-10';   // a Tuesday

const schedule = (over = {}) => ({
    id: 7, accountId: 3, direction: 'out', amount: '1000.00', currency: 'GBP', frequency: 'monthly',
    intervalCount: 1, startDate: '2026-01-05', activeFrom: null, occurrenceCount: null, endDate: null,
    weekendRule: 'none', settleMode: 'auto', ...over,
});

// Override JSON (lib/shape.js overrideToJson).
const override = (naturalDate, over = {}) => ({
    id: 40, scheduleId: 7, naturalDate, amount: null, dueDate: null, status: null, settleMode: null,
    paidOn: null, paidAmount: null, note: null, sourceScenarioId: null, rowVersion: 0,
    createdBy: 'a@b.c', createdAt: 'c', updatedAt: 'u', ...over,
});

const INSTANCE_KEYS = [
    'amount', 'currency', 'direction', 'dueDate', 'key', 'naturalDate', 'override', 'payments',
    'predictedDueDate', 'remainingAmount', 'scheduleId', 'settleMode', 'status', 'tuned',
];
const OVERRIDE_KEYS = [
    'amount', 'createdAt', 'createdBy', 'dueDate', 'id', 'note', 'paidAmount', 'paidOn', 'rowVersion',
    'settleMode', 'sourceScenarioId', 'status', 'updatedAt',
];

describe('buildInstance (§6.9)', () => {
    test('predicted: effective values are the schedule\'s, weekend rule applied', () => {
        // 5 Apr 2026 is a Sunday.
        const inst = buildInstance(schedule({ weekendRule: 'next' }), '2026-04-05');
        expect(Object.keys(inst).sort()).toEqual(INSTANCE_KEYS);
        expect(inst).toEqual({
            key: 'sched.7.2026-04-05', scheduleId: 7, naturalDate: '2026-04-05',
            predictedDueDate: '2026-04-06', dueDate: '2026-04-06',
            amount: '1000.00', remainingAmount: '1000.00', currency: 'GBP', direction: 'out',
            status: 'expected', settleMode: 'auto', tuned: false, override: null, payments: [],
        });
    });

    test('tuned: the override\'s amount, date (verbatim, weekend rule bypassed), status and settle mode', () => {
        const o = override('2026-04-05', {
            amount: '983.00', dueDate: '2026-04-04', status: 'skipped', settleMode: 'manual', note: 'June 983',
        });
        const inst = buildInstance(schedule({ weekendRule: 'next' }), '2026-04-05', o);
        expect(inst).toMatchObject({
            predictedDueDate: '2026-04-06', dueDate: '2026-04-04', amount: '983.00', remainingAmount: '983.00',
            status: 'skipped', settleMode: 'manual', tuned: true,
        });
        expect(Object.keys(inst.override).sort()).toEqual(OVERRIDE_KEYS);
        expect(inst.override).toMatchObject({ id: 40, amount: '983.00', dueDate: '2026-04-04', note: 'June 983' });
    });

    test('an all-null override is still a tune; status "expected" stored explicitly reads expected', () => {
        expect(buildInstance(schedule(), '2026-04-05', override('2026-04-05'))).toMatchObject({
            tuned: true, status: 'expected', settleMode: 'auto', amount: '1000.00', dueDate: '2026-04-05',
        });
        expect(buildInstance(schedule(), '2026-04-05', override('2026-04-05', { status: 'expected' })).status).toBe('expected');
    });

    test('part paid: remainingAmount off the cache; payments without their parent ids', () => {
        const o = override('2026-03-05', { status: 'part_paid', paidAmount: '700.00', paidOn: '2026-03-03' });
        const payments = [
            { id: 1, cashItemId: null, overrideId: 40, paidOn: '2026-02-24', amount: '400.00', note: 'first', createdBy: 'x', createdAt: 't1' },
            { id: 2, cashItemId: null, overrideId: 40, paidOn: '2026-03-03', amount: '300.00', note: null, createdBy: 'x', createdAt: 't2' },
        ];
        const inst = buildInstance(schedule(), '2026-03-05', o, payments);
        expect(inst).toMatchObject({ status: 'part_paid', amount: '1000.00', remainingAmount: '300.00' });
        expect(inst.payments).toEqual([
            { id: 1, paidOn: '2026-02-24', amount: '400.00', note: 'first', createdBy: 'x', createdAt: 't1' },
            { id: 2, paidOn: '2026-03-03', amount: '300.00', note: null, createdBy: 'x', createdAt: 't2' },
        ]);
    });

    test('money is normalised to two decimals', () => {
        expect(buildInstance(schedule({ amount: '5' }), '2026-04-05').amount).toBe('5.00');
    });
});

describe('expandInstances', () => {
    test('natural dates in the window with their overrides; orphans reported whatever the window (§5.5)', () => {
        const s = schedule({ endDate: '2026-05-31' });
        const overrides = [
            override('2026-02-05', { id: 1 }),
            override('2026-02-06', { id: 2 }),       // not on the grid
            override('2026-03-05', { id: 3 }),
            override('2026-06-05', { id: 4 }),       // past the end
        ];
        const { instances, orphans } = expandInstances(s, overrides, '2026-03-01', '2026-12-31');
        expect(instances.map((i) => [i.naturalDate, i.override && i.override.id])).toEqual([
            ['2026-03-05', 3], ['2026-04-05', null], ['2026-05-05', null],
        ]);
        expect(orphans).toEqual([
            { code: 'ORPHAN_OVERRIDE', scheduleId: 7, naturalDate: '2026-02-06', overrideId: 2 },
            { code: 'ORPHAN_OVERRIDE', scheduleId: 7, naturalDate: '2026-06-05', overrideId: 4 },
        ]);
    });

    test('a date before active_from belongs to the predecessor: an override there is an orphan', () => {
        const s = schedule({ activeFrom: '2026-03-05' });
        const { instances, orphans } = expandInstances(s, [override('2026-02-05', { id: 9 })], '2026-01-01', '2026-04-30');
        expect(instances.map((i) => i.naturalDate)).toEqual(['2026-03-05', '2026-04-05']);
        expect(orphans.map((o) => o.overrideId)).toEqual([9]);
    });
});

describe('hasOccurrenceOnOrAfter (D17 liveSchedules)', () => {
    test('open-ended, and ended before / on / after today', () => {
        expect(hasOccurrenceOnOrAfter(schedule(), [], TODAY)).toBe(true);
        expect(hasOccurrenceOnOrAfter(schedule({ endDate: '2026-03-09' }), [], TODAY)).toBe(false);
        expect(hasOccurrenceOnOrAfter(schedule({ startDate: '2026-01-10', endDate: '2026-03-10' }), [], TODAY)).toBe(true);
        expect(hasOccurrenceOnOrAfter(schedule({ occurrenceCount: 2 }), [], TODAY)).toBe(false);   // 5 Jan, 5 Feb
    });

    test('by effective date: the weekend rule can pull the last natural date to before today', () => {
        // Last natural date Sun 15 Mar; today is Fri 13 Mar.
        const s = schedule({ startDate: '2026-01-15', endDate: '2026-03-15', weekendRule: 'previous' });
        expect(hasOccurrenceOnOrAfter(s, [], '2026-03-13')).toBe(true);    // → Fri 13 Mar = today
        expect(hasOccurrenceOnOrAfter(s, [], '2026-03-14')).toBe(false);   // → Fri 13 Mar < Sat 14 Mar
        expect(hasOccurrenceOnOrAfter({ ...s, weekendRule: 'next' }, [], '2026-03-16')).toBe(true);   // → Mon 16 Mar
    });

    test('overrides: a date moved forward keeps it live; one moved back is not an occurrence on or after today', () => {
        const ended = schedule({ endDate: '2026-02-28' });
        expect(hasOccurrenceOnOrAfter(ended, [override('2026-02-05', { dueDate: '2026-03-20' })], TODAY)).toBe(true);
        expect(hasOccurrenceOnOrAfter(ended, [override('2026-02-06', { dueDate: '2026-03-20' })], TODAY)).toBe(false); // orphan
        const last = schedule({ endDate: '2026-03-31' });   // 5 Mar (past), then nothing
        expect(hasOccurrenceOnOrAfter(schedule({ endDate: '2026-04-05' }), [override('2026-04-05', { dueDate: '2026-03-01' })], TODAY)).toBe(false);
        expect(hasOccurrenceOnOrAfter(last, [], TODAY)).toBe(false);
    });
});

describe('owedCandidateDates (D17 owedInstances)', () => {
    test('a manual schedule is scanned back OWED_SCAN_DAYS (§8 rule 5) up to today + 2', () => {
        expect(OWED_SCAN_DAYS).toBe(730);
        const weekly = schedule({ frequency: 'weekly', startDate: '2023-01-02', settleMode: 'manual' });
        const dates = owedCandidateDates(weekly, [], TODAY);
        expect(dates[0] >= '2024-03-10').toBe(true);           // today − 730
        expect(dates[0] < '2024-03-17').toBe(true);
        expect(dates[dates.length - 1]).toBe('2026-03-09');    // Mondays; the next is 16 Mar > today + 2
    });

    test('an auto schedule contributes only its overrides; orphans never', () => {
        const overrides = [override('2026-02-05', { settleMode: 'manual' }), override('2026-02-07'), override('2026-01-05', { status: 'part_paid' })];
        expect(owedCandidateDates(schedule(), overrides, TODAY)).toEqual(['2026-01-05', '2026-02-05']);
    });

    test('manual scan and overrides merge, ascending, without duplicates', () => {
        const s = schedule({ settleMode: 'manual', startDate: '2026-01-05' });
        expect(owedCandidateDates(s, [override('2026-02-05'), override('2026-04-05')], TODAY))
            .toEqual(['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']);
    });
});

describe('module boundary', () => {
    test('instances.js is pure and holds no band table', () => {
        const src = fs.readFileSync(require.resolve('../../src/lib/instances'), 'utf8');
        expect(src).not.toMatch(/require\([^)]*db/);
        expect(src).not.toMatch(/new Date|Date\.now/);
        expect(src).not.toMatch(/assumedSettled|settledBeforeAnchor|unresolved|overdue/);
    });
});
