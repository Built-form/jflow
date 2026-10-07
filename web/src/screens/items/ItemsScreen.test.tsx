// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { __setTestTransport } from '../../api/client';
import type { Item } from '../../api/items';
import type { InstanceAcross } from '../../api/schedules';
import { addDays, formatDay, londonToday } from '../../lib/dates';
import { ItemsScreen } from './ItemsScreen';
import { account, category, company, instance, item, list } from './testFixtures';

afterEach(cleanup);

const today = londonToday();
const longAgo = addDays(today, -19);

type Call = { method: string; path: string; body: unknown };

/** The items routes as CONTRACT §6.7 describes them, answering from `rows`; `/instances` from `instanceRows`. */
function stubApi(rows: Item[], answer: (call: Call) => unknown = () => undefined, instanceRows: InstanceAcross[] = []) {
  const calls: Call[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const call = { method, path, body };
    calls.push(call);
    const ok = (value: unknown) => Promise.resolve(value as T);
    if (method === 'GET' && path.startsWith('/instances')) return ok({ data: instanceRows });
    if (method === 'GET' && path.startsWith('/companies')) return ok(list([company]));
    if (method === 'GET' && path.startsWith('/accounts')) return ok(list([account(1, 'Barclays')]));
    if (method === 'GET' && path.startsWith('/categories')) {
      return ok(list([category(1, 'Sales', 'in'), category(2, 'Suppliers', 'out')]));
    }
    if (method === 'GET' && path.startsWith('/items')) return ok(list(rows));
    const reply = answer(call);
    return reply === undefined ? Promise.reject(new Error(`unexpected ${method} ${path}`)) : ok(reply);
  });
  return calls;
}

const rows = [
  item(1, { name: 'Invoice 1041', dueDate: addDays(today, 6) }),
  item(2, { name: 'Stationery', dueDate: longAgo, derivedStatus: 'assumedSettled' }),
  item(3, { name: 'Courier', dueDate: addDays(today, -3), settleMode: 'manual', derivedStatus: 'overdue' }),
  item(4, {
    name: 'Deposit',
    dueDate: addDays(today, -2),
    status: 'paid',
    derivedStatus: 'paid',
    paidOn: addDays(today, -2),
    paidAmount: '100.00',
    remainingAmount: '0.00',
    payments: [{ id: 9, paidOn: addDays(today, -2), amount: '100.00', note: null, createdBy: null, createdAt: '' }],
  }),
];

function renderScreen(path = '/items') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ItemsScreen />
    </MemoryRouter>,
  );
}

const group = (name: string) => screen.getByRole('region', { name });

describe('Income & outgoings', () => {
  it("groups one-offs by the server's derivedStatus, with Assumed settled as its own group", async () => {
    stubApi(rows);
    renderScreen();
    await screen.findByText('Stationery');
    const sections = [...document.querySelectorAll('[data-group]')].map((s) => s.getAttribute('data-group'));
    expect(sections).toEqual(['overdue', 'assumedSettled', 'expected', 'paid']);
    expect(within(group('Assumed settled')).getByText('Stationery')).toBeTruthy();
    expect(within(group('Overdue')).getByText('Courier')).toBeTruthy();
    // The payment rows behind the paid figure are shown.
    expect(within(group('Paid')).getByLabelText('Payments').textContent).toContain('£100.00');
  });

  it("lists the schedules' assumed instances alongside, and Didn't happen on one tunes that instance alone (Dev, 2026-10-07)", async () => {
    const payout: InstanceAcross = {
      ...instance(5, longAgo, { direction: 'in', amount: '2500.00', derivedStatus: 'assumedSettled' }),
      schedule: { id: 5, name: 'Amazon payout', counterparty: 'Amazon', accountId: 1, companyId: 1, categoryId: 1, status: 'active' },
    };
    const calls = stubApi(
      rows,
      (call) =>
        call.method === 'PUT' && call.path === `/schedules/5/instances/${longAgo}`
          ? { ...instance(5, longAgo, { direction: 'in', amount: '2500.00', settleMode: 'manual', derivedStatus: 'overdue', tuned: true }) }
          : undefined,
      [payout],
    );
    renderScreen();
    await screen.findByText('Stationery');
    const asked = calls.find((c) => c.method === 'GET' && c.path.startsWith('/instances'));
    expect(decodeURIComponent(asked?.path ?? '')).toContain('derivedStatus=assumed,assumedSettled,overdue,unresolved');
    expect(decodeURIComponent(asked?.path ?? '')).toContain(`to=${today}`);

    const assumed = group('Assumed settled');
    const row = within(assumed).getByTestId(`instance-sched.5.${longAgo}`);
    expect(within(row).getByRole('link', { name: 'Amazon payout' }).getAttribute('href')).toBe('/schedules/5');
    expect(row.textContent).toContain('RECURRING');
    expect(row.textContent).toContain('+£2,500.00');
    const name = `Amazon payout, ${formatDay(longAgo)}`;
    expect(within(row).getByRole('button', { name: `Confirm paid, ${name}` })).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: `Didn't happen, ${name}` }));
    const dialog = screen.getByRole('dialog', { name: `${name} didn't happen?` });
    expect(dialog.textContent).toMatch(/Only this instance changes/);
    fireEvent.click(within(dialog).getByRole('button', { name: "It didn't happen" }));
    await screen.findByRole('status');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: `/schedules/5/instances/${longAgo}`,
      body: { settleMode: 'manual' },
    });
    expect(within(group('Overdue')).getByTestId(`instance-sched.5.${longAgo}`)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Amazon payout.*settled by hand.*Overdue/);
  });

  it('offers Confirm paid and Didn\'t happen only on assumed-settled items', async () => {
    stubApi(rows);
    renderScreen();
    await screen.findByText('Stationery');
    const assumed = group('Assumed settled');
    expect(within(assumed).getByRole('button', { name: 'Confirm paid, Stationery' })).toBeTruthy();
    expect(within(assumed).getByRole('button', { name: "Didn't happen, Stationery" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm paid, Invoice 1041' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay, Invoice 1041' })).toBeTruthy();
  });

  it("Didn't happen explains itself, sends settleMode manual, and the row moves to the group the server answers", async () => {
    const calls = stubApi(rows, (call) =>
      call.method === 'PUT' && call.path === '/items/2'
        ? { ...rows[1], settleMode: 'manual', derivedStatus: 'overdue', rowVersion: 4 }
        : undefined,
    );
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: "Didn't happen, Stationery" }));
    const dialog = screen.getByRole('dialog', { name: "Stationery didn't happen?" });
    expect(dialog.textContent).toMatch(/reappears as overdue/);
    fireEvent.click(within(dialog).getByRole('button', { name: "It didn't happen" }));

    await screen.findByRole('status');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/items/2',
      body: { settleMode: 'manual', baseVersion: 3 },
    });
    expect(screen.queryByRole('region', { name: 'Assumed settled' })).toBeNull();
    expect(within(group('Overdue')).getByText('Stationery')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/settled by hand.*Overdue/);
  });

  it('Confirm paid opens the pay dialog at the due date and replaces the row from the response', async () => {
    const calls = stubApi(rows, (call) =>
      call.method === 'POST' && call.path === '/items/2/pay'
        ? {
            ...rows[1],
            status: 'paid',
            derivedStatus: 'paid',
            paidOn: longAgo,
            paidAmount: '100.00',
            remainingAmount: '0.00',
            payments: [{ id: 11, paidOn: longAgo, amount: '100.00', note: null, createdBy: null, createdAt: '' }],
          }
        : undefined,
    );
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm paid, Stationery' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm Stationery was paid' });
    expect((within(dialog).getByLabelText('Paid on') as HTMLInputElement).value).toBe(longAgo);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record payment' }));

    await screen.findByRole('button', { name: 'Unpay, Stationery' });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ paidOn: longAgo, paidAmount: '100.00', baseVersion: 3 });
    expect(within(group('Paid')).getByText('Stationery')).toBeTruthy();
  });

  it('filters to the assumed-settled group from the URL-held filter', async () => {
    stubApi(rows);
    renderScreen();
    await screen.findByText('Stationery');
    fireEvent.click(screen.getByRole('button', { name: 'Assumed settled · 1' }));
    expect(screen.getByText('Stationery')).toBeTruthy();
    expect(screen.queryByText('Invoice 1041')).toBeNull();
    expect(screen.queryByText('Courier')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All · 4' }));
    expect(screen.getByText('Invoice 1041')).toBeTruthy();
  });

  it('opens with the filter from ?show=', async () => {
    stubApi(rows);
    renderScreen('/items?show=assumedSettled');
    await screen.findByText('Stationery');
    expect(screen.queryByText('Courier')).toBeNull();
  });

  it('unpay confirms first, listing the payments it removes', async () => {
    const calls = stubApi(rows, (call) =>
      call.path === '/items/4/unpay'
        ? { ...rows[3], status: 'expected', derivedStatus: 'overdue', paidOn: null, paidAmount: null, remainingAmount: '100.00', payments: [] }
        : undefined,
    );
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Unpay, Deposit' }));
    const dialog = screen.getByRole('dialog', { name: 'Unpay Deposit?' });
    expect(dialog.textContent).toMatch(/Every payment recorded against it is removed/);
    expect(calls.some((c) => c.path === '/items/4/unpay')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the payment' }));
    await screen.findByRole('button', { name: 'Pay, Deposit' });
    expect(calls.find((c) => c.path === '/items/4/unpay')?.body).toEqual({ baseVersion: 3 });
  });
});
