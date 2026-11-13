// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

  function stubApi(rows: ExternalItem[], plan: (body: unknown, path: string) => ExternalItem, companies: unknown[] = []) {
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
      if (method === 'GET' && path.startsWith('/companies')) return ok(list(companies));
      if (method === 'GET' && path.startsWith('/accounts')) return ok(list([{ id: 1, name: 'Barclays USD' }]));
      if (method === 'PUT' && path.startsWith('/external-items/')) return ok(plan(body, path));
      if (method === 'DELETE' && path.startsWith('/external-items/')) return ok(undefined);
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    return calls;
  }

  function Location() {
    return <div data-testid="location">{useLocation().search}</div>;
  }

  const renderScreen = (entry = '/stock-payments') =>
    render(
      <MemoryRouter initialEntries={[entry]}>
        <StockPaymentsScreen />
        <Location />
      </MemoryRouter>,
    );

  it('lists every row in its group, with shipping’s marks and why a row is left out', async () => {
    stubApi([overdue, expected, undated, skipped], () => expected);
    renderScreen();
    const balance = await screen.findByTestId('stock-ship.bal-812-s311');
    expect(balance.closest('[data-group]')?.getAttribute('data-group')).toBe('expected');
    expect(balance.textContent).toContain('Acme Textiles · PO-812 · balance');
    expect(balance.textContent).toContain('Waiting on artwork sign-off');
    expect(balance.textContent).not.toContain('PROJECTED');   // retired 2026-10-06
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

  it('chooses the company of a payment shipping gives none, from its dialog (§10.11a)', async () => {
    const noCompany = { ...unmapped, shippingCompanyId: null };
    const stamp = '2026-10-15T09:00:00Z';
    const jfa = { id: 5, code: 'JFA', name: 'JFA', sortOrder: 1, shippingCompanyId: 11, rowVersion: 1, createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null };
    const calls = stubApi(
      [noCompany],
      () => ({ ...noCompany, assignedCompanyId: 5, companySetBy: 'dev@x.y', companySetAt: stamp, companyId: 5, accountId: 1, derivedStatus: 'expected', rowVersion: 5 }),
      [jfa],
    );
    renderScreen();
    const before = await screen.findByTestId('stock-ship.dep-902');
    expect(before.textContent).toContain('UNMAPPED');
    fireEvent.click(within(before).getByRole('button', { name: 'Plan, Acme Textiles · PO-902 · deposit' }));
    const dialog = screen.getByRole('dialog');
    const select = await within(dialog).findByLabelText('Company for Acme Textiles · PO-902 · deposit');
    fireEvent.change(select, { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use this company' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/external-items/ship.dep-902/company',
      body: { companyId: 5, baseVersion: 4 },
    });
    const after = screen.getByTestId('stock-ship.dep-902');
    expect(after.closest('[data-group]')?.getAttribute('data-group')).toBe('expected');
    expect(after.textContent).toContain('COMPANY SET IN JFLOW');
    expect(after.textContent).not.toContain('UNMAPPED');
  });

  it('a payment shipping gives a company has no company picker', async () => {
    stubApi([expected], () => expected);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Plan, Acme Textiles · PO-812 · balance' }));
    expect(within(screen.getByRole('dialog')).queryByLabelText(/^Company for/)).toBeNull();
  });

  it('unskips a skipped row from here (it is not on the Forecast)', async () => {
    // The note keeps a plan on the row; with only the skip, unskipping is Revert to feed (shipPlan.test.ts).
    const skippedNoted = { ...skipped, plannedNote: 'Waiting on QC' };
    const calls = stubApi([skippedNoted], () => ({ ...skippedNoted, plannedSkipped: false, derivedStatus: 'expected' }));
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

  // Three expected rows with different amounts and dates, plus the overdue deposit in its own section.
  const early = externalRow({ id: 51, key: 'ship.bal-51-s1', extId: 'bal-51-s1', supplier: 'Brightway', poNumber: 'PO-51', containerRef: 'TGHU0000051', amount: '900.00', effectiveAmount: '900.00', dueDate: '2026-10-15', effectiveDate: '2026-10-15' });
  const middle = externalRow({ id: 52, key: 'ship.bal-52-s1', extId: 'bal-52-s1', supplier: 'Acme Textiles', poNumber: 'PO-52', containerRef: 'MSCU0000052', amount: '100.00', effectiveAmount: '100.00', dueDate: '2026-10-20', effectiveDate: '2026-10-20' });
  const late = externalRow({ id: 53, key: 'ship.bal-53-s1', extId: 'bal-53-s1', supplier: 'Coastline', poNumber: 'PO-53', containerRef: null, currency: 'GBP', amount: '400.00', effectiveAmount: '400.00', dueDate: '2026-10-30', effectiveDate: '2026-10-30', accountId: null });
  const keysIn = (group: string) =>
    [...document.querySelectorAll(`[data-group="${group}"] [data-testid^="stock-ship."]`)].map((el) => el.getAttribute('data-testid'));

  it('searches by supplier, PO or container, says how many it shows, and clears', async () => {
    stubApi([overdue, early, middle, late], () => expected);
    renderScreen();
    await screen.findByTestId('stock-ship.bal-51-s1');
    const search = screen.getByRole('searchbox', { name: 'Search stock payments' });

    fireEvent.change(search, { target: { value: 'po-52' } });
    await waitFor(() => expect(screen.queryByTestId('stock-ship.bal-51-s1')).toBeNull());
    expect(screen.getByTestId('stock-ship.bal-52-s1')).toBeTruthy();
    expect(screen.queryByTestId('stock-ship.dep-900')).toBeNull();
    expect(screen.getByTestId('stock-shown').textContent).toBe('1 of 4 stock payments');
    expect(screen.getByTestId('location').textContent).toBe('?q=po-52');

    fireEvent.change(search, { target: { value: 'tghu' } });
    await waitFor(() => expect(keysIn('expected')).toEqual(['stock-ship.bal-51-s1']));

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(keysIn('expected')).toHaveLength(3));
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('stock-shown')).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('');
  });

  it('narrows by date range, kind, currency and account, and says when nothing matches', async () => {
    stubApi([overdue, early, middle, late], () => expected);
    renderScreen();
    await screen.findByTestId('stock-ship.bal-51-s1');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-16' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-25' } });
    await waitFor(() => expect(keysIn('expected')).toEqual(['stock-ship.bal-52-s1']));
    expect(screen.queryByTestId('stock-ship.dep-900')).toBeNull();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '' } });

    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'deposit' } });
    await waitFor(() => expect(keysIn('expected')).toEqual([]));
    expect(screen.getByTestId('stock-ship.dep-900')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: '' } });

    fireEvent.change(screen.getByRole('combobox', { name: 'Currency' }), { target: { value: 'GBP' } });
    await waitFor(() => expect(keysIn('expected')).toEqual(['stock-ship.bal-53-s1']));
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByText(/No stock payments match/)).toBeTruthy());
    expect(screen.getByTestId('location').textContent).toBe('?ccy=GBP&account=1');
  });

  it('sorts inside each section from the column headings, and again to reverse', async () => {
    stubApi([overdue, early, middle, late], () => expected);
    renderScreen();
    await screen.findByTestId('stock-ship.bal-51-s1');
    // The server's order: date ascending.
    expect(keysIn('expected')).toEqual(['stock-ship.bal-51-s1', 'stock-ship.bal-52-s1', 'stock-ship.bal-53-s1']);

    // Amount starts with the biggest; face value, no exchange rate.
    fireEvent.click(screen.getAllByRole('button', { name: 'Sort by amount' })[0]);
    await waitFor(() => expect(keysIn('expected')).toEqual(['stock-ship.bal-51-s1', 'stock-ship.bal-53-s1', 'stock-ship.bal-52-s1']));
    expect(screen.getByTestId('location').textContent).toBe('?sort=-amount');
    expect(screen.getAllByRole('button', { name: 'Sort by amount, largest first' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Sort by amount, largest first' })[0]);
    await waitFor(() => expect(keysIn('expected')).toEqual(['stock-ship.bal-52-s1', 'stock-ship.bal-53-s1', 'stock-ship.bal-51-s1']));

    fireEvent.click(screen.getAllByRole('button', { name: 'Sort by supplier' })[0]);
    await waitFor(() => expect(keysIn('expected')).toEqual(['stock-ship.bal-52-s1', 'stock-ship.bal-51-s1', 'stock-ship.bal-53-s1']));
    // The sections keep their order: overdue still comes first.
    expect([...document.querySelectorAll('[data-group]')].map((el) => el.getAttribute('data-group'))).toEqual(['overdue', 'expected']);
  });

  it('opens on the view in the link', async () => {
    stubApi([overdue, early, middle, late], () => expected);
    renderScreen('/stock-payments?q=acme&sort=-amount');
    await screen.findByTestId('stock-ship.bal-52-s1');
    expect((screen.getByRole('searchbox', { name: 'Search stock payments' }) as HTMLInputElement).value).toBe('acme');
    // Acme is the supplier of 52 and of the overdue deposit.
    expect(keysIn('expected')).toEqual(['stock-ship.bal-52-s1']);
    expect(keysIn('overdue')).toEqual(['stock-ship.dep-900']);
    expect(screen.queryByTestId('stock-ship.bal-51-s1')).toBeNull();
  });

  it('totals each section per currency, from the amounts it shows', async () => {
    stubApi([overdue, early, middle, late], () => expected);
    renderScreen();
    const total = await screen.findByTestId('stock-total-expected');
    expect(total.textContent).toContain('Total');
    expect(within(total).getAllByTestId('stock-total-amount').map((el) => el.textContent)).toEqual(['−£400.00', '−$1,000.00']);
    // One row needs no total.
    expect(screen.queryByTestId('stock-total-overdue')).toBeNull();
  });
});
