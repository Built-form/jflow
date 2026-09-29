// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { __setTestTransport } from '../api/client';
import type { Account, Balance, Company } from '../api/types';
import { londonToday } from '../lib/dates';
import { CashAtBankScreen } from './CashAtBankScreen';

afterEach(cleanup);

const stamp = '2026-09-29T08:00:00Z';
const company: Company = {
  id: 1, code: 'JFA', name: 'JFA', sortOrder: 1, rowVersion: 0, createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null,
};

function account(id: number, name: string, currency: string): Account {
  return {
    id, companyId: 1, name, currency, sortOrder: id, isActive: true, isDefault: id === 1, rowVersion: 0,
    createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null, anchorDate: null, anchorBalance: null,
  };
}

const list = <T,>(rows: T[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });

/** A stub API: the reads answer from the given accounts; every call is recorded. */
function stubApi(accounts: Account[]) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    const answer = (value: unknown) => Promise.resolve(value as T);
    if (method === 'GET' && path.startsWith('/companies')) return answer(list([company]));
    if (method === 'GET' && path.startsWith('/accounts')) return answer(list(accounts));
    if (method === 'GET' && path.startsWith('/balances')) return answer(list<Balance>([]));
    if (method === 'POST' && path === '/balances/bulk') {
      const sent = body as { balanceDate: string; entries: { accountId: number; balance: string }[] };
      return answer({
        data: sent.entries.map((e, i) => ({
          id: 100 + i, accountId: e.accountId, balanceDate: sent.balanceDate, balance: e.balance, note: null,
          enteredBy: 'local@dev', rowVersion: 0, createdAt: stamp, updatedAt: stamp,
        })),
      });
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/cash']}>
      <CashAtBankScreen />
    </MemoryRouter>,
  );
}

describe('Cash at bank', () => {
  it('is labelled "Cash at bank at start of day" and defaults to today (Europe/London)', async () => {
    stubApi([account(1, 'Barclays', 'GBP')]);
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Cash at bank at start of day' })).toBeTruthy();
    expect(screen.getByTestId('entry-day').textContent).toMatch(/\(today\)$/);
    expect((screen.getByLabelText('Balance date') as HTMLInputElement).value).toBe(londonToday());
    expect(await screen.findByLabelText('Cash at bank at start of day, Barclays')).toBeTruthy();
  });

  it('saves every filled account in one bulk call, as DECIMAL strings for today', async () => {
    const calls = stubApi([account(1, 'Barclays', 'GBP'), account(2, 'Lloyds', 'GBP')]);
    renderScreen();
    fireEvent.change(await screen.findByLabelText('Cash at bank at start of day, Barclays'), {
      target: { value: '1,024.5' },
    });
    fireEvent.change(screen.getByLabelText('Cash at bank at start of day, Lloyds'), { target: { value: '-20' } });

    // All GBP: a combined figure, summed in minor units.
    expect(screen.getByTestId('entry-total').textContent).toContain('£1,004.50');

    fireEvent.click(screen.getByRole('button', { name: 'Save 2 balances' }));
    await screen.findByText('Saved 2 balances.');
    const bulk = calls.find((c) => c.method === 'POST');
    expect(bulk?.body).toEqual({
      balanceDate: londonToday(),
      entries: [
        { accountId: 1, balance: '1024.50' },
        { accountId: 2, balance: '-20.00' },
      ],
    });
  });

  it('shows no combined figure when the accounts in view are not all GBP', async () => {
    stubApi([account(1, 'Barclays', 'GBP'), account(3, 'Santander EUR', 'EUR')]);
    renderScreen();
    await screen.findByLabelText('Cash at bank at start of day, Santander EUR');
    const total = screen.getByTestId('entry-total').textContent ?? '';
    expect(total).toContain('NO COMBINED TOTAL');
    expect(total).toContain('EUR, GBP');
    expect(total).not.toContain('£');
    await waitFor(() => expect(screen.getByTestId('no-combined-line')).toBeTruthy());
  });

  it('keeps Save disabled while a row is wrong, and says which', async () => {
    stubApi([account(1, 'Barclays', 'GBP')]);
    renderScreen();
    fireEvent.change(await screen.findByLabelText('Cash at bank at start of day, Barclays'), {
      target: { value: '10.999' },
    });
    expect(screen.getByRole('alert').textContent).toBe('At most two decimal places.');
    expect((screen.getByRole('button', { name: 'Save balances' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
