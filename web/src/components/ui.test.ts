import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { errorDetailLines } from './ui';

describe('refusal detail lines', () => {
  it("names each bad bulk entry by the account the screen sent at that position", () => {
    const error = new ApiError(400, {
      error: 'Some entries are not valid.',
      details: { entries: [null, { message: 'balance must be a DECIMAL string' }, 'account is not active'] },
    });
    const names = ['Barclays', 'Lloyds', 'Santander'];
    expect(errorDetailLines(error, (i) => names[i] ?? null)).toEqual([
      { key: 'entry-1', label: 'Lloyds', message: 'balance must be a DECIMAL string' },
      { key: 'entry-2', label: 'Santander', message: 'account is not active' },
    ]);
    expect(errorDetailLines(error)[0].label).toBe('Entry 2');
  });

  it('explains a stale write and an in-use refusal', () => {
    const stale = new ApiError(409, { error: 'Changed since you read it.', code: 'STALE_WRITE', details: { currentVersion: 5 } });
    expect(errorDetailLines(stale)[0].message).toMatch(/now version 5/);
    const inUse = new ApiError(409, {
      error: 'Account in use.',
      code: 'ACCOUNT_IN_USE',
      details: { itemCount: 1, scheduleCount: 2, balanceCount: 0 },
    });
    expect(errorDetailLines(inUse)).toEqual([{ key: 'uses', label: 'Still used by', message: '1 item · 2 schedules' }]);
  });
});
