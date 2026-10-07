import { describe, expect, it } from 'vitest';
import { TODAY, line } from './fixtures';
import { addPart, checkSplit, initialSplit, leftToAllocate, removePart, setPart, splitBase } from './split';
import type { SplitForm } from './split';

const invoice = line({ key: 'item.10', id: 10, name: 'Invoice 1041', amountMinor: 100000, date: '2026-10-06', bucketIndex: 1 });
const odd = { ...invoice, amountMinor: 100001 };
// Already moved and resized in the scenario: the split shares out the REAL amount, from the real date.
const moved = line({
  key: 'sched.45.2026-10-01',
  id: 45,
  name: 'Office rent',
  amountMinor: 130000,
  date: '2026-10-09',
  flags: ['adjusted'],
  baseline: { date: '2026-10-02', amountMinor: 120000, gbpMinor: 120000, flags: [] },
});

const ctx = (item = invoice) => ({ base: splitBase(item), currency: item.currency, today: TODAY });

describe('a split starts as two halves, a month apart (D40)', () => {
  it('halves the line in minor units, from its own date', () => {
    expect(splitBase(invoice)).toBe(100000n);
    expect(initialSplit(invoice, TODAY)).toEqual({
      parts: [
        { date: '2026-10-06', amount: '500.00' },
        { date: '2026-11-05', amount: '500.00' },
      ],
    });
  });

  it('puts the odd penny on part 1', () => {
    expect(initialSplit(odd, TODAY).parts.map((p) => p.amount)).toEqual(['500.01', '500.00']);
    expect(leftToAllocate(initialSplit(odd, TODAY), splitBase(odd))).toBe(0n);
  });

  it("shares out the BASELINE amount from the baseline date when the line already carries an adjustment", () => {
    expect(splitBase(moved)).toBe(120000n);
    expect(initialSplit(moved, TODAY)).toEqual({
      parts: [
        { date: '2026-10-02', amount: '600.00' },
        { date: '2026-11-01', amount: '600.00' },
      ],
    });
  });

  it("re-splitting an anchor shares out the real amount again, not part 1's", () => {
    const anchor = { ...invoice, amountMinor: 60000, flags: ['split'], splitGroup: 21, baseline: { date: '2026-10-06', amountMinor: 100000, gbpMinor: 100000, flags: [] } };
    expect(splitBase(anchor)).toBe(100000n);
  });

  it('never starts on a date before today', () => {
    const late = { ...invoice, date: '2026-09-20', baseline: { date: '2026-09-20', amountMinor: 100000, gbpMinor: 100000, flags: [] } };
    expect(initialSplit(late, TODAY).parts.map((p) => p.date)).toEqual([TODAY, '2026-10-29']);
  });
});

describe('parts', () => {
  const start = initialSplit(invoice, TODAY);

  it('"Add a part" appends one 30 days after the last, at zero', () => {
    const three = addPart(start, TODAY);
    expect(three.parts).toHaveLength(3);
    expect(three.parts[2]).toEqual({ date: '2026-12-05', amount: '0.00' });
    // The form it came from is untouched.
    expect(start.parts).toHaveLength(2);
  });

  it('removes a part, but always keeps two', () => {
    const three = addPart(start, TODAY);
    expect(removePart(three, 1).parts.map((p) => p.date)).toEqual(['2026-10-06', '2026-12-05']);
    expect(removePart(start, 0)).toBe(start);
  });

  it('keeps a running "left to allocate" in minor units', () => {
    expect(leftToAllocate(start, 100000n)).toBe(0n);
    const less = setPart(start, 1, { amount: '400' });
    expect(leftToAllocate(less, 100000n)).toBe(10000n);
    const more = setPart(start, 1, { amount: '600.01' });
    expect(leftToAllocate(more, 100000n)).toBe(-10001n);
    // A part not yet a valid amount counts as nothing.
    expect(leftToAllocate(setPart(start, 1, { amount: 'abc' }), 100000n)).toBe(50000n);
  });
});

describe('checkSplit', () => {
  const start = initialSplit(invoice, TODAY);

  it('sends the parts as DECIMAL strings, in order', () => {
    const form: SplitForm = { parts: [{ date: '2026-10-06', amount: '£700' }, { date: '2026-10-20', amount: '300' }] };
    const check = checkSplit(form, ctx());
    expect(check.errors).toEqual({ parts: [{}, {}] });
    expect(check.body).toEqual({
      parts: [
        { newDate: '2026-10-06', newAmount: '700.00' },
        { newDate: '2026-10-20', newAmount: '300.00' },
      ],
    });
    expect(check.left).toBe(0n);
  });

  it.each([
    ['', 'Enter an amount.'],
    ['0', 'Must be more than zero.'],
    ['-5', 'Must not be negative.'],
    ['1.234', 'At most two decimal places.'],
  ])('refuses the amount %j', (amount, message) => {
    const check = checkSplit(setPart(start, 1, { amount }), ctx());
    expect(check.body).toBeNull();
    expect(check.errors.parts[1].amount).toBe(message);
    expect(check.errors.parts[0]).toEqual({});
  });

  it('refuses a date that is not real, or is before today', () => {
    expect(checkSplit(setPart(start, 0, { date: '2026-02-30' }), ctx()).errors.parts[0].date).toBe('Pick a date.');
    const past = checkSplit(setPart(start, 1, { date: '2026-09-28' }), ctx());
    expect(past.body).toBeNull();
    expect(past.errors.parts[1].date).toBe('Today or later.');
    expect(checkSplit(setPart(start, 1, { date: TODAY }), ctx()).body).not.toBeNull();
  });

  it('refuses parts that do not add up to the line', () => {
    const check = checkSplit(setPart(start, 1, { amount: '400' }), ctx());
    expect(check.body).toBeNull();
    expect(check.errors.form).toBe('The parts must add up to £1,000.00.');
    expect(check.left).toBe(10000n);
  });

  it('refuses fewer than two parts', () => {
    const one: SplitForm = { parts: [{ date: '2026-10-06', amount: '1000' }] };
    const check = checkSplit(one, ctx());
    expect(check.body).toBeNull();
    expect(check.errors.form).toBe('A split needs at least two parts.');
  });

  it('adds up in the line currency', () => {
    const usd = { ...invoice, currency: 'USD' };
    expect(checkSplit(setPart(initialSplit(usd, TODAY), 1, { amount: '1' }), ctx(usd)).errors.form).toBe(
      'The parts must add up to $1,000.00.',
    );
  });
});
