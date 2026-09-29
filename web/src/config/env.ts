// Copied from workflows/web/src/config/env.ts — changes: PRODUCTION_HOSTS is empty and PRODUCTION_API_BASE null until prod is deployed, so every host runs on the test stack; `resolveApiBase` takes a nullable test URL and answers '' (not configured) for it too; window title JFlow; the "both stages exist" note rewritten for "only test exists"
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
// ── Only test is deployed ────────────────────────────────────────────────────
// `test` went up on 2026-09-29 (BUILD_PLAN step 11); `prod` has not. Until it
// does, PRODUCTION_HOSTS is empty, so every host, jflow.built-form.co.uk
// included, IS test: it reads the test stack and says so (banner, tab title).
// That is deliberate. The alternative, pointing PRODUCTION_API_BASE at the test
// URL, would put test data on a screen that claims to be production, and a
// production screen full of test data looks exactly like a working app. When
// prod is deployed, put jflow.built-form.co.uk back in PRODUCTION_HOSTS and its
// gateway URL in PRODUCTION_API_BASE, together. A null address still means
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
// Empty until prod is deployed: jflow.built-form.co.uk runs on test (see above).
const PRODUCTION_HOSTS: readonly string[] = [];

/** serverless stage `test` (`jflow-test-jflowApi`, eu-north-1). */
const TEST_API_BASE: string | null = 'https://d3votdaxd9.execute-api.eu-north-1.amazonaws.com/api/v1';

/** serverless stage `prod` — not deployed yet; its gateway URL goes here when it is. */
const PRODUCTION_API_BASE: string | null = null;

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
