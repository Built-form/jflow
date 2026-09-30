import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';

/**
 * The open scenario (PLAN "State": `useQuery` + replace-from-response, a `ScenarioContext`
 * holding the active scenario id, the company filter in the URL — no state library).
 *
 * While a scenario is open the Forecast writes ADJUSTMENTS to it instead of real data, and
 * every screen shows a banner saying so — a what-if must never look like the real plan.
 *
 * The context's value is a tiny store rather than state in a provider: the app mounts no
 * provider for it (the Shell only renders the banner), so the default value IS the app's
 * store, and a test hands in its own with `createScenarioStore`. The open scenario is kept
 * in `sessionStorage`, so a refresh keeps it and a new tab starts on the real plan.
 */

export interface ActiveScenario {
  id: number;
  name: string;
}

export interface ScenarioStore {
  get: () => ActiveScenario | null;
  subscribe: (listener: () => void) => () => void;
  open: (scenario: ActiveScenario) => void;
  close: () => void;
}

export const SCENARIO_STORAGE_KEY = 'jflow.scenario';

function readStored(): ActiveScenario | null {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SCENARIO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveScenario>;
    return typeof parsed.id === 'number' && parsed.id > 0 && typeof parsed.name === 'string'
      ? { id: parsed.id, name: parsed.name }
      : null;
  } catch {
    return null;
  }
}

function writeStored(value: ActiveScenario | null): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (value) sessionStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SCENARIO_STORAGE_KEY);
  } catch {
    /* storage refused (private mode, quota): the scenario still opens for this page */
  }
}

/** A store. `persist` (the app's) mirrors it into sessionStorage; a test's stays in memory. */
export function createScenarioStore(initial: ActiveScenario | null = null, persist = false): ScenarioStore {
  let current = initial;
  const listeners = new Set<() => void>();
  const set = (next: ActiveScenario | null) => {
    current = next;
    if (persist) writeStored(next);
    for (const listener of listeners) listener();
  };
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (scenario) => set({ id: scenario.id, name: scenario.name }),
    close: () => set(null),
  };
}

export const appScenarioStore = createScenarioStore(readStored(), true);

export const ScenarioContext = createContext<ScenarioStore>(appScenarioStore);

export interface ScenarioControls {
  /** The open scenario, or null when edits write real data. */
  active: ActiveScenario | null;
  open: (scenario: ActiveScenario) => void;
  close: () => void;
}

export function useScenario(): ScenarioControls {
  const store = useContext(ScenarioContext);
  const active = useSyncExternalStore(store.subscribe, store.get, store.get);
  return useMemo(() => ({ active, open: store.open, close: store.close }), [active, store]);
}

/**
 * The banner every screen shows while a scenario is open. The Shell renders it once
 * (`<ScenarioBanner />`, its one line for this), above the screen; on the real plan it
 * renders nothing.
 */
export function ScenarioBanner() {
  const { active, close } = useScenario();
  if (!active) return null;
  return (
    <div
      role="status"
      aria-label="Scenario open"
      data-testid="scenario-banner"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '10px 16px',
        border: '1px solid var(--waivedBd)',
        background: 'var(--waivedBg)',
        borderRadius: 'var(--radius)',
        margin: '14px 26px 0',
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <span className="mono" style={{ fontSize: 11.5, letterSpacing: '.1em', color: 'var(--waived)' }}>
        SCENARIO OPEN
      </span>
      <span style={{ fontWeight: 600 }}>{active.name}</span>
      <span style={{ color: 'var(--mut)', flex: 1, minWidth: 220 }}>
        Edits on the Forecast change this what-if, not the real plan.
      </span>
      <Link className="btn" to={`/scenarios/${active.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
        View scenario
      </Link>
      <button type="button" className="btn" onClick={close}>
        Close scenario
      </button>
    </div>
  );
}
