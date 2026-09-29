// Copied from workflows/web/src/App.tsx — changes: JFlow's routes (Forecast, Cash at bank, Income & outgoings, Schedules, Scenarios, Settings, People, About; Forecast, Income & outgoings, Schedules and Scenarios built in step 9; Stock payments added in Phase 2 step 22); home is Forecast; dropped the InstancesProvider/CatalogueProvider frame and every role guard (standard is trust-the-team, CONTRACT D5); the not-found screen's way home is Forecast
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Shell } from './components/Shell';
import { api } from './api';
import { useQuery } from './app/useQuery';
import { useSession } from './app/session';
import { useAuth } from './app/auth';
import { apiBaseUrl } from './api/client';
import { NotAllowedScreen } from './screens/SignInScreen';
import { Loading } from './components/ui';
import { CashAtBankScreen } from './screens/CashAtBankScreen';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { ItemsScreen } from './screens/items/ItemsScreen';
import { SchedulesScreen } from './screens/schedules/SchedulesScreen';
import { ScheduleScreen } from './screens/schedules/ScheduleScreen';
import { PeopleScreen } from './screens/PeopleScreen';
import { AboutScreen } from './screens/AboutScreen';
import { ForecastScreen } from './screens/forecast/ForecastScreen';
import { ScenariosScreen } from './screens/scenarios/ScenariosScreen';
import { ScenarioScreen } from './screens/scenarios/ScenarioScreen';
import { StockPaymentsScreen } from './screens/stock/StockPaymentsScreen';

/** Where `/` lands. */
export const HOME = '/forecast';

export function App() {
  const { ready, bootError } = useSession();
  const { signOut } = useAuth();

  if (!ready) {
    return (
      <div className="page">
        <Loading what="Starting up" />
      </div>
    );
  }

  // A 401 that survived the transport's check means the credential was fine and the SERVER
  // refused the account — this email is not on the allowlist. Signing in again would
  // succeed and be refused again, so say so instead of looping.
  if (bootError?.status === 401) {
    return <NotAllowedScreen onSignOut={signOut} />;
  }

  if (bootError) {
    return (
      <div className="page">
        <div className="page-title">Could not start</div>
        <div className="explainer">
          {bootError.message}
          {/* Naming the address is the whole diagnosis when it is the wrong one: a 404 on
              every call usually means this is not the API at all. */}
          {' '}
          <span className="mono" style={{ fontSize: 13 }}>
            {apiBaseUrl()}
          </span>
        </div>
        <HealthLine />
        {bootError.status === 404 && (
          <div className="explainer">
            Every call 404'd. That address answered, but it is not this API — check{' '}
            <span className="mono">VITE_API_BASE_URL</span> in{' '}
            <span className="mono">web/.env.local</span> and restart the dev server; Vite only
            reads it at startup.
          </div>
        )}
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to={HOME} replace />} />
        <Route path="/forecast" element={<ForecastScreen />} />
        <Route path="/cash" element={<CashAtBankScreen />} />
        <Route path="/items" element={<ItemsScreen />} />
        <Route path="/schedules" element={<SchedulesScreen />} />
        <Route path="/schedules/:id" element={<ScheduleScreen />} />
        <Route path="/stock-payments" element={<StockPaymentsScreen />} />
        <Route path="/scenarios" element={<ScenariosScreen />} />
        <Route path="/scenarios/:id" element={<ScenarioScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/people" element={<PeopleScreen />} />
        {/* The app's own test record, not the business's data. */}
        <Route path="/about" element={<AboutScreen />} />
        {/* A wrong address must say so — silently landing on the home screen makes a stale
            link look like a working navigation to the wrong place. */}
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
    </Routes>
  );
}

/**
 * The readiness probe, on the one screen where it earns its place: when boot failed, "the
 * server answers but its database is down" and "nothing answers at all" are different
 * problems with different owners.
 */
function HealthLine() {
  const health = useQuery(() => api.meta.health().catch(() => null), []);
  if (health.loading) return null;
  return (
    <div className="mono" style={{ fontSize: 12.5, color: 'var(--dim)' }}>
      {health.data
        ? `The API answers — status ${health.data.status}, database ${health.data.database}${
            health.data.schema ? `, schema ${health.data.schema}` : ''
          }.`
        : 'The API itself is not answering.'}
    </div>
  );
}

function NotFoundScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div className="page">
      <div className="page-title">Page not found</div>
      <div className="explainer">
        Nothing lives at <span className="mono">{location.pathname}</span>. The link may be
        stale, or the thing it pointed at may have moved.
      </div>
      <div>
        <button type="button" className="btn" onClick={() => navigate(HOME)}>
          Go to Cash at bank
        </button>
      </div>
    </div>
  );
}
