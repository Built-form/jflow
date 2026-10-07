import { describe, expect, it } from 'vitest';
import { isValidKey, parseKey } from './keys';

describe('parseKey (CONTRACT §4, parse only)', () => {
  it('reads the four kinds', () => {
    expect(parseKey('item.123')).toEqual({ targetKind: 'item', targetId: '123', targetDate: null });
    expect(parseKey('sched.45.2026-06-01')).toEqual({ targetKind: 'sched', targetId: '45', targetDate: '2026-06-01' });
    expect(parseKey('ship.PO-778')).toEqual({ targetKind: 'ship', targetId: 'PO-778', targetDate: null });
    expect(parseKey('new.77')).toEqual({ targetKind: 'new', targetId: '77', targetDate: null });
  });

  it("reads a scenario add's `new.` key back to the adjustment id the server built it from (D39)", () => {
    for (const id of ['1', '77', '123456789012345678']) {
      const parsed = parseKey(`new.${id}`);
      expect(parsed).toEqual({ targetKind: 'new', targetId: id, targetDate: null });
      expect(isValidKey(`new.${id}`)).toBe(true);
    }
    expect(parseKey('new.1234567890123456789')).toBeNull();
  });

  it('keeps the id as the decimal string, up to 18 digits', () => {
    expect(parseKey('item.123456789012345678')?.targetId).toBe('123456789012345678');
    expect(parseKey('item.1234567890123456789')).toBeNull();
  });

  it.each([
    'item.0',
    'item.012',
    'item.-1',
    'item.+1',
    'item.1.5',
    'sched.45.2026-02-30',
    'sched.45.2026-6-01',
    'sched.045.2026-06-01',
    'sched.45',
    'ship.PO 778',
    'ship.PO#778',
    'ship.',
    'new.0',
    'new.01',
    'new.-1',
    'new.',
    'new.7.2026-10-01',
    'new.abc',
    'NEW.7',
    'item:123',
    'item/123',
    'ITEM.123',
    '',
    ` item.123`,
  ])('refuses %j', (key) => {
    expect(parseKey(key)).toBeNull();
    expect(isValidKey(key)).toBe(false);
  });

  it('refuses a key longer than 80 characters and anything that is not a string', () => {
    expect(parseKey(`ship.${'A'.repeat(64)}`)).not.toBeNull();
    expect(parseKey(`ship.${'A'.repeat(65)}`)).toBeNull();
    expect(parseKey(null)).toBeNull();
    expect(parseKey(123)).toBeNull();
  });

  it('accepts a leap day only in a leap year', () => {
    expect(parseKey('sched.1.2028-02-29')?.targetDate).toBe('2028-02-29');
    expect(parseKey('sched.1.2027-02-29')).toBeNull();
  });
});
