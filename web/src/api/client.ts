// Copied from workflows/web/src/api/client.ts — changes: error-code and user types come from JFlow's api/types.ts; `X-User-Type` is `standard | admin` only; dropped `gateSteps` (workflows' submit gate) and the Idempotency-Key plumbing (`idempotencyKey`, `newIdempotencyKey`), which CONTRACT does not define; "people-picker" note dropped
/**
 * The single transport seam. Every screen goes through `api.*` in `./index.ts`; nothing
 * calls `fetch` directly.
 *
 * Auth is the estate-wide Google session (`src/auth/sharedSession.ts`): one ID token in a
 * cookie on `.built-form.co.uk`, shared with ShipLine, JFPRO, DispatchLine, Workflows and
 * the rest, because every gateway is configured with the same issuer and audience. Sign in
 * on any of them and you are signed in here.
 *
 * Local dev against `npm run dev` in `api/` bypasses auth entirely and resolves the identity
 * as `local@dev`, so the header is optional there, never required.
 *
 * There is no mock switch. The app talks to the API; `__setTestTransport` is a test-only
 * seam, so nothing that ships can answer from fixtures.
 */

import type { ApiErrorBody, ErrorCode, UserType } from './types';
import { API_BASE } from '../config/env';
import { clearSharedToken, isSessionValid, readSharedToken } from '../auth/sharedSession';

/**
 * Where the API is: resolved in `src/config/env.ts` from the hostname (test vs production
 * stack), with `VITE_API_BASE_URL` as the override. There is **no localhost fallback** —
 * one would silently aim the app at whatever is on that port AND silently switch OFF the
 * sign-in gate, because a localhost API is the one that bypasses auth. Unresolvable is a
 * screen that says so, never the other environment's stack.
 */
export function isConfiguredBaseUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && /^https?:\/\/\S+$/.test(url.trim());
}

export const API_CONFIGURED: boolean = isConfiguredBaseUrl(API_BASE);
const BASE_URL: string = API_BASE;

export function apiBaseUrl(): string {
  return BASE_URL || '(not set)';
}

/**
 * True when the API we point at is a developer's own `npm run dev`, which bypasses auth.
 * The sign-in gate is skipped there — demanding a Google credential the server will not
 * even read would make local development impossible for anyone off the allowlist.
 */
export const API_IS_LOCAL: boolean = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

export class ApiError extends Error {
  readonly status: number;
  readonly code?: ErrorCode | string;
  readonly details?: ApiErrorBody['details'];
  /** `X-Request-Id` from the failed response — the correlation handle into server logs. */
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody, requestId?: string) {
    // `error` is one line written to be shown to the operator as-is. Show it.
    super(body.error || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = requestId;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** `X-User-Type` (standard | admin) is CORS-exposed; the screens gate on `/me`, this is a courtesy. */
let lastUserType: UserType | null = null;
export function lastKnownUserType(): UserType | null {
  return lastUserType;
}

/**
 * Told when the credential itself is finished, so the app can drop to the sign-in screen.
 *
 * Deliberately NOT fired for every 401: this API answers 401 both for a dead token and for
 * a live token whose email is not on the allowlist. Signing that second person out sends
 * them into a loop — sign in, 401, sign in — so only a credential we can see is spent
 * counts as the session ending.
 */
type SessionListener = () => void;
const sessionListeners = new Set<SessionListener>();

export function onSessionLost(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function announceSessionLost(): void {
  clearSharedToken();
  for (const listener of sessionListeners) {
    try {
      listener();
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

/**
 * Test-only transport. The app never sets it, so no stub is reachable from — or bundled
 * into — a build. `src/test/setup.ts` installs a refusing one for the suite.
 */
export type TestTransport = <T>(method: string, path: string, body?: unknown) => Promise<T>;

let testTransport: TestTransport | null = null;
export function __setTestTransport(transport: TestTransport | null): void {
  testTransport = transport;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

export function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const url = path + buildQuery(opts.query);

  if (testTransport) return testTransport<T>(method, url, opts.body);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  // Absent rather than `Bearer null` when signed out: an absent header is a clean 401 from
  // the authorizer, while the literal string has been known to surface as a 500.
  const token = readSharedToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(BASE_URL + url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(0, {
      error: 'Could not reach the server. Check your connection.',
      code: 'NETWORK',
    });
  }

  const userType = res.headers.get('X-User-Type');
  if (userType === 'admin' || userType === 'standard') lastUserType = userType;

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? safeParse(text) : null;

  if (!res.ok) {
    // A rejected token surfaces as a real 401 with CORS headers, so it is readable rather
    // than an opaque network failure.
    const body: ApiErrorBody =
      payload && typeof payload === 'object' && 'error' in (payload as object)
        ? (payload as ApiErrorBody)
        : { error: res.status === 401 ? 'Your session has expired. Sign in again.' : `Request failed (${res.status})` };

    // Which 401 is this? A credential we can see is spent (or was never there) is the
    // session ending. A live one means the server refused the ACCOUNT — the email is not
    // on the allowlist — and that refusal is information to show, not a reason to sign
    // anyone out. 403 is "not an admin", which always has a good session behind it.
    if (res.status === 401 && !isSessionValid(readSharedToken())) {
      announceSessionLost();
    }
    // `X-Request-Id` is on every response, even malformed-JSON 400s — it is the handle
    // support uses to find the request in the server logs, so a failure keeps it.
    throw new ApiError(res.status, body, res.headers.get('X-Request-Id') ?? undefined);
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
