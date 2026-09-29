/**
 * Schedules and their virtual instances (CONTRACT §6.8, §6.9): types and request functions.
 *
 * A schedule's **structure** (D37) is editable in place only while `structureLocked` is
 * false; the server says which, and answers `SCHEDULE_STRUCTURE_LOCKED` otherwise. A change
 * to a used series is a split (§10.5). Instances are identified by their NATURAL date; their
 * `dueDate`/`amount`/`status`/`settleMode` are the effective values the server resolved.
 */

import { request } from './client';
import type { DerivedStatus, PayBody, Payment, SettleMode } from './items';
import type { Decimal, Direction, IsoDate, IsoDateTime, ListEnvelope } from './types';

const PAGE_LIMIT = 500;

export type Frequency = 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'quarterly' | 'annually';
export type WeekendRule = 'none' | 'previous' | 'next';
export type ScheduleStatus = 'active' | 'ended';

export const FREQUENCIES: Frequency[] = ['weekly', 'fortnightly', 'four_weekly', 'monthly', 'quarterly', 'annually'];
export const WEEKEND_RULES: WeekendRule[] = ['none', 'previous', 'next'];

export interface Schedule {
  id: number;
  accountId: number;
  /** Read-only, derived through the account. */
  companyId: number;
  categoryId: number;
  direction: Direction;
  name: string;
  counterparty: string | null;
  amount: Decimal;
  currency: string;
  frequency: Frequency;
  intervalCount: number;
  startDate: IsoDate;
  /** Natural dates before it belong to the predecessor; null = from `startDate` (D21). */
  activeFrom: IsoDate | null;
  occurrenceCount: number | null;
  endDate: IsoDate | null;
  weekendRule: WeekendRule;
  settleMode: SettleMode;
  predecessorId: number | null;
  /** The live schedule split from this one, or null. */
  successorId: number | null;
  status: ScheduleStatus;
  notes: string | null;
  /** `start_date <= today` or an override exists (D37): structure changes need a split. */
  structureLocked: boolean;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}

/** D37's structural fields — what a split's `changes` carries. `activeFrom` is never sent. */
export interface ScheduleStructure {
  amount: Decimal;
  currency: string;
  accountId: number;
  frequency: Frequency;
  intervalCount: number;
  startDate: IsoDate;
  occurrenceCount: number | null;
  endDate: IsoDate | null;
  weekendRule: WeekendRule;
  settleMode: SettleMode;
}

export type StructuralField = keyof ScheduleStructure;

export const STRUCTURAL_FIELDS: StructuralField[] = [
  'amount',
  'currency',
  'accountId',
  'frequency',
  'intervalCount',
  'startDate',
  'occurrenceCount',
  'endDate',
  'weekendRule',
  'settleMode',
];

/** Edit in place always (D37). */
export interface ScheduleDescriptive {
  name: string;
  counterparty: string | null;
  categoryId: number;
  notes: string | null;
}

export interface ScheduleCreate {
  accountId: number;
  categoryId: number;
  name: string;
  amount: Decimal;
  frequency: Frequency;
  startDate: IsoDate;
  intervalCount?: number;
  occurrenceCount?: number | null;
  endDate?: IsoDate | null;
  weekendRule?: WeekendRule;
  settleMode?: SettleMode;
  direction?: Direction;
  currency?: string;
  counterparty?: string | null;
  notes?: string | null;
}

export type ScheduleUpdate = Partial<ScheduleDescriptive & ScheduleStructure>;

/** `SCHEDULE_STRUCTURE_LOCKED`'s details (§6.8). */
export interface StructureLockDetails {
  fields: string[];
  reason: 'started' | 'has_overrides' | string;
  split: string;
}

export interface InstanceOverride {
  id: number;
  amount: Decimal | null;
  dueDate: IsoDate | null;
  status: string | null;
  settleMode: SettleMode | null;
  paidOn: IsoDate | null;
  paidAmount: Decimal | null;
  note: string | null;
  sourceScenarioId: number | null;
  rowVersion: number;
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One virtual instance; `dueDate`, `amount`, `status`, `settleMode` are the effective values. */
export interface Instance {
  key: string;
  scheduleId: number;
  naturalDate: IsoDate;
  dueDate: IsoDate;
  amount: Decimal;
  currency: string;
  direction: Direction;
  status: 'expected' | 'part_paid' | 'paid' | 'skipped' | string;
  settleMode: SettleMode;
  /** An override row exists. */
  tuned: boolean;
  override: InstanceOverride | null;
  payments: Payment[];
  derivedStatus: DerivedStatus | string;
}

export interface OrphanOverride {
  code: 'ORPHAN_OVERRIDE';
  scheduleId: number;
  naturalDate: IsoDate;
  overrideId: number;
}

export interface InstanceList {
  data: Instance[];
  orphans: OrphanOverride[];
}

/**
 * Tune one instance (§6.9): absent = unchanged, `null` = back to the schedule's. `amount`
 * and `status` are refused on a row with payment state (`OVERRIDE_HAS_PAYMENT`).
 */
export interface TuneBody {
  amount?: Decimal | null;
  dueDate?: IsoDate | null;
  note?: string | null;
  settleMode?: SettleMode | null;
  status?: 'expected' | 'skipped' | null;
}

export interface SplitBody {
  fromNaturalDate: IsoDate;
  changes: Partial<ScheduleStructure>;
  dropOverrides?: boolean;
  dropAdjustments?: boolean;
}

export interface SplitResult {
  ended: Schedule;
  successor: Schedule;
  deletedOverrides: IsoDate[];
  rekeyedAdjustments: { scenarioId: number; from: string; to: string }[];
  droppedAdjustments: { scenarioId: number; itemKey: string }[];
}

export interface EndBody {
  lastNaturalDate: IsoDate;
  dropOverrides?: boolean;
  dropAdjustments?: boolean;
}

export interface EndResult {
  ended: Schedule;
  deletedOverrides: IsoDate[];
  droppedAdjustments: { scenarioId: number; itemKey: string }[];
}

/** `SCHEDULE_HAS_ADJUSTMENTS`'s entries (§6.8, §7). */
export interface BlockingAdjustment {
  scenarioId: number;
  scenarioName: string;
  itemKey: string;
  naturalDate: IsoDate;
}

export interface ScheduleQuery {
  accountId?: number;
  companyId?: number | null;
  categoryId?: number;
  /** Comma list of `active, ended`. */
  status?: string;
  settleMode?: SettleMode;
  q?: string;
  includeDeleted?: boolean;
  page?: number;
  limit?: number;
}

const versioned = <T extends object>(body: T, baseVersion?: number) =>
  baseVersion === undefined ? body : { ...body, baseVersion };

const versionOnly = (baseVersion?: number) => (baseVersion === undefined ? undefined : { baseVersion });

const instancePath = (scheduleId: number, naturalDate: IsoDate) =>
  `/schedules/${scheduleId}/instances/${naturalDate}`;

export const schedules = {
  /** Sorted `created_at DESC, id DESC` by the server (D28). */
  list: (q: ScheduleQuery = {}) =>
    request<ListEnvelope<Schedule>>('/schedules', {
      query: {
        accountId: q.accountId,
        companyId: q.companyId ?? undefined,
        categoryId: q.categoryId,
        status: q.status,
        settleMode: q.settleMode,
        q: q.q,
        includeDeleted: q.includeDeleted ? 1 : undefined,
        page: q.page,
        limit: q.limit ?? PAGE_LIMIT,
      },
    }),
  get: (id: number) => request<Schedule>(`/schedules/${id}`),
  create: (body: ScheduleCreate) => request<Schedule>('/schedules', { method: 'POST', body }),
  /** Descriptive fields always; structural ones only while unlocked (`SCHEDULE_STRUCTURE_LOCKED`). */
  update: (id: number, body: ScheduleUpdate, baseVersion?: number) =>
    request<Schedule>(`/schedules/${id}`, { method: 'PUT', body: versioned(body, baseVersion) }),
  remove: (id: number, baseVersion?: number) =>
    request<void>(`/schedules/${id}`, { method: 'DELETE', body: versionOnly(baseVersion) }),
  /** §10.5. The three 409s are answered by resending with `dropOverrides`/`dropAdjustments`. */
  split: (id: number, body: SplitBody, baseVersion?: number) =>
    request<SplitResult>(`/schedules/${id}/split`, { method: 'POST', body: versioned(body, baseVersion) }),
  end: (id: number, body: EndBody, baseVersion?: number) =>
    request<EndResult>(`/schedules/${id}/end`, { method: 'POST', body: versioned(body, baseVersion) }),

  /** D35: the server defaults `from = today − 90d`, `to = today + 365d`; span at most 730 days. */
  instances: (id: number, q: { from?: IsoDate; to?: IsoDate } = {}) =>
    request<InstanceList>(`/schedules/${id}/instances`, { query: { from: q.from, to: q.to } }),
  /** `baseVersion` is checked against the OVERRIDE row when one exists (§10.4). */
  tune: (id: number, naturalDate: IsoDate, body: TuneBody, baseVersion?: number) =>
    request<Instance>(instancePath(id, naturalDate), { method: 'PUT', body: versioned(body, baseVersion) }),
  /** 204; hard-deletes the override (back to predicted). */
  revert: (id: number, naturalDate: IsoDate, baseVersion?: number) =>
    request<void>(instancePath(id, naturalDate), { method: 'DELETE', body: versionOnly(baseVersion) }),
  pay: (id: number, naturalDate: IsoDate, body: PayBody, baseVersion?: number) =>
    request<Instance>(`${instancePath(id, naturalDate)}/pay`, { method: 'POST', body: versioned(body, baseVersion) }),
  unpay: (id: number, naturalDate: IsoDate, baseVersion?: number) =>
    request<Instance>(`${instancePath(id, naturalDate)}/unpay`, {
      method: 'POST',
      body: versionOnly(baseVersion) ?? {},
    }),
};
