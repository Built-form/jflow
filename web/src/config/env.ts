// Copied from workflows/web/src/config/env.ts — changes: JFlow's host and gateway URLs; `resolveApiBase` takes nullable stage URLs and answers '' (not configured) for a missing one; window title JFlow; the "both stages exist" note rewritten with JFlow's deploy dates
// ─────────────────────────────────────────────────────────────────────────────
// Deployment environment + the ONE place the API address is written down
// ─────────────────────────────────────────────────────────────────────────────
//
// Same structure as ShipLine's, JFPRO's and Workflows' `src/config/env.ts` —
// duplicated, not shared, because the apps are separate deployables with no
// common package. The STRUCTURE is deliberately identical so they read the
// same; the VALUES are this app's own.
//
// ── How the environment is chosen ────────────────────────────────────────────
// From the HOSTNAME at runtime, not from a build-time variable. One build
// artifact behaves correctly wherever it is served: no committed env file can
// leak the wrong way, and promoting a build never carries an environment with
// it. `VITE_APP_ENV` overrides the hostname for local development and as an
// escape hatch.
//
// ── Why unknown hosts resolve to TEST ────────────────────────────────────────
// The two failure directions are not symmetric. A production host missing from
// PRODUCTION_HOSTS runs against test data — loud, harmless, fixed by adding one
// string. A test host mistaken for production writes to live data — silent, and
// done by the time anyone notices. So TEST is the default and PRODUCTION must be
// named explicitly.
//
// ── Both stages are deployed ─────────────────────────────────────────────────
// `test` went up on 2026-09-29 and `prod` on 2026-09-30 (BUILD_PLAN step 11).
// jflow.built-form.co.uk is production; every other host is test. Change
// PRODUCTION_HOSTS and PRODUCTION_API_BASE together. A null address still means
// REFUSE (the not-configured screen), never the other stack.
//
// The catch is the override. `VITE_API_BASE_URL` beats the hostname, so an
// `.env.local` (or any deployed env file) pointing at test makes a production
// host read test data with no visible sign. That file is local-only by design;
// keep it that way.

export type AppEnv = 'production' | 'test';

/**
 * Hosts that serve PRODUCTION. Anything not listed — localhost, Vercel preview
 * URLs, the project's `*.vercel.app` domain — resolves to `test`. The
 * `.built-form.co.uk` subdomain also matters for sign-in: the shared session
 * cookie lives on that domain, so on any other host the estate-wide SSO cannot
 * be read.
 */
// mjflow.built-form.co.uk is mobileweb's, which carries its own env.ts (step 10).
const PRODUCTION_HOSTS: readonly string[] = ['jflow.built-form.co.uk'];

/** serverless stage `test` (`jflow-test-jflowApi`, eu-north-1). */
const TEST_API_BASE: string | null = 'https://d3votdaxd9.execute-api.eu-north-1.amazonaws.com/api/v1';

/** serverless stage `prod` (`jflow-prod-jflowApi`, eu-north-1). */
const PRODUCTION_API_BASE: string | null = 'https://jfwzm52aj0.execute-api.eu-north-1.amazonaws.com/api/v1';

/** Trailing slashes would produce `…v1//companies`, which the API 404s. */
const trimSlash = (url: string): string => url.trim().replace(/\/+$/, '');

/**
 * Pure resolution, exported for tests. `override` is the raw `VITE_APP_ENV`;
 * `hostname` is `window.location.hostname` (empty off-browser → test, the right
 * answer for any tooling context).
 */
export function resolveAppEnv(override: string | undefined, hostname: string): AppEnv {
  const explicit = (override ?? '').trim().toLowerCase();
  if (explicit === 'production' || explicit === 'test') return explicit;
  if (explicit) {
    // A typo'd value must not quietly pick an environment. Falling through to
    // the hostname is the safe outcome; say so rather than swallowing it.
    console.warn(
      `[config] Ignoring unrecognised VITE_APP_ENV="${override}" — expected "production" or "test". Falling back to hostname.`,
    );
  }
  return PRODUCTION_HOSTS.includes(hostname.trim().toLowerCase()) ? 'production' : 'test';
}

/**
 * Pure address resolution, exported for tests. Returns '' when there is nowhere
 * to point — which the caller must treat as "not configured", never as "use the
 * other environment's stack".
 */
export function resolveApiBase(
  appEnv: AppEnv,
  override: string | undefined,
  productionUrl: string | null,
  testUrl: string | null,
): string {
  const explicit = override?.trim();
  if (explicit) return trimSlash(explicit);
  if (appEnv === 'production') return productionUrl ? trimSlash(productionUrl) : '';
  return testUrl ? trimSlash(testUrl) : '';
}

/**
 * The browser-tab title. Production is just the app's name; anything else wears
 * its environment first, so a row of open tabs shows which one is safe to
 * demonstrate from before it is focused. `index.html` carries the plain name for
 * the instant before the bundle runs; `main.tsx` sets this over it.
 */
export function windowTitle(appEnv: AppEnv): string {
  return appEnv === 'production' ? 'JFlow' : '[TEST] JFlow';
}

export const APP_ENV: AppEnv = resolveAppEnv(
  import.meta.env.VITE_APP_ENV,
  typeof window === 'undefined' ? '' : window.location.hostname,
);

export const IS_TEST = APP_ENV === 'test';
export const IS_PRODUCTION = APP_ENV === 'production';

/**
 * The resolved API base URL, '' when unresolvable (no stack for this
 * environment, no override). `VITE_API_BASE_URL` keeps the estate's name for
 * it. NOTE: `import.meta.env.X` must be written out in full for Vite to inline
 * it; a computed lookup does not work.
 */
export const API_BASE: string = resolveApiBase(
  APP_ENV,
  import.meta.env.VITE_API_BASE_URL,
  PRODUCTION_API_BASE,
  TEST_API_BASE,
);
