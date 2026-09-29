import { describe, expect, it } from 'vitest';
import type { Balance } from '../api/types';
import {
  START_OF_DAY_LABEL,
  combinedHistory,
  combinedLineAllowed,
  entryTotal,
  historyFor,
  mergeBalances,
  planBulkBalances,
  startOfDay,
  startOfDayLine,
  withoutBalance,
} from './balances';

const TODAY = '2026-09-29';

function bal(accountId: number, balanceDate: string, balance: string, extra: Partial<Balance> = {}): Balance {
  return {
    id: accountId * 1000 + Number(balanceDate.slice(8)),
    accountId,
    balanceDate,
    balance,
    note: null,
    enteredBy: 'dev@built-form.co.uk',
    rowVersion: 0,
    createdAt: '2026-09-29T08:00:00Z',
    updatedAt: '2026-09-29T08:00:00Z',
    ...extra,
  };
}

describe('the start-of-day label', () => {
  it('is exactly the words PLAN fixes', () => {
    expect(START_OF_DAY_LABEL).toBe('Cash at bank at start of day');
    expect(startOfDay(TODAY, TODAY).label).toBe('Cash at bank at start of day');
    expect(startOfDay('2026-09-01', TODAY).label).toBe('Cash at bank at start of day');
  });

  it('names the day, and says when it is today or yesterday', () => {
    expect(startOfDay(TODAY, TODAY)).toEqual({
      label: START_OF_DAY_LABEL,
      day: 'Tue 29 Sep 2026',
      relative: 'today',
      error: null,
    });
    expect(startOfDayLine(TODAY, TODAY)).toBe('Tue 29 Sep 2026 (today)');
    expect(startOfDayLine('2026-09-28', TODAY)).toBe('Mon 28 Sep 2026 (yesterday)');
    expect(startOfDayLine('2026-09-01', TODAY)).toBe('Tue 1 Sep 2026');
  });

  it('refuses a future day before the server has to (BALANCE_DATE_IN_FUTURE)', () => {
    const tomorrow = startOfDay('2026-09-30', TODAY);
    expect(tomorrow.error).toMatch(/today or an earlier day/);
    expect(tomorrow.relative).toBeNull();
    expect(startOfDay(TODAY, TODAY).error).toBeNull();
    expect(startOfDay('2020-01-01', TODAY).error).toBeNull();
  });

  it('refuses a date that is not one', () => {
    expect(startOfDay('2026-02-30', TODAY)).toMatchObject({ day: '—', error: 'Pick a day.' });
  });
});

describe('the combined GBP line', () => {
  const gbp1 = { id: 1, currency: 'GBP' };
  const gbp2 = { id: 2, currency: 'GBP' };
  const eur = { id: 3, currency: 'EUR' };

  it('is drawn only when every account in view is GBP', () => {
    expect(combinedLineAllowed([gbp1, gbp2])).toBe(true);
    expect(combinedLineAllowed([gbp1])).toBe(true);
    expect(combinedLineAllowed([gbp1, eur])).toBe(false);
    expect(combinedLineAllowed([eur])).toBe(false);
    expect(combinedLineAllowed([])).toBe(false);
  });

  it('is null in history when not allowed', () => {
    expect(combinedHistory([gbp1, eur], [bal(1, TODAY, '10.00'), bal(3, TODAY, '10.00')])).toBeNull();
  });

  it('totals a day only when every account in view recorded it — never a partial sum', () => {
    const points = combinedHistory(
      [gbp1, gbp2],
      [
        bal(1, '2026-09-29', '1000.10'),
        bal(2, '2026-09-29', '-250.20'),
        bal(1, '2026-09-28', '900.00'),
        // An account out of view is ignored even if it recorded.
        bal(9, '2026-09-28', '5.00'),
      ],
    );
    expect(points).toEqual([
      { date: '2026-09-29', totalMinor: 74990n, recorded: 2, of: 2 },
      { date: '2026-09-28', totalMinor: null, recorded: 1, of: 2 },
    ]);
  });

  it('sums the entry table in minor units, and says when it is incomplete', () => {
    const drafts = [
      { accountId: 1, balance: '0.10', note: '' },
      { accountId: 2, balance: '0.20', note: '' },
    ];
    expect(entryTotal([gbp1, gbp2], drafts)).toEqual({ totalMinor: 30n, filled: 2, of: 2 });
    expect(entryTotal([gbp1, gbp2], [{ accountId: 1, balance: '5', note: '' }, { accountId: 2, balance: '', note: '' }])).toEqual({
      totalMinor: 500n,
      filled: 1,
      of: 2,
    });
    expect(entryTotal([gbp1, eur], drafts)).toBeNull();
    expect(entryTotal([gbp1, gbp2], [{ accountId: 1, balance: 'x', note: '' }])).toBeNull();
  });
});

describe('replace-from-response for balances', () => {
  it('replaces the row for the same account and date, and keeps date-desc order', () => {
    const list = [bal(1, '2026-09-28', '1.00'), bal(2, '2026-09-28', '2.00')];
    const merged = mergeBalances(list, [bal(1, '2026-09-28', '9.00', { rowVersion: 1 }), bal(1, '2026-09-29', '3.00')]);
    expect(merged.map((b) => [b.accountId, b.balanceDate, b.balance])).toEqual([
      [1, '2026-09-29', '3.00'],
      [1, '2026-09-28', '9.00'],
      [2, '2026-09-28', '2.00'],
    ]);
  });

  it('removes one and reads one account newest first', () => {
    const list = [bal(1, '2026-09-27', '1.00'), bal(1, '2026-09-29', '3.00'), bal(2, '2026-09-29', '2.00')];
    expect(withoutBalance(list, 1, '2026-09-29')).toHaveLength(2);
    expect(historyFor(list, 1).map((b) => b.balanceDate)).toEqual(['2026-09-29', '2026-09-27']);
  });
});

describe('planBulkBalances — the entry form', () => {
  const none = new Map<number, Pick<Balance, 'balance' | 'note'>>();

  it('sends the filled rows as DECIMAL strings, skipping blanks', () => {
    const plan = planBulkBalances(
      TODAY,
      TODAY,
      [
        { accountId: 1, balance: '£1,024.5', note: ' opening ' },
        { accountId: 2, balance: '', note: '' },
        { accountId: 3, balance: '-250', note: '' },
      ],
      none,
    );
    expect(plan.body).toEqual({
      balanceDate: TODAY,
      entries: [
        { accountId: 1, balance: '1024.50', note: 'opening' },
        { accountId: 3, balance: '-250.00' },
      ],
    });
    expect(plan.dateError).toBeNull();
    expect(plan.rowErrors).toEqual({});
  });

  it('accepts zero and an overdraft — a bank balance is not an item amount', () => {
    const plan = planBulkBalances(TODAY, TODAY, [{ accountId: 1, balance: '0', note: '' }], none);
    expect(plan.body?.entries).toEqual([{ accountId: 1, balance: '0.00' }]);
  });

  it('does not resend what is already recorded', () => {
    const recorded = new Map([[1, { balance: '1024.50', note: 'opening' }]]);
    const plan = planBulkBalances(TODAY, TODAY, [{ accountId: 1, balance: '1024.5', note: 'opening' }], recorded);
    expect(plan.body).toBeNull();
    expect(plan.unchanged).toBe(1);
    const changedNote = planBulkBalances(TODAY, TODAY, [{ accountId: 1, balance: '1024.50', note: 'corrected' }], recorded);
    expect(changedNote.body?.entries).toEqual([{ accountId: 1, balance: '1024.50', note: 'corrected' }]);
  });

  it('names the row that is wrong and sends nothing', () => {
    const plan = planBulkBalances(
      TODAY,
      TODAY,
      [
        { accountId: 1, balance: '10.123', note: '' },
        { accountId: 2, balance: '5', note: '' },
        { accountId: 3, balance: '1', note: 'x'.repeat(501) },
      ],
      none,
    );
    expect(plan.body).toBeNull();
    expect(plan.rowErrors[1]).toBe('At most two decimal places.');
    expect(plan.rowErrors[2]).toBeUndefined();
    expect(plan.rowErrors[3]).toMatch(/at most 500/);
  });

  it('refuses a future date for the whole save', () => {
    const plan = planBulkBalances('2026-09-30', TODAY, [{ accountId: 1, balance: '5', note: '' }], none);
    expect(plan.body).toBeNull();
    expect(plan.dateError).toMatch(/today or an earlier day/);
  });

  it('sends nothing when nothing is filled', () => {
    expect(planBulkBalances(TODAY, TODAY, [{ accountId: 1, balance: '', note: '' }], none).body).toBeNull();
  });
});
