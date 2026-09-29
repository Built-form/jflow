/**
 * One-off items (CONTRACT §6.7): types and request functions.
 *
 * Money is a DECIMAL string both ways (D1). `derivedStatus` is the server's classification
 * of the row against its account's anchor and today (D10, §9.6) — the client groups by it
 * and never computes one. `payments` are the rows behind the `paidOn`/`paidAmount` cache
 * (D23). The shared pay vocabulary (`PayBody`, `Payment`, `SettleMode`, `DerivedStatus`)
 * lives here and the schedule instances in `./schedules` reuse it.
 */

import { request } from './client';
import type { Decimal, Direction, IsoDate, IsoDateTime, ListEnvelope } from './types';

/** `parseListParams`'s ceiling (§2.3). */
const PAGE_LIMIT = 500;

export type ItemStatus = 'expected' | 'part_paid' | 'paid' | 'skipped';
export type SettleMode = 'auto' | 'manual';

/**
 * §9.6's projection, one per item or instance (D10). A `part_paid` row reports its
 * remainder's band and keeps `status: 'part_paid'`. Typed open-ended too: a value this
 * client does not know yet is shown in a group of its own, never dropped.
 */
export type DerivedStatus =
  | 'expected'
  | 'overdue'
  | 'unresolved'
  | 'assumed'
  | 'assumedSettled'
  | 'paid'
  | 'skipped';

/** One pay: `[{id, paidOn, amount, note, createdBy, createdAt}]`, ascending by `paidOn, id`. */
export interface Payment {
  id: number;
  paidOn: IsoDate;
  amount: Decimal;
  note: string | null;
  createdBy: string | null;
  createdAt: IsoDateTime;
}

export interface Item {
  id: number;
  /** `item.<id>` — built by the server (§4); never parsed here. */
  key: string;
  accountId: number;
  /** Read-only, derived through the account. */
  companyId: number;
  categoryId: number;
  direction: Direction;
  name: string;
  counterparty: string | null;
  amount: Decimal;
  currency: string;
  dueDate: IsoDate;
  status: ItemStatus;
  paidOn: IsoDate | null;
  paidAmount: Decimal | null;
  remainingAmount: Decimal;
  payments: Payment[];
  settleMode: SettleMode;
  notes: string | null;
  sourceScenarioId: number | null;
  derivedStatus: DerivedStatus | string;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}

export interface ItemCreate {
  accountId: number;
  categoryId: number;
  name: string;
  amount: Decimal;
  dueDate: IsoDate;
  /** Omitted, it is the category's; sent, it must equal it (D14). */
  direction?: Direction;
  /** Defaults to the account's. */
  currency?: string;
  counterparty?: string | null;
  settleMode?: SettleMode;
  notes?: string | null;
}

/**
 * `PUT /items/:id`. `status` moves only `expected ↔ skipped` (D19); on a paid or part-paid
 * item `status`, `amount` and `currency` are refused (`ITEM_NOT_EDITABLE`). `direction`
 * follows the category. `settleMode: 'manual'` on an assumed-settled item is "Didn't happen".
 */
export interface ItemUpdate {
  accountId?: number;
  categoryId?: number;
  name?: string;
  counterparty?: string | null;
  amount?: Decimal;
  currency?: string;
  dueDate?: IsoDate;
  settleMode?: SettleMode;
  status?: 'expected' | 'skipped';
  notes?: string | null;
}

/**
 * One pay (§6.7, §6.9 — the same body for items and instances). `paidAmount` defaults to
 * what remains; `remainderDueDate` (today or later) moves the due date of what is left and
 * is required for a partial pay on something whose effective date is before today
 * (`REMAINDER_DATE_REQUIRED`).
 */
export interface PayBody {
  paidOn: IsoDate;
  paidAmount?: Decimal;
  note?: string;
  remainderDueDate?: IsoDate;
}

export interface ItemQuery {
  accountId?: number;
  companyId?: number | null;
  categoryId?: number;
  /** Comma list of `ItemStatus`. */
  status?: string;
  settleMode?: SettleMode;
  /** Bound `due_date`. */
  from?: IsoDate;
  to?: IsoDate;
  q?: string;
  includeDeleted?: boolean;
  page?: number;
  limit?: number;
}

/** Optimistic lock (D4): sent when known, omitted otherwise. */
const versioned = <T extends object>(body: T, baseVersion?: number) =>
  baseVersion === undefined ? body : { ...body, baseVersion };

const versionOnly = (baseVersion?: number) => (baseVersion === undefined ? undefined : { baseVersion });

export const items = {
  /** Sorted `due_date, id` by the server (D28); every row carries `derivedStatus`. */
  list: (q: ItemQuery = {}) =>
    request<ListEnvelope<Item>>('/items', {
      query: {
        accountId: q.accountId,
        companyId: q.companyId ?? undefined,
        categoryId: q.categoryId,
        status: q.status,
        settleMode: q.settleMode,
        from: q.from,
        to: q.to,
        q: q.q,
        includeDeleted: q.includeDeleted ? 1 : undefined,
        page: q.page,
        limit: q.limit ?? PAGE_LIMIT,
      },
    }),
  /** Every page, as one envelope — a list that silently stopped at row 500 would hide money. */
  listAll: async (q: Omit<ItemQuery, 'page' | 'limit'> = {}): Promise<ListEnvelope<Item>> => {
    const rows: Item[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const res = await items.list({ ...q, page, limit: PAGE_LIMIT });
      rows.push(...res.data);
      if (res.data.length < PAGE_LIMIT || rows.length >= res.total) break;
    }
    return { data: rows, page: 1, limit: rows.length, total: rows.length };
  },
  get: (id: number) => request<Item>(`/items/${id}`),
  create: (body: ItemCreate) => request<Item>('/items', { method: 'POST', body }),
  update: (id: number, body: ItemUpdate, baseVersion?: number) =>
    request<Item>(`/items/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  /** Soft delete, any status (§6.7, D18). */
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/items/${id}`, { method: 'DELETE', body: versionOnly(baseVersion) }),
  /** One `payments` row; answers the row with its new `payments[]` (§10.3). */
  pay: (id: number, body: PayBody, baseVersion?: number) =>
    request<Item>(`/items/${id}/pay`, { method: 'POST', body: versioned(body, baseVersion) }),
  /** Deletes every payment of the item; answers the row with `payments: []`. */
  unpay: (id: number, baseVersion?: number) =>
    request<Item>(`/items/${id}/unpay`, { method: 'POST', body: versionOnly(baseVersion) ?? {} }),
};
