// Copied from workflows/web/src/api/index.ts — changes: resources rewritten for JFlow (CONTRACT §6.1–6.6: meta, users, audit, companies, accounts, categories, fxRates, balances); `request`/`ApiError` from ./client kept; `users.setReviewer`, the instance/template audit helpers and every workflows resource dropped; `envelope` moved in from workflows' adapters.ts (the only adapter JFlow needs)
/**
 * One object per resource, so a naming surprise from the API is a one-file fix. Route
 * strings mirror `api/docs/CONTRACT.md` §6 exactly.
 *
 * Money travels as DECIMAL strings in both directions (D1) — nothing here converts one.
 * `baseVersion` (D4) is optional on every PUT/PATCH/DELETE; the screens send the
 * `rowVersion` they last read, so a concurrent edit answers 409 `STALE_WRITE` instead of
 * being overwritten.
 */

import { request } from './client';
import type {
  Account,
  AccountCreate,
  AccountUpdate,
  AllowedUser,
  AuditRow,
  Balance,
  BulkBalances,
  Category,
  CategoryCreate,
  CategoryUpdate,
  Company,
  CompanyInput,
  CompanyUpdate,
  CursorEnvelope,
  FxCurrent,
  FxRate,
  FxRateCreate,
  FxRateUpdate,
  Health,
  IsoDate,
  ListEnvelope,
  Me,
  MetaEnums,
  UserType,
} from './types';

/** The ceiling `parseListParams` allows (§2.3). Reference lists are short; one page holds them. */
export const MAX_LIMIT = 500;

/** A bare array as a one-page envelope, so every list reads `.data`. */
export function envelope<T>(rows: T[]): ListEnvelope<T> {
  return { data: rows, page: 1, limit: rows.length, total: rows.length };
}

/** Optimistic lock (D4): sent when known, omitted otherwise (last write wins). */
const versioned = <T extends object>(body: T, baseVersion?: number) =>
  baseVersion === undefined ? body : { ...body, baseVersion };

const deleteBody = (baseVersion?: number) => (baseVersion === undefined ? undefined : { baseVersion });

/* ---------- meta / identity (§6.1) ---------- */

export const meta = {
  /** First call on boot. */
  me: () => request<Me>('/me'),
  /** Fetch once, cache for the session. Never hard-code a vocabulary this serves. */
  enums: () => request<MetaEnums>('/meta/enums'),
  /**
   * Readiness, not liveness: a 200 with `database:'down'` is the useful answer, so nothing
   * here should treat a 200 as "everything is fine".
   */
  health: () => request<Health>('/health'),
};

export const users = {
  /** Returns a bare array on the wire. */
  list: () => request<AllowedUser[]>('/users').then(envelope),
  create: (body: { email: string; displayName?: string; type?: UserType }) =>
    request<AllowedUser>('/users', { method: 'POST', body }),
  update: (email: string, body: { displayName?: string; type?: UserType }) =>
    request<AllowedUser>(`/users/${encodeURIComponent(email)}`, { method: 'PATCH', body }),
  remove: (email: string) => request<void>(`/users/${encodeURIComponent(email)}`, { method: 'DELETE' }),
};

/* ---------- audit (keyset, never page numbers) ---------- */

export interface AuditQuery {
  entityType?: string;
  entityId?: number;
  action?: string;
  userEmail?: string;
  cursor?: number | null;
  limit?: number;
}

export const audit = {
  list: (q: AuditQuery = {}) =>
    request<CursorEnvelope<AuditRow>>('/audit', { query: { ...q, cursor: q.cursor ?? undefined } }),
};

/* ---------- companies (§6.2) ---------- */

export const companies = {
  list: (q: { q?: string; includeDeleted?: boolean } = {}) =>
    request<ListEnvelope<Company>>('/companies', {
      query: { q: q.q, includeDeleted: q.includeDeleted ? 1 : undefined, limit: MAX_LIMIT },
    }),
  get: (id: number) => request<Company>(`/companies/${id}`),
  create: (body: CompanyInput) => request<Company>('/companies', { method: 'POST', body }),
  update: (id: number, body: CompanyUpdate, baseVersion?: number) =>
    request<Company>(`/companies/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/companies/${id}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
};

/* ---------- accounts (§6.3) ---------- */

export const accounts = {
  list: (q: { companyId?: number | null; isActive?: boolean; q?: string; includeDeleted?: boolean } = {}) =>
    request<ListEnvelope<Account>>('/accounts', {
      query: {
        companyId: q.companyId ?? undefined,
        isActive: q.isActive === undefined ? undefined : q.isActive ? 1 : 0,
        q: q.q,
        includeDeleted: q.includeDeleted ? 1 : undefined,
        limit: MAX_LIMIT,
      },
    }),
  get: (id: number) => request<Account>(`/accounts/${id}`),
  create: (body: AccountCreate) => request<Account>('/accounts', { method: 'POST', body }),
  update: (id: number, body: AccountUpdate, baseVersion?: number) =>
    request<Account>(`/accounts/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
};

/* ---------- categories (§6.4) ---------- */

export const categories = {
  list: (q: { direction?: 'in' | 'out'; q?: string; includeDeleted?: boolean } = {}) =>
    request<ListEnvelope<Category>>('/categories', {
      query: { direction: q.direction, q: q.q, includeDeleted: q.includeDeleted ? 1 : undefined, limit: MAX_LIMIT },
    }),
  get: (id: number) => request<Category>(`/categories/${id}`),
  create: (body: CategoryCreate) => request<Category>('/categories', { method: 'POST', body }),
  update: (id: number, body: CategoryUpdate, baseVersion?: number) =>
    request<Category>(`/categories/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/categories/${id}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
};

/* ---------- FX rates (§6.5) ---------- */

export const fxRates = {
  list: (q: { currency?: string; from?: IsoDate; to?: IsoDate } = {}) =>
    request<ListEnvelope<FxRate>>('/fx-rates', { query: { ...q, limit: MAX_LIMIT } }),
  /** The rate set the engine would use on `on` (defaults to the server's today). */
  current: (on?: IsoDate) => request<FxCurrent>('/fx-rates/current', { query: { on } }),
  get: (id: number) => request<FxRate>(`/fx-rates/${id}`),
  create: (body: FxRateCreate) => request<FxRate>('/fx-rates', { method: 'POST', body }),
  update: (id: number, body: FxRateUpdate, baseVersion?: number) =>
    request<FxRate>(`/fx-rates/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  /** Hard delete (§2.7). */
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/fx-rates/${id}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
};

/* ---------- balances (§6.6) ---------- */

export interface BalanceQuery {
  accountId?: number;
  companyId?: number | null;
  from?: IsoDate;
  to?: IsoDate;
  page?: number;
  limit?: number;
}

export const balances = {
  /** Sorted `balance_date DESC, account_id` by the server. */
  list: (q: BalanceQuery = {}) =>
    request<ListEnvelope<Balance>>('/balances', {
      query: {
        accountId: q.accountId,
        companyId: q.companyId ?? undefined,
        from: q.from,
        to: q.to,
        page: q.page,
        limit: q.limit ?? MAX_LIMIT,
      },
    }),
  /**
   * Every page of a balance read, as one envelope. A year of daily balances across a
   * handful of accounts passes the 500-row page, and a history that silently stopped at
   * row 500 would look like days nobody recorded.
   */
  listAll: async (q: Omit<BalanceQuery, 'page' | 'limit'> = {}): Promise<ListEnvelope<Balance>> => {
    const rows: Balance[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const res = await balances.list({ ...q, page, limit: MAX_LIMIT });
      rows.push(...res.data);
      if (res.data.length < MAX_LIMIT || rows.length >= res.total) break;
    }
    return { data: rows, page: 1, limit: rows.length, total: rows.length };
  },
  /** Create or replace one account's start-of-day balance; the response is the same either way. */
  put: (accountId: number, date: IsoDate, body: { balance: string; note?: string }, baseVersion?: number) =>
    request<Balance>(`/accounts/${accountId}/balances/${date}`, {
      method: 'PUT',
      body: versioned(body, baseVersion),
    }),
  /** One date, many accounts, all-or-nothing. */
  bulk: (body: BulkBalances) => request<{ data: Balance[] }>('/balances/bulk', { method: 'POST', body }),
  /** Hard delete (§2.7). */
  remove: (accountId: number, date: IsoDate, baseVersion?: number) =>
    request<void>(`/accounts/${accountId}/balances/${date}`, {
      method: 'DELETE',
      body: deleteBody(baseVersion),
    }),
};

export const api = {
  meta,
  users,
  audit,
  companies,
  accounts,
  categories,
  fxRates,
  balances,
};

export * from './forecast';
export * from './scenarios';
export * from './items';
export * from './schedules';
export * from './external';
