// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { __setTestTransport } from '../../api/client';
import type { ExternalItem } from '../../api/external';
import { externalRow } from '../forecast/fixtures';
import { NOT_IN_FORECAST, groupExternalItems, notInForecastTags } from './grouping';
import { StockPaymentsScreen } from './StockPaymentsScreen';

afterEach(cleanup);

const list = (rows: unknown[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });

const expected = externalRow();
const overdue = externalRow({ id: 32, key: 'ship.dep-900', extId: 'dep-900', feedKind: 'deposit', poNumber: 'PO-900', dueDate: '2026-09-20', effectiveDate: '2026-09-20', blocked: null, amountBasis: 'stated', derivedStatus: 'overdue' });
const undated = externalRow({ id: 33, key: 'ship.bal-901-n', extId: 'bal-901-n', poNumber: 'PO-901', dueDate: null, effectiveDate: null, dateBasis: 'undated', derivedStatus: null });
const unmapped = externalRow({ id: 34, key: 'ship.dep-902', extId: 'dep-902', feedKind: 'deposit', poNumber: 'PO-902', companyId: null, accountId: null, derivedStatus: null });
const gone = externalRow({ id: 35, key: 'ship.dep-700', extId: 'dep-700', feedKind: 'deposit', poNumber: 'PO-700', goneAt: '2026-09-28T10:00:00Z', plannedDate: '2026-10-30', derivedStatus: null });
const skipped = externalRow({ id: 36, key: 'ship.dep-903', extId: 'dep-903', feedKind: 'deposit', poNumber: 'PO-903', plannedSkipped: true, derivedStatus: 'skipped' });
const paid = externalRow({ id: 37, key: 'ship.pay-3-904', extId: 'pay-3-904', poNumber: 'PO-904', feedStatus: 'paid', paidOn: '2026-09-25', dueDate: null, effectiveDate: '2026-09-25', derivedStatus: 'paid' });
const DUE_SET = { by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-11-01', scope: 'item', note: 'agreed with the supplier' };
const setByHand = externalRow({ id: 38, key: 'ship.bal-905-s311', extId: 'bal-905-s311', poNumber: 'PO-905', dueDate: '2026-11-20', effectiveDate: '2026-11-20', flags: ['due_set'], dueSet: DUE_SET });
const movedDate = externalRow({ id: 39, key: 'ship.bal-906-s311', extId: 'bal-906-s311', poNumber: 'PO-906', dueDate: '2026-10-21', effectiveDate: '2026-10-21', dueDatePrev: '2026-10-05', dueDateMovedAt: '2026-10-06T07:00:00.000Z', dateMoved: true });
const setUnderPlan = externalRow({ id: 41, key: 'ship.bal-907-s311', extId: 'bal-907-s311', poNumber: 'PO-907', dueDate: '2026-11-20', plannedDate: '2026-11-27', effectiveDate: '2026-11-27', flags: ['due_set'], dueSet: { ...DUE_SET, note: null } });

describe('grouping stock payments by the server’s derivedStatus', () => {
  it('orders the bands, with null as "Not in the forecast", and drops empty ones', () => {
    const groups = groupExternalItems([paid, expected, undated, skipped, overdue, unmapped]);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
      ['overdue', [32]],
      [NOT_IN_FORECAST, [33, 34]],
      ['expected', [31]],
      ['skipped', [36]],
      ['paid', [37]],
    ]);
  });

  it('keeps a band it does not know, last', () => {
    const odd = externalRow({ id: 40, derivedStatus: 'someday' });
    expect(groupExternalItems([odd, expected]).map((g) => g.id)).toEqual(['expected', 'someday']);
  });

  it('says why a null row is not in the forecast, from its own fields', () => {
    expect(notInForecastTags(undated).map((t) => t.label)).toEqual(['NO DATE YET']);
    expect(notInForecastTags(unmapped).map((t) => t.label)).toEqual(['UNMAPPED']);
    // Linked to a JFlow company, but no account in its currency and no default.
    expect(notInForecastTags({ ...unmapped, companyId: 3 }).map((t) => t.label)).toEqual(['NO ACCOUNT']);
    expect(notInForecastTags(gone).map((t) => t.label)).toEqual(['GONE FROM SHIPPING']);
    expect(notInForecastTags(expected)).toEqual([]);
  });
});

describe('the Stock payments screen', () => {
  type Call = { method: string; path: string; body: unknown };

  function stubApi(rows: ExternalItem[], plan: (body: unknown) => ExternalItem) {
    const calls: Call[] = [];
    __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const ok = (v: unknown) => Promise.resolve(v as T);
      if (method === 'GET' && path.startsWith('/external-items')) {
        return ok(list(path.includes('includeGone=1') ? [...rows, gone] : rows));
      }
      if (method === 'GET' && path === '/external/status') {
        return ok({ source: 'ship', lastSuccessAt: '2026-09-29T12:00:00Z', itemCount: 7, companies: [], configured: true });
      }
      if (method === 'GET' && path.startsWith('/companies')) return ok(list([]));
      if (method === 'GET' && path.startsWith('/accounts')) return ok(list([{ id: 1, name: 'Barclays USD' }]));
      if (method === 'PUT' && path.startsWith('/external-items/')) return ok(plan(body));
      if (method === 'DELETE' && path.startsWith('/external-items/')) return ok(undefined);
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    return calls;
  }

  const renderScreen = () =>
    render(
      <MemoryRouter initialEntries={['/stock-payments']}>
        <StockPaymentsScreen />
      </MemoryRouter>,
    );

  it('lists every row in its group, with shipping’s marks and why a row is left out', async () => {
    stubApi([overdue, expected, undated, skipped], () => expected);
    renderScreen();
    const balance = await screen.findByTestId('stock-ship.bal-812-s311');
    expect(balance.closest('[data-group]')?.getAttribute('data-group')).toBe('expected');
    expect(balance.textContent).toContain('Acme Textiles · PO-812 · balance');
    expect(balance.textContent).toContain('Waiting on artwork sign-off');
    expect(balance.textContent).toContain('PROJECTED');
    expect(balance.textContent).toContain('Barclays USD');
    const noDate = screen.getByTestId('stock-ship.bal-901-n');
    expect(noDate.closest('[data-group]')?.getAttribute('data-group')).toBe(NOT_IN_FORECAST);
    expect(noDate.textContent).toContain('No date yet');
    expect(noDate.textContent).toContain('NO DATE YET');
    expect(screen.getByTestId('stock-feed-line').textContent).toMatch(/^Last synced 29 Sep 2026, \d\d:\d\d · 7 rows$/);
  });

  it("marks a date set by hand in shipping as ShipLine does, says who and what it replaced, and says when shipping moved a date", async () => {
    stubApi([setByHand, movedDate, setUnderPlan], () => expected);
    renderScreen();
    const set = await screen.findByTestId('stock-ship.bal-905-s311');
    const date = set.querySelector('[data-due-set="1"]') as HTMLElement;
    expect(date.textContent).toBe('✎ Fri 20 Nov 2026');
    expect(date.style.textDecoration).toBe('underline dotted');
    expect(date.title).toBe('Set by hand in shipping by Ops on Tue 6 Oct 2026, in place of Sun 1 Nov 2026 (this row only): “agreed with the supplier”.');
    expect(within(set).getByTestId('stock-due-set').textContent).toBe('set by Ops on Tue 6 Oct 2026 · derived Sun 1 Nov 2026');
    expect(within(set).getByTestId('stock-due-set-note').textContent).toBe('shipping: “agreed with the supplier”');
    expect(set.textContent).toContain('SET IN SHIPPING');
    expect(within(set).queryByTestId('stock-date-moved')).toBeNull();

    const moved = screen.getByTestId('stock-ship.bal-906-s311');
    expect(moved.querySelector('[data-due-set]')).toBeNull();
    expect(within(moved).getByTestId('stock-date-moved').textContent).toBe('moved from Mon 5 Oct 2026 on Tue 6 Oct 2026');
    expect(moved.textContent).toContain('DATE MOVED');
    expect(moved.textContent).not.toContain('SET IN SHIPPING');

    // JFlow's plan wins the date; the mark sits on shipping's own date underneath.
    const planned = screen.getByTestId('stock-ship.bal-907-s311');
    expect(planned.textContent).toContain('Fri 27 Nov 2026');
    const under = planned.querySelector('[data-due-set="1"]') as HTMLElement;
    expect(under.textContent).toBe('shipping ✎ Fri 20 Nov 2026');
    expect(planned.textContent).toContain('PLANNED');
    expect(planned.textContent).toContain('SET IN SHIPPING');
    expect(within(planned).queryByTestId('stock-due-set-note')).toBeNull();

    // The plain row wears none of it.
    expect(within(screen.getByTestId('stock-ship.bal-905-s311')).getByTestId('stock-due-set')).toBeTruthy();
  });

  it('plans a row with its note and row version known, and replaces it from the answer', async () => {
    const calls = stubApi([expected], (body) => ({
      ...expected,
      plannedDate: (body as { plannedDate: string }).plannedDate,
      effectiveDate: (body as { plannedDate: string }).plannedDate,
      rowVersion: 5,
    }));
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Plan, Acme Textiles · PO-812 · balance' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('ship-feed').textContent).toBe('Shipping says $1,500.00 on Tue 13 Oct 2026.');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-10-27' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/external-items/ship.bal-812-s311',
      body: { plannedDate: '2026-10-27', baseVersion: 4 },
    });
    const row = screen.getByTestId('stock-ship.bal-812-s311');
    expect(row.textContent).toContain('Tue 27 Oct 2026');
    expect(row.textContent).toContain('shipping Tue 13 Oct 2026');
    expect(row.textContent).toContain('PLANNED');
    // Replaced from the response, not re-read.
    expect(calls.filter((c) => c.method === 'GET' && c.path.startsWith('/external-items'))).toHaveLength(1);
  });

  it('unskips a skipped row from here (it is not on the Forecast)', async () => {
    const calls = stubApi([skipped], () => ({ ...skipped, plannedSkipped: false, derivedStatus: 'expected' }));
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Plan, Acme Textiles · PO-903 · deposit' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('switch', { name: /Skip it/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ skipped: false, baseVersion: 4 });
    await waitFor(() =>
      expect(screen.getByTestId('stock-ship.dep-903').closest('[data-group]')?.getAttribute('data-group')).toBe('expected'),
    );
  });

  it('shows gone rows on request, and clears a plan left on one', async () => {
    const calls = stubApi([expected], () => expected);
    renderScreen();
    await screen.findByTestId('stock-ship.bal-812-s311');
    expect(screen.queryByTestId('stock-ship.dep-700')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Include gone rows/ }));
    const goneRow = await screen.findByTestId('stock-ship.dep-700');
    expect(goneRow.textContent).toContain('GONE FROM SHIPPING');
    expect(within(goneRow).queryByRole('button', { name: /^Plan/ })).toBeNull();
    fireEvent.click(within(goneRow).getByRole('button', { name: 'Clear the plan, Acme Textiles · PO-700 · deposit' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')).toEqual({
      method: 'DELETE',
      path: '/external-items/ship.dep-700',
      body: { baseVersion: 4 },
    });
  });
});
