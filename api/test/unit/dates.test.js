'use strict';

// lib/dates.js (CONTRACT §2.5): calendar days are 'YYYY-MM-DD' strings and all
// arithmetic is on epoch days (days since 1970-01-01). Pinned here:
//
//  - strict validation: a real Gregorian date, exact shape, nothing else;
//  - epoch-day round trip, addDays, diffDays, dayOfWeek (ISO: Mon 1 … Sun 7), isWeekend;
//  - addMonthsClamped: month-end clamp, leap years, negative months;
//  - londonToday: the Europe/London calendar date of an injectable instant, both
//    sides of midnight UTC in BST and in GMT, and across both 2026 clock changes;
//  - the module imports nothing from src/db.
//
// `Date.UTC` appears below only as an independent oracle; the library never uses it.

const fs = require('fs');
const path = require('path');

const dates = require('../../src/lib/dates');
const {
    toEpochDay, fromEpochDay, addDays, diffDays, dayOfWeek, isWeekend,
    addMonthsClamped, isValidDate, londonToday,
} = dates;

const DAY_MS = 86400000;
const oracleEpochDay = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;

describe('isValidDate', () => {
    test.each([
        '1970-01-01', '2026-09-29', '2026-02-28', '2028-02-29', '2000-02-29',
        '2026-04-30', '2026-12-31', '0001-01-01', '9999-12-31',
    ])('accepts %s', (d) => {
        expect(isValidDate(d)).toBe(true);
    });

    test.each([
        ['30 February', '2026-02-30'],
        ['29 February in a common year', '2026-02-29'],
        ['29 February in a century year that is not leap', '1900-02-29'],
        ['31 April', '2026-04-31'],
        ['month 13', '2026-13-01'],
        ['month 00', '2026-00-10'],
        ['day 00', '2026-01-00'],
        ['day 32', '2026-01-32'],
        ['year 0000', '0000-01-01'],
        ['a single-digit month', '2026-1-01'],
        ['a single-digit day', '2026-01-1'],
        ['a two-digit year', '26-01-01'],
        ['a five-digit year', '20260-01-01'],
        ['a signed year', '+2026-01-01'],
        ['slashes', '2026/01/01'],
        ['no separators', '20260101'],
        ['a time part', '2026-01-01T00:00:00Z'],
        ['a leading space', ' 2026-01-01'],
        ['a trailing space', '2026-01-01 '],
        ['a trailing newline', '2026-01-01\n'],
        ['full-width digits', '２０２６-01-01'],
        ['the empty string', ''],
    ])('rejects %s', (_label, d) => {
        expect(isValidDate(d)).toBe(false);
    });

    test.each([
        ['null', null], ['undefined', undefined], ['a number', 20260101],
        ['a Date', new Date(Date.UTC(2026, 0, 1))], ['an object', {}], ['an array', ['2026-01-01']],
    ])('rejects %s (not a string)', (_label, v) => {
        expect(isValidDate(v)).toBe(false);
    });
});

describe('toEpochDay / fromEpochDay', () => {
    test.each([
        ['1970-01-01', 0],
        ['1970-01-02', 1],
        ['1969-12-31', -1],
        ['2000-02-29', 11016],
        ['2000-03-01', 11017],
        ['2026-01-01', 20454],
        ['2026-09-29', 20725],
    ])('%s is epoch day %i', (d, n) => {
        expect(toEpochDay(d)).toBe(n);
        expect(fromEpochDay(n)).toBe(d);
    });

    test('agrees with an independent oracle on every day from 1899 to 2101, consecutively', () => {
        const mismatches = [];
        let expected = oracleEpochDay(1899, 1, 1);
        let d = '1899-01-01';
        while (d <= '2101-12-31') {
            const n = toEpochDay(d);
            if (n !== expected || fromEpochDay(n) !== d) mismatches.push(d);
            expected += 1;
            d = fromEpochDay(n + 1);
        }
        expect(mismatches).toEqual([]);
        expect(d).toBe('2102-01-01');
    });

    test('round-trips at the ends of the four-digit range', () => {
        expect(fromEpochDay(toEpochDay('0001-01-01'))).toBe('0001-01-01');
        expect(fromEpochDay(toEpochDay('9999-12-31'))).toBe('9999-12-31');
        expect(toEpochDay('9999-12-31') - toEpochDay('0001-01-01')).toBe(3652058);
    });

    test('toEpochDay throws on anything isValidDate rejects', () => {
        for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '', null, undefined, 20260101]) {
            expect(() => toEpochDay(bad)).toThrow();
        }
    });

    test('fromEpochDay throws on a non-integer or out-of-range day', () => {
        for (const bad of [1.5, NaN, Infinity, '1', null, undefined, 0n]) {
            expect(() => fromEpochDay(bad)).toThrow();
        }
        expect(() => fromEpochDay(toEpochDay('9999-12-31') + 1)).toThrow();
        expect(() => fromEpochDay(toEpochDay('0001-01-01') - 1)).toThrow();
    });
});

describe('addDays', () => {
    test.each([
        ['2026-02-28', 1, '2026-03-01'],
        ['2028-02-28', 1, '2028-02-29'],
        ['2026-12-31', 1, '2027-01-01'],
        ['2026-01-01', -1, '2025-12-31'],
        ['2026-03-01', -1, '2026-02-28'],
        ['2026-09-29', 0, '2026-09-29'],
        ['2026-09-29', 90, '2026-12-28'],
        ['2026-09-29', 730, '2028-09-28'],
        ['2026-09-29', -45, '2026-08-15'],
    ])('%s plus %i days is %s', (d, n, want) => {
        expect(addDays(d, n)).toBe(want);
    });

    test('rejects a non-integer day count and an invalid date', () => {
        for (const n of [1.5, NaN, Infinity, '1', null, undefined, 1n]) {
            expect(() => addDays('2026-01-01', n)).toThrow();
        }
        expect(() => addDays('2026-02-30', 1)).toThrow();
    });
});

describe('diffDays(a, b) = epoch(a) − epoch(b)', () => {
    test.each([
        ['2026-03-01', '2026-02-28', 1],
        ['2028-03-01', '2028-02-28', 2],
        ['2026-01-01', '2026-12-31', -364],
        ['2026-09-29', '2026-09-29', 0],
        ['2026-09-29', '2026-08-15', 45],
        ['2026-09-29', '2026-08-14', 46],
        ['2027-01-01', '2026-01-01', 365],
        ['2029-01-01', '2028-01-01', 366],
    ])('diffDays(%s, %s) = %i', (a, b, n) => {
        expect(diffDays(a, b)).toBe(n);
    });

    test('is the inverse of addDays', () => {
        expect(diffDays(addDays('2026-09-29', 123), '2026-09-29')).toBe(123);
        expect(diffDays(addDays('2026-09-29', -123), '2026-09-29')).toBe(-123);
    });

    test('throws on an invalid date on either side', () => {
        expect(() => diffDays('2026-02-30', '2026-01-01')).toThrow();
        expect(() => diffDays('2026-01-01', 'today')).toThrow();
    });
});

describe('dayOfWeek (ISO: Monday 1 … Sunday 7) and isWeekend', () => {
    test.each([
        ['1970-01-01', 4],   // a Thursday (CONTRACT §2.5)
        ['1969-12-28', 7],   // a Sunday, before the epoch
        ['1969-12-29', 1],
        ['2026-09-28', 1],
        ['2026-09-29', 2],
        ['2026-10-02', 5],
        ['2026-10-03', 6],
        ['2026-10-04', 7],
        ['2000-01-01', 6],
    ])('%s is day %i', (d, dow) => {
        expect(dayOfWeek(d)).toBe(dow);
    });

    test('matches the oracle for 400 consecutive days either side of the epoch', () => {
        for (let n = -200; n < 200; n += 1) {
            const oracle = new Date(n * DAY_MS).getUTCDay();   // 0 = Sunday
            expect(dayOfWeek(fromEpochDay(n))).toBe(oracle === 0 ? 7 : oracle);
        }
    });

    test.each([
        ['2026-10-02', false],  // Friday
        ['2026-10-03', true],   // Saturday
        ['2026-10-04', true],   // Sunday
        ['2026-10-05', false],  // Monday
    ])('isWeekend(%s) is %s', (d, want) => {
        expect(isWeekend(d)).toBe(want);
    });

    test('both throw on an invalid date', () => {
        expect(() => dayOfWeek('2026-02-30')).toThrow();
        expect(() => isWeekend('2026-02-30')).toThrow();
    });
});

describe('addMonthsClamped', () => {
    test.each([
        ['2026-01-31', 1, '2026-02-28'],
        ['2026-01-31', 2, '2026-03-31'],
        ['2026-01-31', 3, '2026-04-30'],
        ['2028-01-31', 1, '2028-02-29'],
        ['2028-02-29', 12, '2029-02-28'],
        ['2028-02-29', 48, '2032-02-29'],
        ['2026-01-31', 24, '2028-01-31'],
        ['2026-11-30', 3, '2027-02-28'],
        ['2026-12-31', 2, '2027-02-28'],
        ['2026-12-15', 1, '2027-01-15'],
        ['2026-03-31', -1, '2026-02-28'],
        ['2026-01-15', -1, '2025-12-15'],
        ['2026-01-31', -13, '2024-12-31'],
        ['2026-09-29', 0, '2026-09-29'],
    ])('%s plus %i months is %s', (d, n, want) => {
        expect(addMonthsClamped(d, n)).toBe(want);
    });

    test('31 Jan → 28 Feb → 31 Mar when computed from the start, never chained (CONTRACT §5.1)', () => {
        const start = '2026-01-31';
        expect([0, 1, 2, 3].map((n) => addMonthsClamped(start, n)))
            .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
        // Chaining loses the month end — the reason recurrence never chains.
        expect(addMonthsClamped(addMonthsClamped(start, 1), 1)).toBe('2026-03-28');
    });

    test('rejects a non-integer month count and an invalid date', () => {
        for (const n of [1.5, NaN, '1', null, undefined, 1n]) {
            expect(() => addMonthsClamped('2026-01-31', n)).toThrow();
        }
        expect(() => addMonthsClamped('2026-02-30', 1)).toThrow();
    });

    test('throws rather than leave the four-digit year range', () => {
        expect(() => addMonthsClamped('9999-12-31', 1)).toThrow();
        expect(() => addMonthsClamped('0001-01-31', -1)).toThrow();
    });
});

describe('londonToday (Europe/London calendar date of an instant)', () => {
    test.each([
        // BST (UTC+1): 23:xx UTC is already tomorrow in London.
        ['BST, 22:59:59 UTC', '2026-06-30T22:59:59Z', '2026-06-30'],
        ['BST, 23:00 UTC = midnight BST', '2026-06-30T23:00:00Z', '2026-07-01'],
        ['BST, 23:30 UTC', '2026-06-30T23:30:00Z', '2026-07-01'],
        ['BST, 00:30 UTC', '2026-07-01T00:30:00Z', '2026-07-01'],
        // GMT (UTC+0): the London date is the UTC date.
        ['GMT, 23:30 UTC', '2026-01-15T23:30:00Z', '2026-01-15'],
        ['GMT, 23:59:59 UTC', '2026-01-15T23:59:59Z', '2026-01-15'],
        ['GMT, 00:00 UTC', '2026-01-16T00:00:00Z', '2026-01-16'],
        // The 2026 clock changes: BST from 29 Mar 01:00 UTC to 25 Oct 01:00 UTC.
        ['the evening before BST starts', '2026-03-28T23:30:00Z', '2026-03-28'],
        ['the evening BST has started', '2026-03-29T23:30:00Z', '2026-03-30'],
        ['the evening before BST ends', '2026-10-24T23:30:00Z', '2026-10-25'],
        ['the evening BST has ended', '2026-10-25T23:30:00Z', '2026-10-25'],
        // New Year in BST cannot happen; in GMT it is the UTC midnight.
        ['New Year, GMT', '2026-12-31T23:59:59Z', '2026-12-31'],
    ])('%s: %s → %s', (_label, iso, want) => {
        expect(londonToday(new Date(iso))).toBe(want);
    });

    test('accepts an epoch-millisecond number as the instant', () => {
        expect(londonToday(Date.UTC(2026, 5, 30, 23, 30))).toBe('2026-07-01');
    });

    test('defaults to the current instant and returns a valid date', () => {
        const got = londonToday();
        expect(isValidDate(got)).toBe(true);
        // Within a day of the UTC date, whatever the season.
        const utc = new Date().toISOString().slice(0, 10);
        expect(Math.abs(diffDays(got, utc))).toBeLessThanOrEqual(1);
    });

    test('throws on an invalid instant', () => {
        expect(() => londonToday(new Date(NaN))).toThrow();
        expect(() => londonToday('2026-01-01')).toThrow();
    });
});

describe('the module', () => {
    test('exports the §2.5 surface plus londonToday', () => {
        expect(Object.keys(dates).sort()).toEqual([
            'addDays', 'addMonthsClamped', 'dayOfWeek', 'diffDays', 'fromEpochDay',
            'isValidDate', 'isWeekend', 'londonToday', 'toEpochDay',
        ]);
    });

    test('imports nothing from src/db', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/lib/dates.js'), 'utf8');
        expect(src).not.toMatch(/require\(\s*['"][^'"]*\bdb\b/);
    });
});
