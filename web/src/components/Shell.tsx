// Copied from workflows/web/src/components/Shell.tsx — changes: nav rebuilt for JFlow's screens (PLAN: Forecast, Cash at bank, Income & outgoings, Schedules, Stock payments (Phase 2), Scenarios / Settings, People / About); one nav for both account types; nav links carry the URL's company filter from screen to screen; brand mark and caption JFlow's; dropped the instances/myTasks/families/processes/stages reads, the lot and verdict counts and the warehouse/standard/reviewer groups; scenario mode — the pinned ScenarioBanner in a `.main` column above `.content`, `scenario-mode` on the shell and the sidebar's scenario chip; the Forecast's stock payments search under its nav entry; the sidebar folds to a rail (Dev, 2026-11-20), the choice kept in `jflow.nav`
import { Fragment, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { ForecastFind } from '../screens/forecast/ForecastFind';
import { SHIP_PARAM } from '../screens/forecast/ForecastScreen';
import { ErrorBoundary } from './ErrorBoundary';
import { useSession } from '../app/session';
import { useAuth } from '../app/auth';
import { Segmented } from './ui';
import { shortEmail } from '../lib/format';
import { COMPANY_PARAM } from '../app/companyFilter';
import { PulseMark } from './PulseMark';
import { ScenarioBanner, useScenario } from '../app/ScenarioContext';

interface NavEntry {
  to: string;
  label: string;
  /** Prefixes that also light this entry up. */
  match?: string[];
  count?: string;
}

type NavGroup = { label: string; items: NavEntry[] };

/** The sidebar's open / rail choice, per browser, beside `jflow.theme`. */
const NAV_KEY = 'jflow.nav';
/** With no choice made, a window this narrow (a tablet held upright) starts on the rail. */
const NARROW = 900;

function startCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(NAV_KEY);
    if (stored === 'rail') return true;
    if (stored === 'open') return false;
  } catch {
    // Storage refused (private mode): fall through to the width.
  }
  return typeof window !== 'undefined' && window.innerWidth < NARROW;
}

/** A window with its side panel: the usual sign for "show / hide the sidebar". */
function PanelIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M7.5 3.5v13" />
    </svg>
  );
}

function FindIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M12.75 12.75 17 17" />
    </svg>
  );
}

export function Shell() {
  const { me, theme, setTheme, users } = useSession();
  const { token, signOut } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  const { active: scenario } = useScenario();

  // The menu folds to a rail so the grid gets the width (Dev, 2026-11-20, on an iPad).
  const [collapsed, setCollapsedState] = useState(startCollapsed);
  // Set when the rail's search button opened the menu, so the box takes the cursor.
  const [focusFind, setFocusFind] = useState(false);
  // One use: `autoFocus` acts when the box mounts, and must not again on a later visit.
  useEffect(() => {
    if (focusFind) setFocusFind(false);
  }, [focusFind]);
  const setCollapsed = (next: boolean, find = false) => {
    setCollapsedState(next);
    setFocusFind(find);
    try {
      localStorage.setItem(NAV_KEY, next ? 'rail' : 'open');
    } catch {
      // Not kept; the menu still moves.
    }
  };

  // Every account sees the same nav: standard is trust-the-team (CONTRACT D5) and only the
  // People list's buttons are admin-only — the screen hides those itself.
  const groups: NavGroup[] = [
    {
      label: 'PLAN',
      items: [
        { to: '/forecast', label: 'Forecast' },
        { to: '/cash', label: 'Cash at bank' },
        { to: '/items', label: 'Income & outgoings' },
        { to: '/schedules', label: 'Schedules' },
        { to: '/stock-payments', label: 'Stock payments' },
        { to: '/scenarios', label: 'Scenarios' },
      ],
    },
    {
      label: 'SET UP',
      items: [
        { to: '/settings', label: 'Settings' },
        { to: '/people', label: 'People', count: String(users.length) },
      ],
    },
    // About is the app's own record — its environment and last test run — not the
    // business's data.
    { label: 'APP', items: [{ to: '/about', label: 'About' }] },
  ];

  // The company filter lives in the URL (PLAN "State"), so moving between the screens that
  // read it keeps it rather than dropping back to every company.
  const company = params.get(COMPANY_PARAM);
  const withCompany = (to: string) =>
    company && to !== '/people' && to !== '/about' ? `${to}?${COMPANY_PARAM}=${encodeURIComponent(company)}` : to;

  const isActive = (item: NavEntry) =>
    location.pathname.startsWith(item.to) || (item.match ?? []).some((m) => location.pathname.startsWith(m));

  const onForecast = location.pathname.startsWith('/forecast');
  const finding = onForecast ? (params.get(SHIP_PARAM) ?? '').trim() : '';

  return (
    <div className={`shell${scenario ? ' scenario-mode' : ''}`}>
      {collapsed ? (
        // The rail: the way back, the mark, and on the Forecast the search the menu holds —
        // lit while a search is narrowing the grid, so a hidden box never hides that it is.
        <div className="sidebar collapsed" data-testid="sidebar-rail">
          <button type="button" className="sidebar-toggle" aria-label="Show menu" aria-expanded="false" onClick={() => setCollapsed(false)}>
            <PanelIcon />
          </button>
          <PulseMark className="mark" />
          {onForecast && (
            <button
              type="button"
              className="sidebar-toggle"
              aria-label={finding ? `Find stock payments (searching for ${finding})` : 'Find stock payments'}
              data-active={finding ? '' : undefined}
              onClick={() => setCollapsed(false, true)}
            >
              <FindIcon />
            </button>
          )}
        </div>
      ) : (
        <div className="sidebar">
          <div className="sidebar-brand">
            <PulseMark className="mark" />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div className="name">paypulse</div>
              <div className="who">{shortEmail(me?.email)}</div>
            </div>
            <button type="button" className="sidebar-toggle" aria-label="Hide menu" aria-expanded="true" onClick={() => setCollapsed(true)}>
              <PanelIcon />
            </button>
          </div>

          {scenario && (
            <div className="sidebar-scenario" data-testid="sidebar-scenario">
              <div className="tag">SCENARIO MODE</div>
              <div className="name">{scenario.name}</div>
            </div>
          )}

          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="kicker">{group.label}</div>
              {group.items.map((item) => (
                <Fragment key={item.to}>
                  <NavLink to={withCompany(item.to)} className={`nav-item${isActive(item) ? ' active' : ''}`}>
                    <span className="label">{item.label}</span>
                    <span className="count">{item.count ?? ''}</span>
                  </NavLink>
                  {/* The Forecast's stock payments search sits under its entry while it is open (Dev, 2026-11-19). */}
                  {item.to === '/forecast' && isActive(item) && <ForecastFind autoFocus={focusFind} />}
                </Fragment>
              ))}
            </div>
          ))}

          <div className="sidebar-foot">
            <Segmented
              ariaLabel="Theme"
              compact
              options={[
                { id: 'light', label: 'Light' },
                { id: 'dark', label: 'Dark' },
              ]}
              value={theme}
              onChange={(next) => setTheme(next)}
            />
            <div className="caption">
              Every change is recorded with who and when. Balances are cash at bank at the start
              of the day.
            </div>
            {token && (
              <button
                type="button"
                className="btn"
                style={{ width: '100%' }}
                // Ends the session for every Built Form app, not just this one — the token is
                // shared, so a half sign-out would be a lie.
                onClick={signOut}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      )}

      <div className="main">
        {/* Outside the scroller, so the banner never scrolls out of sight. */}
        <ScenarioBanner />
        <div className="content">
          {/*
            One screen that throws must not take the frame with it — the sidebar stays
            usable, so there is somewhere to go.

            Keyed by the top-level SECTION, never the full pathname or the query: a screen
            that owns its filters in the URL changes `search` without leaving the screen, and
            remounting the boundary mid-load would throw away its state and start the read
            again. The section still changes on real navigation, so a throw is cleared by
            going somewhere else.
          */}
          <ErrorBoundary key={location.pathname.split('/')[1] ?? ''}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
