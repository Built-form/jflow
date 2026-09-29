// Copied from workflows/web/src/components/Shell.tsx — changes: nav rebuilt for JFlow's screens (PLAN: Forecast, Cash at bank, Income & outgoings, Schedules, Scenarios / Settings, People / About); one nav for both account types; nav links carry the URL's company filter from screen to screen; brand mark and caption JFlow's; dropped the instances/myTasks/families/processes/stages reads, the lot and verdict counts and the warehouse/standard/reviewer groups
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { useSession } from '../app/session';
import { useAuth } from '../app/auth';
import { Segmented } from './ui';
import { shortEmail } from '../lib/format';
import { COMPANY_PARAM } from '../app/companyFilter';
import { ScenarioBanner } from '../app/ScenarioContext';

interface NavEntry {
  to: string;
  label: string;
  /** Prefixes that also light this entry up. */
  match?: string[];
  count?: string;
}

type NavGroup = { label: string; items: NavEntry[] };

export function Shell() {
  const { me, theme, setTheme, users } = useSession();
  const { token, signOut } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();

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

  return (
    <div className="shell">
      <div className="sidebar">
        <div className="sidebar-brand">
          <div className="mark">J</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="name">JFlow</div>
            <div className="who">{shortEmail(me?.email)}</div>
          </div>
        </div>

        {groups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="kicker">{group.label}</div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={withCompany(item.to)}
                className={`nav-item${isActive(item) ? ' active' : ''}`}
              >
                <span className="label">{item.label}</span>
                <span className="count">{item.count ?? ''}</span>
              </NavLink>
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
        <ScenarioBanner />
        <ErrorBoundary key={location.pathname.split('/')[1] ?? ''}>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}
