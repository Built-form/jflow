// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { ForecastResponse } from '../../api/forecast';
import { ScenarioBanner, ScenarioContext, createScenarioStore } from '../../app/ScenarioContext';
import type { ScenarioStore } from '../../app/ScenarioContext';
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
    if (method === 'PUT') return ok({});
    if (method === 'DELETE') return ok(undefined);
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

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
    // In and Out are closed too: no category shows, and Out says what is behind it.
    expect(within(grid).queryByTestId('category-3')).toBeNull();
    expect(within(grid).getByTestId('attention-out').textContent).toContain('OVERDUE 1');
    expect(within(grid).queryByTestId('attention-in')).toBeNull();
    fireEvent.click(within(grid).getByRole('button', { name: 'Out' }));
    expect(within(grid).queryByTestId('attention-out')).toBeNull();
    expect(within(grid).queryByTestId('category-1')).toBeNull();
    fireEvent.click(within(grid).getByRole('button', { name: 'In' }));
    expect(within(grid).getByTestId('category-1')).toBeTruthy();
    // Suppliers holds a REMAINDER and an OVERDUE line; Sales and Rent hold nothing to flag.
    const marker = within(grid).getByTestId('attention-3');
    expect(marker.textContent).toContain('REMAINDER 1');
    expect(marker.textContent).toContain('OVERDUE 1');
    expect(within(grid).queryByTestId('attention-1')).toBeNull();
    // Open, the lines wear their own tags, so the marker goes.
    fireEvent.click(within(within(grid).getByTestId('category-3')).getByRole('button'));
    expect(await screen.findByTestId('line-item.88')).toBeTruthy();
    expect(within(grid).queryByTestId('attention-3')).toBeNull();
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
    // Neither is editable (the server said so): no buttons in the row.
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
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
