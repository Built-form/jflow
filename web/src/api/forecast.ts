/**
 * `GET /forecast` (CONTRACT §6.10) and the two real-data writes the Forecast screen's edit
 * dialog makes when no scenario is open (§6.7 `PUT /items/:id`, §6.9
 * `PUT /schedules/:id/instances/:naturalDate`).
 *
 * `/forecast` is the one route whose money is **integer minor units** (JSON integers,
 * pence for GBP; `Native`/`amountMinor` fields in the line's own currency) — D1. The
 * client turns them into `bigint` with `lib/money.ts` `toMinor` and never does float
 * arithmetic on them. The two writes send DECIMAL strings, like every CRUD route.
 *
 * Every flag, `editable`, band and status here is the server's (CLAUDE.md "Never": no
 * engine rule in a client). The screen renders them; it does not decide them.
 *
 * Phase 2 adds ship lines (`kind: 'ship'`, a `ship` block, the feed flags), the `shipping`
 * block and four warnings. A ship line's real-data edit is the overlay in `./external`.
 */

import { request } from './client';
import type { Decimal, IsoDate, IsoDateTime } from './types';

/** A JSON integer count of minor units. Parse with `toMinor`, never add as a number. */
export type Minor = number;

export type BucketKind = 'day' | 'week' | 'month';
export type IncludeMode = 'summary' | 'grid';
export type LineDirection = 'in' | 'out';
export type StaleReason = 'BASE_CHANGED' | 'TARGET_SETTLED' | 'TARGET_MISSING' | 'DATE_PASSED';

/**
 * §6.10's feed flags on a ship line (Phase 2): `estimated` (shipping's date is an estimate),
 * `blocked` (the feed's `blocked` is set), `planned` (an overlay column is set), `due_set`
 * (the date was set by hand in ShipLine), `date_moved` (the feed's date moved lately). None
 * of them changes a band. `projected` was retired on 2026-10-06; `ShipInfo.amountBasis`
 * still says whether the amount is derived from the terms or stated.
 */
export type ShipFlag = 'estimated' | 'blocked' | 'planned' | 'due_set' | 'date_moved';

/**
 * The story of a due date set by hand on ShipLine's Payments flow page (the feed's
 * `due_set_json`, CONTRACT §3.5; 2026-10-06): who, when, in place of which derived date,
 * for the whole payment or this row alone, and why.
 */
export interface ShipDueSet {
  /** The setter's display name, else the part of the email before @. */
  by: string;
  email: string;
  /** ISO instant of the last change. */
  at: IsoDateTime;
  /** What shipping's model would have said; null when it had no date. */
  derivedDate: IsoDate | null;
  scope: 'payment' | 'item' | (string & {});
  note: string | null;
}

/**
 * §6.10 item flags. A string union for the ones CONTRACT names, open to anything newer so
 * an unknown flag still renders (as its own word) rather than failing a type check.
 */
export type ItemFlag =
  | 'tuned'
  | 'overdue'
  | 'paid'
  | 'partial'
  | 'remainder'
  | 'adjusted'
  | 'excluded'
  /** Scenario set (2026-10-07, D39): a hypothetical one-off, `kind: 'new'`, that exists only in the scenario. */
  | 'added'
  /** Scenario set (D40): the anchor or a part of a split; `splitGroup` says which group. */
  | 'split'
  | 'stale'
  | 'fromScenario'
  /** Left out of this read by `hide` / `hideCategories`: shown, counts nothing. */
  | 'hidden'
  | ShipFlag
  | (string & {});

/** What a blocked ship line waits on (the feed's `blocked`, CONTRACT §3.5). */
export type ShipBlocker = 'shipment' | 'artwork' | 'pi' | 'pi_signed';

/**
 * `rows[].items[].ship` (§6.10, Phase 2): the feed's own view of a ship line, so the client
 * can show what shipping says next to what is planned. `feedDate` is the feed `due_date`
 * (null when shipping has no date), `feedAmountMinor` the feed `amount` in the line's own
 * currency.
 */
export interface ShipInfo {
  kind: 'deposit' | 'balance' | 'extra' | 'qc' | (string & {});
  poNumber: string | null;
  containerRef: string | null;
  dateBasis: 'firm' | 'estimated' | 'undated' | (string & {});
  amountBasis: 'stated' | 'derived' | (string & {});
  blocked: ShipBlocker | (string & {}) | null;
  feedDate: IsoDate | null;
  feedAmountMinor: Minor;
  /** The feed's date was set by hand in ShipLine (flag `due_set`); null when derived. */
  dueSet: ShipDueSet | null;
  /** Flag `date_moved`: the refresh moved the feed's date within the last 14 days — from this date (null = none), at this instant. */
  dateMovedFrom: IsoDate | null;
  dateMovedAt: IsoDateTime | null;
}

export interface ForecastMeta {
  today: IsoDate;
  from: IsoDate;
  to: IsoDate;
  bucket: BucketKind;
  fromClamped: boolean;
  toClamped: boolean;
  companyId: number | 'all';
  scenarioId: number | null;
  include: IncludeMode;
  ratesUsed: Record<string, { rateToGbp: string; effectiveFrom: IsoDate | null }>;
  generatedAt: IsoDateTime;
}

export interface AbsorbedLine {
  key: string;
  name: string;
  categoryId: number;
  date: IsoDate;
  currency: string;
  amountMinor: Minor;
  accountMinor: Minor;
  gbpMinor: Minor;
  direction: LineDirection;
  paymentId?: number;
  flags: ItemFlag[];
}

export interface ForecastAccount {
  accountId: number;
  name: string;
  companyId: number;
  currency: string;
  rateToGbp: string;
  anchorDate: IsoDate;
  anchorAgeDays: number;
  anchorNative: Minor;
  anchorGbp: Minor;
  openingNative: Minor;
  openingGbp: Minor;
  absorbed: AbsorbedLine[];
}

/** One date in `[today, to]`, combined GBP. `baselineClosing` only with a scenario (D34). */
export interface ForecastDay {
  date: IsoDate;
  opening: Minor;
  inflow: Minor;
  outflow: Minor;
  net: Minor;
  closing: Minor;
  baselineClosing?: Minor;
  /** Only with a hide: the day's closing with nothing hidden. */
  fullClosing?: Minor;
}

export interface ForecastBucket {
  start: IsoDate;
  end: IsoDate;
  opening: Minor;
  inflow: Minor;
  outflow: Minor;
  net: Minor;
  closing: Minor;
  /** The lowest DAILY closing inside the bucket — never the bucket's own closing. */
  minClosing: Minor;
  minDate: IsoDate;
}

export interface BaselineLine {
  date: IsoDate;
  amountMinor: Minor;
  gbpMinor: Minor;
  flags: ItemFlag[];
}

/**
 * One forecast LINE. One key may own several lines (a payment line per payment row in
 * the window plus a remainder line), told apart by `flags` and `paymentId` — §6.10.
 */
export interface ForecastItem {
  key: string;
  /** `ship` from Phase 2: a stock payment from the shipping feed (§6.10). */
  kind: 'item' | 'sched' | 'ship' | 'new';
  /**
   * The row id; for a ship line the feed's `ext_id` (a string, CONTRACT D32); for a `new`
   * line (a scenario's hypothetical one-off, D39) its adjustment's id.
   */
  id: number | string;
  scheduleId?: number;
  naturalDate?: IsoDate;
  /** For a ship line, `<supplier> · <poNumber> · deposit|balance` — shown as sent. */
  name: string;
  counterparty: string | null;
  accountId: number;
  currency: string;
  amountMinor: Minor;
  accountMinor: Minor;
  gbpMinor: Minor;
  /** Where the line is PLACED (today for an overdue line, `paidOn` for a payment line). */
  date: IsoDate;
  /** Its effective date before placement (§6.10); differs from `date` only on overdue and payment lines. */
  dueDate?: IsoDate;
  bucketIndex: number;
  status: string;
  settleMode: string;
  flags: ItemFlag[];
  editable: boolean;
  paymentId?: number;
  /** `kind: 'ship'` only. */
  ship?: ShipInfo;
  /**
   * Present only with a scenario: the line's values in the baseline set — null on a `new`
   * line, which has no baseline (D39).
   */
  baseline?: BaselineLine | null;
  /** Present only with a scenario: the anchor adjustment's id when the line is the anchor or a part of a split (D40), else null. */
  splitGroup?: number | null;
}

export interface ForecastRow {
  categoryId: number;
  categoryName: string;
  direction: LineDirection;
  sortOrder: number;
  /** Per bucket, the integer sum of the row's lines' `gbpMinor` — magnitudes. */
  totals: Minor[];
  total: Minor;
  items: ForecastItem[];
}

export interface ForecastSummary {
  opening: Minor;
  inflow: Minor;
  outflow: Minor;
  net: Minor;
  closing: Minor;
  minClosing: Minor;
  minDate: IsoDate;
  unresolvedCount: number;
  unresolvedTotal: Minor;
  absorbedCount: number;
}

export interface BucketDelta {
  start: IsoDate;
  end: IsoDate;
  inflow: Minor;
  outflow: Minor;
  net: Minor;
  closing: Minor;
}

export type ScenarioWarning =
  | { code: 'STALE'; key: string; reason: StaleReason }
  | { code: 'ADJUSTMENT_OUT_OF_SCOPE'; key: string; reason?: undefined }
  | { code: string; key: string; reason?: string };

export interface ForecastScenario {
  id: number;
  name: string;
  status: string;
  baselineSummary: ForecastSummary;
  /** Scenario bucket − baseline bucket. */
  deltaByBucket: BucketDelta[];
  warnings: ScenarioWarning[];
}

/**
 * What a read leaves out (§6.10 `hide`, `hideCategories`; Dev, 2026-10-07): line keys, and
 * whole categories. Nothing is stored — it is a look at the forecast without those rows.
 */
export interface ForecastHide {
  keys: string[];
  categoryIds: number[];
}

/** `hidden` (§6.10): what the hide took out of the window, and the summary with nothing hidden. */
export interface ForecastHidden {
  /** Hidden lines in the window that would otherwise have counted. */
  count: number;
  inflow: Minor;
  outflow: Minor;
  fullSummary: ForecastSummary;
}

export interface UnresolvedLine {
  key: string;
  kind: 'item' | 'sched' | 'ship' | 'new';
  name: string;
  categoryId: number;
  accountId: number;
  currency: string;
  amountMinor: Minor;
  gbpMinor: Minor;
  direction: LineDirection;
  date: IsoDate;
  ageDays: number;
  settleMode: string;
}

/**
 * Why a shipping refresh failed (§6.10 `SHIPPING_UNAVAILABLE`, §7): `unconfigured | timeout |
 * unreachable | http_401 | http_<status> | bad_response`.
 */
export type ShippingReason = 'unconfigured' | 'timeout' | 'unreachable' | 'http_401' | 'bad_response' | (string & {});

/** Why ship rows were left out (§6.10 `SHIP_UNMAPPED.reason`): no company linked, or no account to land on. */
export type ShipUnmappedReason = 'company' | 'account';

export type ForecastWarning =
  | { code: 'NO_ANCHOR'; accountId: number }
  | { code: 'ORPHAN_OVERRIDE'; scheduleId: number; naturalDate: IsoDate; overrideId: number }
  /** The refresh that was due failed; the answer is built on the last snapshot (or none). */
  | { code: 'SHIPPING_UNAVAILABLE'; reason: ShippingReason; lastSuccessAt: IsoDateTime | null }
  /**
   * Ship rows left out. `reason: 'company'`: no JFlow company is linked to this shipping company
   * (null = POs with no company). `reason: 'account'`: JFlow company `companyId` is linked, but has
   * no active account in `currencies` and no active default account.
   */
  | {
      code: 'SHIP_UNMAPPED';
      shippingCompanyId: number | null;
      count: number;
      reason: ShipUnmappedReason;
      companyId?: number;
      currencies?: string[];
    }
  /** A plan (overlay) sits on a row shipping no longer lists. */
  | { code: 'SHIP_PLAN_ORPHANED'; key: string }
  /** The planned amount is ignored: shipping's amount moved since it was set (P6). */
  | { code: 'SHIP_PLAN_STALE'; key: string }
  | { code: string; [field: string]: unknown };

/**
 * `shipping` (§6.10, Phase 2): the feed snapshot's state over this scope; null until the
 * feed has succeeded once. `undatedGbp` is GBP minor units.
 */
export interface ForecastShipping {
  lastSuccessAt: IsoDateTime | null;
  feedToday: IsoDate | null;
  openCount: number;
  undatedCount: number;
  undatedGbp: Minor;
  unmappedCount: number;
}

export interface ForecastResponse {
  meta: ForecastMeta;
  accounts: ForecastAccount[];
  days: ForecastDay[];
  buckets: ForecastBucket[];
  /** Absent (not empty) with `include=summary`. */
  rows?: ForecastRow[];
  summary: ForecastSummary;
  scenario: ForecastScenario | null;
  /** null without a hide; absent from an API older than 2026-10-07. */
  hidden?: ForecastHidden | null;
  unresolved: UnresolvedLine[];
  /** Phase 2; null until the shipping feed has succeeded once. */
  shipping: ForecastShipping | null;
  warnings: ForecastWarning[];
}

export interface ForecastQuery {
  /** null = every company (`all`). */
  companyId: number | null;
  from?: IsoDate;
  to?: IsoDate;
  bucket?: BucketKind;
  scenarioId?: number | null;
  include?: IncludeMode;
  hide?: ForecastHide | null;
}

/** The body of a real-data edit from the grid: only the fields that changed. */
export interface LineEdit {
  amount?: Decimal;
  dueDate?: IsoDate;
}

export const forecast = {
  get: (q: ForecastQuery) =>
    request<ForecastResponse>('/forecast', {
      query: {
        companyId: q.companyId ?? 'all',
        from: q.from,
        to: q.to,
        bucket: q.bucket,
        scenarioId: q.scenarioId ?? undefined,
        include: q.include,
        hide: q.hide?.keys.join(','),
        hideCategories: q.hide?.categoryIds.join(','),
      },
    }),
  /**
   * A one-off's amount or due date (§6.7). The forecast line carries no `rowVersion`, so no
   * `baseVersion` is sent — last write wins (D4). The answer is the item row; the forecast
   * is derived from everything, so the screen re-reads it rather than patching it.
   */
  editItem: (itemId: string, body: LineEdit) =>
    request<unknown>(`/items/${itemId}`, { method: 'PUT', body }),
  /** Tune one instance (§6.9): `amount`/`dueDate` on its override row, created when none. */
  tuneInstance: (scheduleId: string, naturalDate: IsoDate, body: LineEdit) =>
    request<unknown>(`/schedules/${scheduleId}/instances/${naturalDate}`, { method: 'PUT', body }),
};
