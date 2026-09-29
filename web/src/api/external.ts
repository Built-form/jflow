/**
 * The shipping feed and its stock payments (CONTRACT §6.12, Phase 2).
 *
 * JFlow holds a snapshot of shipping's payments forecast (`external_items`) and an OVERLAY
 * on each row — a planned date, a planned amount, "skipped", a note — which is the only
 * thing JFlow writes. The feed columns belong to the refresh. Money is DECIMAL strings in
 * both directions here (D1); `derivedStatus` is the server's band (null = undated, gone or
 * unmapped: nothing was classified).
 *
 * `:key` is a `ship.<ext_id>` key, sent as-is: keys use unreserved characters only (§4), and
 * the caller has checked it with `lib/keys.ts` first.
 */

import { request } from './client';
import type { Decimal, IsoDate, IsoDateTime, ListEnvelope } from './types';
import type { ShipBlocker, ShippingReason } from './forecast';

/** `parseListParams`'s ceiling (§2.3). */
const PAGE_LIMIT = 500;

export type FeedStatus = 'open' | 'paid';

/** §6.12: the band, or null when nothing was classified (undated, gone or unmapped). */
export type ExternalDerivedStatus = 'expected' | 'overdue' | 'unresolved' | 'paid' | 'skipped' | (string & {});

/** One `external_items` row (§6.12 Row JSON). */
export interface ExternalItem {
  /** `ship.<extId>`. */
  key: string;
  id: number;
  source: 'ship' | (string & {});
  extId: string;
  feedKind: 'deposit' | 'balance' | (string & {});
  feedStatus: FeedStatus | (string & {});
  supplier: string | null;
  shippingCompanyId: number | null;
  /** Resolved at read time (§3.4, P5); null when unmapped. */
  companyId: number | null;
  accountId: number | null;
  poId: number | null;
  poNumber: string | null;
  shipmentId: number | null;
  containerRef: string | null;
  currency: string;
  /** Open: still owed. Paid: this payment. */
  amount: Decimal;
  dueDate: IsoDate | null;
  paidOn: IsoDate | null;
  settles: string | null;
  dateBasis: 'firm' | 'estimated' | 'undated' | (string & {});
  amountBasis: 'stated' | 'derived' | (string & {});
  blocked: ShipBlocker | (string & {}) | null;
  flags: string[];
  goneAt: IsoDateTime | null;
  plannedDate: IsoDate | null;
  plannedAmount: Decimal | null;
  plannedSkipped: boolean;
  plannedBaseAmount: Decimal | null;
  plannedNote: string | null;
  sourceScenarioId: number | null;
  plannedBy: string | null;
  plannedAt: IsoDateTime | null;
  /** `plannedDate ?? dueDate` — null when undated. */
  effectiveDate: IsoDate | null;
  effectiveAmount: Decimal;
  /** `plannedAmount` is set but ignored: shipping's amount moved since (P6). */
  planStale: boolean;
  derivedStatus: ExternalDerivedStatus | null;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ShippingCompany {
  id: number;
  name: string;
}

/** `GET /external/status` (§6.12): the `external_sync` row. */
export interface ExternalStatus {
  source: string;
  lastAttemptAt: IsoDateTime | null;
  /** Null until the feed has succeeded once. */
  lastSuccessAt: IsoDateTime | null;
  feedToday: IsoDate | null;
  lastError: string | null;
  itemCount: number;
  rejectedCount: number;
  /** The feed's companies — what Settings offers in the shipping-company picker. */
  companies: ShippingCompany[];
  /** Whether this API has a shipping base and key at all. */
  configured: boolean;
  updatedAt: IsoDateTime | null;
}

/** `POST /external/refresh` 200: `ran: false` when another run held the 60-second claim. */
export interface RefreshResult {
  ran: boolean;
  status: ExternalStatus;
}

/** `SHIPPING_UNAVAILABLE` details (503 on refresh; the forecast warning has the same fields). */
export interface ShippingUnavailable {
  reason: ShippingReason;
  lastSuccessAt: IsoDateTime | null;
}

/**
 * `PUT /external-items/:key` (§6.12, §10.11): a MERGE, like tune — an absent field is left
 * as it is, `null` clears `plannedDate` / `plannedAmount` / `note`.
 */
export interface PlanWrite {
  plannedDate?: IsoDate | null;
  plannedAmount?: Decimal | null;
  skipped?: boolean;
  note?: string | null;
}

export interface ExternalItemQuery {
  status?: FeedStatus[];
  /** null = every company. */
  companyId?: number | null;
  from?: IsoDate;
  to?: IsoDate;
  includeGone?: boolean;
  q?: string;
  page?: number;
  limit?: number;
}

const versioned = <T extends object>(body: T, baseVersion?: number) =>
  baseVersion === undefined ? body : { ...body, baseVersion };

export const external = {
  status: () => request<ExternalStatus>('/external/status'),
  /**
   * Force a refresh now (P4). 503 `SHIPPING_UNAVAILABLE {reason, lastSuccessAt}` when the run
   * fails; the last snapshot is kept. The forecast is re-read afterwards, never patched.
   */
  refresh: () => request<RefreshResult>('/external/refresh', { method: 'POST' }),
  /** Sorted by effective date, undated last, then id (§6.12). */
  list: (q: ExternalItemQuery = {}) =>
    request<ListEnvelope<ExternalItem>>('/external-items', {
      query: {
        status: q.status?.length ? q.status.join(',') : undefined,
        companyId: q.companyId ?? undefined,
        from: q.from,
        to: q.to,
        includeGone: q.includeGone ? 1 : undefined,
        q: q.q,
        page: q.page,
        limit: q.limit ?? PAGE_LIMIT,
      },
    }),
  /** Every page, as one envelope. */
  listAll: async (q: Omit<ExternalItemQuery, 'page' | 'limit'> = {}): Promise<ListEnvelope<ExternalItem>> => {
    const rows: ExternalItem[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const res = await external.list({ ...q, page, limit: PAGE_LIMIT });
      rows.push(...res.data);
      if (res.data.length < PAGE_LIMIT || rows.length >= res.total) break;
    }
    return { data: rows, page: 1, limit: rows.length, total: rows.length };
  },
  /**
   * One row by its key, with the overlay columns and `rowVersion` — what the plan dialog
   * edits (added for step 21 at the coordinator's request; not yet in CONTRACT §6.12).
   */
  get: (key: string) => request<ExternalItem>(`/external-items/${key}`),
  /** Write the overlay; answers the row as the server now holds it. */
  plan: (key: string, body: PlanWrite, baseVersion?: number) =>
    request<ExternalItem>(`/external-items/${key}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  /**
   * "Revert to feed": clears every overlay column (works on a gone row too). Answers the
   * row (step 21); an older server's 204 arrives as `undefined`.
   */
  unplan: (key: string, baseVersion?: number) =>
    request<ExternalItem | undefined>(`/external-items/${key}`, {
      method: 'DELETE',
      body: baseVersion === undefined ? undefined : { baseVersion },
    }),
};
