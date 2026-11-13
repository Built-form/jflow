/**
 * Search, filters and sort for the Stock payments screen. Display only: every row is the
 * server's, already fetched in full (`external.listAll`), and nothing here classifies or
 * moves a figure — the bands stay `derivedStatus`, the amounts stay DECIMAL strings read
 * with `parseMinor`. The view lives in the URL beside `?company=` and `?show=`, so a
 * filtered list is a link someone can send.
 */

import type { ExternalItem } from '../../api/external';
import { formatDay, isValidDate } from '../../lib/dates';
import { blockedText } from '../../lib/ship';
import { formatDecimal, parseMinor } from '../../lib/money';
import { hasOverlay, shipRowName } from '../forecast/shipPlan';

export type SortKey = 'date' | 'supplier' | 'po' | 'container' | 'account' | 'amount';
export interface StockSort {
  key: SortKey;
  dir: 'asc' | 'desc';
}
/** The server's own order (§6.12): effective date ascending, undated last, then id. */
export const DEFAULT_SORT: StockSort = { key: 'date', dir: 'asc' };
const SORT_KEYS: readonly SortKey[] = ['date', 'supplier', 'po', 'container', 'account', 'amount'];

export type MarkFilter =
  | 'planned'
  | 'due_set'
  | 'date_moved'
  | 'blocked'
  | 'estimated'
  | 'plan_stale'
  | 'company_in_jflow'
  | 'from_scenario';
/** An account id, `'none'` for rows no account takes, null for every row. */
export type AccountFilter = number | 'none' | null;

export interface StockFilters {
  q: string;
  /** Bounds on the shown date (`effectiveDate`: the paid date for a paid row), inclusive. */
  from: string | null;
  to: string | null;
  kind: string | null;
  currency: string | null;
  account: AccountFilter;
  mark: MarkFilter | null;
}
export const NO_FILTERS: StockFilters = { q: '', from: null, to: null, kind: null, currency: null, account: null, mark: null };

export type AccountName = (id: number | null) => string | null;

export interface Option<T> {
  value: T;
  label: string;
}
export interface StockFilterOptions {
  kinds: Option<string>[];
  currencies: Option<string>[];
  accounts: Option<number | 'none'>[];
  marks: Option<MarkFilter>[];
}

/**
 * The marks a row can be picked by — the same tags it wears on the screen, read off the
 * same fields (`targetFromRow`, the tag list in StockPaymentsScreen), in that order.
 */
const MARKS: { value: MarkFilter; label: string; has: (row: ExternalItem) => boolean }[] = [
  { value: 'planned', label: 'Planned in JFlow', has: (r) => hasOverlay(r) },
  { value: 'due_set', label: 'Set in shipping', has: (r) => r.dueSet != null },
  { value: 'date_moved', label: 'Date moved', has: (r) => r.dateMoved },
  { value: 'blocked', label: 'Blocked', has: (r) => r.blocked != null },
  { value: 'estimated', label: 'Estimated date', has: (r) => r.dateBasis === 'estimated' },
  { value: 'plan_stale', label: 'Plan ignored', has: (r) => r.planStale },
  { value: 'company_in_jflow', label: 'Company set in JFlow', has: (r) => r.shippingCompanyId == null && r.assignedCompanyId != null },
  { value: 'from_scenario', label: 'From a scenario', has: (r) => r.sourceScenarioId != null },
];

const KIND_LABEL: Record<string, string> = { deposit: 'Deposits', balance: 'Balances', extra: 'Extras', qc: 'QC units' };
const KIND_ORDER = Object.keys(KIND_LABEL);

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

export function hasActiveFilters(f: StockFilters): boolean {
  return (
    words(f.q).length > 0 ||
    f.from != null ||
    f.to != null ||
    f.kind != null ||
    f.currency != null ||
    f.account != null ||
    f.mark != null
  );
}

/** Everything a search can find a row by, lower-cased: what it is, who, where, the money as stored and as shown, the dates as stored and as shown. */
function searchText(row: ExternalItem, accountName: AccountName): string {
  const parts: (string | null | undefined)[] = [
    shipRowName(row),
    row.supplier,
    row.poNumber,
    row.containerRef,
    row.label,
    row.feedKind === 'qc' ? 'QC units' : row.feedKind,
    row.extId,
    accountName(row.accountId),
    row.currency,
    row.plannedNote,
    row.dueSet?.note,
    row.dueSet?.by,
    row.blocked ? blockedText(row.blocked) : null,
    row.effectiveAmount,
    formatDecimal(row.effectiveAmount, row.currency),
    row.amount,
    formatDecimal(row.amount, row.currency),
  ];
  for (const day of [row.effectiveDate, row.dueDate, row.plannedDate, row.paidOn]) {
    if (day) parts.push(day, formatDay(day));
  }
  return parts.filter((p) => p != null && p !== '').join(' \u0000 ').toLowerCase();
}

export function applyStockFilters(rows: ExternalItem[], f: StockFilters, accountName: AccountName): ExternalItem[] {
  const terms = words(f.q);
  const mark = f.mark ? MARKS.find((m) => m.value === f.mark) : null;
  return rows.filter((row) => {
    if (f.from != null || f.to != null) {
      const day = row.effectiveDate;
      if (day == null) return false;
      if (f.from != null && day < f.from) return false;
      if (f.to != null && day > f.to) return false;
    }
    if (f.kind != null && row.feedKind !== f.kind) return false;
    if (f.currency != null && row.currency.toUpperCase() !== f.currency) return false;
    if (f.account === 'none' && row.accountId != null) return false;
    if (typeof f.account === 'number' && row.accountId !== f.account) return false;
    if (mark && !mark.has(row)) return false;
    if (terms.length > 0) {
      const text = searchText(row, accountName);
      if (!terms.every((t) => text.includes(t))) return false;
    }
    return true;
  });
}

const collator = new Intl.Collator('en-GB', { sensitivity: 'base', numeric: true });

/** A comparison where an absent value sorts last in both directions. */
function lastIfAbsent<T>(a: T | null | undefined, b: T | null | undefined, cmp: (x: T, y: T) => number, dir: 1 | -1): number | null {
  const aNone = a == null || a === '';
  const bNone = b == null || b === '';
  if (aNone && bNone) return null;
  if (aNone) return 1;
  if (bNone) return -1;
  const c = cmp(a as T, b as T) * dir;
  return c === 0 ? null : c;
}

const byText = (x: string, y: string) => collator.compare(x, y);
const byDay = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * A sorted copy. Ties fall back to the default order (date ascending, undated last, then
 * id), whatever the direction, so rows never jump about between equal values. Amounts sort
 * by face value: there is no exchange rate here, so $1,000 sits beside £1,000.
 */
export function sortStockRows(rows: ExternalItem[], sort: StockSort, accountName: AccountName): ExternalItem[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const primary = (a: ExternalItem, b: ExternalItem): number | null => {
    switch (sort.key) {
      case 'date':
        return lastIfAbsent(a.effectiveDate, b.effectiveDate, byDay, dir);
      case 'supplier':
        return lastIfAbsent(a.supplier, b.supplier, byText, dir);
      case 'po':
        return lastIfAbsent(a.poNumber, b.poNumber, byText, dir);
      case 'container':
        return lastIfAbsent(a.containerRef, b.containerRef, byText, dir);
      case 'account':
        return lastIfAbsent(accountName(a.accountId), accountName(b.accountId), byText, dir);
      case 'amount':
        return lastIfAbsent(parseMinor(a.effectiveAmount), parseMinor(b.effectiveAmount), (x, y) => (x < y ? -1 : x > y ? 1 : 0), dir);
      default:
        return null;
    }
  };
  return [...rows].sort((a, b) => primary(a, b) ?? lastIfAbsent(a.effectiveDate, b.effectiveDate, byDay, 1) ?? a.id - b.id);
}

/** What the rows show, added per currency in minor units (BigInt, never a float), currencies A–Z. */
export function totalsByCurrency(rows: ExternalItem[]): { currency: string; minor: bigint }[] {
  const sums = new Map<string, bigint>();
  for (const row of rows) {
    const minor = parseMinor(row.effectiveAmount);
    if (minor == null) continue;
    const code = row.currency.toUpperCase();
    sums.set(code, (sums.get(code) ?? 0n) + minor);
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, minor]) => ({ currency, minor }));
}

/** The choices each filter offers: only what occurs in these rows. */
export function filterOptions(rows: ExternalItem[], accountName: AccountName): StockFilterOptions {
  const kinds = new Set<string>();
  const currencies = new Set<string>();
  const accounts = new Map<number, string>();
  let noAccount = false;
  for (const row of rows) {
    kinds.add(row.feedKind);
    currencies.add(row.currency.toUpperCase());
    if (row.accountId == null) noAccount = true;
    else accounts.set(row.accountId, accountName(row.accountId) ?? `Account ${row.accountId}`);
  }
  const rank = (k: string) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length);
  return {
    kinds: [...kinds]
      .sort((a, b) => rank(a) - rank(b) || collator.compare(a, b))
      .map((k) => ({ value: k, label: KIND_LABEL[k] ?? k })),
    currencies: [...currencies].sort().map((c) => ({ value: c, label: c })),
    accounts: [
      ...[...accounts.entries()].sort(([, a], [, b]) => collator.compare(a, b)).map(([id, name]) => ({ value: id, label: name })),
      ...(noAccount ? [{ value: 'none' as const, label: 'No account' }] : []),
    ],
    marks: MARKS.filter((m) => rows.some(m.has)).map(({ value, label }) => ({ value, label })),
  };
}

export const STOCK_PARAMS = { q: 'q', from: 'from', to: 'to', kind: 'kind', currency: 'ccy', account: 'account', mark: 'mark', sort: 'sort' } as const;

export function parseStockParams(p: URLSearchParams): { filters: StockFilters; sort: StockSort } {
  const date = (raw: string | null) => (raw && isValidDate(raw) ? raw : null);
  const kind = p.get(STOCK_PARAMS.kind);
  const ccy = p.get(STOCK_PARAMS.currency);
  const account = p.get(STOCK_PARAMS.account);
  const mark = p.get(STOCK_PARAMS.mark);
  const sortRaw = p.get(STOCK_PARAMS.sort) ?? '';
  const sortKey = sortRaw.replace(/^-/, '') as SortKey;
  return {
    filters: {
      q: p.get(STOCK_PARAMS.q) ?? '',
      from: date(p.get(STOCK_PARAMS.from)),
      to: date(p.get(STOCK_PARAMS.to)),
      kind: kind && /^[a-z_]{1,20}$/.test(kind) ? kind : null,
      currency: ccy && /^[a-z]{3}$/i.test(ccy) ? ccy.toUpperCase() : null,
      account: account === 'none' ? 'none' : account && /^[1-9]\d{0,14}$/.test(account) ? Number(account) : null,
      mark: MARKS.some((m) => m.value === mark) ? (mark as MarkFilter) : null,
    },
    sort: SORT_KEYS.includes(sortKey) ? { key: sortKey, dir: sortRaw.startsWith('-') ? 'desc' : 'asc' } : DEFAULT_SORT,
  };
}

/** A copy of `prev` with the view written in; defaults are left out, every other parameter is kept. */
export function writeStockParams(prev: URLSearchParams, f: StockFilters, sort: StockSort): URLSearchParams {
  const out = new URLSearchParams(prev);
  const put = (name: string, value: string | null) => (value == null || value === '' ? out.delete(name) : out.set(name, value));
  put(STOCK_PARAMS.q, f.q.trim() === '' ? null : f.q);
  put(STOCK_PARAMS.from, f.from);
  put(STOCK_PARAMS.to, f.to);
  put(STOCK_PARAMS.kind, f.kind);
  put(STOCK_PARAMS.currency, f.currency);
  put(STOCK_PARAMS.account, f.account == null ? null : String(f.account));
  put(STOCK_PARAMS.mark, f.mark);
  const isDefault = sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;
  put(STOCK_PARAMS.sort, isDefault ? null : `${sort.dir === 'desc' ? '-' : ''}${sort.key}`);
  return out;
}
