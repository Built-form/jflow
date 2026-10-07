// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { ForecastResponse } from '../../api/forecast';
import { ScenarioBanner, ScenarioContext, createScenarioStore } from '../../app/ScenarioContext';
import type { ScenarioStore } from '../../app/ScenarioContext';
import { category } from '../items/testFixtures';
import { BalanceChart } from './BalanceChart';
import { ForecastScreen } from './ForecastScreen';
import { forecastFixture } from './fixtures';

afterEach(cleanup);

const stamp = '2026-09-29T08:00:00Z';
const list = (rows: unknown[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });
const accountRow = (id: number, name: string) => ({
  id, companyId: 1, name, currency: 'GBP', sortOrder: id, isActive: true, isDefault: false, rowVersion: 0,
  createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null,
});

type Call = { method: string; path: string; body: unknown };

/** The API as stubs: `/forecast` answers `answer()` (or throws it), writes answer `{}`. */
function stubApi(answer: () => ForecastResponse | ApiError) {
  const calls: Call[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    const ok = (v: unknown) => Promise.resolve(v as T);
    if (method === 'GET' && path.startsWith('/forecast')) {
      const a = answer();
      return a instanceof ApiError ? Promise.reject(a) : ok(a);
    }
    if (method === 'GET' && path.startsWith('/companies')) return ok(list([]));
    if (method === 'GET' && path.startsWith('/accounts')) return ok(list([accountRow(1, 'Barclays'), accountRow(2, 'Lloyds')]));
    if (method === 'GET' && path.startsWith('/categories')) return ok(list(CATEGORIES));
    if (method === 'GET' && path === '/scenarios/9') return ok(SCENARIO_DETAIL);
    if (method === 'PUT' || method === 'POST') return ok({});
    if (method === 'DELETE') return ok(undefined);
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

const CATEGORIES = [category(1, 'Sales', 'in'), category(2, 'Rent', 'out'), category(3, 'Suppliers', 'out')];

/** `GET /scenarios/9` for the `adds` fixture: the penalty's add carries a note the forecast line does not. */
const SCENARIO_DETAIL = {
  id: 9, name: 'Delay the rent', description: null, companyId: null, status: 'draft', appliedAt: null, appliedBy: null,
  adjustmentCount: 1, rowVersion: 3, createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null,
  adjustments: [
    {
      id: 23, scenarioId: 9, itemKey: 'new.23', targetKind: 'new', targetId: '23', targetDate: null, kind: 'add',
      newDate: '2026-10-13', newAmount: '75.00', baseDate: null, baseAmount: null, note: 'If the return is late',
      accountId: 1, categoryId: 3, direction: 'out', name: 'Late filing penalty', counterparty: 'HMRC', currency: 'GBP',
      splitGroup: null, rowVersion: 0, createdBy: null, createdAt: stamp, updatedAt: stamp, stale: null, current: null,
    },
  ],
};

function renderForecast(store: ScenarioStore = createScenarioStore(), path = '/forecast') {
  return render(
    <ScenarioContext.Provider value={store}>
      <MemoryRouter initialEntries={[path]}>
        <ScenarioBanner />
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

const forecastCalls = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/forecast'));

describe('Forecast', () => {
  it('asks for the grid, every company, week buckets — and draws one line without a scenario', async () => {
    const calls = stubApi(() => forecastFixture());
    renderForecast();
    await expandGrid();
    await screen.findByTestId('forecast-grid');
    const [call] = forecastCalls(calls);
    expect(call.path).toMatch(/companyId=all/);
    expect(call.path).toMatch(/bucket=week/);
    expect(call.path).toMatch(/include=grid/);
    expect(call.path).not.toMatch(/scenarioId/);
    expect(screen.getByTestId('chart-line-closing')).toBeTruthy();
    expect(screen.queryByTestId('chart-line-baseline')).toBeNull();
    expect(screen.queryByTestId('scenario-banner')).toBeNull();
  });

  it('counts the starting-point accounts in capitals throughout: 2 ACCOUNTS, not 2 ACCOUNTs', async () => {
    const two = forecastFixture();
    two.accounts = [...two.accounts, { ...two.accounts[0], accountId: 2, name: 'Lloyds' }];
    stubApi(() => two);
    renderForecast();
    await expandGrid();
    expect(await screen.findByText('STARTING POINT · 2 ACCOUNTS')).toBeTruthy();
  });

  it('takes the company from the URL', async () => {
    const calls = stubApi(() => forecastFixture());
    renderForecast(createScenarioStore(), '/forecast?company=2&bucket=month');
    await expandGrid();
    await screen.findByTestId('forecast-grid');
    expect(forecastCalls(calls)[0].path).toMatch(/companyId=2/);
    expect(forecastCalls(calls)[0].path).toMatch(/bucket=month/);
  });

  it('puts the Day / Week / Month toggle and the days picker side by side, below the chart and above the grid', async () => {
    stubApi(() => forecastFixture());
    renderForecast();
    await screen.findByTestId('forecast-grid');
    const chart = screen.getByRole('region', { name: 'Balance chart' });
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    const bucket = within(timeline).getByRole('group', { name: 'Bucket' });
    const grid = within(timeline).getByTestId('forecast-grid');
    // Chart, then the toggle, then the grid.
    expect(chart.compareDocumentPosition(bucket) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bucket.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bucket).getAllByRole('button').map((b) => b.textContent)).toEqual(['Day', 'Week', 'Month']);
    // The days picker and the date range sit in the same row, right after the toggle.
    const window = within(timeline).getByRole('group', { name: 'Window' });
    expect(bucket.parentElement).toBe(window.parentElement);
    expect(bucket.nextElementSibling).toBe(window);
    expect(within(bucket.parentElement as HTMLElement).getByText(/–/).textContent).toMatch(/\d{4}/);
    expect(window.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('flags negative cells: a closing below zero, and one whose bucket dips below zero', async () => {
    stubApi(() => forecastFixture());
    renderForecast();
    await expandGrid();
    const grid = await screen.findByTestId('forecast-grid');
    const closing = within(grid).getByRole('row', { name: /^Closing/ });
    const cells = within(closing).getAllByRole('cell');
    // Three buckets and the window total.
    expect(cells.map((c) => c.getAttribute('data-flag'))).toEqual(['negative', 'dips', 'negative', 'negative']);
    expect(cells[0].textContent).toContain('-£650.00');
    const opening = within(grid).getByRole('row', { name: /^Opening/ });
    expect(within(opening).getAllByRole('cell').map((c) => c.getAttribute('data-flag'))).toEqual([null, 'negative', null, null]);
    // The lowest point is marked on the chart and in the summary.
    expect(screen.getByTestId('chart-min')).toBeTruthy();
    expect(within(screen.getByTestId('summary')).getAllByLabelText('below zero').length).toBeGreaterThan(0);
  });

  it('opens with categories collapsed, and a collapsed category says which of its lines need attention', async () => {
    stubApi(() => forecastFixture());
    renderForecast();
    const grid = await screen.findByTestId('forecast-grid');
    expect(screen.queryByTestId('line-item.88')).toBeNull();
    // The categories are listed under the balance rows, each side under its own band.
    const order = Array.from(grid.querySelectorAll('tr[data-testid^="section-"], tr[data-testid^="category-"]')).map(
      (tr) => `${tr.getAttribute('data-testid')}:${tr.getAttribute('data-direction')}`,
    );
    expect(order[0]).toBe('section-in:in');
    expect(order.indexOf('section-out:out')).toBeGreaterThan(order.indexOf('category-1:in'));
    expect(order.slice(order.indexOf('section-out:out') + 1).every((o) => o.endsWith(':out'))).toBe(true);
    expect(within(grid).getByTestId('section-in').textContent).toBe('Money in');
    expect(within(grid).getByTestId('section-out').textContent).toBe('Money out');
    // Suppliers holds a REMAINDER and an OVERDUE line; Sales and Rent hold nothing to flag.
    const marker = within(grid).getByTestId('attention-3');
    expect(marker.textContent).toContain('REMAINDER 1');
    expect(marker.textContent).toContain('OVERDUE 1');
    expect(within(grid).queryByTestId('attention-1')).toBeNull();
    // Open, the lines wear their own tags, so the marker goes.
    fireEvent.click(within(within(grid).getByTestId('category-3')).getByRole('button', { expanded: false }));
    expect(await screen.findByTestId('line-item.88')).toBeTruthy();
    expect(within(grid).queryByTestId('attention-3')).toBeNull();
  });

  it('adds up the figures picked: a click on a total, Ctrl-click on a line (which does not edit it), Clear to start again', async () => {
    stubApi(() => forecastFixture());
    renderForecast();
    await expandGrid();
    const grid = await screen.findByTestId('forecast-grid');
    expect(screen.queryByTestId('sum-bar')).toBeNull();
    const minorOf = (el: Element) => BigInt(el.getAttribute('data-pick-minor') ?? '0');
    const pounds = (minor: bigint) => `£${(Number(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;

    // Two category totals on the Out side: one sum.
    const [first, second] = Array.from(grid.querySelectorAll('td[data-pick^="category:3:"], td[data-pick^="category:2:"]'));
    fireEvent.click(first);
    fireEvent.click(second);
    const bar = screen.getByTestId('sum-bar');
    expect(bar.textContent).toContain('2 figures');
    expect(bar.textContent).toContain(`Sum ${pounds(minorOf(first) + minorOf(second))}`);
    expect(first.getAttribute('data-picked')).toBe('true');
    // Clicking a picked figure again takes it out.
    fireEvent.click(second);
    expect(bar.textContent).toContain('1 figure');

    // A line: a plain click edits, Ctrl-click picks.
    const line = within(grid).getByRole('button', { name: /Edit Invoice 1041/ });
    fireEvent.click(line, { ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bar.textContent).toContain('2 figures');

    // A total already holds what is under it, so the two are never picked together: Out
    // lets go of a picked category of its own, its Window figure of a picked bucket — and a
    // figure picked under a picked total lets go of the total.
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    const out = grid.querySelector('td[data-pick^="side:out:"]:not([data-pick$=":window"])') as Element;
    const col = (out.getAttribute('data-pick') as string).split(':')[2];
    const part = grid.querySelector(`td[data-pick^="category:"][data-pick$=":${col}"][data-pick-direction="out"]`) as Element;
    fireEvent.click(part);
    fireEvent.click(out);
    const again = screen.getByTestId('sum-bar');
    expect(again.textContent).toContain('1 figure');
    expect(again.textContent).toContain(`Sum ${pounds(minorOf(out))}`);
    expect(part.getAttribute('data-picked')).toBeNull();
    expect(out.getAttribute('data-picked')).toBe('true');
    const outWindow = grid.querySelector('td[data-pick="side:out:window"]') as Element;
    fireEvent.click(outWindow);
    expect(again.textContent).toContain(`1 figure`);
    expect(again.textContent).toContain(`Sum ${pounds(minorOf(outWindow))}`);
    expect(out.getAttribute('data-picked')).toBeNull();
    // A child under the picked total: it is picked, and the total is let go.
    fireEvent.click(part);
    expect(part.getAttribute('data-picked')).toBe('true');
    expect(outWindow.getAttribute('data-picked')).toBeNull();
    expect(again.textContent).toContain(`Sum ${pounds(minorOf(part))}`);
    fireEvent.click(within(again).getByRole('button', { name: 'Clear' }));
    fireEvent.click(first);
    fireEvent.click(line, { ctrlKey: true });

    // Money in with money out reads as in, out and the net.
    fireEvent.click(grid.querySelector('td[data-pick="side:in:window"]') as Element);
    expect(screen.getByTestId('sum-bar').textContent).toMatch(/In £.*Out £.*Net [+-]?£/);

    fireEvent.click(within(screen.getByTestId('sum-bar')).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('sum-bar')).toBeNull();
  });

  it('hides a row or a category with its eye: re-reads without it, says what went, and shows everything again', async () => {
    let calls: Call[] = [];
    calls = stubApi(() => {
      const res = forecastFixture();
      if (/hide/.test(calls[calls.length - 1].path)) {
        res.hidden = { count: 1, inflow: 0, outflow: 50000, fullSummary: { ...res.summary, closing: res.summary.closing - 50000 } };
        res.days = res.days.map((d) => ({ ...d, fullClosing: d.closing - 50000 }));
      }
      return res;
    });
    const lastPath = () => decodeURIComponent(forecastCalls(calls).slice(-1)[0].path);
    renderForecast();
    await expandGrid();
    const grid = await screen.findByTestId('forecast-grid');
    expect(screen.queryByTestId('hidden-panel')).toBeNull();
    expect(lastPath()).not.toMatch(/hide/);

    // A line: its key goes in `hide`, and the answer's `hidden` block is what the panel says.
    const eye = () => within(within(grid).getByTestId('line-item.88')).getByRole('button', { name: /forecast|hidden/ });
    expect(eye().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(eye());
    await waitFor(() => expect(lastPath()).toMatch(/[?&]hide=item\.88(&|$)/));
    const panel = await screen.findByTestId('hidden-panel');
    await waitFor(() => expect(panel.textContent).toContain('1 line hidden: £500.00 out'));
    expect(panel.textContent).toContain('Nothing is changed or saved.');
    expect(eye().getAttribute('aria-pressed')).toBe('true');
    // The chart compares with everything shown.
    expect(screen.getByTestId('chart-line-baseline')).toBeTruthy();
    expect(screen.getByTestId('chart-legend').textContent).toContain('With everything');

    // A category: one id, and its rows are hidden with it.
    fireEvent.click(within(within(grid).getByTestId('category-3')).getByRole('button', { name: /^Hide / }));
    await waitFor(() => expect(lastPath()).toMatch(/hideCategories=3(&|$)/));
    expect(lastPath()).toMatch(/[?&]hide=item\.88(&|$)/);
    expect((eye() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hidden-panel').textContent).toContain('1 category and 1 line hidden');

    fireEvent.click(within(screen.getByTestId('hidden-panel')).getByRole('button', { name: 'Show everything' }));
    await waitFor(() => expect(lastPath()).not.toMatch(/hide/));
    expect(screen.queryByTestId('hidden-panel')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('chart-line-baseline')).toBeNull());
  });

  it('renders every line of a key that appears several times — the payment and the remainder', async () => {
    stubApi(() => forecastFixture());
    renderForecast();
    await expandGrid();
    const row = await screen.findByTestId('line-item.77');
    // One row for the key, both lines in it, in their own buckets.
    const cells = within(row).getAllByRole('cell');
    expect(cells[0].textContent).toContain('£400.00');
    expect(cells[0].textContent).toContain('PART PAID');
    expect(cells[2].textContent).toContain('£600.00');
    expect(cells[2].textContent).toContain('REMAINDER');
    expect(row.querySelectorAll('[data-line="item.77"]')).toHaveLength(2);
    // Neither is editable (the server said so): the row's only button is its eye.
    expect(within(row).queryAllByRole('button').map((b) => b.className)).toEqual(['ledger-eye']);
    // Overdue comes from the flag, and that line is editable.
    const late = screen.getByTestId('line-item.88');
    expect(within(late).getByRole('button', { name: /Edit Late courier invoice/ }).textContent).toContain('OVERDUE');
  });

  it('shows the unresolved banner from the summary, listing unresolved[]', async () => {
    stubApi(() => forecastFixture({ unresolved: true }));
    renderForecast();
    await expandGrid();
    const banner = await screen.findByTestId('unresolved-banner');
    expect(banner.textContent).toContain('2 lines');
    expect(banner.textContent).toContain('£830.00');
    fireEvent.click(within(banner).getByRole('button', { name: 'Show them' }));
    expect(banner.textContent).toContain('Old VAT query');
    expect(banner.textContent).toContain('90 days ago');
    expect(banner.textContent).toContain('Lloyds');
  });

  it('shows warnings[] in words', async () => {
    stubApi(() =>
      forecastFixture({
        warnings: [
          { code: 'NO_ANCHOR', accountId: 2 },
          { code: 'ORPHAN_OVERRIDE', scheduleId: 45, naturalDate: '2026-09-15', overrideId: 3 },
        ],
      }),
    );
    renderForecast();
    await expandGrid();
    const warnings = await screen.findByTestId('forecast-warnings');
    await waitFor(() => expect(warnings.textContent).toContain('Lloyds has no recorded balance'));
    expect(warnings.textContent).toContain('Schedule #45');
    expect(warnings.textContent).toContain('Tue 15 Sep 2026');
  });

  it('says which rate is missing when the forecast is refused with FX_RATE_MISSING', async () => {
    stubApi(() => new ApiError(422, { error: 'No FX rate.', code: 'FX_RATE_MISSING', details: { currencies: ['EUR', 'USD'] } }));
    renderForecast();
    const note = await screen.findByTestId('fx-missing');
    expect(note.textContent).toContain('EUR, USD');
    expect(within(note).getByRole('link', { name: /Add the rate in Settings/ }).getAttribute('href')).toBe('/settings?tab=fx');
  });

  it('with no scenario, an edit changes the real one-off and the forecast is read again', async () => {
    const calls = stubApi(() => forecastFixture());
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Invoice 1041/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /\+7 days/ }));
    expect((within(dialog).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-10-13');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change the item' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/items/10', body: { dueDate: '2026-10-13' } },
    ]);
    await waitFor(() => expect(forecastCalls(calls)).toHaveLength(2));
  });

  it('with no scenario, an instance is tuned by its schedule id and natural date', async () => {
    const calls = stubApi(() => forecastFixture());
    renderForecast();
    await expandGrid();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Office rent/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '1250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change the instance' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/schedules/45/instances/2026-10-01',
      body: { amount: '1250.00' },
    });
  });

  describe('with a scenario open', () => {
    const openStore = () => createScenarioStore({ id: 9, name: 'Delay the rent' });

    it('draws the scenario and the baseline, shows the banner, and the delta row', async () => {
      const calls = stubApi(() => forecastFixture({ scenario: true }));
      renderForecast(openStore());
      await expandGrid();
      await screen.findByTestId('forecast-grid');
      expect(forecastCalls(calls)[0].path).toMatch(/scenarioId=9/);
      expect(screen.getByTestId('chart-line-scenario')).toBeTruthy();
      expect(screen.getByTestId('chart-line-baseline')).toBeTruthy();
      expect(screen.getByTestId('chart-legend').textContent).toContain('Baseline');
      expect(screen.getByTestId('scenario-banner').textContent).toContain('Delay the rent');
      expect(screen.getAllByTestId('delta-cell').map((c) => c.textContent)).toEqual(['+£300.00', '+£300.00', '+£300.00']);
      // The scenario's stale warning, with its reason in words.
      expect(screen.getByTestId('scenario-warnings').textContent).toContain('STALE · SETTLED');
    });

    it('writes an adjustment instead of real data — the whole change against the baseline', async () => {
      const calls = stubApi(() => forecastFixture({ scenario: true }));
      renderForecast(openStore());
      await expandGrid();
      fireEvent.click(await screen.findByRole('button', { name: /Edit Office rent/ }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('edit-baseline').textContent).toContain('Thu 24 Sep 2026');
      fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '1300' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls.filter((c) => c.method === 'PUT')).toEqual([
        {
          method: 'PUT',
          path: '/scenarios/9/adjustments/sched.45.2026-10-01',
          body: { kind: 'adjust', newDate: '2026-10-01', newAmount: '1300.00' },
        },
      ]);
    });

    it('refuses a date before today in the dialog, and shows the server refusal when one comes', async () => {
      stubApi(() => forecastFixture({ scenario: true }));
      renderForecast(openStore());
      await expandGrid();
      fireEvent.click(await screen.findByRole('button', { name: /Edit Invoice 1041/ }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-09-28' } });
      expect(within(dialog).getByRole('alert').textContent).toBe('A scenario cannot move a line to before today.');
      expect((within(dialog).getByRole('button', { name: 'Save to scenario' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('closes from the banner and goes back to the real plan', async () => {
      const store = openStore();
      const calls = stubApi(() => forecastFixture({ scenario: store.get() !== null }));
      renderForecast(store);
      await expandGrid();
      await screen.findByTestId('chart-line-scenario');
      fireEvent.click(screen.getByRole('button', { name: 'Close scenario' }));
      await screen.findByTestId('chart-line-closing');
      expect(store.get()).toBeNull();
      expect(forecastCalls(calls).at(-1)?.path).not.toMatch(/scenarioId/);
    });

    it('offers "Add a one-off…" only on a draft, and posts the add from its dialog (D39)', async () => {
      const calls = stubApi(() => forecastFixture({ scenario: true }));
      renderForecast(openStore());
      const panel = await screen.findByTestId('forecast-scenario');
      fireEvent.click(within(panel).getByRole('button', { name: 'Add a one-off…' }));

      const dialog = screen.getByRole('dialog', { name: 'Add a one-off to this scenario' });
      expect(dialog.textContent).toContain('SCENARIO · DELAY THE RENT');
      expect(dialog.textContent).toContain('It exists only in this scenario. Apply writes it to the real plan as a new one-off.');
      const add = within(dialog).getByRole('button', { name: 'Add to scenario' }) as HTMLButtonElement;
      expect(add.disabled).toBe(true);
      // The first active account, money out, today.
      expect((within(dialog).getByLabelText('Account') as HTMLSelectElement).value).toBe('1');
      expect((within(dialog).getByLabelText('Currency') as HTMLInputElement).value).toBe('GBP');
      expect((within(dialog).getByLabelText('Date') as HTMLInputElement).value).toBe('2026-09-29');
      // Money out offers the money-out categories only.
      await waitFor(() => expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toContain('Suppliers'));
      expect(within(dialog).queryByRole('option', { name: 'Sales' })).toBeNull();

      fireEvent.change(within(dialog).getByLabelText('Category'), { target: { value: '3' } });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Late filing penalty' } });
      fireEvent.change(within(dialog).getByLabelText('Counterparty'), { target: { value: 'HMRC' } });
      fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '75' } });
      fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-09-28' } });
      expect(within(dialog).getByRole('alert').textContent).toBe('Today or later: a scenario cannot add a one-off in the past.');
      expect(add.disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-10-13' } });
      fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'If the return is late' } });
      fireEvent.click(add);

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls.filter((c) => c.method === 'POST')).toEqual([
        {
          method: 'POST',
          path: '/scenarios/9/adjustments',
          body: {
            kind: 'add',
            accountId: 1,
            categoryId: 3,
            direction: 'out',
            name: 'Late filing penalty',
            counterparty: 'HMRC',
            newDate: '2026-10-13',
            newAmount: '75.00',
            currency: 'GBP',
            note: 'If the return is late',
          },
        },
      ]);
      await waitFor(() => expect(forecastCalls(calls)).toHaveLength(2));
    });

    it('offers no "Add a one-off…" on a scenario that is not a draft', async () => {
      stubApi(() => {
        const res = forecastFixture({ scenario: true });
        if (res.scenario) res.scenario.status = 'applied';
        return res;
      });
      renderForecast(openStore());
      const panel = await screen.findByTestId('forecast-scenario');
      expect(within(panel).queryByRole('button', { name: 'Add a one-off…' })).toBeNull();
    });

    it('splits a line into parts from its edit dialog, and posts them to …/split (D40)', async () => {
      const calls = stubApi(() => forecastFixture({ scenario: true }));
      renderForecast(openStore());
      await expandGrid();
      fireEvent.click(await screen.findByRole('button', { name: /Edit Invoice 1041/ }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Split into parts…' }));

      const dialog = screen.getByRole('dialog', { name: 'Split Invoice 1041' });
      expect(dialog.textContent).toContain('The line becomes part 1; each further part is a new one-off in this scenario');
      expect(within(dialog).getByTestId('split-base').textContent).toBe('£1,000.00');
      expect(within(dialog).getByTestId('split-left').textContent).toBe('£0.00');
      expect((within(dialog).getByLabelText('Part 1 amount') as HTMLInputElement).value).toBe('500.00');
      expect((within(dialog).getByLabelText('Part 2 date') as HTMLInputElement).value).toBe('2026-11-05');
      const confirm = within(dialog).getByRole('button', { name: 'Split it' }) as HTMLButtonElement;

      // A third part at zero holds the split back until the money is shared out again.
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add a part' }));
      expect((within(dialog).getByLabelText('Part 3 date') as HTMLInputElement).value).toBe('2026-12-05');
      expect(confirm.disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText('Part 2 amount'), { target: { value: '300' } });
      expect(within(dialog).getByTestId('split-left').textContent).toBe('£200.00');
      expect(within(dialog).getByTestId('split-error').textContent).toBe('The parts must add up to £1,000.00.');
      fireEvent.change(within(dialog).getByLabelText('Part 3 amount'), { target: { value: '200' } });
      expect(within(dialog).getByTestId('split-left').textContent).toBe('£0.00');
      expect(confirm.disabled).toBe(false);
      fireEvent.click(confirm);

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls.filter((c) => c.method === 'POST')).toEqual([
        {
          method: 'POST',
          path: '/scenarios/9/adjustments/item.10/split',
          body: {
            parts: [
              { newDate: '2026-10-06', newAmount: '500.00' },
              { newDate: '2026-11-05', newAmount: '300.00' },
              { newDate: '2026-12-05', newAmount: '200.00' },
            ],
          },
        },
      ]);
      await waitFor(() => expect(forecastCalls(calls)).toHaveLength(2));
    });

    it("shows a split's refusal in the line's currency", async () => {
      __setTestTransport(<T,>(method: string, path: string): Promise<T> => {
        if (method === 'GET' && path.startsWith('/forecast')) return Promise.resolve(forecastFixture({ scenario: true }) as T);
        if (method === 'GET') return Promise.resolve(list([]) as T);
        return Promise.reject(
          new ApiError(422, { error: 'The parts do not add up.', code: 'SPLIT_AMOUNTS_MISMATCH', details: { total: '1000.00', expected: '1100.00' } }),
        );
      });
      renderForecast(openStore());
      await expandGrid();
      fireEvent.click(await screen.findByRole('button', { name: /Edit Invoice 1041/ }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Split into parts…' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Split it' }));
      expect((await screen.findByTestId('refusal-lines')).textContent).toContain('The parts add up to £1,000.00, but the line is £1,100.00.');
    });

    it("a scenario's own one-off: only in this scenario, nothing to leave out, and an edit sends the add whole, note kept", async () => {
      const calls = stubApi(() => forecastFixture({ scenario: true, adds: true }));
      renderForecast(openStore());
      await expandGrid();
      fireEvent.click(await screen.findByRole('button', { name: /Edit Late filing penalty/ }));
      const dialog = screen.getByRole('dialog', { name: 'Late filing penalty' });
      expect(await within(dialog).findByText(/Note: If the return is late/)).toBeTruthy();
      expect(within(dialog).getByTestId('edit-new').textContent).toContain('Only in this scenario.');
      expect(within(dialog).queryByTestId('edit-baseline')).toBeNull();
      expect(within(dialog).queryByRole('switch', { name: /Leave it out/ })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Split into parts…' })).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Remove it from the scenario' })).toBeTruthy();

      fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '90' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls.filter((c) => c.method === 'PUT')).toEqual([
        {
          method: 'PUT',
          path: '/scenarios/9/adjustments/new.23',
          body: {
            kind: 'add',
            accountId: 1,
            categoryId: 3,
            direction: 'out',
            name: 'Late filing penalty',
            counterparty: 'HMRC',
            currency: 'GBP',
            newDate: '2026-10-13',
            newAmount: '90.00',
            note: 'If the return is late',
          },
        },
      ]);
    });

    it("a split's anchor undoes the whole split; a part removes itself alone", async () => {
      const calls = stubApi(() => forecastFixture({ scenario: true, adds: true }));
      renderForecast(openStore());
      await expandGrid();

      fireEvent.click(await screen.findByRole('button', { name: /Edit Invoice 1041, £600\.00/ }));
      let dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('edit-baseline').textContent).toContain('split into parts');
      expect(dialog.textContent).toContain('Removes its parts too.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Undo the split' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      fireEvent.click(await screen.findByRole('button', { name: /Edit Invoice 1041, £400\.00/ }));
      dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('edit-new').textContent).toBe('Only in this scenario. Part of a split.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove this part' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
        '/scenarios/9/adjustments/item.10',
        '/scenarios/9/adjustments/new.22',
      ]);
    });
  });

  it('offers no "Add a one-off…" without a scenario open', async () => {
    stubApi(() => forecastFixture());
    renderForecast();
    await screen.findByTestId('forecast-grid');
    expect(screen.queryByRole('button', { name: 'Add a one-off…' })).toBeNull();
  });
});

describe('BalanceChart', () => {
  it('draws both lines when a scenario is open, and one when not', () => {
    const { days } = forecastFixture({ scenario: true });
    const { rerender } = render(<BalanceChart days={days} withBaseline minDate="2026-10-01" />);
    const scenarioPath = screen.getByTestId('chart-line-scenario').getAttribute('d') ?? '';
    const baselinePath = screen.getByTestId('chart-line-baseline').getAttribute('d') ?? '';
    expect(scenarioPath.split(' ')).toHaveLength(days.length);
    expect(baselinePath.split(' ')).toHaveLength(days.length);
    expect(baselinePath).not.toBe(scenarioPath);
    expect(screen.getByTestId('chart-below-zero')).toBeTruthy();
    rerender(<BalanceChart days={forecastFixture().days} withBaseline={false} />);
    expect(screen.getByTestId('chart-line-closing')).toBeTruthy();
    expect(screen.queryByTestId('chart-line-baseline')).toBeNull();
    expect(screen.queryByTestId('chart-legend')).toBeNull();
  });
});
