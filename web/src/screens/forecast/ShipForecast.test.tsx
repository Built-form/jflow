// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { ExternalItem, ExternalStatus, RefreshResult } from '../../api/external';
import type { ForecastResponse } from '../../api/forecast';
import { ScenarioContext, createScenarioStore } from '../../app/ScenarioContext';
import type { ScenarioStore } from '../../app/ScenarioContext';
import { ForecastScreen } from './ForecastScreen';
import { SHIPPING, TODAY, depositRow, externalRow, forecastFixture } from './fixtures';

afterEach(cleanup);

const list = (rows: unknown[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });

type Call = { method: string; path: string; body: unknown };

const STATUS: ExternalStatus = {
  source: 'ship',
  lastAttemptAt: '2026-09-29T12:00:00Z',
  lastSuccessAt: '2026-09-29T12:00:00Z',
  feedToday: TODAY,
  lastError: null,
  itemCount: 14,
  rejectedCount: 0,
  companies: [
    { id: 11, name: 'JFA Medical Ltd' },
    { id: 12, name: 'Hangerworld Ltd' },
  ],
  configured: true,
  updatedAt: '2026-09-29T12:00:00Z',
};

interface Answers {
  forecast: () => ForecastResponse | ApiError;
  refresh?: () => RefreshResult | ApiError;
  /** `PUT /external-items/:key`. */
  plan?: () => unknown;
  /** `DELETE /external-items/:key`. */
  unplan?: () => unknown;
  /** `GET /external-items/:key`; by default the rows behind the fixture's two ship lines. */
  row?: (key: string, n: number) => ExternalItem | ApiError;
  /** `GET /companies`; empty by default. */
  companies?: unknown[];
}

const ROWS: Record<string, ExternalItem> = { 'ship.dep-812': depositRow(), 'ship.bal-812-s311': externalRow() };

function stubApi(answers: Answers) {
  const calls: Call[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    const reply = (v: unknown) => (v instanceof ApiError ? Promise.reject(v) : Promise.resolve(v as T));
    if (method === 'GET' && path.startsWith('/forecast')) return reply(answers.forecast());
    if (method === 'GET' && path.startsWith('/companies')) return reply(list(answers.companies ?? []));
    if (method === 'GET' && path.startsWith('/accounts')) return reply(list([]));
    if (method === 'GET' && path === '/external/status') return reply(STATUS);
    if (method === 'POST' && path === '/external/refresh') return reply(answers.refresh ? answers.refresh() : { ran: true, status: STATUS });
    if (method === 'GET' && path.startsWith('/external-items/')) {
      const key = path.slice('/external-items/'.length);
      const n = calls.filter((c) => c.method === 'GET' && c.path === path).length;
      return reply(answers.row ? answers.row(key, n) : ROWS[key] ?? new ApiError(404, { error: 'Not found.' }));
    }
    if (method === 'PUT' && path.startsWith('/external-items/')) return reply(answers.plan ? answers.plan() : depositRow({ rowVersion: 8 }));
    if (method === 'DELETE' && path.startsWith('/external-items/')) return reply(answers.unplan ? answers.unplan() : depositRow({ plannedDate: null, plannedNote: null, rowVersion: 8 }));
    if (method === 'PUT' && path.startsWith('/scenarios/')) return reply({});
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

function renderForecast(store: ScenarioStore = createScenarioStore()) {
  return render(
    <ScenarioContext.Provider value={store}>
      <MemoryRouter initialEntries={['/forecast']}>
        <ForecastScreen />
      </MemoryRouter>
    </ScenarioContext.Provider>,
  );
}

/** Categories start collapsed; open them all so the tests can reach the lines. */
async function expandGrid() {
  const grid = await screen.findByTestId('forecast-grid');
  fireEvent.click(within(grid).getByRole('button', { name: 'Expand all' }));
}

const forecastReads = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/forecast'));

describe('ship lines in the grid', () => {
  it('render from the server flags: estimated hatched and italic, blocked and planned marked, no mark for a derived amount, the name as sent', async () => {
    stubApi({ forecast: () => forecastFixture({ ship: true, shipping: SHIPPING }) });
    renderForecast();
    await expandGrid();
    const grid = await screen.findByTestId('forecast-grid');
    expect(within(grid).getByTestId('category-90').textContent).toContain('Stock payments');

    const deposit = within(grid).getByTestId('line-ship.dep-812');
    expect(deposit.textContent).toContain('Acme Textiles · PO-812 · deposit');
    const estimated = deposit.querySelector('[data-estimated="true"]') as HTMLElement;
    expect(estimated).toBeTruthy();
    expect(estimated.style.fontStyle).toBe('italic');
    expect(estimated.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(deposit.querySelector('[data-flag="estimated"]')?.textContent).toBe('ESTIMATED');
    expect(deposit.querySelector('[data-flag="planned"]')?.textContent).toBe('PLANNED');

    const balance = within(grid).getByTestId('line-ship.bal-812-s311');
    expect(balance.textContent).toContain('Acme Textiles · PO-812 · balance');
    // Its container sits on the supplier + shipment group row above it, not on the line again.
    expect(balance.textContent).not.toContain('MSCU1234567');
    expect(within(grid).getByTestId('combo-acme textiles|MSCU1234567').textContent).toContain('MSCU1234567 · 1 payment');
    expect(balance.querySelector('[data-estimated="true"]')).toBeNull();
    expect(balance.querySelector('[data-flag="blocked"]')?.textContent).toBe('BLOCKED');
    // `projected` retired 2026-10-06: a derived amount wears no tag and gets no sentence.
    expect(balance.querySelector('[data-flag="projected"]')).toBeNull();
    expect(balance.textContent).not.toContain('PROJECTED');
    // The blocker is explained on the line.
    expect(within(balance).getByRole('button', { name: /^Edit / }).getAttribute('title')).toContain('Waiting on artwork sign-off.');
    expect(within(balance).getByRole('button', { name: /^Edit / }).getAttribute('title')).not.toContain('invoice');
  });

  it('marks a SHIP_PLAN_STALE line and lists it; lists a SHIP_PLAN_ORPHANED plan with a way to clear it', async () => {
    const calls = stubApi({
      forecast: () =>
        forecastFixture({
          ship: true,
          shipping: SHIPPING,
          warnings: [
            { code: 'SHIP_PLAN_STALE', key: 'ship.bal-812-s311' },
            { code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-700' },
          ],
        }),
    });
    renderForecast();
    await expandGrid();
    const balance = await screen.findByTestId('line-ship.bal-812-s311');
    expect(balance.querySelector('[data-flag="planStale"]')?.textContent).toBe('PLAN IGNORED');
    expect(screen.getByTestId('line-ship.dep-812').querySelector('[data-flag="planStale"]')).toBeNull();

    const notes = screen.getByTestId('ship-notes');
    expect(within(notes).getByTestId('ship-stale-ship.bal-812-s311').textContent).toContain('Acme Textiles · PO-812 · balance');
    // The ship warnings are not repeated in the generic list.
    expect(screen.queryByTestId('forecast-warnings')).toBeNull();

    const orphan = within(notes).getByTestId('ship-orphaned-ship.dep-700');
    expect(orphan.textContent).toContain('no longer lists');
    fireEvent.click(within(orphan).getByRole('button', { name: 'Clear the plan' }));
    await waitFor(() => expect(forecastReads(calls)).toHaveLength(2));
    expect(calls.find((c) => c.method === 'DELETE')).toEqual({ method: 'DELETE', path: '/external-items/ship.dep-700', body: undefined });
  });

  it('says why SHIP_UNMAPPED rows are left out: no company linked, no company in shipping, no account to land on', async () => {
    const stamp = '2026-09-29T12:00:00Z';
    stubApi({
      companies: [
        { id: 5, code: 'JFA', name: 'JFA', sortOrder: 1, shippingCompanyId: 11, rowVersion: 1, createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null },
      ],
      forecast: () =>
        forecastFixture({
          shipping: SHIPPING,
          warnings: [
            { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 11, count: 3, reason: 'account', companyId: 5, currencies: ['USD', 'EUR'] },
            { code: 'SHIP_UNMAPPED', shippingCompanyId: 12, count: 2, reason: 'company' },
            { code: 'NO_ANCHOR', accountId: 2 },
          ],
        }),
    });
    renderForecast();
    await expandGrid();
    const [noCompany, noAccount, notLinked] = await screen.findAllByTestId('ship-unmapped');

    expect(noCompany.textContent).toBe('SHIP_UNMAPPED1 stock payment has no company in shipping.');
    expect(within(noCompany).queryByRole('link')).toBeNull();

    await waitFor(() =>
      expect(noAccount.textContent).toContain(
        "3 stock payments (USD, EUR) for JFA have no account to land on: add an account in that currency, or mark one of JFA's accounts as default.",
      ),
    );
    expect(within(noAccount).getByRole('link', { name: 'Open Settings → Accounts' }).getAttribute('href')).toBe('/settings?tab=accounts');

    await waitFor(() =>
      expect(notLinked.textContent).toContain('2 stock payments belong to shipping company Hangerworld Ltd, which no JFlow company is linked to.'),
    );
    expect(within(notLinked).getByRole('link', { name: 'Link it in Settings' }).getAttribute('href')).toBe('/settings?tab=companies');
    // Other warnings still show in the general list.
    expect(screen.getByTestId('forecast-warnings').textContent).toContain('NO_ANCHOR');
  });

  it('sends an unresolved stock payment to the Stock payments screen', async () => {
    const res = forecastFixture({ unresolved: true });
    res.unresolved = [
      { key: 'ship.dep-500', kind: 'ship', name: 'Acme · PO-500 · deposit', categoryId: 90, accountId: 1, currency: 'USD', amountMinor: 90000, gbpMinor: 66600, direction: 'out', date: '2026-07-01', ageDays: 90, settleMode: 'manual' },
    ];
    stubApi({ forecast: () => res });
    renderForecast();
    await expandGrid();
    const banner = await screen.findByTestId('unresolved-banner');
    fireEvent.click(within(banner).getByRole('button', { name: 'Show them' }));
    expect(within(banner).getByRole('link', { name: 'Stock payments' }).getAttribute('href')).toBe('/stock-payments');
  });
});

describe('the shipping status line and Refresh now', () => {
  it('shows the last sync, open, undated with its £ total, and unmapped counts', async () => {
    stubApi({ forecast: () => forecastFixture({ shipping: SHIPPING }) });
    renderForecast();
    await expandGrid();
    const line = await screen.findByTestId('shipping-status-line');
    expect(line.textContent).toMatch(/^Last synced 29 Sep 2026, \d\d:\d\d · 12 open · 3 undated \(£4,500\.00\) · 2 unmapped$/);
  });

  it('says a feed that has never succeeded has never synced', async () => {
    stubApi({ forecast: () => forecastFixture({ shipping: null }) });
    renderForecast();
    await expandGrid();
    expect((await screen.findByTestId('shipping-status-line')).textContent).toBe('Never synced');
  });

  it('posts a refresh, then reads the forecast again', async () => {
    let n = 0;
    const calls = stubApi({
      forecast: () => {
        n += 1;
        return forecastFixture({ shipping: n === 1 ? null : SHIPPING });
      },
    });
    renderForecast();
    await expandGrid();
    const status = await screen.findByTestId('shipping-status');
    expect(within(status).getByTestId('shipping-status-line').textContent).toBe('Never synced');
    fireEvent.click(within(status).getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(screen.getByTestId('shipping-status-line').textContent).toContain('12 open'));
    const order = calls.map((c) => `${c.method} ${c.path.split('?')[0]}`).filter((c) => /forecast|refresh/.test(c));
    expect(order).toEqual(['GET /forecast', 'POST /external/refresh', 'GET /forecast']);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says so when another refresh was already running (ran: false), and still reads again', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ shipping: SHIPPING }), refresh: () => ({ ran: false, status: STATUS }) });
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh now' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/already running/);
    await waitFor(() => expect(forecastReads(calls)).toHaveLength(2));
  });

  it('shows a failed refresh (503 SHIPPING_UNAVAILABLE) with its reason and the snapshot still in use, and does not re-read', async () => {
    const calls = stubApi({
      forecast: () => forecastFixture({ shipping: SHIPPING }),
      refresh: () =>
        new ApiError(503, {
          error: 'The shipping feed could not be refreshed (timeout); the last snapshot is kept.',
          code: 'SHIPPING_UNAVAILABLE',
          details: { reason: 'timeout', lastSuccessAt: '2026-09-29T08:00:00Z' },
        }),
    });
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh now' }));
    const error = await screen.findByTestId('refresh-error');
    expect(error.textContent).toMatch(/Not refreshed: shipping did not answer in time\. The snapshot from 29 Sep 2026, \d\d:\d\d is still in use\./);
    expect(forecastReads(calls)).toHaveLength(1);
    // The button is usable again.
    expect((screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the SHIPPING_UNAVAILABLE banner', () => {
  it('shows the reason and the last successful sync', async () => {
    stubApi({
      forecast: () =>
        forecastFixture({
          ship: true,
          shipping: SHIPPING,
          warnings: [{ code: 'SHIPPING_UNAVAILABLE', reason: 'http_401', lastSuccessAt: '2026-09-28T12:00:00Z' }],
        }),
    });
    renderForecast();
    await expandGrid();
    const banner = await screen.findByTestId('shipping-unavailable');
    expect(banner.textContent).toMatch(/Stock payments could not be refreshed: shipping refused JFlow's key\. The forecast uses the snapshot from 28 Sep 2026, \d\d:\d\d\./);
    expect(banner.textContent).toContain('SHIPPING_UNAVAILABLE · http_401');
    // The forecast is still shown, built on the last snapshot.
    expect(screen.getByTestId('line-ship.dep-812')).toBeTruthy();
    expect(screen.queryByTestId('forecast-warnings')).toBeNull();
  });

  it('says there are no stock payments when the feed has never synced', async () => {
    stubApi({
      forecast: () => forecastFixture({ warnings: [{ code: 'SHIPPING_UNAVAILABLE', reason: 'unconfigured', lastSuccessAt: null }] }),
    });
    renderForecast();
    await expandGrid();
    const banner = await screen.findByTestId('shipping-unavailable');
    expect(banner.textContent).toContain('the shipping feed is not set up for this environment');
    expect(banner.textContent).toContain('The feed has never synced, so no stock payments are in the forecast.');
  });

  it('is absent when the refresh was fine', async () => {
    stubApi({ forecast: () => forecastFixture({ ship: true, shipping: SHIPPING }) });
    renderForecast();
    await expandGrid();
    await screen.findByTestId('forecast-grid');
    expect(screen.queryByTestId('shipping-unavailable')).toBeNull();
  });
});

describe('stock payments grouped by supplier + shipment (Dev, 2026-10-06)', () => {
  /** The fixture's two Acme lines plus a second Acme balance in the same container, flagged overdue. */
  const withSecondBalance = () => {
    const fx = forecastFixture({ ship: true, shipping: SHIPPING });
    const stock = fx.rows!.find((r) => r.categoryId === 90)!;
    const bal = stock.items.find((i) => i.key === 'ship.bal-812-s311')!;
    stock.items.push({
      ...bal, key: 'ship.bal-813-s311', id: 'bal-813-s311', name: 'Acme Textiles · PO-813 · balance',
      amountMinor: 50000, accountMinor: 50000, gbpMinor: 37000, flags: ['overdue'], ship: { ...bal.ship!, poNumber: 'PO-813' },
    });
    return fx;
  };

  it('opening the category shows one line per supplier + container with the summed figure; the payments open on a click, or with Expand all', async () => {
    stubApi({ forecast: withSecondBalance });
    renderForecast();
    const grid = await screen.findByTestId('forecast-grid');
    fireEvent.click(within(grid).getByRole('button', { name: /^Stock payments/ }));

    const combo = within(grid).getByTestId('combo-acme textiles|MSCU1234567');
    expect(combo.textContent).toContain('Acme Textiles');
    expect(combo.textContent).toContain('MSCU1234567 · 2 payments');
    expect(combo.textContent).toContain('£1,480.00');
    expect(within(combo).getByTestId('attention-combo:acme textiles|MSCU1234567').textContent).toContain('OVERDUE 1');
    expect(screen.queryByTestId('line-ship.bal-812-s311')).toBeNull();
    expect(screen.queryByTestId('line-ship.bal-813-s311')).toBeNull();

    const single = within(grid).getByTestId('combo-acme textiles|-');
    expect(single.textContent).toContain('No container · 1 payment');
    expect(single.textContent).toContain('£3,700.00');

    fireEvent.click(within(combo).getByRole('button', { name: /^Acme Textiles/ }));
    expect(screen.getByTestId('line-ship.bal-812-s311').textContent).toContain('Acme Textiles · PO-812 · balance');
    expect(screen.getByTestId('line-ship.bal-813-s311').textContent).toContain('PO-813');
    // Under its group the line does not repeat the container; the group already says it.
    expect(screen.getByTestId('line-ship.bal-812-s311').textContent).not.toContain('MSCU1234567');
    expect(screen.queryByTestId('attention-combo:acme textiles|MSCU1234567')).toBeNull();
    expect(screen.queryByTestId('line-ship.dep-812')).toBeNull();

    fireEvent.click(within(grid).getByRole('button', { name: 'Expand all' }));
    expect(screen.getByTestId('line-ship.dep-812')).toBeTruthy();
    fireEvent.click(within(grid).getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByTestId('combo-acme textiles|-')).toBeNull();
    expect(screen.queryByTestId('line-ship.dep-812')).toBeNull();
  });
});

describe('editing a ship line with no scenario open: the overlay', () => {
  const openDeposit = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · deposit/ }));
    // The dialog reads the row first: the form is a new dialog once it has arrived.
    await screen.findByLabelText('Amount');
    return screen.getByRole('dialog');
  };
  const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');

  it("reads the row on open, and shows shipping's date and amount next to the planned ones, with the note", async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/external-items/ship.dep-812')).toHaveLength(1);
    expect(within(dialog).getByTestId('ship-feed').textContent).toBe('Shipping says $5,000.00 on Fri 2 Oct 2026.');
    expect(within(dialog).getByTestId('ship-planned').textContent).toBe('JFlow uses $5,000.00 on Tue 6 Oct 2026 (pinned).');
    expect(dialog.textContent).toContain("The date is shipping's estimate.");
    expect((within(dialog).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-06');
    expect(within(dialog).getByTestId('ship-date-mode').textContent).toMatch(/^Pinned/);
    expect((within(dialog).getByLabelText('Amount') as HTMLInputElement).value).toBe('5000.00');
    expect((within(dialog).getByLabelText('Note') as HTMLInputElement).value).toBe('Factory holiday');
  });

  it('writes PUT /external-items/:key with only what changed and the row version, then reads the forecast again', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '4800' } });
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Agreed a discount' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)).toEqual([
      {
        method: 'PUT',
        path: '/external-items/ship.dep-812',
        body: { note: 'Agreed a discount', plannedAmount: '4800.00', baseVersion: 7 },
      },
    ]);
    await waitFor(() => expect(forecastReads(calls)).toHaveLength(2));
  });

  it('clears the existing note with null', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)[0].body).toEqual({ note: null, baseVersion: 7 });
  });

  it("\"Use shipping's\" date clears the pinned date, so the line follows shipping again", async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.click(within(dialog).getByRole('button', { name: "Use shipping's (2 Oct)" }));
    expect(within(dialog).getByTestId('ship-date-mode').textContent).toMatch(/^Follows shipping's date/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)[0].body).toEqual({ plannedDate: null, baseVersion: 7 });
  });

  it("pins a date equal to shipping's when the row already has a plan", async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-10-02' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)[0].body).toEqual({ plannedDate: '2026-10-02', baseVersion: 7 });
  });

  it("pins shipping's own date on a planned row that follows it", async () => {
    const calls = stubApi({
      forecast: () => forecastFixture({ ship: true }),
      row: (key) => (key === 'ship.bal-812-s311' ? externalRow({ plannedNote: 'Check with QC' }) : depositRow()),
    });
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · balance/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin 13 Oct' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('ship-date-mode').textContent).toMatch(/^Pinned/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)[0]).toEqual({
      method: 'PUT',
      path: '/external-items/ship.bal-812-s311',
      body: { plannedDate: '2026-10-13', baseVersion: 4 },
    });
  });

  it('skips a line', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.click(within(dialog).getByRole('switch', { name: /Skip it/ }));
    expect(within(dialog).queryByLabelText('Amount')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls)[0].body).toEqual({ skipped: true, baseVersion: 7 });
  });

  it('reverts to the feed with DELETE and the row version, offered only on a planned row', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · balance/ }));
    await screen.findByLabelText('Amount');
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Revert to feed' })).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Not now' }));

    const dialog = await openDeposit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revert to feed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.method === 'DELETE')).toEqual({
      method: 'DELETE',
      path: '/external-items/ship.dep-812',
      body: { baseVersion: 7 },
    });
    await waitFor(() => expect(forecastReads(calls)).toHaveLength(2));
  });

  it('refuses a planned date before today, and an amount that is not a DECIMAL above zero, before the click', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }) });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    const save = within(dialog).getByRole('button', { name: 'Save the plan' }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-09-28' } });
    expect(within(dialog).getByText('A planned date must be today or later.')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: TODAY } });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '0' } });
    expect(within(dialog).getByText('Must be more than zero.')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '12.345' } });
    expect(within(dialog).getByText('At most two decimal places.')).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(puts(calls)).toHaveLength(0);
  });

  it('on 409 STALE_WRITE, reads the row again and saves against the new version', async () => {
    let putCount = 0;
    const calls = stubApi({
      forecast: () => forecastFixture({ ship: true }),
      row: (_key, n) => (n <= 1 ? depositRow() : depositRow({ plannedNote: 'Moved again by Sam', rowVersion: 9 })),
      plan: () => {
        putCount += 1;
        return putCount === 1
          ? new ApiError(409, { error: 'Changed since you read it.', code: 'STALE_WRITE', details: { currentVersion: 9 } })
          : depositRow({ rowVersion: 10 });
      },
    });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '4800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    const refusal = await within(dialog).findByTestId('ship-refusal');
    expect(refusal.textContent).toContain('STALE_WRITE');
    expect(refusal.textContent).toMatch(/now version 9/);
    expect(within(refusal).queryByRole('button', { name: 'Close and reload' })).toBeNull();

    fireEvent.click(within(refusal).getByRole('button', { name: 'Load the latest' }));
    await waitFor(() =>
      expect((within(screen.getByRole('dialog')).getByLabelText('Note') as HTMLInputElement).value).toBe('Moved again by Sam'),
    );
    const fresh = screen.getByRole('dialog');
    // A fresh read is a fresh form: the typed amount is gone, the refusal too.
    expect((within(fresh).getByLabelText('Amount') as HTMLInputElement).value).toBe('5000.00');
    expect(within(fresh).queryByTestId('ship-refusal')).toBeNull();
    fireEvent.change(within(fresh).getByLabelText('Amount'), { target: { value: '4800' } });
    fireEvent.click(within(fresh).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts(calls).map((c) => c.body)).toEqual([
      { plannedAmount: '4800.00', baseVersion: 7 },
      { plannedAmount: '4800.00', baseVersion: 9 },
    ]);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/external-items/ship.dep-812')).toHaveLength(2);
  });

  it('says so when the row cannot be read on open (gone), with nothing to save', async () => {
    const calls = stubApi({
      forecast: () => forecastFixture({ ship: true }),
      row: () => new ApiError(404, { error: 'Target missing.', code: 'TARGET_MISSING', details: { key: 'ship.dep-812' } }),
    });
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · deposit/ }));
    const dialog = screen.getByRole('dialog');
    const error = await within(dialog).findByTestId('ship-load-error');
    expect(error.textContent).toMatch(/no longer lists this payment/);
    expect((within(dialog).getByRole('button', { name: 'Save the plan' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(error).getByRole('button', { name: 'Close and reload' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(forecastReads(calls)).toHaveLength(2));
  });

  it.each([
    [
      '404 TARGET_MISSING',
      new ApiError(404, { error: 'Target missing.', code: 'TARGET_MISSING', details: { key: 'ship.dep-812' } }),
      /no longer lists this payment/,
      true,
    ],
    [
      '409 TARGET_SETTLED',
      new ApiError(409, { error: 'Already paid.', code: 'TARGET_SETTLED', details: { key: 'ship.dep-812', status: 'paid' } }),
      /has been made/,
      true,
    ],
    [
      '422 PLANNED_DATE_IN_PAST',
      new ApiError(422, {
        error: 'Planned date in the past.',
        code: 'PLANNED_DATE_IN_PAST',
        details: { plannedDate: '2026-10-09', today: '2026-10-10' },
      }),
      /Fri 9 Oct 2026 is before today \(Sat 10 Oct 2026\)/,
      false,
    ],
  ])('shows a %s refusal in words, and keeps the dialog open', async (_label, error, text, reload) => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true }), plan: () => error });
    renderForecast();
    await expandGrid();
    const dialog = await openDeposit();
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '4800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    const refusal = await within(dialog).findByTestId('ship-refusal');
    expect(refusal.textContent).toContain(error.message);
    expect(refusal.textContent).toContain(String(error.code));
    expect(refusal.textContent).toMatch(text);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const closeAndReload = within(refusal).queryByRole('button', { name: 'Close and reload' });
    expect(closeAndReload !== null).toBe(reload);
    if (closeAndReload) {
      fireEvent.click(closeAndReload);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(forecastReads(calls)).toHaveLength(2));
    }
  });
});

describe("a date set by hand in ShipLine, in the dialogs", () => {
  const DUE_SET = { by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-10-01', scope: 'item', note: 'agreed with the supplier' };

  it("the plan dialog says who set shipping's date, in place of what, and tags the row", async () => {
    stubApi({ forecast: () => forecastFixture({ ship: true }), row: () => depositRow({ dueSet: DUE_SET, flags: ['due_set'], dateBasis: 'firm' }) });
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · deposit/ }));
    await screen.findByLabelText('Amount');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('ship-feed').textContent).toBe(
      "Shipping says $5,000.00 on Fri 2 Oct 2026 (set by hand by Ops on Tue 6 Oct 2026; shipping's derived date was Thu 1 Oct 2026).",
    );
    expect(dialog.textContent).toContain('Set by hand in shipping by Ops on Tue 6 Oct 2026, in place of Thu 1 Oct 2026 (this row only): “agreed with the supplier”.');
    expect(dialog.textContent).toContain('SET IN SHIPPING');
    expect(dialog.textContent).not.toContain("The date is shipping's estimate.");
  });

  it("the scenario edit dialog says the same from the line's ship block, and a moved date says where from", async () => {
    const fx = forecastFixture({ ship: true, scenario: true });
    const stock = fx.rows!.find((r) => r.categoryId === 90)!;
    const balance = stock.items.find((i) => i.key === 'ship.bal-812-s311')!;
    balance.flags = ['blocked', 'due_set', 'date_moved'];
    balance.ship = { ...balance.ship!, dueSet: DUE_SET, dateMovedFrom: '2026-10-01', dateMovedAt: '2026-10-06T09:30:00.000Z' };
    stubApi({ forecast: () => fx });
    renderForecast(createScenarioStore({ id: 9, name: 'Delay the rent' }));
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · balance/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('edit-ship-feed').textContent).toBe(
      "Shipping says $1,500.00 on Tue 13 Oct 2026 (set by hand by Ops on Tue 6 Oct 2026; shipping's derived date was Thu 1 Oct 2026).",
    );
    expect(dialog.textContent).toContain('Shipping moved this date from Thu 1 Oct 2026 on Tue 6 Oct 2026.');
    expect(dialog.textContent).toContain('DATE MOVED');
  });
});

describe('editing a ship line inside a scenario', () => {
  it('writes an adjustment like any other line, and still shows what shipping says', async () => {
    const calls = stubApi({ forecast: () => forecastFixture({ ship: true, scenario: true }) });
    renderForecast(createScenarioStore({ id: 9, name: 'Delay the rent' }));
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Acme Textiles · PO-812 · balance/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('edit-ship-feed').textContent).toBe('Shipping says $1,500.00 on Tue 13 Oct 2026.');
    expect(dialog.textContent).toContain('Waiting on artwork sign-off.');
    expect(dialog.textContent).toContain('The real stock payment does not change unless the scenario is applied.');
    fireEvent.click(within(dialog).getByRole('button', { name: /\+7 days/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/scenarios/9/adjustments/ship.bal-812-s311', body: { kind: 'adjust', newDate: '2026-10-20' } },
    ]);
    expect(calls.some((c) => c.path.startsWith('/external-items'))).toBe(false);
  });
});
