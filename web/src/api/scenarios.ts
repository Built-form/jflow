/**
 * Scenarios and their adjustments (CONTRACT §6.11). Route strings mirror the contract
 * exactly. Money is DECIMAL strings in both directions (D1); `baseVersion` (D4) is sent
 * whenever the screen knows the row's `rowVersion`.
 *
 * `:itemKey` goes into the path as-is: keys use unreserved URL characters only (§4), so
 * there is nothing to encode — and the screen has already checked it with `lib/keys.ts`.
 */

import { request } from './client';
import type { Decimal, IsoDate, IsoDateTime, ListEnvelope } from './types';
import type { StaleReason } from './forecast';

export type ScenarioStatus = 'draft' | 'applied' | 'archived';
export type AdjustmentKind = 'adjust' | 'exclude';

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
  targetKind: 'item' | 'sched' | 'ship';
  targetId: string;
  targetDate: IsoDate | null;
  kind: AdjustmentKind;
  newDate: IsoDate | null;
  newAmount: Decimal | null;
  baseDate: IsoDate;
  baseAmount: Decimal;
  note: string | null;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Resolved on reads that resolve targets, and only while the scenario is a draft. */
  stale?: StaleReason | null;
  /** CONTRACT §6.11: the target's current values, with its `name` and `currency`. */
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

export interface ApplyResult {
  scenario: Scenario;
  applied: { itemKey: string; kind: AdjustmentKind; wrote: 'cash_item' | 'schedule_override'; entityId: number }[];
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
  kind: AdjustmentKind;
  newDate?: IsoDate;
  newAmount?: Decimal;
  note?: string;
}

/** `SCENARIO_STALE` details (§7): each key and why; nothing was written. */
export interface StaleEntry {
  itemKey: string;
  reason: StaleReason | (string & {});
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
  /** Create or replace the adjustment for one key (§10.7); the server sets the bases. */
  putAdjustment: (id: number, itemKey: string, body: AdjustmentWrite, baseVersion?: number) =>
    request<Adjustment>(`/scenarios/${id}/adjustments/${itemKey}`, {
      method: 'PUT',
      body: versioned(body, baseVersion),
    }),
  removeAdjustment: (id: number, itemKey: string, baseVersion?: number) =>
    request<void>(`/scenarios/${id}/adjustments/${itemKey}`, { method: 'DELETE', body: deleteBody(baseVersion) }),
  rebase: (id: number, dropStale: boolean) =>
    request<RebaseResult>(`/scenarios/${id}/rebase`, { method: 'POST', body: { dropStale } }),
  /** All or nothing (§10.9): a stale adjustment answers 409 `SCENARIO_STALE` and nothing is written. */
  apply: (id: number, baseVersion?: number) =>
    request<ApplyResult>(`/scenarios/${id}/apply`, { method: 'POST', body: versioned({}, baseVersion) }),
};
