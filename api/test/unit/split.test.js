'use strict';

// lib/split.js — the pure decisions of split and end (CONTRACT §10.5 steps 2 and 5,
// D21, D22, D37): which structural fields a body changes, whether the change keeps the
// date grid (keepSeries), the successor's shape, and the partition of the draft
// adjustments into rekey[] and drop[]. The transaction itself is pinned end to end by
// test/e2e/split.test.js; this file pins the rules.

const fs = require('fs');

const {
    STRUCTURAL_FIELDS, changedStructure, keepsSeries, successorShape, partitionAdjustments,
} = require('../../src/lib/split');
const { occurrences, isOccurrence } = require('../../src/lib/recurrence');

// Schedule JSON (lib/shape.js scheduleToJson), the fields the rules read.
const schedule = (over = {}) => ({
    id: 7, accountId: 3, amount: '1000.00', currency: 'GBP', frequency: 'monthly', intervalCount: 1,
    startDate: '2026-01-31', activeFrom: null, occurrenceCount: null, endDate: null,
    weekendRule: 'none', settleMode: 'auto', ...over,
});

describe('STRUCTURAL_FIELDS (D37)', () => {
    test('exactly the ten structural fields, JSON names', () => {
        expect(STRUCTURAL_FIELDS).toEqual([
            'amount', 'currency', 'accountId', 'frequency', 'intervalCount', 'startDate',
            'occurrenceCount', 'endDate', 'weekendRule', 'settleMode',
        ]);
    });
});

describe('changedStructure', () => {
    test('only fields present in changes AND different from the row, in D37 order', () => {
        expect(changedStructure(schedule(), {})).toEqual([]);
        expect(changedStructure(schedule(), { settleMode: 'manual', amount: '1050.00' })).toEqual(['amount', 'settleMode']);
    });

    test('an unchanged value is not a change: money by minor units, ids and counts by value', () => {
        expect(changedStructure(schedule(), {
            amount: '1000', currency: 'GBP', accountId: 3, frequency: 'monthly', intervalCount: 1,
            startDate: '2026-01-31', weekendRule: 'none', settleMode: 'auto',
        })).toEqual([]);
        expect(changedStructure(schedule({ occurrenceCount: 12 }), { occurrenceCount: 12 })).toEqual([]);
    });

    test('the two ends: null clears (a change only when one was set)', () => {
        expect(changedStructure(schedule(), { endDate: null, occurrenceCount: null })).toEqual([]);
        expect(changedStructure(schedule({ endDate: '2026-12-31' }), { endDate: null })).toEqual(['endDate']);
        expect(changedStructure(schedule(), { occurrenceCount: 6 })).toEqual(['occurrenceCount']);
    });
});

describe('keepsSeries (D21)', () => {
    test('true unless frequency, intervalCount, startDate or weekendRule changes', () => {
        expect(keepsSeries(schedule(), { amount: '1050.00' })).toBe(true);
        expect(keepsSeries(schedule(), { accountId: 4, currency: 'EUR', settleMode: 'manual' })).toBe(true);
        expect(keepsSeries(schedule(), { endDate: '2026-12-31' })).toBe(true);
        expect(keepsSeries(schedule(), { frequency: 'monthly', startDate: '2026-01-31' })).toBe(true);
        expect(keepsSeries(schedule(), { frequency: 'quarterly' })).toBe(false);
        expect(keepsSeries(schedule(), { intervalCount: 2 })).toBe(false);
        expect(keepsSeries(schedule(), { startDate: '2026-07-01' })).toBe(false);
        expect(keepsSeries(schedule(), { weekendRule: 'next' })).toBe(false);
    });
});

describe('successorShape', () => {
    test('amount-only split of a monthly-from-31-Jan series at 30 Jun keeps the grid (§5.4)', () => {
        const s = successorShape(schedule(), '2026-06-30', { amount: '1050.00' });
        expect(s).toEqual({
            keepSeries: true,
            amount: '1050.00', currency: 'GBP', accountId: 3, frequency: 'monthly', intervalCount: 1,
            weekendRule: 'none', settleMode: 'auto',
            startDate: '2026-01-31', activeFrom: '2026-06-30', occurrenceCount: null, endDate: null,
        });
        expect(occurrences(s, '2026-01-01', '2026-09-30')).toEqual(['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']);
        expect(isOccurrence(s, '2026-05-31')).toBe(false);
    });

    test('keepSeries inherits occurrence_count verbatim (n counts from start_date) and end_date', () => {
        expect(successorShape(schedule({ occurrenceCount: 12 }), '2026-06-30', { amount: '1.00' }))
            .toMatchObject({ startDate: '2026-01-31', activeFrom: '2026-06-30', occurrenceCount: 12, endDate: null });
        expect(successorShape(schedule({ endDate: '2026-12-31' }), '2026-06-30', { amount: '1.00' }))
            .toMatchObject({ occurrenceCount: null, endDate: '2026-12-31' });
    });

    test('a grid change starts at k (or changes.startDate) with the remaining count', () => {
        const s = successorShape(schedule({ occurrenceCount: 12 }), '2026-06-30', { frequency: 'quarterly' });
        // 31 Jan … 31 May are occurrences 0–4, so 7 of the 12 remain.
        expect(s).toMatchObject({
            keepSeries: false, frequency: 'quarterly', startDate: '2026-06-30', activeFrom: null,
            occurrenceCount: 7, endDate: null,
        });
        expect(successorShape(schedule(), '2026-06-30', { startDate: '2026-07-15' }))
            .toMatchObject({ keepSeries: false, startDate: '2026-07-15', activeFrom: null });
    });

    test('an end in changes replaces the inherited end entirely (D22: never both)', () => {
        expect(successorShape(schedule({ occurrenceCount: 12 }), '2026-06-30', { amount: '1.00', endDate: '2026-10-31' }))
            .toMatchObject({ occurrenceCount: null, endDate: '2026-10-31' });
        expect(successorShape(schedule({ endDate: '2026-12-31' }), '2026-06-30', { frequency: 'quarterly', occurrenceCount: 2 }))
            .toMatchObject({ occurrenceCount: 2, endDate: null });
        expect(successorShape(schedule({ endDate: '2026-12-31' }), '2026-06-30', { amount: '1.00', endDate: null }))
            .toMatchObject({ occurrenceCount: null, endDate: null });
    });

    test('a chained successor (active_from already set) keeps the original start_date', () => {
        const chained = schedule({ activeFrom: '2026-03-31' });
        expect(successorShape(chained, '2026-06-30', { amount: '2.00' }))
            .toMatchObject({ startDate: '2026-01-31', activeFrom: '2026-06-30' });
    });

    test('k must be an occurrence (endBefore throws otherwise)', () => {
        expect(() => successorShape(schedule(), '2026-06-15', { amount: '1.00' })).toThrow(RangeError);
    });
});

describe('partitionAdjustments (§10.5 step 5)', () => {
    const adj = (targetDate, id = 1) => ({ id, scenarioId: 9, itemKey: `sched.7.${targetDate}`, targetDate });
    const drafts = [adj('2026-06-30', 1), adj('2026-07-31', 2), adj('2026-10-31', 3)];
    const plan = (changes, base = schedule()) => {
        const successor = successorShape(base, '2026-06-30', changes);
        return {
            action: 'split',
            keepSeries: successor.keepSeries,
            currencyChanged: changedStructure(base, changes).includes('currency'),
            successor,
        };
    };
    const ids = (list) => list.map((a) => a.id);

    test('amount-only or account-only: every adjustment re-keys', () => {
        for (const changes of [{ amount: '1050.00' }, { accountId: 4 }, { settleMode: 'manual' }]) {
            const { rekey, drop } = partitionAdjustments(drafts, plan(changes));
            expect([ids(rekey), ids(drop)]).toEqual([[1, 2, 3], []]);
        }
    });

    test('a currency change drops them all, even with the grid kept', () => {
        const { rekey, drop } = partitionAdjustments(drafts, plan({ currency: 'EUR' }));
        expect([ids(rekey), ids(drop)]).toEqual([[], [1, 2, 3]]);
    });

    test('a grid change (frequency, interval, start, weekend rule) drops them all', () => {
        for (const changes of [{ frequency: 'quarterly' }, { intervalCount: 2 }, { startDate: '2026-07-01' }, { weekendRule: 'previous' }]) {
            const { rekey, drop } = partitionAdjustments(drafts, plan(changes));
            expect([ids(rekey), ids(drop)]).toEqual([[], [1, 2, 3]]);
        }
    });

    test('an end never re-keys', () => {
        const { rekey, drop } = partitionAdjustments(drafts, { action: 'end' });
        expect([ids(rekey), ids(drop)]).toEqual([[], [1, 2, 3]]);
    });

    test('keepSeries with a shorter end: only the dates the successor still generates re-key', () => {
        const { rekey, drop } = partitionAdjustments(drafts, plan({ amount: '1050.00', endDate: '2026-08-31' }));
        expect([ids(rekey), ids(drop)]).toEqual([[1, 2], [3]]);
    });

    test('a target date that is no occurrence at all (already missing) is dropped, never re-keyed', () => {
        const { rekey, drop } = partitionAdjustments([adj('2026-07-15', 4)], plan({ amount: '1050.00' }));
        expect([ids(rekey), ids(drop)]).toEqual([[], [4]]);
    });

    test('the input order is kept in both lists', () => {
        const mixed = [adj('2026-10-31', 3), adj('2026-06-30', 1), adj('2026-11-30', 5), adj('2026-07-31', 2)];
        const { rekey, drop } = partitionAdjustments(mixed, plan({ amount: '1.00', endDate: '2026-08-31' }));
        expect([ids(rekey), ids(drop)]).toEqual([[1, 2], [3, 5]]);
    });
});

describe('module boundary', () => {
    test('split.js is pure: nothing from db/, no clock', () => {
        const src = fs.readFileSync(require.resolve('../../src/lib/split'), 'utf8');
        expect(src).not.toMatch(/require\([^)]*db/);
        expect(src).not.toMatch(/new Date|Date\.now/);
    });
});
