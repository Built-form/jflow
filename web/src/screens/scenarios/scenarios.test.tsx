// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { StaleReason } from '../../api/forecast';
import type { Adjustment, Scenario, ScenarioDetail } from '../../api/scenarios';
import { ScenarioContext, createScenarioStore } from '../../app/ScenarioContext';
import type { ScenarioStore } from '../../app/ScenarioContext';
import { forecastFixture } from '../forecast/fixtures';
import { ScenarioScreen, StaleMarker } from './ScenarioScreen';
import { ScenariosScreen } from './ScenariosScreen';
import { STALE_REASONS } from './stale';

afterEach(cleanup);

const stamp = '2026-09-29T08:00:00Z';
const list = (rows: unknown[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });

function scenarioRow(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 9, name: 'Delay the rent', description: null, companyId: null, status: 'draft', appliedAt: null, appliedBy: null,
    adjustmentCount: 2, rowVersion: 3, createdBy: 'dev@built-form.co.uk', createdAt: stamp, updatedAt: stamp, deletedAt: null,
    ...overrides,
  };
}

function adjustment(id: number, itemKey: string, overrides: Partial<Adjustment> = {}): Adjustment {
  return {
    id, scenarioId: 9, itemKey, targetKind: itemKey.startsWith('sched.') ? 'sched' : 'item', targetId: '10', targetDate: null,
    kind: 'adjust', newDate: '2026-10-13', newAmount: null, baseDate: '2026-10-06', baseAmount: '1000.00', note: null,
    rowVersion: 0, createdBy: 'dev@built-form.co.uk', createdAt: stamp, updatedAt: stamp,
    stale: null, current: { date: '2026-10-06', amount: '1000.00', status: 'expected' },
    ...overrides,
  };
}

type Call = { method: string; path: string; body: unknown };
type Handler = (call: Call) => unknown;

/** Reads answer from `detail`; `handle` answers everything else (or throws an ApiError). */
function stubApi(detail: () => ScenarioDetail, handle: Handler = () => undefined) {
  const calls: Call[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const call = { method, path, body };
    calls.push(call);
    try {
      const custom = handle(call);
      if (custom !== undefined) return Promise.resolve(custom as T);
    } catch (e) {
      return Promise.reject(e);
    }
    const ok = (v: unknown) => Promise.resolve(v as T);
    if (method === 'GET' && path === '/scenarios/9') return ok(detail());
    if (method === 'GET' && path.startsWith('/forecast')) return ok(forecastFixture({ scenario: true }));
    if (method === 'GET' && path.startsWith('/companies')) return ok(list([]));
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

function renderDetail(store: ScenarioStore = createScenarioStore()) {
  return render(
    <ScenarioContext.Provider value={store}>
      <MemoryRouter initialEntries={['/scenarios/9']}>
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioScreen />} />
          <Route path="/scenarios" element={<div>the list</div>} />
          <Route path="/forecast" element={<div>the forecast</div>} />
        </Routes>
      </MemoryRouter>
    </ScenarioContext.Provider>,
  );
}

const REASONS = Object.keys(STALE_REASONS) as StaleReason[];

describe('stale markers', () => {
  it.each(REASONS)('%s shows its word, what happened and the fix', (reason) => {
    render(<StaleMarker reason={reason} />);
    const marker = screen.getByTestId('stale-marker');
    expect(marker.getAttribute('data-reason')).toBe(reason);
    expect(marker.textContent).toContain(`STALE · ${STALE_REASONS[reason].label}`);
    expect(marker.textContent).toContain(STALE_REASONS[reason].text);
    expect(marker.textContent).toContain(STALE_REASONS[reason].fix);
  });

  it('names each of the four reasons differently, and says rebase fixes only BASE_CHANGED', () => {
    expect(REASONS.sort()).toEqual(['BASE_CHANGED', 'DATE_PASSED', 'TARGET_MISSING', 'TARGET_SETTLED']);
    expect(REASONS.map((r) => STALE_REASONS[r].label)).toEqual(['BASE CHANGED', 'DATE PASSED', 'MISSING', 'SETTLED']);
    expect(REASONS.filter((r) => STALE_REASONS[r].rebaseFixes)).toEqual(['BASE_CHANGED']);
  });

  it('marks each adjustment on the scenario with its own reason', async () => {
    const detail = {
      ...scenarioRow({ adjustmentCount: 5 }),
      adjustments: [
        adjustment(1, 'item.10', { stale: 'BASE_CHANGED', current: { date: '2026-10-08', amount: '1000.00', status: 'expected' } }),
        adjustment(2, 'item.20', { stale: 'TARGET_SETTLED', current: { date: '2026-10-06', amount: '1000.00', status: 'paid' } }),
        adjustment(3, 'item.30', { stale: 'TARGET_MISSING', current: null }),
        adjustment(4, 'sched.45.2026-10-01', { stale: 'DATE_PASSED', newDate: '2026-09-20' }),
        adjustment(5, 'item.88', { kind: 'exclude', newDate: null }),
      ],
    };
    stubApi(() => detail);
    renderDetail();
    await screen.findByTestId('adjustment-item.10');
    const reasonOf = (key: string) =>
      within(screen.getByTestId(`adjustment-${key}`)).queryByTestId('stale-marker')?.getAttribute('data-reason') ?? null;
    expect(reasonOf('item.10')).toBe('BASE_CHANGED');
    expect(reasonOf('item.20')).toBe('TARGET_SETTLED');
    expect(reasonOf('item.30')).toBe('TARGET_MISSING');
    expect(reasonOf('sched.45.2026-10-01')).toBe('DATE_PASSED');
    expect(reasonOf('item.88')).toBeNull();
    expect(screen.getByTestId('adjustment-item.88').textContent).toContain('UP TO DATE');
    expect(screen.getByTestId('adjustment-item.88').textContent).toContain('LEFT OUT');
    expect(screen.getByTestId('stale-count').textContent).toContain('4 stale adjustments');
    // Names come from the forecast's lines once it answers.
    await waitFor(() => expect(screen.getByTestId('adjustment-sched.45.2026-10-01').textContent).toContain('Office rent'));
  });

  it("names and prices a target outside the forecast window from the server's `current` (§6.11)", async () => {
    // July 2027 is past the screen's 90-day forecast, so the forecast has no line for it.
    const detail = {
      ...scenarioRow({ adjustmentCount: 1 }),
      adjustments: [
        adjustment(1, 'sched.1.2027-07-01', {
          newDate: '2027-08-20', baseDate: '2027-07-01', baseAmount: '1024.00',
          current: { date: '2027-07-01', amount: '1024.00', status: 'expected', name: 'Hold-back rent', currency: 'GBP' },
        }),
      ],
    };
    stubApi(() => detail);
    renderDetail();
    const row = await screen.findByTestId('adjustment-sched.1.2027-07-01');
    await waitFor(() => expect(row.textContent).toContain('Hold-back rent'));
    expect(row.textContent).toContain('£1,024.00');
    expect(row.textContent).not.toContain('Schedule instance');
  });
});

describe('apply', () => {
  const detail = () => ({ ...scenarioRow(), adjustments: [adjustment(1, 'item.10'), adjustment(2, 'sched.45.2026-10-01')] });

  it('surfaces SCENARIO_STALE: every key and its reason, and that nothing was written', async () => {
    const calls = stubApi(detail, ({ method, path }) => {
      if (method === 'POST' && path === '/scenarios/9/apply') {
        throw new ApiError(409, {
          error: 'The scenario has stale adjustments.',
          code: 'SCENARIO_STALE',
          details: {
            stale: [
              { itemKey: 'item.10', reason: 'BASE_CHANGED' },
              { itemKey: 'sched.45.2026-10-01', reason: 'DATE_PASSED' },
            ],
          },
        });
      }
      return undefined;
    });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    // Wait for the names the forecast gives the keys.
    await screen.findByTestId('delta-table');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply it' }));

    const lines = await screen.findByTestId('refusal-lines');
    expect(lines.textContent).toContain('Nothing was applied');
    expect(lines.textContent).toContain('BASE CHANGED');
    expect(lines.textContent).toContain('Invoice 1041 (item.10)');
    expect(lines.textContent).toContain('DATE PASSED');
    expect(lines.textContent).toContain('Office rent (sched.45.2026-10-01)');
    expect(screen.getByRole('dialog').textContent).toContain('SCENARIO_STALE');
    // Sent with the version it read; the dialog stays open; the markers are read again.
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ baseVersion: 3 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/scenarios/9')).toHaveLength(2));
  });

  it('on success, says what was written and closes the scenario if it was open', async () => {
    let applied = false;
    const store = createScenarioStore({ id: 9, name: 'Delay the rent' });
    stubApi(
      () => (applied ? { ...scenarioRow({ status: 'applied', appliedAt: stamp, appliedBy: 'dev@built-form.co.uk' }), adjustments: [] } : detail()),
      ({ method, path }) => {
        if (method === 'POST' && path === '/scenarios/9/apply') {
          applied = true;
          return {
            scenario: scenarioRow({ status: 'applied', rowVersion: 4 }),
            applied: [
              { itemKey: 'item.10', kind: 'adjust', wrote: 'cash_item', entityId: 10 },
              { itemKey: 'sched.45.2026-10-01', kind: 'adjust', wrote: 'schedule_override', entityId: 3 },
            ],
          };
        }
        return undefined;
      },
    );
    renderDetail(store);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply it' }));
    expect((await screen.findByRole('status')).textContent).toContain('2 changes written to the real plan (1 item, 1 instance)');
    expect(store.get()).toBeNull();
    expect(await screen.findByTestId('not-draft')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply…' })).toBeNull();
  });
});

describe('a scenario that is not a draft', () => {
  it('says so, offers no rebase or apply, and asks for no comparison', async () => {
    const calls = stubApi(() => ({
      ...scenarioRow({ status: 'applied', appliedAt: stamp, appliedBy: 'dev@built-form.co.uk' }),
      adjustments: [adjustment(1, 'item.10', { stale: null, current: null })],
    }));
    renderDetail();
    const note = await screen.findByTestId('not-draft');
    expect(note.textContent).toContain('Only a draft takes adjustments, a rebase or an apply');
    expect(screen.queryByRole('button', { name: 'Rebase…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply…' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove the adjustment/ })).toBeNull();
    expect(screen.getByTestId('adjustment-item.10').textContent).toContain('history');
    expect(calls.some((c) => c.path.startsWith('/forecast'))).toBe(false);
  });

  it('surfaces SCENARIO_NOT_DRAFT when the server says it changed under us', async () => {
    stubApi(
      () => ({ ...scenarioRow(), adjustments: [adjustment(1, 'item.10')] }),
      ({ method }) => {
        if (method === 'DELETE') {
          throw new ApiError(409, { error: 'The scenario is not a draft.', code: 'SCENARIO_NOT_DRAFT', details: { status: 'applied' } });
        }
        return undefined;
      },
    );
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the adjustment to item.10' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove it' }));
    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toContain('SCENARIO_NOT_DRAFT');
  });
});

describe('rebase', () => {
  it('sends dropStale, keeps what was not dropped, and says what happened', async () => {
    const calls = stubApi(
      () => ({
        ...scenarioRow(),
        adjustments: [adjustment(1, 'item.10', { stale: 'BASE_CHANGED' }), adjustment(2, 'item.30', { stale: 'TARGET_MISSING' })],
      }),
      ({ method, path }) =>
        method === 'POST' && path === '/scenarios/9/rebase'
          ? {
              scenario: scenarioRow({ rowVersion: 4 }),
              adjustments: [
                { ...adjustment(1, 'item.10', { baseDate: '2026-10-08' }), rebased: true, dropped: false, stale: null },
                { ...adjustment(2, 'item.30'), rebased: false, dropped: true, stale: 'TARGET_MISSING' },
              ],
            }
          : undefined,
    );
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Rebase…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('switch', { name: /Drop what can't be rebased/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebase and drop' }));
    expect((await screen.findByRole('status')).textContent).toContain('Rebased 1 adjustment, dropped 1.');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ dropStale: true });
    expect(screen.queryByTestId('adjustment-item.30')).toBeNull();
    expect(within(screen.getByTestId('adjustment-item.10')).queryByTestId('stale-marker')).toBeNull();
  });
});

describe('the effect on the forecast', () => {
  it('shows the baseline against the scenario, and the delta per bucket from deltaByBucket', async () => {
    const calls = stubApi(() => ({ ...scenarioRow(), adjustments: [adjustment(1, 'item.10')] }));
    renderDetail();
    const table = await screen.findByTestId('delta-table');
    expect(table.textContent).toContain('29 Sep–4 Oct');
    expect(table.textContent).toContain('+£300.00');
    const summary = screen.getByTestId('effect-summary');
    expect(summary.textContent).toContain('real plan -£550.00');
    expect(summary.textContent).toContain('+£300.00');
    expect(calls.find((c) => c.path.startsWith('/forecast'))?.path).toMatch(/scenarioId=9/);
  });
});

describe('the scenarios list', () => {
  function renderList(store: ScenarioStore) {
    return render(
      <ScenarioContext.Provider value={store}>
        <MemoryRouter initialEntries={['/scenarios']}>
          <Routes>
            <Route path="/scenarios" element={<ScenariosScreen />} />
            <Route path="/scenarios/:id" element={<div>detail</div>} />
            <Route path="/forecast" element={<div>the forecast</div>} />
          </Routes>
        </MemoryRouter>
      </ScenarioContext.Provider>,
    );
  }

  it('opens a scenario into the context and goes to the forecast', async () => {
    const store = createScenarioStore();
    stubApi(
      () => ({ ...scenarioRow(), adjustments: [] }),
      ({ method, path }) => (method === 'GET' && path.startsWith('/scenarios?') ? list([scenarioRow()]) : undefined),
    );
    renderList(store);
    const row = await screen.findByTestId('scenario-9');
    fireEvent.click(within(row).getByRole('button', { name: 'open' }));
    expect(store.get()).toEqual({ id: 9, name: 'Delay the rent' });
    expect(await screen.findByText('the forecast')).toBeTruthy();
  });

  it('creates, duplicates and deletes', async () => {
    const store = createScenarioStore({ id: 9, name: 'Delay the rent' });
    const calls = stubApi(
      () => ({ ...scenarioRow(), adjustments: [] }),
      ({ method, path, body }) => {
        if (method === 'GET' && path.startsWith('/scenarios?')) return list([scenarioRow()]);
        if (method === 'POST' && path === '/scenarios/9/duplicate') return scenarioRow({ id: 10, name: (body as { name: string }).name });
        if (method === 'DELETE' && path === '/scenarios/9') return null;
        if (method === 'POST' && path === '/scenarios') return scenarioRow({ id: 11, name: 'Big order' });
        return undefined;
      },
    );
    renderList(store);
    const row = await screen.findByTestId('scenario-9');

    fireEvent.click(within(row).getByRole('button', { name: 'duplicate' }));
    let dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Delay the rent (copy)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByTestId('scenario-10')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('scenario-9')).getByRole('button', { name: 'delete' }));
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(screen.queryByTestId('scenario-9')).toBeNull());
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ baseVersion: 3 });
    // It was the open one: the context lets go of it.
    expect(store.get()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New scenario' }));
    dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('button', { name: 'Create it' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Big order  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create it' }));
    expect(await screen.findByText('detail')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/scenarios')?.body).toEqual({ name: 'Big order' });
  });
});
