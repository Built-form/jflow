// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { Instance } from '../../api/schedules';
import { account, category, instance, list, schedule } from '../items/testFixtures';
import { ScheduleScreen } from './ScheduleScreen';

afterEach(cleanup);

type Call = { method: string; path: string; body: unknown };

const override = (over: Partial<NonNullable<Instance['override']>> = {}) => ({
  id: 40, amount: null, dueDate: null, status: null, settleMode: null, paidOn: null, paidAmount: null, note: null,
  sourceScenarioId: null, rowVersion: 2, createdBy: null, createdAt: '', updatedAt: '', ...over,
});

const s = schedule(8, { predecessorId: 7, activeFrom: '2026-06-30', startDate: '2026-01-31', name: 'Rent' });
const instances: Instance[] = [
  instance(8, '2026-06-30', { derivedStatus: 'assumedSettled' }),
  instance(8, '2026-07-31', {
    amount: '983.00',
    tuned: true,
    override: override({ amount: '983.00', status: 'paid', paidOn: '2026-07-31', paidAmount: '983.00' }),
    status: 'paid',
    derivedStatus: 'paid',
    payments: [{ id: 5, paidOn: '2026-07-31', amount: '983.00', note: null, createdBy: null, createdAt: '' }],
  }),
  instance(8, '2026-10-31', { dueDate: '2026-10-30' }),
];

function stubApi(answer: (call: Call) => unknown = () => undefined) {
  const calls: Call[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const call = { method, path, body };
    calls.push(call);
    const ok = (value: unknown) => Promise.resolve(value as T);
    const reply = answer(call);
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply !== undefined) return ok(reply);
    if (method === 'GET' && path === '/schedules/8') return ok(s);
    if (method === 'GET' && path === '/schedules/7') return ok(schedule(7, { name: 'Rent (old)', successorId: 8, status: 'ended' }));
    if (method === 'GET' && path.startsWith('/schedules/8/instances')) return ok({ data: instances, orphans: [] });
    if (method === 'GET' && path.startsWith('/accounts')) return ok(list([account(1, 'Barclays')]));
    if (method === 'GET' && path.startsWith('/categories')) return ok(list([category(2, 'Premises', 'out')]));
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/schedules/8']}>
      <Routes>
        <Route path="/schedules/:id" element={<ScheduleScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

const group = (name: string) => screen.getByRole('region', { name });

describe('a schedule', () => {
  it('shows where it was split from, and from when it is active', async () => {
    stubApi();
    renderScreen();
    await screen.findByRole('heading', { name: 'Rent' });
    const lineage = await screen.findByTestId('lineage');
    await within(lineage).findByText('Rent (old)');
    expect(lineage.textContent).toMatch(/Split from Rent \(old\) — takes over from Tue 30 Jun 2026/);
    expect(within(lineage).getByRole('link', { name: 'Rent (old)' }).getAttribute('href')).toBe('/schedules/7');
    expect(screen.getByText(/earlier dates belong to the schedule it was split from/)).toBeTruthy();
  });

  it('asks for instances in a bounded window, and groups them by the server\'s derivedStatus', async () => {
    const calls = stubApi();
    renderScreen();
    await screen.findByTestId('instance-2026-06-30');
    const read = calls.find((c) => c.path.startsWith('/schedules/8/instances'))!;
    expect(read.path).toMatch(/^\/schedules\/8\/instances\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    const sections = [...document.querySelectorAll('[data-group]')].map((g) => g.getAttribute('data-group'));
    expect(sections).toEqual(['assumedSettled', 'expected', 'paid']);
    // Predicted vs tuned: the tuned amount, with the schedule's amount it replaced.
    const tuned = screen.getByTestId('instance-2026-07-31');
    expect(tuned.textContent).toMatch(/£983.00.*predicted £1,000.00.*TUNED/);
    expect(screen.getByTestId('instance-2026-10-31').textContent).toMatch(/as predicted/);
  });

  it("Didn't happen on an assumed-settled instance tunes its settle mode to manual", async () => {
    const calls = stubApi((c) =>
      c.method === 'PUT' && c.path === '/schedules/8/instances/2026-06-30'
        ? { ...instances[0], settleMode: 'manual', tuned: true, override: override({ settleMode: 'manual' }), derivedStatus: 'unresolved' }
        : undefined,
    );
    renderScreen();
    const assumed = await screen.findByRole('region', { name: 'Assumed settled' });
    expect(within(assumed).getByRole('button', { name: 'Confirm paid, Tue 30 Jun 2026' })).toBeTruthy();
    fireEvent.click(within(assumed).getByRole('button', { name: "Didn't happen, Tue 30 Jun 2026" }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/reappears as overdue/);
    fireEvent.click(within(dialog).getByRole('button', { name: "It didn't happen" }));
    await screen.findByRole('region', { name: 'Unresolved' });
    // No override row yet, so no base version to send (§10.4).
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/schedules/8/instances/2026-06-30',
      body: { settleMode: 'manual' },
    });
    expect(screen.queryByRole('region', { name: 'Assumed settled' })).toBeNull();
    expect(within(group('Unresolved')).getByText(/BY HAND/)).toBeTruthy();
  });

  it('explains OVERRIDE_HAS_PAYMENT when a revert is refused', async () => {
    stubApi((c) =>
      c.method === 'DELETE'
        ? new ApiError(409, {
            error: 'This instance carries a payment.',
            code: 'OVERRIDE_HAS_PAYMENT',
            details: { naturalDate: '2026-07-31', status: 'paid', paidAmount: '983.00', paidOn: '2026-07-31' },
          })
        : undefined,
    );
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Revert, Fri 31 Jul 2026' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revert' }));
    const why = await screen.findByTestId('revert-has-payment');
    expect(why.textContent).toMatch(/payment recorded \(£983.00 on Fri 31 Jul 2026\).*Unpay it first, then revert/);
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Revert' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('pays an instance through the shared pay dialog, keyed by its natural date', async () => {
    const calls = stubApi((c) =>
      c.method === 'POST' && c.path === '/schedules/8/instances/2026-10-31/pay'
        ? { ...instances[2], status: 'part_paid', tuned: true, override: override({ status: 'part_paid', paidAmount: '400.00', paidOn: '2026-09-29' }), payments: [{ id: 6, paidOn: '2026-09-29', amount: '400.00', note: null, createdBy: null, createdAt: '' }] }
        : undefined,
    );
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Pay, Sat 31 Oct 2026' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('pay-remaining').textContent).toContain('£1,000.00');
    fireEvent.change(within(dialog).getByLabelText('Amount paid'), { target: { value: '400' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record part-payment' }));
    await screen.findByText('£600.00 left');
    const pay = calls.find((c) => c.method === 'POST')!;
    expect(pay.body).toMatchObject({ paidAmount: '400.00' });
  });
});
