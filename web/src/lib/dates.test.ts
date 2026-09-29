import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  diffDays,
  formatDay,
  fromEpochDay,
  isValidDate,
  londonToday,
  relativeDay,
  toEpochDay,
} from './dates';

describe('calendar dates', () => {
  it('knows a real date from a look-alike', () => {
    expect(isValidDate('2026-09-29')).toBe(true);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2100-02-29')).toBe(false);
    expect(isValidDate('2000-02-29')).toBe(true);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-9-29')).toBe(false);
    expect(isValidDate('')).toBe(false);
    expect(isValidDate(null)).toBe(false);
  });

  it('round-trips through epoch days', () => {
    expect(toEpochDay('1970-01-01')).toBe(0);
    expect(toEpochDay('1969-12-31')).toBe(-1);
    for (const d of ['2026-09-29', '2028-02-29', '1999-12-31', '2000-03-01']) {
      expect(fromEpochDay(toEpochDay(d))).toBe(d);
    }
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-09-29', -89)).toBe('2026-07-02');
    expect(diffDays('2026-10-01', '2026-09-29')).toBe(2);
  });

  it('counts the weekday from the date alone (1970-01-01 was a Thursday)', () => {
    expect(dayOfWeek('1970-01-01')).toBe(3);
    expect(dayOfWeek('2026-09-28')).toBe(0); // Monday
    expect(dayOfWeek('2026-10-04')).toBe(6); // Sunday
  });

  it('formats a day without going through a time zone', () => {
    expect(formatDay('2026-09-29')).toBe('Tue 29 Sep 2026');
    expect(formatDay('2026-01-01')).toBe('Thu 1 Jan 2026');
    expect(formatDay('nope')).toBe('—');
    expect(formatDay(null)).toBe('—');
  });

  it('names today and yesterday only', () => {
    expect(relativeDay('2026-09-29', '2026-09-29')).toBe('today');
    expect(relativeDay('2026-09-28', '2026-09-29')).toBe('yesterday');
    expect(relativeDay('2026-09-30', '2026-09-29')).toBe('tomorrow');
    expect(relativeDay('2026-09-01', '2026-09-29')).toBeNull();
  });
});

describe('londonToday — the Europe/London date, whatever zone the browser is in', () => {
  it('is already tomorrow in London at 23:30 UTC in summer (BST)', () => {
    expect(londonToday(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
  });

  it('is still today in London at 23:30 UTC in winter (GMT)', () => {
    expect(londonToday(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31');
  });

  it('follows the clock change: 00:30 UTC on the last Sunday of March', () => {
    // BST starts at 01:00 UTC on 29 Mar 2026; half an hour before, London is on GMT.
    expect(londonToday(new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-29');
    expect(londonToday(new Date('2026-03-28T23:59:00Z'))).toBe('2026-03-28');
  });

  it('is a YYYY-MM-DD calendar date', () => {
    expect(isValidDate(londonToday())).toBe(true);
  });
});
