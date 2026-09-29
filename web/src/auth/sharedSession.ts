// ─────────────────────────────────────────────────────────────────────────────
// Shared cross-app session — ONE Google ID token for every *.built-form.co.uk app
// ─────────────────────────────────────────────────────────────────────────────
//
// Every app in the estate (ShipLine, JFPRO, DispatchLine, Payments, Cashboard)
// authenticates against API-Gateway JWT authorizers configured with the SAME
// issuer (Google) and the SAME audience (the client id below). The gateways sit
// on different execute-api hosts, but they all accept the same credential — so
// there is no reason for each app to hold its own copy of it.
//
// This module makes that one credential literally one value: a cookie scoped to
//   Domain=.built-form.co.uk
// which every host under that registrable domain — jfpro.built-form.co.uk,
// shipline.built-form.co.uk, cashboard.built-form.co.uk, … — reads and writes.
// Sign in on any one app and you are signed in on all of them; sign out of one
// and you are out of all of them.
//
// ── Why a JS-readable cookie and not HttpOnly ────────────────────────────────
// The authorizer reads `$request.header.Authorization`, so the token has to be
// attached as a Bearer header by the frontend. A cookie also would not reach the
// gateway on its own: the APIs live on *.execute-api.eu-north-1.amazonaws.com,
// a different registrable domain, so no cookie of ours is ever sent there. The
// cookie is therefore pure cross-subdomain STORAGE, not an auth channel, and it
// must stay script-readable. The security posture is the same as the localStorage
// it replaces, with one real difference worth stating plainly: an XSS in ANY app
// on the domain now reads the token for ALL of them. See SECURITY at the bottom.
//
// ── This file is duplicated, not shared ──────────────────────────────────────
// The apps are separate deployables with no common package. This file is byte-
// identical in each one and has ZERO imports so it can stay that way. If you
// change it, copy it to all five:
//   ShipLine/src/auth/sharedSession.ts
//   JFPRO/src/data/auth/sharedSession.ts
//   dispatchline/src/auth/sharedSession.ts
//   payments/src/auth/sharedSession.ts
//   cashboard-ui/services/sharedSession.ts

// The leading dot is what makes the cookie visible to every subdomain.
const COOKIE_NAME = 'bf_id_token';
const ROOT_HOST = 'built-form.co.uk';
const COOKIE_DOMAIN = `.${ROOT_HOST}`;

/** The one OAuth client id. Matches every gateway authorizer's `audience`. */
export const GOOGLE_CLIENT_ID =
  '1085148951708-8qfkho7ilq084vvpo52jvc6fgg9ecdjt.apps.googleusercontent.com';

// Google mints ID tokens with either spelling of the issuer.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Treat a token as spent a minute early: long enough to cover the round trip of
// a request that is already in flight when it lapses, short enough not to throw
// away usable session. Matches the buffer Cashboard has been running with.
const EXPIRY_SKEW_MS = 60_000;

// Renew this far ahead of expiry. Google ID tokens live ~1h, so this refreshes
// at roughly the 55-minute mark while the tab is open.
const RENEW_AHEAD_MS = 5 * 60_000;

// How often to re-read the cookie looking for a change made by ANOTHER app or
// tab. Cookies fire no storage event, so this poll is the only way to notice a
// sibling app signing in or out. It is a substring scan of document.cookie.
const SYNC_POLL_MS = 5_000;

// Give up on a silent renewal after this. GIS can simply never call back (FedCM
// blocked, third-party cookies off, no Google session) and without a ceiling the
// single-flight latch would wedge for the life of the page.
const SILENT_TIMEOUT_MS = 20_000;

// Same-origin mirror of the cookie. Cookies can be blocked outright (private
// modes, strict blockers) and local dev runs on a host the shared domain does
// not cover, so the token is always written here too. The COOKIE WINS on read —
// the mirror is a fallback, never an override, or one app's stale local copy
// would shadow another app's fresh renewal. The key is the historical one four
// of the five apps already used, which is also what migrates their signed-in
// users across without a re-login.
//
// Deliberately NOT including Cashboard's 'cashboard_auth_token': that key doubles
// as its manual DEMO_MODE_TOKEN hatch, and this module clears its mirrors when it
// finds no valid session — which would wipe the hatch on first read.
const MIRROR_KEYS = ['authToken'];

// Set the first time this origin reads a session, so the one-time migration of a
// pre-existing localStorage login runs exactly once. After that the mirror is
// never a source of truth on a browser where cookies work — see readSharedToken.
const MIGRATED_KEY = 'bf_session_migrated';

// ── Claims ───────────────────────────────────────────────────────────────────

export interface SessionClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  picture?: string;
  hd?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  [claim: string]: unknown;
}

/** Decode a JWT payload. Returns null for anything unparseable. */
export function decodeToken(token: string | null | undefined): SessionClaims | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(json) as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Is this token one the gateways will actually accept?
 *
 * Checks the three things a client CAN check for free: it is a well-formed JWT,
 * it was issued by Google for OUR audience, and it has not expired. A token that
 * fails any of these is one every endpoint would reject, so we treat it as no
 * session at all rather than sending a request we know will 401.
 *
 * NOT a signature check — that is impossible in the browser without Google's
 * public keys, and pointless besides: the authorizer verifies the signature on
 * every request and remains the only thing standing between a forged token and
 * the data. This function exists to avoid doomed requests and login flicker, not
 * to establish trust.
 */
export function isSessionValid(token: string | null | undefined): boolean {
  const claims = decodeToken(token);
  if (!claims) return false;
  // A Google ID token always carries `exp`. One without it is not a credential
  // we recognise, so it is rejected rather than treated as eternal.
  if (typeof claims.exp !== 'number') return false;
  if (claims.exp * 1000 <= Date.now() + EXPIRY_SKEW_MS) return false;
  if (typeof claims.iss === 'string' && !ISSUERS.includes(claims.iss)) return false;
  if (typeof claims.aud === 'string' && claims.aud !== GOOGLE_CLIENT_ID) return false;
  return true;
}

/** Inverse of `isSessionValid`, kept for call sites that read better this way. */
export function isTokenExpired(token: string | null | undefined): boolean {
  return !isSessionValid(token);
}

/** Milliseconds until the token lapses, or null when it has no readable expiry. */
export function msUntilTokenExpiry(token: string | null | undefined): number | null {
  const exp = decodeToken(token)?.exp;
  if (typeof exp !== 'number') return null;
  return exp * 1000 - Date.now();
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** True when this page is on a host the shared cookie domain covers. */
function onSharedDomain(): boolean {
  if (typeof location === 'undefined') return false;
  const host = location.hostname;
  return host === ROOT_HOST || host.endsWith(COOKIE_DOMAIN);
}

function readCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(eq + 1));
      } catch {
        return part.slice(eq + 1);
      }
    }
  }
  return null;
}

function writeCookie(token: string, expMs: number): void {
  if (typeof document === 'undefined') return;
  // Expire the cookie exactly when the token does, so a closed-then-reopened
  // browser never presents a credential the gateway has already stopped taking.
  const maxAge = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    // Lax, not None: the token is read by same-site script, never posted
    // cross-site, so None would widen exposure for nothing.
    'SameSite=Lax',
  ];
  // Domain= is only legal on the domain it names; on localhost the browser
  // silently drops the whole cookie. Fall back to a host-only cookie there so
  // dev exercises the same code path.
  if (onSharedDomain()) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  if (location.protocol === 'https:') attrs.push('Secure');
  document.cookie = attrs.join('; ');
}

function deleteCookie(): void {
  if (typeof document === 'undefined') return;
  // A cookie is only cleared by a Set-Cookie whose name/domain/path match, and
  // we may have written either form, so clear both.
  document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  if (onSharedDomain()) {
    document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; Domain=${COOKIE_DOMAIN}`;
  }
}

function readMirror(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeMirrors(token: string): void {
  for (const key of MIRROR_KEYS) {
    try {
      // Compare first: readSharedToken() runs on every request-header build, and
      // an unconditional write would both burn a synchronous storage call each
      // time and fire a pointless `storage` event in every other tab.
      if (localStorage.getItem(key) !== token) localStorage.setItem(key, token);
    } catch {
      /* storage full or blocked — the cookie is the source of truth anyway */
    }
  }
}

function clearMirrors(): void {
  for (const key of MIRROR_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  }
}

function firstValidMirror(): string | null {
  for (const key of MIRROR_KEYS) {
    const mirrored = readMirror(key);
    if (isSessionValid(mirrored)) return mirrored;
  }
  return null;
}

// Can this browser hold our cookie at all? Probe once and remember. The answer
// decides whether an absent cookie means "signed out" or "cookies are blocked,
// fall back to per-app storage".
let cookiesWork: boolean | null = null;
function cookiesAvailable(): boolean {
  if (cookiesWork !== null) return cookiesWork;
  try {
    // Explicit Max-Age rather than a session cookie, so the probe does not
    // depend on how the browser treats cookies with no lifetime. Deleted again
    // immediately either way.
    document.cookie = 'bf_probe=1; Path=/; Max-Age=10; SameSite=Lax';
    cookiesWork = document.cookie.includes('bf_probe=1');
    document.cookie = 'bf_probe=; Path=/; Max-Age=0; SameSite=Lax';
  } catch {
    cookiesWork = false;
  }
  return cookiesWork;
}

// Hand back a pre-existing localStorage login, but only on the very first read
// this origin has ever performed. That is the whole migration: everyone signed
// in under the old per-app scheme keeps their session, once, and after that the
// flag makes this a permanent no-op.
let migrationChecked = false;
function takeLegacyMirror(): string | null {
  if (migrationChecked) return null;
  migrationChecked = true;
  try {
    if (localStorage.getItem(MIGRATED_KEY) === '1') return null;
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch {
    return null;
  }
  return firstValidMirror();
}

/**
 * The current session token, or null when there isn't a usable one.
 *
 * Reading is also where the session is POLICED: an expired or foreign token is
 * deleted on sight rather than returned, so no caller has to remember to check.
 *
 * The same-origin mirror is deliberately NOT a general read fallback. localStorage
 * is per-origin, so shipline.built-form.co.uk and jfpro.built-form.co.uk each hold
 * their own copy — and if an absent cookie fell back to the mirror, signing out of
 * one app would be silently undone by the next app that read its own stale copy.
 * Once cookies are known to work and migration has run, an absent cookie means
 * signed out, full stop, and the mirror is cleared to match. The mirror only
 * governs when the browser refuses cookies outright, where the estate-wide session
 * is impossible anyway and each app degrades to its own local one.
 */
export function readSharedToken(): string | null {
  // FIRST, before anything else, so the migration window closes on this origin's
  // very first read whether or not a cookie happened to be present. Closing it
  // only on the cookie-less path leaves it open for an app that read a live
  // session once — and that app would then promote its own stale mirror back
  // into the cookie the next time someone signed out elsewhere.
  const legacy = takeLegacyMirror();

  const cookie = readCookie();
  if (isSessionValid(cookie)) {
    writeMirrors(cookie as string);
    return cookie;
  }
  if (cookie) deleteCookie();

  if (legacy) {
    writeSharedToken(legacy);
    return legacy;
  }

  if (!cookiesAvailable()) {
    const mirrored = firstValidMirror();
    if (mirrored) return mirrored;
  }

  clearMirrors();
  return null;
}

/**
 * Store a freshly-issued credential for the whole estate.
 *
 * Returns false — and stores nothing — for a token the gateways would reject.
 * Refusing here rather than storing optimistically is deliberate: a bad token
 * written to the cookie reads back as "no session" on the very next tick, which
 * looks to the user like a sign-in that silently did nothing.
 */
export function writeSharedToken(token: string): boolean {
  const claims = decodeToken(token);
  if (!claims || typeof claims.exp !== 'number') return false;
  if (typeof claims.iss === 'string' && !ISSUERS.includes(claims.iss)) return false;
  if (typeof claims.aud === 'string' && claims.aud !== GOOGLE_CLIENT_ID) return false;

  writeCookie(token, claims.exp * 1000);
  writeMirrors(token);
  // Tell in-page watchers immediately rather than making them wait out the poll.
  emit(token);
  return true;
}

/** Sign out everywhere: drop the shared cookie and every same-origin mirror. */
export function clearSharedToken(): void {
  deleteCookie();
  clearMirrors();
  emit(null);
  // Stop GIS auto-selecting the same account straight back in — otherwise a
  // silent renewal can undo the sign-out the user just asked for.
  try {
    (window as unknown as GoogleWindow).google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    /* GIS not loaded — nothing to disable */
  }
}

// ── Silent renewal ───────────────────────────────────────────────────────────

interface GoogleWindow {
  google?: {
    accounts?: {
      id?: {
        initialize(config: Record<string, unknown>): void;
        prompt(listener?: (notification: unknown) => void): void;
        cancel(): void;
        disableAutoSelect?(): void;
      };
    };
  };
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisLoad: Promise<void> | null = null;

/** Load Google Identity Services once, whether or not the host app already has. */
function loadGis(): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document'));
  if ((window as unknown as GoogleWindow).google?.accounts?.id) return Promise.resolve();
  if (gisLoad) return gisLoad;

  gisLoad = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('GIS failed to load')));
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch(err => {
    gisLoad = null; // let a later attempt retry
    throw err;
  });
  return gisLoad;
}

// Single-flight latch. Every trigger — the renewal timer, a 401, a focus check —
// coalesces onto ONE prompt, so an expiry can't surface four sign-in attempts.
let renewInFlight: Promise<string | null> | null = null;

/**
 * Try to obtain a fresh credential WITHOUT user interaction.
 *
 * Uses GIS auto-select: if the browser still has a live Google session for an
 * account that has signed in here before, Google re-issues an ID token with no
 * UI at all. Resolves to the new token, or to null when it can't be done
 * silently — which is a normal, expected outcome, not an error. Third-party
 * cookie blocking, FedCM being disabled, a signed-out Google account, or a
 * recent explicit sign-out all land on null, and every caller must be prepared
 * to fall back to the interactive login screen.
 */
export function renewSharedSession(): Promise<string | null> {
  // Never take over GIS from a login screen that has never held a session — see
  // `hadSession`. Renewal is for keeping a session alive, not for starting one.
  if (!hadSession) return Promise.resolve(null);
  if (renewInFlight) return renewInFlight;
  renewInFlight = attemptSilentRenew().finally(() => {
    renewInFlight = null;
  });
  return renewInFlight;
}

async function attemptSilentRenew(): Promise<string | null> {
  try {
    await loadGis();
  } catch {
    return null;
  }
  const gis = (window as unknown as GoogleWindow).google?.accounts?.id;
  if (!gis) return null;

  return new Promise<string | null>(resolve => {
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(token);
    };
    const timer = setTimeout(() => finish(null), SILENT_TIMEOUT_MS);

    try {
      gis.initialize({
        client_id: GOOGLE_CLIENT_ID,
        auto_select: true,
        cancel_on_tap_outside: false,
        use_fedcm_for_prompt: true,
        callback: (response: { credential?: string }) => {
          // writeSharedToken publishes to every app and notifies watchers.
          const credential = response?.credential;
          finish(credential && writeSharedToken(credential) ? credential : null);
        },
      });
      // Clear any prompt left over from a previous cycle, or GIS aborts this one.
      try {
        gis.cancel();
      } catch {
        /* nothing pending */
      }
      gis.prompt((notification: unknown) => {
        // The callback above is authoritative — a credential ALWAYS arrives
        // there. This listener only lets us fail fast instead of waiting out the
        // timeout. Its methods are guarded because GIS has been changing which
        // of them exist as FedCM rolls out, and a throw here would strand us.
        try {
          const n = notification as {
            isDisplayed?: () => boolean;
            isDismissedMoment?: () => boolean;
            getDismissedReason?: () => string;
          };
          if (n?.isDisplayed?.()) return; // UI is up; wait for the callback
          if (n?.isDismissedMoment?.() && n.getDismissedReason?.() === 'credential_returned') return;
        } catch {
          return; // can't read the moment — let the timeout decide
        }
        // No credential is coming. Give the callback a beat in case the two
        // race, then declare the silent path unavailable.
        setTimeout(() => finish(null), 300);
      });
    } catch {
      finish(null);
    }
  });
}

// ── Change notification ──────────────────────────────────────────────────────

type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();
let lastSeen: string | null = null;
let watchers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// True once this page has held a session. Silent renewal is gated on it, because
// a page that has NEVER been signed in is showing its login screen — and there
// the interactive Google button owns google.accounts.id. Renewing would call
// initialize() with OUR callback and quietly steal the button's, so a user
// clicking "Sign in with Google" would see nothing happen.
let hadSession = false;

function emit(token: string | null): void {
  if (token) hadSession = true;
  if (token === lastSeen) return;
  lastSeen = token;
  for (const listener of listeners) {
    try {
      listener(token);
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

function checkForChange(): void {
  const token = readSharedToken();
  emit(token);
}

/**
 * Watch the shared session and keep it alive.
 *
 * Does three jobs for the price of one subscription:
 *
 *  1. CROSS-APP SYNC. Polls the cookie so this tab notices a sign-in or sign-out
 *     that happened in a sibling app. Cookies emit no storage event, so polling
 *     is the only mechanism available; it is a scan of a short string.
 *  2. PROACTIVE RENEWAL. Schedules a silent renewal a few minutes before expiry,
 *     so a tab left open all day never hits a hard sign-out mid-action.
 *  3. LAPSE DETECTION. Re-checks on focus and visibility, covering a tab that
 *     was backgrounded or a laptop that slept — cases where timers are throttled
 *     or frozen and the scheduled renewal never fired.
 *
 * `onChange` fires with the new token on renewal or cross-app sign-in, and with
 * null when the session is gone for good and the app should show its login
 * screen. Returns an unsubscribe function.
 *
 * Pass `{ renew: false }` when the host app drives its own GIS renewal (Cashboard
 * does, with a request queue, a re-auth circuit breaker and a Session Expired
 * modal). Both this module and the app calling google.accounts.id.initialize()
 * would fight over one global config — last writer wins — so exactly one of them
 * must own it. With renew off you still get cross-app sync and lapse detection.
 */
export function watchSharedSession(
  onChange: Listener,
  options: { renew?: boolean } = {},
): () => void {
  const autoRenew = options.renew !== false;
  listeners.add(onChange);
  watchers += 1;
  lastSeen = readSharedToken();
  if (lastSeen) hadSession = true;

  let renewTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRenew = () => {
    if (!autoRenew) return;
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    const ms = msUntilTokenExpiry(lastSeen);
    if (ms == null) return;
    const delay = Math.max(0, ms - RENEW_AHEAD_MS);
    // setTimeout's delay is a signed 32-bit int; only arm it when representable.
    if (delay >= 2_147_483_647) return;
    renewTimer = setTimeout(async () => {
      const renewed = await renewSharedSession();
      // A null here is not yet fatal: the current token may still have minutes
      // left on it. The lapse check below is what finally reports the session
      // gone, once it actually is.
      if (renewed) scheduleRenew();
      else checkForChange();
    }, delay);
  };

  const revalidate = () => {
    const before = lastSeen;
    const token = readSharedToken();
    if (token) {
      if (token !== before) {
        emit(token);
        scheduleRenew();
      }
      return;
    }
    // Nothing usable. When we own renewal, try once to get it back silently
    // before telling the app to bounce the user to a login screen. When the app
    // owns renewal, report the loss and let it run its own recovery.
    if (!autoRenew) {
      emit(null);
      return;
    }
    void renewSharedSession().then(renewed => {
      if (renewed) scheduleRenew();
      else emit(null);
    });
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') revalidate();
  };
  // A sibling TAB of this same app writes the mirror; catch that instantly
  // instead of waiting out the poll.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || MIRROR_KEYS.includes(e.key)) checkForChange();
  };

  scheduleRenew();
  window.addEventListener('focus', revalidate);
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onVisible);
  if (pollTimer === null) pollTimer = setInterval(checkForChange, SYNC_POLL_MS);

  return () => {
    listeners.delete(onChange);
    watchers -= 1;
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    window.removeEventListener('focus', revalidate);
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onVisible);
    if (watchers === 0 && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

// ── Request helpers ──────────────────────────────────────────────────────────

/**
 * Authorization header for the shared token, or {} when signed out.
 *
 * Returning {} rather than `Bearer null` matters: an absent header produces a
 * clean 401 from the authorizer, while the literal string "null" has been known
 * to surface as a malformed-token 500 instead.
 */
export function sharedAuthHeaders(): Record<string, string> {
  const token = readSharedToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── SECURITY ─────────────────────────────────────────────────────────────────
//
// What this design does and does not buy, stated plainly so the next person does
// not have to reverse-engineer the trade:
//
//  * The token MUST be script-readable (see the header). It is therefore exposed
//    to XSS exactly as the localStorage it replaces was — but now a single XSS
//    anywhere on *.built-form.co.uk yields a credential for EVERY app on the
//    domain. Widening the blast radius is the price of single sign-on here; the
//    mitigation is that every app on the domain must be held to the same
//    standard, since the weakest one now sets the bar for all of them.
//  * Anything hosted under built-form.co.uk can read this cookie, including a
//    subdomain someone stands up later. Do not park untrusted or third-party
//    content on a built-form.co.uk host.
//  * Exposure is time-boxed by Google: these tokens last about an hour, and the
//    cookie is set to expire with the token rather than outlive it.
//  * The client-side validity check is a convenience gate, NOT a security
//    control. Signature verification happens in the API Gateway authorizer on
//    every single request and is the only thing that actually enforces access.
//  * The cookie rides along on requests to the app hosts themselves (~1KB). It
//    is ignored there — those are static frontends — but it is not free.
