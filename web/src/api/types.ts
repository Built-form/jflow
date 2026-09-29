// Copied from workflows/web/src/api/types.ts — changes: rewritten for JFlow's resources from api/docs/CONTRACT.md §6.1–6.6 (companies, accounts, categories, FX rates, balances); UserType is `standard | admin` (D5); MetaEnums, ErrorCode and ApiErrorBody follow CONTRACT §6.1 and §7; kept AuditRow, AllowedUser, Me and the list/cursor envelopes; dropped every workflows resource (templates, instances, lots, answers, reviews, processes, JFpro)
/**
 * Hand-written from `api/docs/CONTRACT.md` §6 (routes) and §7 (error codes). Responses are
 * the camelCase form of the DB columns (§2.4).
 *
 * Money in these CRUD shapes is a **DECIMAL string** (`"1024.00"`, `"-250.50"`), never a
 * JSON number (D1). Only `/forecast` (step 9) carries integer minor units. Nothing here
 * turns one into a `number`: `src/lib/money.ts` parses them to `bigint` minor units.
 */

/** A DECIMAL(14,2) value as the API sends it: up to two decimals, optional leading minus. */
export type Decimal = string;
/** A DECIMAL(12,6) rate as the API sends it. */
export type RateDecimal = string;
/** A calendar date, `YYYY-MM-DD`, no time zone (§2.5). */
export type IsoDate = string;
/** A DATETIME in UTC, ISO 8601. */
export type IsoDateTime = string;

export type UserType = 'standard' | 'admin';
export type Direction = 'in' | 'out';

/* ---------- identity ---------- */

export interface Me {
  email: string;
  displayName?: string | null;
  type: UserType;
}

export interface AllowedUser {
  email: string;
  displayName?: string | null;
  type: UserType;
  createdAt?: IsoDateTime;
}

export interface Health {
  status: string;
  service: string;
  stage: string;
  database: 'up' | 'down' | 'unknown';
  schema?: 'ready' | 'pending';
  time: IsoDateTime;
}

/** `GET /meta/enums` (§6.1) — the vocabularies §7 and §9 name. */
export interface MetaEnums {
  directions: Direction[];
  itemStatuses: string[];
  overrideStatuses: string[];
  settleModes: string[];
  frequencies: string[];
  weekendRules: string[];
  scheduleStatuses: string[];
  scenarioStatuses: string[];
  adjustmentKinds: string[];
  staleReasons: string[];
  derivedStatuses: string[];
  buckets: string[];
  includeModes: string[];
  targetKinds: string[];
  userTypes: UserType[];
  errorCodes: string[];
  warningCodes: string[];
}

/**
 * The audit row is deliberately raw: the server stores what changed, not a sentence about
 * it (§2.8). Snapshots are the row's own JSON shape.
 */
export interface AuditRow {
  id: number;
  entityType: string;
  entityId: number;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  userEmail?: string | null;
  createdAt: IsoDateTime;
}

/* ---------- reference data (§6.2–6.5) ---------- */

/** Every row carries these (§2.4). */
interface RowMeta {
  id: number;
  rowVersion: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Company extends RowMeta {
  code: string;
  name: string;
  sortOrder: number;
  /**
   * Phase 2 (§6.2): the shipping company this JFlow company maps to, picked in Settings from
   * `GET /external/status` → `companies`; null until mapped. Unique among live companies
   * (409 `SHIPPING_COMPANY_TAKEN`).
   */
  shippingCompanyId: number | null;
  createdBy: string | null;
  deletedAt: IsoDateTime | null;
}

export interface Account extends RowMeta {
  companyId: number;
  name: string;
  currency: string;
  sortOrder: number;
  isActive: boolean;
  isDefault: boolean;
  createdBy: string | null;
  deletedAt: IsoDateTime | null;
  /** Latest recorded balance date — on list and single reads only, never on a mutation response. */
  anchorDate?: IsoDate | null;
  /** The balance recorded on `anchorDate` — same rule. */
  anchorBalance?: Decimal | null;
}

export interface Category extends RowMeta {
  name: string;
  direction: Direction;
  sortOrder: number;
  /**
   * Phase 2 (§6.4, P10): `'ship'` on the seeded "Stock payments" category, else null. A system
   * category is never deletable and its direction never changes (409 `CATEGORY_IN_USE
   * {systemKey}`); its name and order edit freely. Never sent in a body.
   */
  systemKey: string | null;
  createdBy: string | null;
  deletedAt: IsoDateTime | null;
}

/** 1 unit of `currency` = `rateToGbp` GBP. GBP itself never has a row (D3). */
export interface FxRate extends RowMeta {
  currency: string;
  rateToGbp: RateDecimal;
  effectiveFrom: IsoDate;
  note: string | null;
  createdBy: string | null;
}

/** `GET /fx-rates/current?on=` — the rate set the engine would use on `on`; GBP omitted. */
export interface FxCurrent {
  on: IsoDate;
  rates: Record<string, { id: number; rateToGbp: RateDecimal; effectiveFrom: IsoDate }>;
}

/**
 * `balance` is the cash at bank at the START of `balanceDate`, before that day's movements
 * (§6.6). Balances carry `enteredBy`, not `createdBy`, and are hard-deleted.
 */
export interface Balance extends RowMeta {
  accountId: number;
  balanceDate: IsoDate;
  balance: Decimal;
  note: string | null;
  enteredBy: string | null;
}

/* ---------- request bodies ---------- */

export interface CompanyInput {
  code: string;
  name: string;
  sortOrder?: number;
}

/**
 * `PUT /companies/:id` (§6.2). `shippingCompanyId` is a positive id, or null to unmap; it is
 * not checked against the feed (the feed may be down), only for uniqueness.
 */
export type CompanyUpdate = Partial<CompanyInput> & { shippingCompanyId?: number | null };

export interface AccountCreate {
  companyId: number;
  name: string;
  currency: string;
  sortOrder?: number;
  isActive?: boolean;
  isDefault?: boolean;
}

/** `companyId` is immutable once created (§6.3). */
export type AccountUpdate = Partial<Omit<AccountCreate, 'companyId'>>;

export interface CategoryCreate {
  name: string;
  direction: Direction;
  sortOrder?: number;
}

export type CategoryUpdate = Partial<CategoryCreate>;

export interface FxRateCreate {
  currency: string;
  rateToGbp: RateDecimal;
  effectiveFrom: IsoDate;
  note?: string;
}

/** `currency` is immutable (§6.5). A null note clears it. */
export interface FxRateUpdate {
  rateToGbp?: RateDecimal;
  effectiveFrom?: IsoDate;
  note?: string | null;
}

export interface BalanceEntry {
  accountId: number;
  balance: Decimal;
  note?: string;
}

export interface BulkBalances {
  balanceDate: IsoDate;
  entries: BalanceEntry[];
}

/* ---------- envelopes ---------- */

/** Every list of this API answers `{data, page, limit, total}` (§2.2). */
export interface ListEnvelope<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

/** Audit is keyset, not offset — pass `nextCursor` back as `cursor`; null means exhausted. */
export interface CursorEnvelope<T> {
  data: T[];
  limit: number;
  nextCursor: number | null;
}

/* ---------- refusals (§7) ---------- */

export type ErrorCode =
  | 'ADMIN_REQUIRED'
  | 'STALE_WRITE'
  | 'COMPANY_CODE_TAKEN'
  | 'COMPANY_IN_USE'
  | 'ACCOUNT_IN_USE'
  | 'CATEGORY_IN_USE'
  | 'SHIPPING_COMPANY_TAKEN'
  | 'PLANNED_DATE_IN_PAST'
  | 'SHIPPING_UNAVAILABLE'
  | 'FX_RATE_EXISTS'
  | 'ITEM_NOT_EDITABLE'
  | 'BALANCE_DATE_IN_FUTURE'
  | 'PAID_ON_IN_FUTURE'
  | 'PAID_AMOUNT_INVALID'
  | 'REMAINDER_DATE_REQUIRED'
  | 'ITEM_KEY_INVALID'
  | 'ADJUSTMENT_DATE_IN_PAST'
  | 'FX_RATE_MISSING'
  | 'OVERRIDE_HAS_PAYMENT'
  | 'SCHEDULE_STRUCTURE_LOCKED'
  | 'SCHEDULE_HAS_PAYMENTS'
  | 'SCHEDULE_HAS_OVERRIDES'
  | 'SCHEDULE_HAS_ADJUSTMENTS'
  | 'SCENARIO_NOT_DRAFT'
  | 'SCENARIO_STALE'
  | 'TARGET_SETTLED'
  | 'TARGET_MISSING'
  /** Client-side only: the transport could not reach the server at all. */
  | 'NETWORK';

/**
 * One problem with one entry of `POST /balances/bulk` (§6.6 `details.entries[i]`). The
 * contract names the key, not the element's shape, so every field is optional and a bare
 * string is read as the message.
 */
export type EntryProblem =
  | string
  | null
  | {
      index?: number;
      accountId?: number;
      field?: string;
      message?: string;
      error?: string;
    };

export interface ApiErrorBody {
  error: string;
  code?: ErrorCode | string;
  details?: {
    /** `STALE_WRITE`: the row's version under the lock. */
    currentVersion?: number;
    /** `POST /balances/bulk` 400: what is wrong with which entry. */
    entries?: EntryProblem[];
    /** `BALANCE_DATE_IN_FUTURE`. */
    balanceDate?: IsoDate;
    today?: IsoDate;
    /** `*_IN_USE` counts. */
    itemCount?: number;
    scheduleCount?: number;
    balanceCount?: number;
    accountIds?: number[];
    /** `COMPANY_CODE_TAKEN` / `FX_RATE_EXISTS`. */
    companyId?: number;
    fxRateId?: number;
    [k: string]: unknown;
  };
}
