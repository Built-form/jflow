/**
 * Scenarios and their adjustments (CONTRACT §6.11). Route strings mirror the contract
 * exactly. Money is DECIMAL strings in both directions (D1); `baseVersion` (D4) is sent
 * whenever the screen knows the row's `rowVersion`.
 *
 * `:itemKey` goes into the path as-is: keys use unreserved URL characters only (§4), so
 * there is nothing to encode — and the screen has already checked it with `lib/keys.ts`.
 *
 * 2026-10-07 (D39–D44): a third kind, `add` — a hypothetical one-off that exists only inside
 * a draft, keyed `new.<its own id>` — created by `POST …/adjustments` and replaced by a PUT
 * on its key; a split (`POST …/adjustments/:itemKey/split`) is a group of ordinary
 * adjustments sharing `splitGroup`; and un-apply (`POST …/unapply`) puts back what an apply
 * wrote and makes the scenario a draft again.
 */

import { request } from './client';
import type { Decimal, Direction, IsoDate, IsoDateTime, ListEnvelope } from './types';
import type { StaleReason } from './forecast';

export type ScenarioStatus = 'draft' | 'applied' | 'archived';
/** `add` (2026-10-07, D39): a hypothetical one-off, keyed `new.<id>`, that exists only in the scenario. */
export type AdjustmentKind = 'adjust' | 'exclude' | 'add';
/** Why un-apply refused a line (§7, D41) — inside `SCENARIO_UNAPPLY_BLOCKED`, never a code of its own. */
export type UnapplyReason = 'TARGET_MISSING' | 'TARGET_SETTLED' | 'CHANGED' | 'NO_RECORD';

export interface Scenario {
  id: number;
  name: string;
  description: string | null;
  /** A view-scope hint only (D20); null = every company. */
  companyId: number | null;
  status: ScenarioStatus | (string & {});
  appliedAt: IsoDateTime | null;
  appliedBy: string | null;
  adjustmentCount: number;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}

export interface Adjustment {
  id: number;
  scenarioId: number;
  itemKey: string;
  /** `new` on an `add`: `targetId` is the row's own id and names no real row (§4). */
  targetKind: 'item' | 'sched' | 'ship' | 'new';
  targetId: string;
  targetDate: IsoDate | null;
  kind: AdjustmentKind;
  /** On an `add`, the one-off's own date and amount. */
  newDate: IsoDate | null;
  newAmount: Decimal | null;
  /** Null on an `add`: there is no real line to compare with (D39). */
  baseDate: IsoDate | null;
  baseAmount: Decimal | null;
  note: string | null;
  /** The `add`'s own one-off (D39); null on `adjust` / `exclude`. */
  accountId: number | null;
  categoryId: number | null;
  direction: Direction | null;
  name: string | null;
  counterparty: string | null;
  currency: string | null;
  /** The anchor adjustment's id on every row of a split (the anchor's own id on the anchor), else null (D40). */
  splitGroup: number | null;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Resolved on reads that resolve targets, and only while the scenario is a draft. */
  stale?: StaleReason | null;
  /** CONTRACT §6.11: the target's current values, with its `name` and `currency`. Always null on an `add`. */
  current?: { date: IsoDate; amount: Decimal; status: string; name?: string | null; currency?: string | null } | null;
}

export interface ScenarioDetail extends Scenario {
  adjustments: Adjustment[];
}

export interface RebasedAdjustment extends Adjustment {
  rebased: boolean;
  dropped: boolean;
}

export interface RebaseResult {
  scenario: Scenario;
  adjustments: RebasedAdjustment[];
}

/** One row apply wrote (§10.9) — or un-apply put back (§10.13, the same shape). An `add` writes a `cash_item`. */
export interface AppliedEntry {
  itemKey: string;
  kind: AdjustmentKind;
  wrote: 'cash_item' | 'schedule_override' | 'external_item';
  entityId: number;
}

export interface ApplyResult {
  scenario: Scenario;
  applied: AppliedEntry[];
}

/** `POST /scenarios/:id/unapply` (D41): the scenario is a draft again. */
export interface UnapplyResult {
  scenario: Scenario;
  unapplied: AppliedEntry[];
}

/** `POST …/adjustments/:itemKey/split` (D40): the anchor first, then one `add` per further part. */
export interface SplitAdjustmentResult {
  splitGroup: number;
  adjustments: Adjustment[];
}

export interface ScenarioCreate {
  name: string;
  description?: string;
  companyId?: number;
}

export interface ScenarioUpdate {
  name?: string;
  description?: string | null;
  companyId?: number | null;
  status?: 'archived';
}

export interface AdjustmentWrite {
  kind: 'adjust' | 'exclude';
  newDate?: IsoDate;
  newAmount?: Decimal;
  note?: string;
}

/**
 * An `add`'s body (§6.11, D43): `POST …/adjustments` creates one, a PUT on its `new.` key
 * replaces it — a FULL replace, so an omitted `counterparty` or `note` is cleared.
 * `currency` defaults to the account's and `direction` to the category's.
 */
export interface AddAdjustmentWrite {
  kind: 'add';
  accountId: number;
  categoryId: number;
  name: string;
  newDate: IsoDate;
  newAmount: Decimal;
  direction?: Direction;
  counterparty?: string;
  currency?: string;
  note?: string;
}

/** One part of a split (D40): `> 0`, today or later. */
export interface SplitPart {
  newDate: IsoDate;
  newAmount: Decimal;
}

/** At least two parts, adding up to the line's real amount; `note` goes on every row of the group. */
export interface SplitWrite {
  parts: SplitPart[];
  note?: string;
}

/** `SCENARIO_STALE` details (§7): each key and why; nothing was written. */
export interface StaleEntry {
  itemKey: string;
  reason: StaleReason | (string & {});
}

/** `SCENARIO_UNAPPLY_BLOCKED` details (§7): each key and why; nothing was written. */
export interface UnapplyBlockedEntry {
  itemKey: string;
  reason: UnapplyReason | (string & {});
}

const versioned = <T extends object>(body: T, baseVersion?: number) =>
  baseVersion === undefined ? body : { ...body, baseVersion };

const deleteBody = (baseVersion?: number) => (baseVersion === undefined ? undefined : { baseVersion });

export interface ScenarioListQuery {
  status?: ScenarioStatus[];
  companyId?: number | null;
  q?: string;
  includeDeleted?: boolean;
}

export const scenarios = {
  /** Sorted `created_at DESC, id DESC` by the server (D28). */
  list: (q: ScenarioListQuery = {}) =>
    request<ListEnvelope<Scenario>>('/scenarios', {
      query: {
        status: q.status?.length ? q.status.join(',') : undefined,
        companyId: q.companyId ?? undefined,
        q: q.q,
        includeDeleted: q.includeDeleted ? 1 : undefined,
        limit: 500,
      },
    }),
  get: (id: number) => request<ScenarioDetail>(`/scenarios/${id}`),
  create: (body: ScenarioCreate) => request<Scenario>('/scenarios', { method: 'POST', body }),
  update: (id: number, body: ScenarioUpdate, baseVersion?: number) =>
    request<Scenario>(`/scenarios/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  /** Soft delete, any status; the adjustments are kept (§2.7). */
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/scenarios/${id}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
  /** A new draft with every adjustment copied as-is (§10.10). */
  duplicate: (id: number, name?: string) =>
    request<Scenario>(`/scenarios/${id}/duplicate`, { method: 'POST', body: name ? { name } : {} }),
  /**
   * Create or replace the adjustment for one key (§10.7); the server sets the bases. On a
   * `new.` key the body is the add's own, in full (§10.7a, D43).
   */
  putAdjustment: (id: number, itemKey: string, body: AdjustmentWrite | AddAdjustmentWrite, baseVersion?: number) =>
    request<Adjustment>(`/scenarios/${id}/adjustments/${itemKey}`, {
      method: 'PUT',
      body: versioned(body, baseVersion),
    }),
  /** The only way to create an `add` (D43): the server assigns its id, and so its `new.` key. */
  addAdjustment: (id: number, body: AddAdjustmentWrite) =>
    request<Adjustment>(`/scenarios/${id}/adjustments`, { method: 'POST', body }),
  /** Hard delete. A split's ANCHOR takes its parts with it; a part goes alone (D40). */
  removeAdjustment: (id: number, itemKey: string, baseVersion?: number) =>
    request<void>(`/scenarios/${id}/adjustments/${itemKey}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
  /**
   * Split one line into dated parts (§10.7b): part 1 resizes (and may move) the line, each
   * further part is a new `add`. Replaces whatever adjustment the key had.
   */
  splitAdjustment: (id: number, itemKey: string, body: SplitWrite, baseVersion?: number) =>
    request<SplitAdjustmentResult>(`/scenarios/${id}/adjustments/${itemKey}/split`, {
      method: 'POST',
      body: versioned(body, baseVersion),
    }),
  rebase: (id: number, dropStale: boolean) =>
    request<RebaseResult>(`/scenarios/${id}/rebase`, { method: 'POST', body: { dropStale } }),
  /** All or nothing (§10.9): a stale adjustment answers 409 `SCENARIO_STALE` and nothing is written. */
  apply: (id: number, baseVersion?: number) =>
    request<ApplyResult>(`/scenarios/${id}/apply`, { method: 'POST', body: versioned({}, baseVersion) }),
  /**
   * All or nothing (§10.13): puts the real plan back as it was before apply and makes the
   * scenario a draft again; 409 `SCENARIO_UNAPPLY_BLOCKED` when anything changed since.
   */
  unapply: (id: number, baseVersion?: number) =>
    request<UnapplyResult>(`/scenarios/${id}/unapply`, { method: 'POST', body: versioned({}, baseVersion) }),
};
