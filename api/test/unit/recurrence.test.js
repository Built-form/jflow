'use strict';

// Recurrence (CONTRACT §5, BUILD_PLAN step 3). Pinned here:
//
//  - natural date n is computed from start_date, never chained: monthly from 31 Jan is
//    31 Jan → 28 Feb → 31 Mar → 30 Apr (§5.1), for every frequency × interval_count;
//  - the two ends, occurrence_count (n < N) and end_date (natural <= E) (§5.2);
//  - the weekend rule and the effective date: an override's due_date verbatim (the
//    weekend rule bypassed), else the weekend-adjusted natural date (§5.3, §3.4);
//  - occurrences / isOccurrence / occurrenceIndex / firstActiveOccurrence /
//    nextOccurrenceAfter / endBefore exactly as §5.4 words them, active_from included;
//  - the split fixture §5.4 fixes: monthly from 2026-01-31 split (amount only) at
//    2026-06-30 keeps yielding 31 Jul, 31 Aug.

const fs = require('fs');

const {
    FREQUENCIES,
    WEEKEND_RULES,
    normalizeSchedule,
    occurrences,
    isOccurrence,
    occurrenceIndex,
    firstActiveOccurrence,
    nextOccurrenceAfter,
    endBefore,
    weekendAdjust,
    effectiveDate,
    effectiveValues,
} = require('../../src/lib/recurrence');

/** A schedule row in its DB (snake_case) shape; each test overrides what it needs. */
function sched(overrides = {}) {
    return {
        id: 45,
        frequency: 'monthly',
        interval_count: 1,
        start_date: '2026-01-31',
        active_from: null,
        occurrence_count: null,
        end_date: null,
        weekend_rule: 'none',
        settle_mode: 'auto',
        amount: '1000.00',
        ...overrides,
    };
}

const MONTH_ENDS_2026 = [
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
    '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31',
];

describe('vocabularies', () => {
    test('the six frequencies and three weekend rules of §3.2', () => {
        expect(FREQUENCIES).toEqual(['weekly', 'fortnightly', 'four_weekly', 'monthly', 'quarterly', 'annually']);
        expect(WEEKEND_RULES).toEqual(['none', 'previous', 'next']);
    });
});

describe('natural dates are computed from start_date, never chained (§5.1)', () => {
    test('monthly from 31 Jan: 31 Jan → 28 Feb → 31 Mar → 30 Apr → 31 May', () => {
        expect(occurrences(sched(), '2026-01-01', '2026-05-31'))
            .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    });

    test('a whole year of month ends from a 31 Jan start', () => {
        expect(occurrences(sched(), '2026-01-01', '2026-12-31')).toEqual(MONTH_ENDS_2026);
    });

    test('a leap year clamps to 29 Feb, then returns to the 31st', () => {
        expect(occurrences(sched({ start_date: '2028-01-31' }), '2028-01-01', '2028-03-31'))
            .toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    });

    test('quarterly from 30 Nov clamps February and returns to the 30th', () => {
        expect(occurrences(sched({ frequency: 'quarterly', start_date: '2025-11-30' }), '2025-01-01', '2026-11-30'))
            .toEqual(['2025-11-30', '2026-02-28', '2026-05-30', '2026-08-30', '2026-11-30']);
    });

    test('29 Feb annual: 28 Feb in common years, 29 Feb in leap years', () => {
        const s = sched({ frequency: 'annually', start_date: '2024-02-29' });
        expect(occurrences(s, '2024-01-01', '2028-12-31'))
            .toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
        expect(isOccurrence(s, '2025-02-28')).toBe(true);
        expect(isOccurrence(s, '2025-03-01')).toBe(false);
        expect(occurrenceIndex(s, '2028-02-29')).toBe(4);
    });

    // [frequency, interval_count, start_date, the first four natural dates]
    test.each([
        ['weekly', 1, '2026-01-05', ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']],
        ['weekly', 3, '2026-01-05', ['2026-01-05', '2026-01-26', '2026-02-16', '2026-03-09']],
        ['fortnightly', 1, '2026-01-05', ['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']],
        ['fortnightly', 2, '2026-01-05', ['2026-01-05', '2026-02-02', '2026-03-02', '2026-03-30']],
        ['four_weekly', 1, '2026-01-05', ['2026-01-05', '2026-02-02', '2026-03-02', '2026-03-30']],
        ['four_weekly', 2, '2026-01-05', ['2026-01-05', '2026-03-02', '2026-04-27', '2026-06-22']],
        ['monthly', 1, '2026-01-31', ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']],
        ['monthly', 2, '2026-01-31', ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']],
        ['quarterly', 1, '2026-01-31', ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']],
        ['quarterly', 2, '2026-01-31', ['2026-01-31', '2026-07-31', '2027-01-31', '2027-07-31']],
        ['annually', 1, '2026-01-31', ['2026-01-31', '2027-01-31', '2028-01-31', '2029-01-31']],
        ['annually', 2, '2024-02-29', ['2024-02-29', '2026-02-28', '2028-02-29', '2030-02-28']],
    ])('%s × interval_count %i from %s', (frequency, intervalCount, start, expected) => {
        const s = sched({ frequency, interval_count: intervalCount, start_date: start });
        // The window closes exactly on the fourth date, so the fifth is not in it.
        expect(occurrences(s, start, expected[3])).toEqual(expected);
        expected.forEach((date, n) => {
            expect(isOccurrence(s, date)).toBe(true);
            expect(occurrenceIndex(s, date)).toBe(n);
        });
        expect(nextOccurrenceAfter(s, expected[2])).toBe(expected[3]);
    });

    test('interval_count defaults to 1 when the row has none', () => {
        const s = sched({ frequency: 'weekly', start_date: '2026-01-05' });
        delete s.interval_count;
        expect(occurrences(s, '2026-01-05', '2026-01-19')).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
    });
});

describe('ends (§5.2)', () => {
    test('occurrence_count = N yields occurrences n < N, whatever the window', () => {
        const s = sched({ occurrence_count: 3 });
        expect(occurrences(s, '2026-01-01', '2027-12-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
        expect(isOccurrence(s, '2026-03-31')).toBe(true);
        expect(isOccurrence(s, '2026-04-30')).toBe(false);
        expect(occurrenceIndex(s, '2026-04-30')).toBe(-1);
        expect(nextOccurrenceAfter(s, '2026-03-31')).toBeNull();
    });

    test('end_date = E yields natural dates <= E (inclusive)', () => {
        const onEnd = sched({ end_date: '2026-04-30' });
        expect(occurrences(onEnd, '2026-01-01', '2026-12-31'))
            .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
        expect(isOccurrence(onEnd, '2026-04-30')).toBe(true);

        const dayBefore = sched({ end_date: '2026-04-29' });
        expect(occurrences(dayBefore, '2026-01-01', '2026-12-31'))
            .toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
        expect(isOccurrence(dayBefore, '2026-04-30')).toBe(false);
        expect(isOccurrence(dayBefore, '2026-05-31')).toBe(false);
        expect(nextOccurrenceAfter(dayBefore, '2026-03-31')).toBeNull();
    });

    test('an open-ended schedule is bounded by the window alone', () => {
        const s = sched({ frequency: 'weekly', start_date: '2026-01-05' });
        expect(occurrences(s, '2030-01-01', '2030-01-14')).toEqual(['2030-01-07', '2030-01-14']);
    });
});

describe('occurrences(schedule, from, to): from <= natural <= to, ascending (§5.4)', () => {
    const s = sched();

    test('both bounds are inclusive', () => {
        expect(occurrences(s, '2026-02-28', '2026-04-30')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    });

    test('bounds just inside the neighbouring occurrences exclude them', () => {
        expect(occurrences(s, '2026-03-01', '2026-04-29')).toEqual(['2026-03-31']);
    });

    test('from = to on an occurrence is that occurrence; on any other date, nothing', () => {
        expect(occurrences(s, '2026-03-31', '2026-03-31')).toEqual(['2026-03-31']);
        expect(occurrences(s, '2026-03-30', '2026-03-30')).toEqual([]);
    });

    test('to before start_date is []', () => {
        expect(occurrences(s, '2025-01-01', '2026-01-30')).toEqual([]);
    });

    test('from before start_date starts at start_date', () => {
        expect(occurrences(s, '2020-01-01', '2026-02-28')).toEqual(['2026-01-31', '2026-02-28']);
    });

    test('from after to is []', () => {
        expect(occurrences(s, '2026-06-01', '2026-05-01')).toEqual([]);
    });

    test('a window deep into a long series lands on the right dates', () => {
        const weekly = sched({ frequency: 'weekly', start_date: '2020-01-06' });
        expect(occurrences(weekly, '2026-09-29', '2026-10-12')).toEqual(['2026-10-05', '2026-10-12']);
        const monthly = sched({ start_date: '2000-01-31' });
        expect(occurrences(monthly, '2026-02-01', '2026-04-30')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
        expect(occurrenceIndex(monthly, '2026-02-28')).toBe(313);
    });

    test('it returns natural dates, not weekend-adjusted ones', () => {
        const next = sched({ weekend_rule: 'next' });
        // 2026-01-31 and 2026-02-28 are Saturdays; identity stays the natural date.
        expect(occurrences(next, '2026-01-01', '2026-02-28')).toEqual(['2026-01-31', '2026-02-28']);
        expect(isOccurrence(next, '2026-02-02')).toBe(false);
    });

    test('malformed or impossible window bounds throw', () => {
        expect(() => occurrences(s, '2026-02-30', '2026-03-31')).toThrow();
        expect(() => occurrences(s, '2026-01-01', '26-03-31')).toThrow();
    });
});

describe('isOccurrence and occurrenceIndex (§5.4)', () => {
    const s = sched();

    test('every occurrence is one, at its n counted from start_date', () => {
        MONTH_ENDS_2026.forEach((date, n) => {
            expect(isOccurrence(s, date)).toBe(true);
            expect(occurrenceIndex(s, date)).toBe(n);
        });
    });

    test('rejects dates that are not on the grid', () => {
        for (const date of ['2026-02-27', '2026-03-30', '2026-02-01', '2026-03-01']) {
            expect(isOccurrence(s, date)).toBe(false);
            expect(occurrenceIndex(s, date)).toBe(-1);
        }
        const weekly = sched({ frequency: 'weekly', start_date: '2026-01-05' });
        expect(isOccurrence(weekly, '2026-01-06')).toBe(false);
        expect(isOccurrence(weekly, '2026-01-11')).toBe(false);
        expect(isOccurrence(weekly, '2026-01-12')).toBe(true);
    });

    test('rejects a weekend-adjusted effective date: identity is the natural date', () => {
        const prev = sched({ weekend_rule: 'previous' });
        expect(effectiveDate(prev, '2026-01-31')).toBe('2026-01-30');
        expect(isOccurrence(prev, '2026-01-30')).toBe(false);
        expect(isOccurrence(prev, '2026-01-31')).toBe(true);
    });

    test('rejects dates before start_date, even on the grid extended backwards', () => {
        expect(isOccurrence(s, '2025-12-31')).toBe(false);
        const weekly = sched({ frequency: 'weekly', start_date: '2026-01-05' });
        expect(isOccurrence(weekly, '2025-12-29')).toBe(false);
        expect(occurrenceIndex(weekly, '2025-12-29')).toBe(-1);
    });

    test('rejects dates before active_from', () => {
        const succ = sched({ active_from: '2026-06-30' });
        expect(isOccurrence(succ, '2026-05-31')).toBe(false);
        expect(occurrenceIndex(succ, '2026-05-31')).toBe(-1);
        expect(isOccurrence(succ, '2026-06-30')).toBe(true);
    });

    test('rejects post-end dates (occurrence_count and end_date)', () => {
        expect(isOccurrence(sched({ occurrence_count: 5 }), '2026-06-30')).toBe(false);
        expect(isOccurrence(sched({ occurrence_count: 5 }), '2026-05-31')).toBe(true);
        expect(isOccurrence(sched({ end_date: '2026-06-29' }), '2026-06-30')).toBe(false);
        expect(isOccurrence(sched({ end_date: '2026-06-29' }), '2026-12-31')).toBe(false);
    });

    test('malformed and impossible dates are not occurrences', () => {
        for (const date of ['2026-02-30', '2026-2-28', '', null, undefined, 20260131]) {
            expect(isOccurrence(s, date)).toBe(false);
            expect(occurrenceIndex(s, date)).toBe(-1);
        }
    });
});

describe('active_from: a split keeps the month-end grid (§5.4 fixture, D21)', () => {
    const original = sched();
    const k = '2026-06-30';
    const ended = endBefore(original, k, { keepSeries: true });
    const predecessor = sched({ end_date: ended.endDate, occurrence_count: ended.occurrenceCount });
    const successor = sched({
        amount: '1050.00',
        start_date: ended.successor.startDate,
        active_from: ended.successor.activeFrom,
        occurrence_count: ended.successor.occurrenceCount,
        end_date: ended.successor.endDate,
    });

    test('the successor keeps start_date and starts at active_from = k', () => {
        expect(ended.successor).toEqual({
            startDate: '2026-01-31', activeFrom: '2026-06-30', occurrenceCount: null, endDate: null,
        });
    });

    test('the successor yields 30 Jun, 31 Jul, 31 Aug, …', () => {
        expect(occurrences(successor, '2026-01-01', '2026-10-31'))
            .toEqual(['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31']);
    });

    test('isOccurrence(successor, 30 Jun) is true; 31 May is not (it is the predecessor\'s)', () => {
        expect(isOccurrence(successor, '2026-06-30')).toBe(true);
        expect(isOccurrence(successor, '2026-05-31')).toBe(false);
    });

    test('n still counts from start_date on the successor', () => {
        expect(occurrenceIndex(successor, '2026-06-30')).toBe(5);
        expect(occurrenceIndex(successor, '2026-07-31')).toBe(6);
    });

    test('the predecessor ends 29 Jun and 30 Jun is no longer its occurrence', () => {
        expect(ended.endDate).toBe('2026-06-29');
        expect(ended.occurrenceCount).toBeNull();
        expect(isOccurrence(predecessor, '2026-06-30')).toBe(false);
        expect(occurrences(predecessor, '2026-01-01', '2026-12-31')).toEqual(MONTH_ENDS_2026.slice(0, 5));
    });

    test('predecessor + successor = the original series, with no date lost or doubled', () => {
        expect([
            ...occurrences(predecessor, '2026-01-01', '2026-12-31'),
            ...occurrences(successor, '2026-01-01', '2026-12-31'),
        ]).toEqual(occurrences(original, '2026-01-01', '2026-12-31'));
    });

    test('firstActiveOccurrence is start_date, else the first natural date >= active_from', () => {
        expect(firstActiveOccurrence(original)).toBe('2026-01-31');
        expect(firstActiveOccurrence(successor)).toBe('2026-06-30');
        // An active_from off the grid moves to the next natural date.
        expect(firstActiveOccurrence(sched({ active_from: '2026-06-15' }))).toBe('2026-06-30');
    });

    test('nextOccurrenceAfter honours active_from', () => {
        expect(nextOccurrenceAfter(successor, '2026-01-31')).toBe('2026-06-30');
        expect(nextOccurrenceAfter(successor, '2026-06-30')).toBe('2026-07-31');
    });
});

describe('endBefore(schedule, k, {keepSeries}) (§5.4, D21, D22)', () => {
    test('the old row always gets end_date = k − 1 day and occurrence_count = null', () => {
        for (const keepSeries of [true, false]) {
            const r = endBefore(sched({ occurrence_count: 12 }), '2026-03-31', { keepSeries });
            expect(r.endDate).toBe('2026-03-30');
            expect(r.occurrenceCount).toBeNull();
        }
    });

    test('keepSeries: the count is inherited verbatim, because n still counts from start_date', () => {
        const original = sched({ occurrence_count: 12 });
        const r = endBefore(original, '2026-06-30', { keepSeries: true });
        expect(r.successor).toEqual({
            startDate: '2026-01-31', activeFrom: '2026-06-30', occurrenceCount: 12, endDate: null,
        });
        const successor = sched({
            start_date: r.successor.startDate, active_from: r.successor.activeFrom,
            occurrence_count: r.successor.occurrenceCount, end_date: r.successor.endDate,
        });
        expect(occurrences(successor, '2026-01-01', '2027-12-31')).toEqual(MONTH_ENDS_2026.slice(5));
    });

    test('keepSeries: end_date is inherited verbatim', () => {
        const r = endBefore(sched({ end_date: '2026-10-31' }), '2026-06-30', { keepSeries: true });
        expect(r.successor).toEqual({
            startDate: '2026-01-31', activeFrom: '2026-06-30', occurrenceCount: null, endDate: '2026-10-31',
        });
    });

    test('new series: starts at k, no active_from, occurrence_count minus the occurrences before k', () => {
        const original = sched({ frequency: 'weekly', start_date: '2026-01-05', occurrence_count: 10 });
        const k = '2026-02-02'; // n = 4
        const r = endBefore(original, k, { keepSeries: false });
        expect(r).toEqual({
            endDate: '2026-02-01',
            occurrenceCount: null,
            successor: { startDate: '2026-02-02', activeFrom: null, occurrenceCount: 6, endDate: null },
        });
        const predecessor = { ...original, end_date: r.endDate, occurrence_count: r.occurrenceCount };
        const successor = {
            ...original, start_date: r.successor.startDate, active_from: r.successor.activeFrom,
            occurrence_count: r.successor.occurrenceCount, end_date: r.successor.endDate,
        };
        expect([
            ...occurrences(predecessor, '2026-01-01', '2026-12-31'),
            ...occurrences(successor, '2026-01-01', '2026-12-31'),
        ]).toEqual(occurrences(original, '2026-01-01', '2026-12-31'));
    });

    test('new series: end_date is inherited; an open-ended series stays open', () => {
        const withEnd = endBefore(sched({ end_date: '2026-10-31' }), '2026-06-30', { keepSeries: false });
        expect(withEnd.successor).toEqual({
            startDate: '2026-06-30', activeFrom: null, occurrenceCount: null, endDate: '2026-10-31',
        });
        const open = endBefore(sched(), '2026-06-30');
        expect(open.successor).toEqual({
            startDate: '2026-06-30', activeFrom: null, occurrenceCount: null, endDate: null,
        });
    });

    test('new series from a series-keeping successor: the remaining count still counts n from start_date', () => {
        const successor = sched({ active_from: '2026-06-30', occurrence_count: 12 });
        const r = endBefore(successor, '2026-09-30', { keepSeries: false }); // n = 8
        expect(r.successor.occurrenceCount).toBe(4);
    });

    test('k must be an occurrence of the schedule', () => {
        expect(() => endBefore(sched(), '2026-06-29', { keepSeries: true })).toThrow();
        expect(() => endBefore(sched({ end_date: '2026-05-31' }), '2026-06-30')).toThrow();
        expect(() => endBefore(sched({ active_from: '2026-06-30' }), '2026-05-31')).toThrow();
    });
});

describe('nextOccurrenceAfter(schedule, date) (§5.4)', () => {
    const s = sched();

    test('the first natural date strictly after date', () => {
        expect(nextOccurrenceAfter(s, '2026-02-28')).toBe('2026-03-31');
        expect(nextOccurrenceAfter(s, '2026-03-01')).toBe('2026-03-31');
        expect(nextOccurrenceAfter(s, '2026-03-30')).toBe('2026-03-31');
    });

    test('before start_date it is start_date', () => {
        expect(nextOccurrenceAfter(s, '2025-06-01')).toBe('2026-01-31');
    });

    test('null when the series has ended', () => {
        expect(nextOccurrenceAfter(sched({ occurrence_count: 1 }), '2026-01-31')).toBeNull();
        expect(nextOccurrenceAfter(sched({ end_date: '2026-03-31' }), '2026-03-31')).toBeNull();
    });
});

describe('weekend rule and effective date (§5.3, §3.4)', () => {
    // 2026-01-31 Sat, 2026-05-31 Sun, 2026-08-01 Sat, 2026-03-31 Tue, 2026-07-31 Fri.
    test.each([
        ['2026-01-31', 'none', '2026-01-31'],
        ['2026-01-31', 'previous', '2026-01-30'],
        ['2026-01-31', 'next', '2026-02-02'],
        ['2026-05-31', 'none', '2026-05-31'],
        ['2026-05-31', 'previous', '2026-05-29'],
        ['2026-05-31', 'next', '2026-06-01'],
        ['2026-08-01', 'previous', '2026-07-31'],
        ['2026-08-01', 'next', '2026-08-03'],
        ['2026-03-31', 'none', '2026-03-31'],
        ['2026-03-31', 'previous', '2026-03-31'],
        ['2026-03-31', 'next', '2026-03-31'],
        ['2026-07-31', 'previous', '2026-07-31'],
        ['2026-07-31', 'next', '2026-07-31'],
    ])('weekendAdjust(%s, %s) = %s', (date, rule, expected) => {
        expect(weekendAdjust(date, rule)).toBe(expected);
    });

    test('with no override, the effective date is the weekend-adjusted natural date', () => {
        expect(effectiveDate(sched({ weekend_rule: 'none' }), '2026-05-31')).toBe('2026-05-31');
        expect(effectiveDate(sched({ weekend_rule: 'previous' }), '2026-05-31')).toBe('2026-05-29');
        expect(effectiveDate(sched({ weekend_rule: 'next' }), '2026-05-31')).toBe('2026-06-01');
        expect(effectiveDate(sched({ weekend_rule: 'next' }), '2026-03-31')).toBe('2026-03-31');
    });

    test('an override due_date is taken verbatim: the weekend rule is bypassed', () => {
        // 2026-06-07 is a Sunday; a person chose it.
        expect(effectiveDate(sched({ weekend_rule: 'next' }), '2026-05-31', { due_date: '2026-06-07' }))
            .toBe('2026-06-07');
        expect(effectiveDate(sched({ weekend_rule: 'previous' }), '2026-05-31', { dueDate: '2026-05-30' }))
            .toBe('2026-05-30');
    });

    test('an override with no due_date falls back to the weekend-adjusted natural date', () => {
        expect(effectiveDate(sched({ weekend_rule: 'previous' }), '2026-05-31', { due_date: null, amount: '983.00' }))
            .toBe('2026-05-29');
        expect(effectiveDate(sched({ weekend_rule: 'previous' }), '2026-05-31', null)).toBe('2026-05-29');
    });

    test('effectiveValues: date, amount, status and settle mode per §3.4', () => {
        const s = sched({ weekend_rule: 'previous', settle_mode: 'auto', amount: '1000.00' });
        expect(effectiveValues(s, '2026-05-31')).toEqual({
            naturalDate: '2026-05-31', effectiveDate: '2026-05-29',
            amount: '1000.00', status: 'expected', settleMode: 'auto',
        });
        expect(effectiveValues(s, '2026-05-31', {
            amount: '983.00', due_date: null, status: null, settle_mode: 'manual',
        })).toEqual({
            naturalDate: '2026-05-31', effectiveDate: '2026-05-29',
            amount: '983.00', status: 'expected', settleMode: 'manual',
        });
        expect(effectiveValues(s, '2026-05-31', {
            amount: null, dueDate: '2026-06-07', status: 'part_paid', settleMode: null,
        })).toEqual({
            naturalDate: '2026-05-31', effectiveDate: '2026-06-07',
            amount: '1000.00', status: 'part_paid', settleMode: 'auto',
        });
    });

    test('an unknown weekend rule throws', () => {
        expect(() => weekendAdjust('2026-01-31', 'nearest')).toThrow();
    });
});

describe('row shapes: snake_case and camelCase through one normaliser (§5.4)', () => {
    const snake = sched({ occurrence_count: 12, active_from: '2026-06-30', weekend_rule: 'next' });
    const camel = {
        frequency: 'monthly', intervalCount: 1, startDate: '2026-01-31', activeFrom: '2026-06-30',
        occurrenceCount: 12, endDate: null, weekendRule: 'next', settleMode: 'auto', amount: '1000.00',
    };

    test('normalizeSchedule maps both shapes to the same camelCase fields', () => {
        expect(normalizeSchedule(snake)).toEqual({
            frequency: 'monthly', intervalCount: 1, startDate: '2026-01-31', activeFrom: '2026-06-30',
            occurrenceCount: 12, endDate: null, weekendRule: 'next', settleMode: 'auto', amount: '1000.00',
        });
        expect(normalizeSchedule(camel)).toEqual(normalizeSchedule(snake));
    });

    test('every function answers the same for both shapes', () => {
        expect(occurrences(camel, '2026-01-01', '2027-12-31')).toEqual(occurrences(snake, '2026-01-01', '2027-12-31'));
        expect(isOccurrence(camel, '2026-05-31')).toBe(false);
        expect(occurrenceIndex(camel, '2026-07-31')).toBe(6);
        expect(firstActiveOccurrence(camel)).toBe('2026-06-30');
        expect(nextOccurrenceAfter(camel, '2026-06-30')).toBe('2026-07-31');
        expect(endBefore(camel, '2026-09-30', { keepSeries: true }))
            .toEqual(endBefore(snake, '2026-09-30', { keepSeries: true }));
        expect(effectiveDate(camel, '2026-01-31')).toBe('2026-02-02');
    });

    test('a malformed schedule throws rather than guessing', () => {
        expect(() => occurrences(sched({ frequency: 'daily' }), '2026-01-01', '2026-12-31')).toThrow();
        expect(() => occurrences(sched({ interval_count: 0 }), '2026-01-01', '2026-12-31')).toThrow();
        expect(() => occurrences(sched({ interval_count: 1.5 }), '2026-01-01', '2026-12-31')).toThrow();
        expect(() => occurrences(sched({ start_date: '2026-02-30' }), '2026-01-01', '2026-12-31')).toThrow();
        expect(() => occurrences(sched({ occurrence_count: 0 }), '2026-01-01', '2026-12-31')).toThrow();
        expect(() => occurrences(sched({ weekend_rule: 'nearest' }), '2026-01-01', '2026-12-31')).toThrow();
    });
});

describe('module boundary', () => {
    test('recurrence.js imports nothing from db/ and reads no clock', () => {
        const src = fs.readFileSync(require.resolve('../../src/lib/recurrence'), 'utf8');
        expect(src).not.toMatch(/require\([^)]*db/);
        expect(src).not.toMatch(/new Date|Date\.now/);
    });
});
