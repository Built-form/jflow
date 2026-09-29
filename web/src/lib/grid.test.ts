import { describe, expect, it } from 'vitest';
import { rows } from '../screens/forecast/fixtures';
import {
  balanceFlag,
  bucketIndexOf,
  bucketLabel,
  cellMoney,
  compactMoney,
  flagTags,
  groupLines,
  isClipped,
  lineId,
  parseBucket,
  parseWindowDays,
  signedMoney,
} from './grid';

describe('bucket parameters', () => {
  it('defaults to week and 90 days, the server defaults (D7)', () => {
    expect(parseBucket(null)).toBe('week');
    expect(parseBucket('fortnight')).toBe('week');
    expect(parseBucket('day')).toBe('day');
    expect(parseBucket('month')).toBe('month');
    expect(parseWindowDays(null)).toBe(90);
    expect(parseWindowDays('365')).toBe(365);
    expect(parseWindowDays('100')).toBe(90);
  });
});

describe('bucket columns (D6: Monday weeks, calendar months, clipped at the window)', () => {
  it('names a day by weekday and date', () => {
    expect(bucketLabel({ start: '2026-09-29', end: '2026-09-29' }, 'day')).toBe('Tue 29 Sep');
    expect(isClipped({ start: '2026-09-29', end: '2026-09-29' }, 'day')).toBe(false);
  });

  it('names a whole Monday–Sunday week by its Monday', () => {
    const week = { start: '2026-10-05', end: '2026-10-11' };
    expect(isClipped(week, 'week')).toBe(false);
    expect(bucketLabel(week, 'week')).toBe('w/c 5 Oct');
  });

  it('names a clipped week by its real span, across a month end too', () => {
    const first = { start: '2026-09-29', end: '2026-10-04' };
    expect(isClipped(first, 'week')).toBe(true);
    expect(bucketLabel(first, 'week')).toBe('29 Sep–4 Oct');
    expect(bucketLabel({ start: '2026-10-12', end: '2026-10-14' }, 'week')).toBe('12–14 Oct');
    expect(bucketLabel({ start: '2026-10-12', end: '2026-10-12' }, 'week')).toBe('12 Oct');
  });

  it('names a whole calendar month by month and year, a clipped one by its days', () => {
    expect(bucketLabel({ start: '2026-10-01', end: '2026-10-31' }, 'month')).toBe('Oct 2026');
    expect(bucketLabel({ start: '2026-12-01', end: '2026-12-31' }, 'month')).toBe('Dec 2026');
    expect(bucketLabel({ start: '2028-02-01', end: '2028-02-29' }, 'month')).toBe('Feb 2028');
    expect(isClipped({ start: '2028-02-01', end: '2028-02-28' }, 'month')).toBe(true);
    expect(bucketLabel({ start: '2026-09-29', end: '2026-09-30' }, 'month')).toBe('29–30 Sep');
  });

  it('finds the bucket holding a date by the buckets\' own bounds', () => {
    const buckets = [
      { start: '2026-09-29', end: '2026-10-04' },
      { start: '2026-10-05', end: '2026-10-11' },
      { start: '2026-10-12', end: '2026-10-18' },
    ];
    expect(bucketIndexOf('2026-09-29', buckets)).toBe(0);
    expect(bucketIndexOf('2026-10-04', buckets)).toBe(0);
    expect(bucketIndexOf('2026-10-05', buckets)).toBe(1);
    expect(bucketIndexOf('2026-10-18', buckets)).toBe(2);
    expect(bucketIndexOf('2026-10-19', buckets)).toBe(-1);
    expect(bucketIndexOf('2026-09-28', buckets)).toBe(-1);
  });
});

describe('lines into rows and cells', () => {
  it("places each line in the server's bucket and keeps every line of one key", () => {
    const suppliers = rows()[2];
    const groups = groupLines(suppliers.items, 3);
    expect(groups.map((g) => g.key)).toEqual(['item.77', 'item.88']);
    const acme = groups[0];
    expect(acme.lines).toHaveLength(2);
    expect(acme.cells[0].map((l) => l.flags)).toEqual([['paid', 'partial']]);
    expect(acme.cells[1]).toEqual([]);
    expect(acme.cells[2].map((l) => l.flags)).toEqual([['remainder']]);
  });

  it('keeps two lines of one key in the same bucket as two entries, not one sum', () => {
    const [paid, remainder] = rows()[2].items;
    const groups = groupLines([paid, { ...remainder, bucketIndex: 0 }], 3);
    expect(groups).toHaveLength(1);
    expect(groups[0].cells[0].map((l) => l.gbpMinor)).toEqual([40000, 60000]);
  });

  it('gives each line its own React key even when the item key repeats', () => {
    const [paid, remainder] = rows()[2].items;
    expect(lineId(paid, 0)).toBe('item.77:p5:0');
    expect(lineId(remainder, 0)).toBe('item.77:rem:0');
  });
});

describe('flags as words', () => {
  it('reads paid + partial as PART PAID, and names the remainder', () => {
    expect(flagTags(['paid', 'partial']).map((t) => t.label)).toEqual(['PART PAID']);
    expect(flagTags(['paid']).map((t) => t.label)).toEqual(['PAID']);
    expect(flagTags(['remainder']).map((t) => t.label)).toEqual(['REMAINDER']);
    expect(flagTags(['overdue', 'tuned']).map((t) => t.label)).toEqual(['OVERDUE', 'TUNED']);
  });

  it('still shows a flag it does not know', () => {
    expect(flagTags(['somethingNew']).map((t) => t.label)).toEqual(['SOMETHINGNEW']);
  });
});

describe('negative cells', () => {
  it('flags a figure below zero, and a closing whose bucket dips below zero', () => {
    expect(balanceFlag(-1)).toBe('negative');
    expect(balanceFlag(0)).toBeNull();
    expect(balanceFlag(35000, -65000)).toBe('dips');
    expect(balanceFlag(-25000, -25000)).toBe('negative');
    expect(balanceFlag(5000, 5000)).toBeNull();
  });

  it('formats cells from minor units without floats', () => {
    expect(cellMoney(-6500001)).toBe('-£65,000.01');
    expect(cellMoney(0, { blankZero: true })).toBe('');
    expect(cellMoney(0)).toBe('£0.00');
    expect(signedMoney(3000)).toBe('+£30.00');
    expect(signedMoney(-3000)).toBe('-£30.00');
    expect(signedMoney(0)).toBe('£0.00');
  });

  it('shortens axis labels by cutting, never rounding up', () => {
    expect(compactMoney(0)).toBe('£0');
    expect(compactMoney(95000)).toBe('£950');
    expect(compactMoney(1_259_900)).toBe('£12.5k');
    expect(compactMoney(-120_000_000)).toBe('-£1.2m');
    expect(compactMoney(25_000_000)).toBe('£250k');
  });
});
