# JFlow — API and engine contract

Every file under `api/` follows this document. It is derived from `docs/PLAN.md` (the spec)
and `docs/BUILD_PLAN.md` (the build order). Where this file and PLAN.md disagree, PLAN.md
wins and the disagreement is a defect to raise, not a choice to make silently. Where PLAN.md
is silent, §1 below records the decision and its reason.

Paths in this file are relative to `api/` unless they start with `docs/` or `web/`.

Sections: 1 Decisions made here · 2 Conventions · 3 Schema · 4 Item keys · 5 Recurrence ·
6 Routes · 7 Error-code catalogue · 8 Load rules · 9 Engine · 10 Transactions and lock
discipline · 11 Deferred · 12 File map.

---

## 1. Decisions made here (not in PLAN.md) — for Dev's review

Each line is a choice PLAN.md and BUILD_PLAN.md leave open. Where they were silent the
workflows convention was preferred; where that was silent too, the smaller, reversible choice.

| # | Decision | Reason |
|---|---|---|
| D1 | Money in CRUD request and response bodies travels as a **DECIMAL string** with up to two decimals (`"1024.00"`, `"1024"`, `"-250.50"`); a JSON number is a 400. `/forecast` alone uses **integer minor units** (JSON integers, pence). | A JSON number is a float on both ends; the string is what MySQL returns and what `lib/money.js` parses. PLAN fixes `/forecast` to minor units. |
| D2 | Currency codes are `^[A-Z]{3}$`, validated by format only, no ISO table. Every currency has a **minor-unit exponent of 2** in phase 1. | `DECIMAL(14,2)` cannot hold anything else; a 0- or 3-decimal currency is deferred (§11). |
| D3 | GBP has **no `fx_rates` row** and is refused on `POST /fx-rates` (400). The engine treats GBP as rate `1.000000` exactly (`1000000` micro-units) and reports it in `meta.ratesUsed` with `effectiveFrom: null`. | One code path for every currency; a stored GBP rate other than 1 would be a data error waiting to happen. |
| D4 | Optimistic locking uses workflows' names: the JSON field is `rowVersion`, the client sends **`baseVersion`** on `PUT`/`PATCH`/`DELETE`/action routes; it is **optional**. When sent and stale → 409 `STALE_WRITE` with `details.currentVersion`; when omitted, last write wins. Every mutation bumps `row_version`. | Mobile "mark paid" must work without a prior read; the web sends it. Same field names as workflows. |
| D5 | **Roles**: `allowed_emails.type` is `standard \| admin` with the pre-2026-09-16 workflows meaning — `standard` can do everything except user management; `admin` adds user management. Admin-only routes are exactly `POST/PATCH/DELETE /users` and `GET /audit?entityType=allowed_email` (403 `ADMIN_REQUIRED`). No `manager` type, no reviewer flag, no answer-only boundary. The routes table (§6) carries a permission column. **Confirmed by Dev 2026-09-29.** | PLAN says `type standard \| admin` "as workflows"; today's workflows three-type model and its delete-is-admin rule were workflows-specific user decisions. Reversible by one gate. |
| D6 | Week buckets start on **Monday** (ISO week); buckets are calendar-aligned (Mon–Sun, calendar month) and the first and last buckets are clipped to the window, so they may be partial. | UK business week; calendar alignment matches how people read a month. |
| D7 | `include` defaults to `grid`. `bucket` defaults to `week`. `from` defaults to `today`, `to` defaults to `today + 90 days`. | Web is the primary client; mobile passes `include=summary` explicitly. |
| D8 | A `ship.<id>` key is grammar-valid and parses to `target_kind = 'ship'`, but in phase 1 there is nothing behind it: an adjustment `PUT` with a `ship.` key answers 404 `TARGET_MISSING`; an existing `ship.` adjustment (none can exist yet) reads stale `TARGET_MISSING`. | PLAN reserves the grammar for phase 2 and forbids inventing scope. |
| D9 | The 45-day overdue boundary is inclusive: `today − effectiveDate <= 45` is **overdue**, `> 45` is **unresolved**. So `today − 45` is overdue, `today − 46` unresolved. The constant is `OVERDUE_WINDOW_DAYS = 45` in `lib/classify.js`. | BUILD_PLAN's tests fix −44 and −46; inclusive reads naturally as "within 45 days". |
| D10 | `derivedStatus` values are `expected \| overdue \| unresolved \| assumed \| assumedSettled \| paid \| skipped`, one per item or instance, computed by the same `lib/classify.js` call the engine makes (§9.6). A `part_paid` item reports its **remainder's** band (`expected \| overdue \| unresolved`, never `assumed*` — the remainder is forced manual) and keeps `status: 'part_paid'`. | One vocabulary, one function, so `/items` and `/forecast` cannot disagree. |
| D11 | The stale check on a `sched.` target compares `base_date`/`base_amount` against the **override-adjusted** effective values (override `due_date`/`amount` when set, else the weekend-adjusted natural date and the schedule's amount). A tune written after the adjustment therefore reads `BASE_CHANGED`. | "Base = the loader's current pre-adjustment effective values" — the override is part of the base, the adjustment is not. |
| D12 | An account with **no anchor** is excluded from `/forecast` (`NO_ANCHOR`), and for `derivedStatus` on `/items` and `/instances` its anchor is treated as minus infinity: nothing is `assumedSettled`, an auto item before today reads `assumed`. | Without a balance nothing can be known to be in the bank. |
| D13 | `settle_mode` defaults to `auto` on items and schedules. | PLAN describes `manual` as the exception ("Didn't happen"). |
| D14 | `category_id` is `NOT NULL` on items and schedules; a category has `direction in \| out` and an item's or schedule's `direction` must equal its category's (400 otherwise). | Rows in the grid are category → items; an uncategorised item would have no row. NOT NULL can be relaxed later, NULL cannot be tightened. |
| D15 | Reference-data soft deletes are refused while the row is referenced by live data: 409 `COMPANY_IN_USE` (live accounts), `ACCOUNT_IN_USE` (live items, schedules or balances), `CATEGORY_IN_USE` (live items or schedules). Company `code` uniqueness is enforced in code among live rows (409 `COMPANY_CODE_TAKEN`), not by a UNIQUE key, so a deleted code can be reused. | Mirrors workflows' `*_IN_USE` codes; a deleted account would silently drop its items from the forecast. |
| D16 | Setting `isDefault: true` on an account clears the flag on the company's other accounts in the same transaction (audited); no refusal code. | One default per company without a round trip. |
| D17 | `is_active = 0` accounts keep their data but are excluded from `/forecast`, `POST /balances/bulk` defaults and the account pickers. Deactivating (`PUT /accounts/:id {isActive: false}`) is **refused** with 409 `ACCOUNT_IN_USE` while the account has anything `/forecast` would show: a live one-off with `status part_paid`, or `expected` with a `derivedStatus` other than `assumedSettled`; a live schedule that still generates an occurrence on or after today; an instance whose `derivedStatus` is `overdue` or `unresolved`. `details` lists counts and keys (capped at 50 keys per kind). | The flag has to mean something, and switching off an account must never silently drop owed money from the forecast (refuse-or-warn asked by Dev; refuse chosen). |
| D18 | Items, schedules and scenarios are soft-deleted with no in-use guard; a deleted target reads stale `TARGET_MISSING`. There are no restore routes in phase 1 (§11). | Reversible by SQL; restore routes are additive. |
| D19 | Tune (`PUT …/instances/:naturalDate`) also accepts `status: 'expected' \| 'skipped'`, and `PUT /items/:id` accepts `status` moving between `expected` and `skipped` only. `paid`/`part_paid` are written only by pay/unpay. | Scenario apply writes `status = 'skipped'` on these rows; there must be a hand door to the same state and back. |
| D20 | A scenario `company_id` is a **view-scope hint** only. `/forecast` never refuses a scope mismatch; an adjustment whose target is outside the requested account set is loaded (so the stale check is truthful), applied to nothing, and reported in `scenario.warnings` as `ADJUSTMENT_OUT_OF_SCOPE`. | Apply, rebase and the stale check are not company-scoped operations. |
| D21 | Split: `fromNaturalDate` must be an occurrence strictly after the schedule's first **active** occurrence (400 otherwise). **Month-end identity survives a split** through `schedules.active_from`: when `changes` leaves `frequency`, `intervalCount`, `startDate` and `weekendRule` untouched, the successor gets `start_date = old.start_date`, `active_from = k`, and inherits `occurrence_count`/`end_date` verbatim unless `changes` sets one — so a monthly series from 31 Jan split at 30 Jun keeps yielding 31 Jul, 31 Aug. Otherwise `start_date = changes.startDate ?? k`, `active_from = NULL`, and the successor inherits the remaining end (`end_date`, or `occurrence_count` minus the occurrences before *k*) unless `changes` sets one. A successor's `start_date <= today`, so it is born structure-locked (D37). End: `lastNaturalDate` must be an occurrence; *k* is the next occurrence after it. | Occurrence *n* is always computed from `start_date` (§5.1); restarting the series at *k* would move every month-end date. The first instance is edited in place while the schedule is unused, or the schedule is deleted. |
| D22 | A schedule may carry `occurrence_count` **or** `end_date`, not both (400). Split and end both go through `endBefore(schedule, k)`, which writes `end_date = k − 1 day` and `occurrence_count = NULL` on the old row. `status = 'ended'` marks a series closed by split or end; ended schedules still project their occurrences up to their end. | Two ends would need a precedence rule; one writer for both actions. |
| D23 | **Payments are rows.** Every pay inserts one `payments` row (`paid_on`, `amount`) under the parent `cash_items` row or `schedule_overrides` row; `paid_amount = SUM(payments.amount)` and `paid_on = MAX(payments.paid_on)` on the parent are a **denormalised cache** rewritten in the same transaction as every payment write. Status becomes `paid` when the cache reaches `amount`, else `part_paid`. The classifier runs **each payment row** on its own `paid_on`, so a payment made before the anchor is excluded while a later one is included. A remainder date moves the item's `due_date` (one-off) or the override's `due_date` (instance). Unpay hard-deletes every payment row of the parent (one audit row each), resets the cache and the status, and does not restore an earlier `due_date`. | A single cached `paid_on` placed the whole paid amount at the latest date: 1,000 item, 400 paid at A−5, 300 at A+2 → 700 absorbed although 400 was already inside the anchor (Dev, 2026-09-29). |
| D24 | `?today=` outside local/test is **ignored**, not refused; `meta.today` always reports the date used. | A stray parameter must not break a deployed client; the response says what happened. |
| D25 | `to` beyond `today + 730 days` is clamped and `meta.toClamped` says so, mirroring `fromClamped`. | PLAN says "capped", not "refused". |
| D26 | Companies are seeded as `('JFA', 'JFA', 1)` and `('HW', 'Hangerworld', 2)` (code, name, sort_order) with an idempotent `INSERT … SELECT … WHERE NOT EXISTS`. **Confirmed by Dev 2026-09-29.** | Short codes; the migration must be re-runnable. |
| D27 | `withTransaction` retries on `ER_LOCK_DEADLOCK` **by default** (`retryOnDeadlock = 1`). | PLAN mandates the retry; JFlow has no out-of-transaction side effects (no events), so it is safe for every caller. |
| D28 | Dated lists (`/items`, `/balances`, `/schedules/:id/instances`) sort by date ascending then id; reference lists by `sort_order, name`; `/schedules` and `/scenarios` by `created_at DESC, id DESC` (workflows' default). | A cashflow list is read by date. |
| D29 | Unknown body fields are ignored; unknown query parameters are ignored. | Workflows' behaviour. |
| D30 | An excluded item still appears in a scenario's `rows[]` with flag `excluded` and contributes nothing to any total. | The grid must show what the scenario removed, and offer the undo. |
| D31 | **Every override row of a loaded schedule is loaded**, whatever its dates or columns (§8 rule 3). This replaces PLAN's two override rules ("due_date in the window" and "carries a status or a payment amount"). | PLAN's rules load nothing for an amount-only override (the headline June 983 tune), for an override moving an instance out of the window, or for a settle-mode-only "Didn't happen" row; overrides are few per schedule, so loading them all is cheap and complete. |
| D32 | `target_id` is `VARCHAR(64)`: the decimal string of the id for `item`/`sched`, the raw id for `ship`. Queries bind the string form. | `ship.` ids are not numeric. |
| D33 | A write of an adjustment against a target that is not `expected` answers 409 `TARGET_SETTLED`; against a target that does not exist, 404 `TARGET_MISSING`. The same names as the stale reasons. | One vocabulary for "why this adjustment cannot stand". |
| D34 | `days[]` carries `baselineClosing` when a scenario is requested, so the chart draws both lines from one series. | PLAN's chart is baseline vs scenario; nothing else in the shape gives a daily baseline. |
| D35 | `GET /schedules/:id/instances` defaults to `from = today − 90d`, `to = today + 365d`, span at most 730 days (400 otherwise). | Bounded reads; the forecast window has the same cap. |
| D36 | Scenario status: `archived` is set by `PUT /scenarios/:id {status: 'archived'}` from `draft` or `applied` and is terminal in phase 1; rework by duplicate. | PLAN names the status but no transition. |
| D37 | **Schedule structure** = `amount, currency, accountId, frequency, intervalCount, startDate, occurrenceCount, endDate, weekendRule, settleMode`. Editable in place only while `start_date > today` **and** no override row exists for the schedule; otherwise 409 `SCHEDULE_STRUCTURE_LOCKED` naming the fields. `name, counterparty, categoryId, notes` edit in place always. `occurrenceCount`/`endDate` are structural: a used schedule is shortened only through `POST …/end`; extending one is a new schedule (or a split whose `changes` set the end). A split's successor has `start_date <= today` and is therefore born locked. **`settleMode` stays structural** (a review proposed making it editable in place — rejected): flipping a used schedule between `auto` and `manual` would retroactively reclassify past instances — auto→manual floods overdue/unresolved with up to 730 days of instances, manual→auto silently assumes owed instances settled. A split from *k* changes it forward only; per-instance "Didn't happen" is the override's `settle_mode`. | BUILD_PLAN step 5's list, plus the two end fields, which change which natural dates exist exactly as frequency does. |
| D38 | A fourth stale reason, **`DATE_PASSED`**: an `adjust` whose `new_date < today` at read time. Checked in §9.5 and again in apply's re-check; rebase cannot fix it (the user must re-date), so `dropStale: true` removes `TARGET_SETTLED`, `TARGET_MISSING` **and** `DATE_PASSED` adjustments. | A stale `new_date` would otherwise place a scenario line before today, which §9.10 forbids (Dev, 2026-09-29). |

---

## 2. Conventions

### 2.1 Transport, auth, identity

- One Express app (`src/handlers/jflow.js`), `serverless-http` export, function `jflowApi`,
  runtime `nodejs22.x`, region eu-north-1, `ANY /api/v1/{proxy+}` behind the shared Google
  JWT authorizer plus the unauthenticated `OPTIONS` CORS shim. Everything below is under
  `/api/v1`.
- Auth middleware as workflows: the JWT email claim, normalised (trim + lowercase), must
  exist in `allowed_emails` → else 401 `{error}`. `/api/v1/health` skips the allowlist lookup
  only. Local bypass: `IS_LOCAL = !AWS_LAMBDA_FUNCTION_NAME && (IS_OFFLINE || NODE_ENV === 'development')`
  → `req.userEmail = 'local@dev'`, type read from the row if present, else `admin`.
- `allowed_emails.type` is `standard | admin`. `standard` may do everything except the
  admin-only routes (D5). Every response carries `X-User-Type` and `X-Request-Id`
  (caller's sanitised `x-request-id`, else API Gateway's request id, else a UUID).
- `Cache-Control: no-store` on every response. Body limit 1 MB (`express.json({limit: '1mb'})`);
  no uploads exist.
- Every route awaits `schemaReady`; in Lambda it resolves at once (no DDL ever runs there);
  locally it runs `ensureSchema` once per container.

### 2.2 Envelopes and status codes

| Situation | Status | Body |
|---|---|---|
| Read, update, action | 200 | the resource (or the documented shape) |
| Create | 201 | the resource |
| Delete, revert | 204 | none |
| Validation failure (shape, type, range, enum, malformed JSON) | 400 | `{error, details?}` — message-only unless the catalogue names a code |
| Not signed in / not on the allowlist | 401 | `{error}` |
| Admin-only route | 403 | `{error, code: 'ADMIN_REQUIRED'}` |
| No such live row (also a malformed path id) | 404 | `{error}` or `{error, code}` where the catalogue names one |
| State conflict (locks, structure, stale, in use) | 409 | `{error, code, details?}` |
| Payload too large | 413 | `{error}` |
| Business rule on otherwise valid input (dates, amounts, keys, FX) | 422 | `{error, code, details?}` |
| Unhandled | 500 | `{error: 'An internal error occurred.', requestId}` |

`fail(res, status, message, code?, details?)` and `apiError(status, code, message, details?)`
from `lib/shape.js` build every refusal; a refusal thrown inside `withTransaction` rolls it
back. `error` is one line safe to show as-is; `code` is the stable machine string.

Lists: `{data, page, limit, total}` via `listResponse`. `GET /audit` alone is keyset:
`{data, limit, nextCursor}`.

### 2.3 List parameters

`parseListParams`: `page` ≥ 1 (default 1), `limit` 1..500 (default 100). `includeDeleted=1`
drops the `deleted_at IS NULL` filter on lists and single reads of soft-deletable tables.
`q` is `LIKE %q%` over the fields named on the route. Status filters accept a comma list;
an unknown value is a message-only 400. Sort per D28. Path ids go through `parseId`
(positive integer) — anything else is 404.

### 2.4 Casing and types

- DB is `snake_case`; JSON is `camelCase`. Every read passes a `toJson` mapper in
  `lib/shape.js`; a column rename is one line there.
- `TINYINT(1)` → boolean. `DATE` → `'YYYY-MM-DD'` string (pool `dateStrings: ['DATE']`).
  `DATETIME` is UTC (pool `timezone: 'Z'`) → ISO 8601 string. `DECIMAL` → string (D1).
  `BIGINT UNSIGNED` ids → JSON number.
- Row JSON always carries `id, rowVersion, createdBy, createdAt, updatedAt` and, on
  soft-deletable tables, `deletedAt` (`bank_balances` carries `enteredBy` instead of
  `createdBy`, per PLAN).
- Enums are `VARCHAR` validated in code from one list per vocabulary, exported to
  `GET /meta/enums`.

### 2.5 Dates

- Every date on the wire and in the engine is a `'YYYY-MM-DD'` string that must be a real
  calendar date (400 otherwise). Nothing carries a time zone.
- Arithmetic is on **epoch days** (`lib/dates.js`): `toEpochDay`, `fromEpochDay`, `addDays`,
  `diffDays(a, b) = epoch(a) − epoch(b)`, `dayOfWeek` (1970-01-01 was a Thursday),
  `isWeekend`, `addMonthsClamped(date, n)` (§5), `isValidDate`. No `Date` object is ever
  used for a calendar day; comparisons are string comparisons or epoch-day comparisons.
- `today` is the Europe/London calendar date from `Intl.DateTimeFormat('en-CA',
  {timeZone: 'Europe/London'})`, computed **once per request in the route** and passed down
  to services, the loader and the engine as an argument. Nothing below the route reads a
  clock. `?today=YYYY-MM-DD` overrides it only when `IS_LOCAL || NODE_ENV === 'test'`
  (D24).

### 2.6 Money

- Storage is `DECIMAL(14,2)`; rates are `DECIMAL(12,6)`. mysql2 returns them as strings and
  they are never coerced to `Number`.
- `lib/money.js`: `parseMinor(str)` → `bigint` minor units (grammar
  `^-?\d{1,12}(\.\d{1,2})?$`, else throws → 400); `formatMinor(bigint)` → `"1024.00"`;
  `parseRate(str)` → `bigint` micro-units (grammar `^\d{1,6}(\.\d{1,6})?$`, `> 0`);
  `roundHalfUp(numerator, denominator)` on `bigint` — half away from zero, applied to the
  magnitude, sign restored; `toGbp(nativeMinor, rateMicro) = roundHalfUp(nativeMinor × rateMicro, 1_000_000n)`;
  `fromGbp(gbpMinor, rateMicro) = roundHalfUp(gbpMinor × 1_000_000n, rateMicro)`.
- No float touches money anywhere: not in routes, not in tests' expected values.
- `amount`, `paidAmount`, `newAmount`, `rateToGbp` must be `> 0`; `balance` may be
  negative (overdraft). `direction in | out` carries the sign; the engine adds `in` and
  subtracts `out`.
- `/forecast` money is JSON integers in **minor units**. GBP figures are pence; fields
  suffixed `Native`/`amountMinor` are in the row's own currency.

### 2.7 Soft vs hard delete

| Table | Delete | Guard |
|---|---|---|
| `companies`, `bank_accounts`, `categories` | soft (`deleted_at`) | `*_IN_USE` (D15) |
| `cash_items`, `schedules`, `scenarios` | soft | none (D18); a deleted scenario keeps its adjustments |
| `bank_balances` | **hard**; audit row carries the before-snapshot | none |
| `fx_rates` | **hard**; audit row carries the before-snapshot | none |
| `schedule_overrides` | **hard** = revert to predicted | `OVERRIDE_HAS_PAYMENT` while the row carries payment state |
| `payments` | **hard**, only by unpay (all rows of the parent); audit row per payment with the before-snapshot | none — the parent's lock serialises it |
| `scenario_adjustments` | **hard**, only while the scenario is `draft` | `SCENARIO_NOT_DRAFT` otherwise |
| `allowed_emails` | hard | self-lockout and last-admin guards as workflows |

Soft-deleted rows are invisible to every read without `includeDeleted=1`, to the loader,
and to every lock-and-check (`WHERE id = ? AND deleted_at IS NULL FOR UPDATE`).

### 2.8 Audit

`lib/audit.js` is workflows' copy: `recordAudit(conn, {entityType, entityId, action, before,
after, userEmail})` diffs the snapshots, skips a no-op `update`, never throws;
`recordAuditBulk` for the split's many rows. **One audit row per mutated row**, written
inside the mutation's transaction. Snapshots are the row's JSON shape (camelCase).

| `entity_type` | Actions |
|---|---|
| `company`, `bank_account`, `category`, `fx_rate` | `create`, `update`, `delete` |
| `bank_balance` | `create`, `update`, `delete` |
| `cash_item` | `create`, `update`, `delete`, `pay`, `unpay`, `apply` |
| `schedule` | `create`, `update`, `delete`, `split`, `end` |
| `schedule_override` | `create`, `update` (tune), `delete` (revert or dropped by split), `pay`, `unpay`, `apply` |
| `payment` | `create` (pay), `delete` (unpay) — `before`/`after` = `{cashItemId, overrideId, paidOn, amount, note}` |
| `scenario` | `create`, `update`, `delete`, `duplicate`, `rebase`, `apply` |
| `scenario_adjustment` | `create`, `update` (edit, rebase, re-key), `delete` |
| `allowed_email` | `create`, `update`, `delete` — `entity_id` 0, email in the JSON |

### 2.9 `row_version`, `created_by`

Every table except `jflow_schema_meta`, `allowed_emails`, `audit_log` and `payments`
(append-only rows: inserted by pay, deleted by unpay, never updated) has
`row_version INT NOT NULL DEFAULT 0`; every UPDATE sets `row_version = row_version + 1`.
`created_by` is the caller's email on insert (`entered_by` on balances). Optimistic lock
per D4: `baseVersion` optional; sent and `≠ row_version` under the row lock →
409 `STALE_WRITE {currentVersion}`.

### 2.10 Users and allowlist

As workflows with two types: `GET /users` bare array (cap 500, `?page=`); `POST /users`
`{email, type?, displayName?}` (default `standard`); `PATCH /users/:email` `{type?,
displayName?}`; `DELETE /users/:email`. Guards: an admin may not remove their own access nor
demote themselves (400); the whole admin set is locked `FOR UPDATE` and a change that would
leave zero admins is 409. `BOOTSTRAP_ADMIN_EMAILS` are seeded `admin` by `tools/migrate.js`
and by local `ensureSchema`.

---

## 3. Schema

### 3.1 Migration rules

- One file, `src/db/migrations/2026-09-29_jflow_core.sql`, every statement
  `CREATE TABLE IF NOT EXISTS`, plus the idempotent company seed. Later files use the
  `information_schema` guard pattern of workflows' `2026-09-08_stages.sql`
  (`SET @missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS …); PREPARE/EXECUTE`).
- DDL runs from `tools/migrate.js --stage <stage>` (called by `deploy.sh` before packaging;
  it keeps `schema_migrations(filename, checksum, applied_at)` and refuses a changed applied
  file) and from local `ensureSchema` (`lib/schema.js`, sentinel `jflow_schema_meta`,
  `IS_LOCAL` only). **The deployed Lambda never runs DDL.**
- No foreign keys. No MySQL ENUMs. `DEFAULT CHARSET=utf8mb4` on every table. All
  `DATETIME` are UTC.
- Money `DECIMAL(14,2)`; rates `DECIMAL(12,6)`; dates `DATE`; ids `BIGINT UNSIGNED
  AUTO_INCREMENT`; emails `VARCHAR(255)`; enums `VARCHAR(n)`.
- `schema_migrations` is created by `migrate.js` itself; a fully migrated schema holds
  15 tables (14 below + that one).

### 3.2 Tables

Timestamp trio used below: `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`,
`updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
`deleted_at DATETIME NULL` (soft-deletable tables only).

```sql
CREATE TABLE IF NOT EXISTS jflow_schema_meta (             -- as workflows
  k VARCHAR(64) NOT NULL PRIMARY KEY, v VARCHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS allowed_emails (                -- as workflows, two types
  email VARCHAR(255) NOT NULL PRIMARY KEY,
  type  VARCHAR(32) NOT NULL DEFAULT 'standard',           -- standard | admin
  display_name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (                     -- as workflows
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(64) NOT NULL,                        -- §2.8
  entity_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(32) NOT NULL,
  before_json JSON NULL, after_json JSON NULL,
  reason VARCHAR(500) NULL,                                -- reserved, unused in phase 1
  user_email VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_entity (entity_type, entity_id), KEY idx_created (created_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,                               -- ^[A-Z0-9_]{1,16}$, unique among live rows (code-enforced)
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …, deleted_at DATETIME NULL,
  KEY idx_code (code), KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  currency CHAR(3) NOT NULL,                               -- ^[A-Z]{3}$
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,                -- at most one per company (D16)
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …, deleted_at DATETIME NULL,
  KEY idx_company (company_id, deleted_at), KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bank_balances (                 -- HARD delete
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  balance_date DATE NOT NULL,                              -- <= today on write
  balance DECIMAL(14,2) NOT NULL,                          -- cash at bank at the START of balance_date
  note VARCHAR(500) NULL,
  entered_by VARCHAR(255) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_at …, updated_at …,
  UNIQUE KEY uniq_account_date (account_id, balance_date)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fx_rates (                      -- HARD delete
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  currency CHAR(3) NOT NULL,                               -- never 'GBP' (D3)
  rate_to_gbp DECIMAL(12,6) NOT NULL,                      -- 1 unit of currency = rate_to_gbp GBP
  effective_from DATE NOT NULL,
  note VARCHAR(500) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …,
  UNIQUE KEY uniq_currency_from (currency, effective_from)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  direction VARCHAR(8) NOT NULL,                           -- in | out
  sort_order INT NOT NULL DEFAULT 0,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …, deleted_at DATETIME NULL,
  KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cash_items (                    -- one-offs; company is derived through the account
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(8) NOT NULL,                           -- in | out, equals the category's
  name VARCHAR(255) NOT NULL,
  counterparty VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,                           -- > 0
  currency CHAR(3) NOT NULL,                               -- defaults to the account's
  due_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'expected',          -- expected | part_paid | paid | skipped
  paid_on DATE NULL,                                       -- cache: MAX(payments.paid_on) (D23)
  paid_amount DECIMAL(14,2) NULL,                          -- cache: SUM(payments.amount)
  settle_mode VARCHAR(8) NOT NULL DEFAULT 'auto',          -- auto | manual
  notes TEXT NULL,
  source_scenario_id BIGINT UNSIGNED NULL,                 -- stamped by scenario apply
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …, deleted_at DATETIME NULL,
  KEY idx_account_status_due (account_id, status, due_date),
  KEY idx_status_due (status, due_date),
  KEY idx_paid_on (paid_on),
  KEY idx_category (category_id),
  KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schedules (                     -- recurring rules; company is derived through the account
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(8) NOT NULL,                           -- in | out
  name VARCHAR(255) NOT NULL,
  counterparty VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,                           -- > 0
  currency CHAR(3) NOT NULL,
  frequency VARCHAR(16) NOT NULL,                          -- weekly | fortnightly | four_weekly | monthly | quarterly | annually
  interval_count INT NOT NULL DEFAULT 1,                   -- >= 1
  start_date DATE NOT NULL,                                -- occurrence 0; n always counts from here (§5.1)
  active_from DATE NULL,                                   -- natural dates < active_from belong to the predecessor; NULL = from start_date (D21)
  occurrence_count INT NULL,                               -- >= 1; NULL = open-ended (D22: not with end_date)
  end_date DATE NULL,                                      -- last natural date allowed
  weekend_rule VARCHAR(8) NOT NULL DEFAULT 'none',         -- none | previous | next
  settle_mode VARCHAR(8) NOT NULL DEFAULT 'auto',          -- auto | manual
  predecessor_id BIGINT UNSIGNED NULL,                     -- the schedule this one was split from
  status VARCHAR(16) NOT NULL DEFAULT 'active',            -- active | ended
  notes TEXT NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …, deleted_at DATETIME NULL,
  KEY idx_account_status (account_id, status),
  KEY idx_predecessor (predecessor_id),
  KEY idx_category (category_id),
  KEY idx_deleted (deleted_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schedule_overrides (            -- one per tuned instance; HARD delete = revert
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  schedule_id BIGINT UNSIGNED NOT NULL,
  natural_date DATE NOT NULL,                              -- the instance's identity (unadjusted date)
  amount DECIMAL(14,2) NULL,                               -- NULL = the schedule's
  due_date DATE NULL,                                      -- NULL = weekend-adjusted natural date; set = verbatim
  status VARCHAR(16) NULL,                                 -- NULL = expected | expected | part_paid | paid | skipped
  settle_mode VARCHAR(8) NULL,                             -- NULL = the schedule's | auto | manual
  paid_on DATE NULL,                                       -- cache: MAX(payments.paid_on) (D23)
  paid_amount DECIMAL(14,2) NULL,                          -- cache: SUM(payments.amount)
  note VARCHAR(500) NULL,
  source_scenario_id BIGINT UNSIGNED NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …,
  UNIQUE KEY uniq_schedule_natural (schedule_id, natural_date),
  KEY idx_status (status)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (                      -- one row per payment; HARD delete by unpay only
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cash_item_id BIGINT UNSIGNED NULL,                       -- exactly one of cash_item_id / override_id is set (code-validated, no FK)
  override_id BIGINT UNSIGNED NULL,
  paid_on DATE NOT NULL,                                   -- <= today at write
  amount DECIMAL(14,2) NOT NULL,                           -- > 0
  note VARCHAR(500) NULL,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cash_item (cash_item_id),
  KEY idx_override (override_id),
  KEY idx_paid_on (paid_on)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scenarios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  company_id BIGINT UNSIGNED NULL,                         -- view scope hint (D20); NULL = all
  status VARCHAR(16) NOT NULL DEFAULT 'draft',             -- draft | applied | archived
  applied_at DATETIME NULL,
  applied_by VARCHAR(255) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …, deleted_at DATETIME NULL,
  KEY idx_status (status, deleted_at), KEY idx_company (company_id)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scenario_adjustments (          -- HARD delete while the scenario is draft; immutable after
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scenario_id BIGINT UNSIGNED NOT NULL,
  item_key VARCHAR(80) NOT NULL,                           -- §4, verbatim
  target_kind VARCHAR(8) NOT NULL,                         -- item | sched | ship
  target_id VARCHAR(64) NOT NULL,                          -- parsed id (D32)
  target_date DATE NULL,                                   -- natural date for sched, else NULL
  kind VARCHAR(8) NOT NULL,                                -- adjust | exclude
  new_date DATE NULL,                                      -- adjust: >= today at write
  new_amount DECIMAL(14,2) NULL,                           -- adjust: > 0
  base_date DATE NOT NULL,                                 -- target's effective date at write / rebase
  base_amount DECIMAL(14,2) NOT NULL,                      -- target's effective amount at write / rebase
  note VARCHAR(500) NULL,
  row_version INT NOT NULL DEFAULT 0,
  created_by VARCHAR(255) NULL,
  created_at …, updated_at …,
  UNIQUE KEY uniq_scenario_key (scenario_id, item_key),
  KEY idx_target (target_kind, target_id)
) DEFAULT CHARSET=utf8mb4;
```

### 3.3 Seed (in the same migration file)

```sql
INSERT INTO companies (code, name, sort_order)
SELECT 'JFA', 'JFA', 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM companies WHERE code = 'JFA');
INSERT INTO companies (code, name, sort_order)
SELECT 'HW', 'Hangerworld', 2 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM companies WHERE code = 'HW');
```

### 3.4 Derived, never stored

- Remaining amount = `amount − COALESCE(paid_amount, 0)`, where `paid_amount` is the cache
  of `SUM(payments.amount)` for the row (D23) and `paid_on` the cache of
  `MAX(payments.paid_on)`; both are rewritten in the same transaction as every payment
  insert or delete, so a reader may trust them without joining `payments`.
- An instance's effective amount = `override.amount ?? schedule.amount`; effective date =
  `override.due_date ?? weekendAdjust(natural_date, schedule.weekend_rule)`; effective
  status = `override.status ?? 'expected'`; effective settle mode =
  `override.settle_mode ?? schedule.settle_mode`.
- Company of an item or schedule = its account's company.
- "Payment state" on an override row = `status IN ('paid', 'part_paid') OR paid_amount > 0
  OR paid_on IS NOT NULL` (PLAN's payment guard predicate, used everywhere the phrase
  appears). It reads the cache columns only; because the cache is rewritten in the same
  transaction as every `payments` write under the parent's lock, the guard needs no join.
- **Currencies in scope** (for `FX_RATE_MISSING` and `meta.ratesUsed`) = the in-scope
  accounts' currencies ∪ the currencies of every loaded item and schedule, adjustment
  targets included. Defined once here; §6.10, §8 and §9.7 refer to it.

---

## 4. Item keys (`lib/keys.js`)

A key names one forecast line across the API, the grid, the audit log and
`scenario_adjustments.item_key`. It uses **unreserved URL characters only**
(`A-Z a-z 0-9 - . _ ~`), so it is safe in a path, a log line and through API Gateway with
no encoding. `lib/keys.js` is the **only** builder and parser; no route, service or client
pattern-matches a key string itself.

| Kind | Grammar (exact regex) | Example | Parsed form |
|---|---|---|---|
| one-off item | `^item\.([1-9][0-9]{0,17})$` | `item.123` | `{targetKind: 'item', targetId: '123', targetDate: null}` |
| schedule instance | `^sched\.([1-9][0-9]{0,17})\.([0-9]{4}-[0-9]{2}-[0-9]{2})$` and the date is a real calendar date | `sched.45.2026-06-01` | `{targetKind: 'sched', targetId: '45', targetDate: '2026-06-01'}` |
| shipping payment (phase 2) | `^ship\.([A-Za-z0-9_-]{1,64})$` | `ship.PO-778` | `{targetKind: 'ship', targetId: 'PO-778', targetDate: null}` |

- `targetDate` is the instance's **natural** date, never its effective date.
- Total length ≤ 80 (`item_key VARCHAR(80)`).
- API:
  `buildItemKey(id)`, `buildSchedKey(scheduleId, naturalDate)`, `buildShipKey(id)`,
  `parseKey(key)` → the parsed form or `null`, `isValidKey(key)`,
  `formatKey(parsed)` (the inverse of `parseKey`; round-trips exactly).
- Any route receiving a key that `parseKey` rejects answers **422 `ITEM_KEY_INVALID`**
  (`details {key}`). Numeric ids have no leading zeros and no sign. `#`, `:`, `/`, spaces
  and anything outside the unreserved set are rejected.
- The `target_kind / target_id / target_date` columns hold the parsed form, written by the
  adjustment route from `parseKey`, so every lookup is an indexed equality on
  `(target_kind, target_id)` plus `target_date`, never a `LIKE`.

---

## 5. Recurrence (`lib/recurrence.js`, pure)

### 5.1 Natural dates

Occurrence *n* (0-based) of a schedule:

| `frequency` | Natural date of occurrence *n* |
|---|---|
| `weekly` | `addDays(start_date, 7 × interval_count × n)` |
| `fortnightly` | `addDays(start_date, 14 × interval_count × n)` |
| `four_weekly` | `addDays(start_date, 28 × interval_count × n)` |
| `monthly` | `addMonthsClamped(start_date, 1 × interval_count × n)` |
| `quarterly` | `addMonthsClamped(start_date, 3 × interval_count × n)` |
| `annually` | `addMonthsClamped(start_date, 12 × interval_count × n)` |

`addMonthsClamped(date, m)` (in `lib/dates.js`): add `m` months to the year/month of `date`,
keep the day of month, and clamp it to the last day of the resulting month. It is **always
computed from `start_date`, never chained** from the previous occurrence: a monthly
schedule starting 31 Jan yields 31 Jan → 28 Feb (29 in a leap year) → 31 Mar → 30 Apr,
because each is `addMonthsClamped('YYYY-01-31', n)`.

`interval_count >= 1` (default 1). Occurrence 0 is `start_date` itself.

### 5.2 Ends

- `occurrence_count = N` → occurrences `n < N`.
- `end_date = E` → occurrences whose natural date `<= E`.
- Both NULL → open-ended (the loader bounds it by the window, §8). Both set → 400 (D22).
- `status = 'ended'` changes nothing about generation; it records that the series was
  closed by a split or an end action and the end fields say where.

### 5.3 Weekend rule and effective date

`weekendAdjust(date, rule)`: `none` → `date`; `previous` → Saturday → Friday, Sunday →
Friday; `next` → Saturday → Monday, Sunday → Monday; weekdays unchanged.

**Effective date of an instance** = `override.due_date` **verbatim when set** (the weekend
rule is bypassed — a person chose that date) else `weekendAdjust(natural_date,
schedule.weekend_rule)`. This is the one definition (§3.4); the loader, the engine, the
instances route and the stale check all use it.

### 5.4 Functions

| Function | Meaning |
|---|---|
| `occurrences(schedule, from, to)` | natural dates with `from <= natural <= to`, ascending, honouring the end **and `active_from`** (natural dates `< active_from` are excluded — they belong to the predecessor); `[]` when `to < start_date` |
| `isOccurrence(schedule, date)` | true iff `date` equals some occurrence's natural date `>= active_from` (when set), including the end check — a date past `end_date`, beyond `occurrence_count`, or before `active_from` is **not** an occurrence |
| `occurrenceIndex(schedule, date)` | the *n* of `date` counted from `start_date`, or `-1` when `isOccurrence` is false |
| `firstActiveOccurrence(schedule)` | the first natural date `>= COALESCE(active_from, start_date)` |
| `endBefore(schedule, k, {keepSeries})` | `{endDate: addDays(k, −1), occurrenceCount: null, successor: …}` — what split and end write on the old row (D22) and what the split offers the successor (D21). `keepSeries = true` (frequency, interval, start and weekend rule untouched): `successor = {startDate: schedule.start_date, activeFrom: k, occurrenceCount: schedule.occurrence_count, endDate: schedule.end_date}` — *n* still counts from `start_date`, so the count inherits verbatim. `keepSeries = false`: `successor = {startDate: k, activeFrom: null, occurrenceCount: schedule.occurrence_count == null ? null : schedule.occurrence_count − occurrenceIndex(schedule, k), endDate: schedule.end_date}` |
| `nextOccurrenceAfter(schedule, date)` | the first natural date `> date` and `>= active_from`, or `null` |

Unit test fixed here (§5, with BUILD_PLAN step 3's): monthly from `2026-01-31`, an
amount-only split from `2026-06-30` yields a successor with `start_date = 2026-01-31`,
`active_from = 2026-06-30` whose occurrences are `2026-06-30, 2026-07-31, 2026-08-31, …`;
`isOccurrence(successor, '2026-06-30')` is true and `isOccurrence(successor, '2026-05-31')`
is false; the predecessor ends `2026-06-29` and `isOccurrence(predecessor, '2026-06-30')` is
false.

`schedule` is the row shape (snake_case or the camelCase JSON; the functions accept both
via one normaliser). These files import nothing from `db/`.

### 5.5 Orphan overrides

An override row whose `natural_date` is not an occurrence of its schedule (`isOccurrence`
false — wrong date, or past the schedule's end after a split or end) is **never projected**.
The engine and `GET /schedules/:id/instances` return it as warning
`{code: 'ORPHAN_OVERRIDE', scheduleId, naturalDate, overrideId}`; it is not an error. The
split transaction deletes overrides from *k* so it normally leaves none, and the payment
guard means an orphan never carries payment state unless written by hand.

---

## 6. Routes

All under `/api/v1`, Google JWT + allowlist. Permission column: `any` = every allowlisted
account (`standard` or `admin`); `admin` = `ADMIN_REQUIRED` otherwise. Every mutation runs
in **one** `withTransaction` per request, writes its audit row(s) inside it, and returns
the updated resource unless the row says 204. `baseVersion` (D4) is accepted on every
`PUT`, `PATCH`, `DELETE` and action `POST` against a `row_version` row. Money fields are
DECIMAL strings (D1) except on `/forecast`.

### 6.1 Health, me, meta, users, audit (from workflows)

| Method, path | Perm | Request | Response / refusals |
|---|---|---|---|
| `GET /health` | token only | — | 200 `{status: 'ok', service: 'jflow', stage, database: 'up'\|'down', schema: 'ready'\|'pending', time}` |
| `GET /me` | any | — | `{email, displayName, type}` |
| `GET /meta/enums` | any | — | `{directions, itemStatuses, overrideStatuses, settleModes, frequencies, weekendRules, scheduleStatuses, scenarioStatuses, adjustmentKinds, staleReasons, derivedStatuses, buckets, includeModes, targetKinds, userTypes, errorCodes, warningCodes}` — the vocabularies §7 and §9 name |
| `GET /users?limit&page` | any | — | bare array `[{email, type, displayName, createdAt}]`, cap 500 |
| `POST /users` | admin | `{email, type?, displayName?}` | 201 row; 400 invalid email / type; 409 already listed. Audit `allowed_email`/`create` |
| `PATCH /users/:email` | admin | `{type?, displayName?}` | 200 row; 400 nothing to update / self-demotion; 404; 409 last admin. Audit `update` |
| `DELETE /users/:email` | admin | — | 204; 400 own email; 404; 409 last admin. Audit `delete` |
| `GET /audit?entityType&entityId&action&userEmail&cursor&limit` | any (`entityType=allowed_email` admin; non-admins never see those rows) | — | `{data: [{id, entityType, entityId, action, before, after, reason, userEmail, createdAt}], limit, nextCursor}` newest first |

### 6.2 Companies

Row JSON: `{id, code, name, sortOrder, rowVersion, createdBy, createdAt, updatedAt, deletedAt}`.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /companies?q&includeDeleted&page&limit` | any | — | list, sorted `sort_order, name`; `q` over `code, name` | — |
| `POST /companies` | any | `{code, name, sortOrder?}` | 201; 400 code grammar / blank name; 409 `COMPANY_CODE_TAKEN {companyId}` among live rows | `company`/`create` |
| `GET /companies/:id` | any | — | row; 404 | — |
| `PUT /companies/:id` | any | `{code?, name?, sortOrder?, baseVersion?}` | row; same 400/409; 409 `STALE_WRITE` | `update` |
| `DELETE /companies/:id` | any | `{baseVersion?}` | 204 soft; 409 `COMPANY_IN_USE {accountIds}` while any live account belongs to it | `delete` |

Code is upper-cased and trimmed on write. The two seeded companies are ordinary rows.

### 6.3 Accounts

Row JSON: `{id, companyId, name, currency, sortOrder, isActive, isDefault, rowVersion, createdBy, createdAt, updatedAt, deletedAt, anchorDate?, anchorBalance?}` — `anchorDate`/`anchorBalance` (latest recorded balance, or null) ride on the list and single read; not on mutation responses.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /accounts?companyId&isActive&q&includeDeleted&page&limit` | any | — | list sorted `company sort_order, sort_order, name` | — |
| `POST /accounts` | any | `{companyId, name, currency, sortOrder?, isActive?, isDefault?}` | 201; 400 (company not live, currency grammar); `isDefault: true` clears the company's other defaults (D16) | `bank_account`/`create` (+ `update` on each cleared account) |
| `GET /accounts/:id` | any | — | row; 404 | — |
| `PUT /accounts/:id` | any | `{name?, currency?, sortOrder?, isActive?, isDefault?, baseVersion?}` | row; `currency` change refused 409 `ACCOUNT_IN_USE` while live items, schedules or balances exist (their currencies would no longer match); `isActive: false` refused 409 `ACCOUNT_IN_USE {owedItems: {count, keys}, liveSchedules: {count, ids}, owedInstances: {count, keys}}` (keys capped at 50 per kind) while the account has a live one-off with `status part_paid` or `expected` with a `derivedStatus` other than `assumedSettled`, a live schedule with an occurrence on or after today, or an instance whose `derivedStatus` is `overdue`/`unresolved` (D17); `companyId` is immutable (400). Sibling defaults cleared by `isDefault: true` are locked ascending by id | `update` |
| `DELETE /accounts/:id` | any | `{baseVersion?}` | 204 soft; 409 `ACCOUNT_IN_USE {itemCount, scheduleCount, balanceCount}` | `delete` |

### 6.4 Categories

Row JSON: `{id, name, direction, sortOrder, rowVersion, createdBy, createdAt, updatedAt, deletedAt}`.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /categories?direction&q&includeDeleted&page&limit` | any | — | list sorted `direction, sort_order, name` | — |
| `POST /categories` | any | `{name, direction, sortOrder?}` | 201; 400 | `category`/`create` |
| `GET /categories/:id` | any | — | row; 404 | — |
| `PUT /categories/:id` | any | `{name?, sortOrder?, baseVersion?}` | row; `direction` immutable once any live item or schedule uses the category (409 `CATEGORY_IN_USE`), else editable | `update` |
| `DELETE /categories/:id` | any | `{baseVersion?}` | 204 soft; 409 `CATEGORY_IN_USE {itemCount, scheduleCount}` | `delete` |

### 6.5 FX rates

Row JSON: `{id, currency, rateToGbp, effectiveFrom, note, rowVersion, createdBy, createdAt, updatedAt}`. `rateToGbp` is a DECIMAL string with up to six decimals: 1 unit of `currency` = `rateToGbp` GBP.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /fx-rates?currency&from&to&page&limit` | any | — | list sorted `currency, effective_from DESC`; `from`/`to` bound `effective_from` | — |
| `GET /fx-rates/current?on=YYYY-MM-DD` | any | `on` defaults to `today` | `{on, rates: {EUR: {id, rateToGbp, effectiveFrom}, …}}` — the rate set the engine would use on `on` (§9.7); GBP omitted | — |
| `POST /fx-rates` | any | `{currency, rateToGbp, effectiveFrom, note?}` | 201; 400 grammar, `currency = 'GBP'` (D3); 409 `FX_RATE_EXISTS {fxRateId}` on `(currency, effective_from)` | `fx_rate`/`create` |
| `GET /fx-rates/:id` | any | — | row; 404 | — |
| `PUT /fx-rates/:id` | any | `{rateToGbp?, effectiveFrom?, note?, baseVersion?}` | row; 409 `FX_RATE_EXISTS` when the move collides; `currency` immutable (400) | `update` |
| `DELETE /fx-rates/:id` | any | `{baseVersion?}` | 204 **hard**; audit `before` = full row | `delete` |

### 6.6 Balances

Row JSON: `{id, accountId, balanceDate, balance, note, enteredBy, rowVersion, createdAt, updatedAt}`.
**`balance` is the cash at bank at the START of `balanceDate`**, before that day's
movements. Entry screens label it "Cash at bank at start of day".

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /balances?accountId&companyId&from&to&page&limit` | any | — | list sorted `balance_date DESC, account_id`; filters optional | — |
| `PUT /accounts/:id/balances/:date` | any | `{balance, note?, baseVersion?}` | 200 row (created or replaced — the response is the same); 404 account not live; 400 date grammar / balance grammar; 422 `BALANCE_DATE_IN_FUTURE {balanceDate, today}` when `:date > today` | `bank_balance`/`create` or `update` |
| `POST /balances/bulk` | any | `{balanceDate, entries: [{accountId, balance, note?}]}` (1..200 entries, distinct accounts, every account live and active) | 200 `{data: [rows]}` all-or-nothing; 400 on any bad entry (`details.entries[i]`); 422 `BALANCE_DATE_IN_FUTURE` | one row per entry |
| `DELETE /accounts/:id/balances/:date` | any | `{baseVersion?}` | 204 **hard**; 404 | `delete` with `before` = full row |

Deleting or correcting a balance changes the anchor and therefore what is "assumed
settled"; nothing else needs rewriting (§9).

### 6.7 Items (one-offs)

Row JSON: `{id, key, accountId, companyId, categoryId, direction, name, counterparty, amount,
currency, dueDate, status, paidOn, paidAmount, remainingAmount, payments, settleMode, notes,
sourceScenarioId, derivedStatus, rowVersion, createdBy, createdAt, updatedAt, deletedAt}`.
`key` is `buildItemKey(id)`; `companyId` is read-only, derived through the account;
`payments` = `[{id, paidOn, amount, note, createdBy, createdAt}]` ascending by `paidOn, id`
(the rows behind the `paidOn`/`paidAmount` cache, D23);
`remainingAmount` is derived (§3.4); `derivedStatus` is §9.6's classification of the row
against its account's anchor (`A` = latest `bank_balances.balance_date` for the account,
D12 when none) and `today` — one `classify` call per row, never a second rule.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /items?accountId&companyId&categoryId&status&settleMode&from&to&q&includeDeleted&page&limit` | any | `from`/`to` bound `due_date`; `status` comma list | list sorted `due_date, id`; every row carries `derivedStatus` | — |
| `POST /items` | any | `{accountId, categoryId, name, amount, dueDate, direction?, currency?, counterparty?, settleMode?, notes?}` | 201; 400: account/category not live, `direction` given but ≠ category's (D14 — omitted it is the category's), amount `<= 0`, currency grammar, date grammar. `currency` defaults to the account's; `settleMode` to `auto`; `status` is `expected` | `cash_item`/`create` |
| `GET /items/:id` | any | — | row; 404 | — |
| `PUT /items/:id` | any | `{accountId?, categoryId?, name?, counterparty?, amount?, currency?, dueDate?, settleMode?, status?, notes?, baseVersion?}` | row. `status` may move only `expected ↔ skipped` (D19), 409 `ITEM_NOT_EDITABLE {status}` when the item is `paid`/`part_paid` and `status`, `amount` or `currency` is sent (pay/unpay own those); `direction` follows the category. `settleMode: 'manual'` on an `assumedSettled` item is "Didn't happen" | `update` |
| `DELETE /items/:id` | any | `{baseVersion?}` | 204 soft (any status) | `delete` |
| `POST /items/:id/pay` | any | `{paidOn, paidAmount?, note?, remainderDueDate?, baseVersion?}` | row with the new `payments[]` entry. §10.3: inserts one `payments` row, rewrites the cache, sets `paid`/`part_paid`. 422 `PAID_ON_IN_FUTURE {paidOn, today}`; 422 `PAID_AMOUNT_INVALID {paidAmount, remainingAmount}`; 422 `REMAINDER_DATE_REQUIRED {dueDate, today}`; 400 `remainderDueDate < today` or not a date | `cash_item`/`pay` + `payment`/`create` |
| `POST /items/:id/unpay` | any | `{baseVersion?}` | row with `payments: []`; deletes every payment row of the item; idempotent 200 on an `expected` item | `cash_item`/`unpay` + `payment`/`delete` per row (skipped when nothing changed) |

### 6.8 Schedules

Row JSON: `{id, accountId, companyId, categoryId, direction, name, counterparty, amount,
currency, frequency, intervalCount, startDate, activeFrom, occurrenceCount, endDate, weekendRule,
settleMode, predecessorId, successorId, status, notes, structureLocked, rowVersion,
createdBy, createdAt, updatedAt, deletedAt}`. `successorId` = the live schedule whose
`predecessor_id` is this id (or null); `activeFrom` per D21 (null except on a series-keeping
successor); `structureLocked` = `start_date <= today OR an override row exists` (D37), so
the client knows before it tries — a split's successor is born locked.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /schedules?accountId&companyId&categoryId&status&settleMode&q&includeDeleted&page&limit` | any | `status` comma list of `active, ended` | list sorted `created_at DESC, id DESC` | — |
| `POST /schedules` | any | `{accountId, categoryId, name, amount, frequency, startDate, intervalCount?, occurrenceCount?, endDate?, weekendRule?, settleMode?, direction?, currency?, counterparty?, notes?}` | 201; 400 as items plus: frequency/weekend enum, `intervalCount < 1`, `occurrenceCount < 1`, both ends set (D22), `endDate < startDate` | `schedule`/`create` |
| `GET /schedules/:id` | any | — | row; 404 | — |
| `PUT /schedules/:id` | any | descriptive `{name?, counterparty?, categoryId?, notes?}` always; structural `{amount?, currency?, accountId?, frequency?, intervalCount?, startDate?, occurrenceCount?, endDate?, weekendRule?, settleMode?}` only while unlocked; `baseVersion?` | row; 409 `SCHEDULE_STRUCTURE_LOCKED {fields, reason: 'started' \| 'has_overrides', split: '/schedules/:id/split'}` when a structural field **changes** and the schedule is locked (an unchanged structural value in the body is not a change) | `update` |
| `DELETE /schedules/:id` | any | `{baseVersion?}` | 204 soft | `delete` |
| `POST /schedules/:id/split` | any | `{fromNaturalDate, changes: {…structural fields…}, dropOverrides?, dropAdjustments?, baseVersion?}` — `changes` must contain at least one structural field; `activeFrom` is never accepted in `changes` (server-set, D21) | 201 `{ended: <old row>, successor: <new row>, deletedOverrides: [naturalDate…], rekeyedAdjustments: [{scenarioId, from, to}], droppedAdjustments: [{scenarioId, itemKey}]}`. §10.5. 400 `fromNaturalDate` not an occurrence strictly after the first active occurrence (D21); 409 `SCHEDULE_HAS_PAYMENTS {naturalDates}`; 409 `SCHEDULE_HAS_OVERRIDES {naturalDates}`; 409 `SCHEDULE_HAS_ADJUSTMENTS {adjustments: [{scenarioId, scenarioName, itemKey, naturalDate}]}` listing only the adjustments that cannot be re-keyed (§10.5 step 5) | `schedule`/`split` on the old row, `create` on the successor, one `schedule_override`/`delete` per dropped override, one `scenario_adjustment`/`update` per re-key or `delete` per drop |
| `POST /schedules/:id/end` | any | `{lastNaturalDate, dropOverrides?, dropAdjustments?, baseVersion?}` | 200 `{ended: <row>, deletedOverrides, droppedAdjustments}`; same guards from *k* = `nextOccurrenceAfter(schedule, lastNaturalDate)` (400 when `lastNaturalDate` is not an occurrence; 200 no-op when nothing follows it); the old row is ended through `endBefore(schedule, k)` exactly as a split (D22); an end never re-keys, so `SCHEDULE_HAS_ADJUSTMENTS` always applies unless `dropAdjustments` | `schedule`/`end` + the per-row audits |

### 6.9 Instances (virtual, expanded at read time)

Instance JSON: `{key, scheduleId, naturalDate, dueDate, amount, currency, direction, status,
settleMode, tuned, override, payments, derivedStatus}` — `dueDate`/`amount`/`status`/`settleMode` are the
**effective** values (§3.4); `tuned` = an override row exists; `override` = `{id, amount, dueDate,
status, settleMode, paidOn, paidAmount, note, sourceScenarioId, rowVersion, createdBy, createdAt,
updatedAt}` or `null`; `payments` = `[{id, paidOn, amount, note, createdBy, createdAt}]` of the
override row (`[]` when none); `key` = `buildSchedKey(scheduleId, naturalDate)`.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /schedules/:id/instances?from&to` | any | D35 defaults; span ≤ 730 days | `{data: [instance…] ascending by naturalDate, orphans: [{code: 'ORPHAN_OVERRIDE', scheduleId, naturalDate, overrideId}]}`; every instance carries `derivedStatus` from the same `classify` call as `/forecast` (settle mode resolved as §3.4 by the route, then passed in) | — |
| `PUT /schedules/:id/instances/:naturalDate` | any | tune: `{amount?, dueDate?, note?, settleMode?, status?, baseVersion?}` — `null` clears a field back to the schedule's | 200 instance. §10.4. 404 not an occurrence; 400 nothing left non-null; 409 `OVERRIDE_HAS_PAYMENT` when `amount` or `status` is sent on a row with payment state (`dueDate`, `note`, `settleMode` stay editable); `status` only `expected \| skipped` (D19). `settleMode: 'manual'` is "Didn't happen" for an instance | `schedule_override`/`create` or `update` |
| `DELETE /schedules/:id/instances/:naturalDate` | any | revert `{baseVersion?}` | 204 **hard**; 404 no override row; 409 `OVERRIDE_HAS_PAYMENT {naturalDate, status, paidAmount, paidOn}` | `delete` |
| `POST /schedules/:id/instances/:naturalDate/pay` | any | `{paidOn, paidAmount?, note?, remainderDueDate?, baseVersion?}` | 200 instance; inserts one `payments` row under the override (creating the override row when none), rewrites the cache; same three 422s as items; the remainder date lands in `override.due_date` | `schedule_override`/`pay` + `payment`/`create` |
| `POST /schedules/:id/instances/:naturalDate/unpay` | any | `{baseVersion?}` | 200 instance; deletes every payment row of the override and clears `status`, `paid_on`, `paid_amount` on it (override row kept) | `schedule_override`/`unpay` + `payment`/`delete` per row |

Every writer above takes the parent `schedules` row lock **first** (§10.1).

### 6.10 Forecast

`GET /forecast?companyId=<id>|all&from&to&bucket=day|week|month&scenarioId&include=summary|grid&today` — perm `any`.

Query validation (all 400 unless stated): `companyId` required, a live company id or `all`;
`from`/`to` dates, `from <= to`, and `to >= today` (a `to` before today is a message-only
400 — there is nothing to forecast); `bucket` enum (default `week`); `include` enum
(default `grid`); `scenarioId` a live scenario (404 when not); `today` per D24. Defaults
per D7. Window: `from` earlier than `today` is clamped to `today` (`meta.fromClamped:
true`); `to` later than `today + 730 days` is clamped (`meta.toClamped: true`). 422
`FX_RATE_MISSING {currencies: [...]}` when any **currency in scope** (§3.4: in-scope
accounts' currencies ∪ currencies of every loaded item and schedule, adjustment targets
included) other than GBP has no rate with `effective_from <= today`.

Account set: live, `is_active` accounts of the company (or all companies). The route
computes `today`, calls `services/forecastLoad.js` (§8), then `lib/engine.js` (§9), and
serialises. All money below is **integer minor units**; GBP unless the name says
`Native`/`amountMinor`.

```
{
  meta: { today, from, to, bucket, fromClamped, toClamped, companyId, scenarioId, include,
          ratesUsed: { EUR: { rateToGbp: "0.850000", effectiveFrom: "2026-09-01" },
                       GBP: { rateToGbp: "1.000000", effectiveFrom: null } },
          generatedAt },
  accounts: [ { accountId, name, companyId, currency, rateToGbp,
                anchorDate, anchorAgeDays,            // today − anchorDate
                anchorNative, anchorGbp,              // the recorded balance, re-valued once
                openingNative, openingGbp,            // at today = anchor + Σ absorbed (accountMinor / gbpMinor)
                absorbed: [ { key, name, categoryId, date, currency,
                              amountMinor,            // in the line's own currency
                              accountMinor,           // in the account's currency (§9.8)
                              gbpMinor, direction, paymentId?,
                              flags: ['assumed'] | ['paid'] | ['paid','partial'] } ] } ],
  days:    [ { date, opening, inflow, outflow, net, closing, baselineClosing? } ],   // [today, to], combined GBP
  buckets: [ { start, end, opening, inflow, outflow, net, closing, minClosing, minDate } ],
  rows:    [ { categoryId, categoryName, direction, sortOrder,
               totals: [ perBucketGbp… ], total,
               items: [ { key, kind: 'item' | 'sched', id, scheduleId?, naturalDate?,
                          name, counterparty, accountId, currency,
                          amountMinor, accountMinor, gbpMinor, date, bucketIndex,
                          status, settleMode, flags: [...], editable, paymentId?,
                          baseline: { date, amountMinor, gbpMinor, flags } | null } ] } ],
  summary: { opening, inflow, outflow, net, closing, minClosing, minDate,
             unresolvedCount, unresolvedTotal, absorbedCount },
  scenario: { id, name, status, baselineSummary: { …same shape as summary… },
              deltaByBucket: [ { start, end, inflow, outflow, net, closing } ],   // scenario − baseline
              warnings: [ { code, key, reason? } ] } | null,
  unresolved: [ { key, kind, name, categoryId, accountId, currency, amountMinor, gbpMinor,
                  direction, date, ageDays, settleMode } ],
  warnings:   [ { code: 'NO_ANCHOR', accountId } | { code: 'ORPHAN_OVERRIDE', scheduleId, naturalDate, overrideId } ]
}
```

- `include=summary` omits `rows` (the key is absent) and keeps everything else; the
  mobile app uses it.
- `days[]` is one entry per date in `[today, to]`; `days[0].opening` is `Σ accounts.openingGbp`
  and the sum of `net` over every day reconciles to `summary.closing − summary.opening`.
  `baselineClosing` is present only with `scenarioId` (D34).
- `buckets[]` per D6; `minClosing`/`minDate` are the minimum `closing` over the bucket's
  `days[]` entries and its date — never the bucket's own closing.
- `rows[]`: one row per category that has at least one item in the window (or in the
  scenario), ordered `direction (in first), sort_order, name`; `totals[i]` is the integer sum
  of `gbpMinor` of its items with `bucketIndex = i`. A row is single-direction, so its
  totals are magnitudes; the bucket-level `inflow`/`outflow`/`net` do the signing.
- Item `flags` (§9.5, §9.6): `tuned` (override row exists), `overdue`, `paid` (a payment
  line placed at its `paidOn`, only when `paidOn = today`), `partial` (that payment line
  belongs to a `part_paid` parent), `remainder` (the owed part of a `part_paid`),
  `adjusted` (scenario set: an adjustment applied), `excluded` (scenario set, D30), `stale`
  (an adjustment exists for this key but was not applied), `fromScenario`
  (`sourceScenarioId` set). `assumed` and pre-today payment lines never appear in
  `rows[]` — they are in `accounts[].absorbed[]`.
- **One key may appear on several lines**: one per payment row placed in the window
  (flags `paid`, plus `partial` when the parent is `part_paid`; `paymentId` set) plus one
  for the remainder (flag `remainder`). They are distinguished by flags and `paymentId`;
  `totals` and every sum count each line.
- `editable` = `status === 'expected' && !flags.includes('remainder') && (scenario == null || scenario.status === 'draft')`.
  With a scenario open the client writes adjustments; without one it tunes or edits the
  real row. No client holds an engine rule; both `flags` and `editable` come from here.
- `baseline` on an item is present only with `scenarioId`: the item's values in the baseline
  set. In phase 1 every scenario item is a baseline item (adjusted or excluded), so it is
  never null there; the null case is reserved for hypothetical items (§11).
- `scenario.warnings` entries: `{code: 'STALE', key, reason: 'BASE_CHANGED' | 'TARGET_SETTLED' | 'TARGET_MISSING' | 'DATE_PASSED'}` and `{code: 'ADJUSTMENT_OUT_OF_SCOPE', key}` (D20; reachable because adjustments are matched against the loaded targets, not the in-scope set — §9.5).
- `unresolved[]` and `summary.unresolvedCount/unresolvedTotal` describe the set the response
  is built on (the scenario's when `scenarioId` is given); `scenario.baselineSummary` keeps
  the baseline's counts. An adjustment that moves an unresolved item to `>= today` removes
  it from the scenario's list only.

### 6.11 Scenarios

Row JSON: `{id, name, description, companyId, status, appliedAt, appliedBy, adjustmentCount,
rowVersion, createdBy, createdAt, updatedAt, deletedAt}`. Adjustment JSON: `{id, scenarioId,
itemKey, targetKind, targetId, targetDate, kind, newDate, newAmount, baseDate, baseAmount,
note, rowVersion, createdBy, createdAt, updatedAt}`; on reads that resolve targets
(`GET /scenarios/:id`, rebase) each adjustment also carries
`stale: null | 'BASE_CHANGED' | 'TARGET_SETTLED' | 'TARGET_MISSING' | 'DATE_PASSED'` and
`current: {date, amount, status} | null`. Both are resolved **only while the scenario is
`draft`**; on an `applied` or `archived` scenario they are `null` — applied adjustments
are history, not a live comparison.

| Method, path | Perm | Request | Response / refusals | Audit |
|---|---|---|---|---|
| `GET /scenarios?status&companyId&q&includeDeleted&page&limit` | any | `status` comma list | list sorted `created_at DESC, id DESC` | — |
| `POST /scenarios` | any | `{name, description?, companyId?}` | 201 draft; 400 (`companyId` not live) | `scenario`/`create` |
| `GET /scenarios/:id` | any | — | `{...row, adjustments: [...]}` with `stale`/`current` resolved against `today` while `draft`, `null` otherwise; 404 | — |
| `PUT /scenarios/:id` | any | `{name?, description?, companyId?, status?, baseVersion?}` | row; `status` only to `archived` from `draft`/`applied` (D36), anything else 400; name/description/companyId editable in any status | `update` |
| `DELETE /scenarios/:id` | any | `{baseVersion?}` | 204 soft, any status; adjustments kept | `delete` |
| `POST /scenarios/:id/duplicate` | any | `{name?}` (default the source name plus " (copy)") | 201 new `draft` with every adjustment copied as-is (bases untouched — the first read shows what is stale); source may be any status | `scenario`/`duplicate` on the new row (`after.copiedFrom`), `scenario_adjustment`/`create` per copy |
| `PUT /scenarios/:id/adjustments/:itemKey` | any | `{kind, newDate?, newAmount?, note?, baseVersion?}` — `kind` is `adjust` or `exclude`; `adjust` needs at least one of `newDate`/`newAmount`; `exclude` takes neither | 200 (updated) / 201 (created) adjustment. §10.7. 422 `ITEM_KEY_INVALID`; 409 `SCENARIO_NOT_DRAFT {status}`; 404 `TARGET_MISSING {key}`; 409 `TARGET_SETTLED {key, status}`; 422 `ADJUSTMENT_DATE_IN_PAST {newDate, today}`; 400 amount grammar. `baseDate`/`baseAmount` are set by the server from the loader, never from the body | `scenario_adjustment`/`create` or `update` |
| `DELETE /scenarios/:id/adjustments/:itemKey` | any | `{baseVersion?}` | 204 hard; 422 `ITEM_KEY_INVALID`; 409 `SCENARIO_NOT_DRAFT`; 404 | `delete` |
| `POST /scenarios/:id/rebase` | any | `{dropStale?}` (boolean) | 200 `{scenario, adjustments: [{...adjustment, rebased, stale, dropped}]}`. §10.8. `dropStale: true` removes `TARGET_SETTLED`, `TARGET_MISSING` and `DATE_PASSED` adjustments (D38); `BASE_CHANGED` ones are rebased. 409 `SCENARIO_NOT_DRAFT` | `scenario`/`rebase`; `scenario_adjustment`/`update` per rebased row, `delete` per dropped |
| `POST /scenarios/:id/apply` | any | `{baseVersion?}` | 200 `{scenario, applied: [{itemKey, kind, wrote, entityId}]}` where `wrote` is `cash_item` or `schedule_override`. §10.9. 409 `SCENARIO_NOT_DRAFT {status}` (a second apply lands here); 409 `SCENARIO_STALE {stale: [{itemKey, reason}]}` — nothing written | `scenario`/`apply`; `cash_item`/`apply` or `schedule_override`/`apply` per target |

`:itemKey` arrives un-encoded (unreserved characters only, §4); Express matches it as one
path segment. Every adjustment route parses it with `parseKey` before touching the DB.

---

## 7. Error-code catalogue

`Kind`: **refusal** = the request fails with that status and `{error, code, details?}`;
**warning** = a 200 body carries it in `warnings[]`, `scenario.warnings[]` or `orphans[]`
and nothing is refused; **reason** = a value inside another code's `details`, never a
top-level `code`. Rows marked "(no code)" are message-only per workflows.

| Code | Status | Kind | When |
|---|---|---|---|
| (no code) | 400 | refusal | Validation: shape, type, enum, grammar, malformed JSON, `parseId` on a query value, nothing to update, both ends on a schedule, a structural value in `changes` that is not structural, `/forecast` with `to < today` |
| (no code) | 401 | refusal | No email in the token, or the email is not on `allowed_emails` |
| `ADMIN_REQUIRED` | 403 | refusal | `POST/PATCH/DELETE /users`, `GET /audit?entityType=allowed_email` by a `standard` account |
| (no code) | 404 | refusal | No live row for the path id (or the id is malformed); no override row on revert; `naturalDate` is not an occurrence; no route |
| (no code) | 409 | refusal | Allowlist: email already listed; last admin |
| (no code) | 413 | refusal | Body over 1 MB |
| `STALE_WRITE` | 409 | refusal | `baseVersion` sent and `≠ row_version` under the lock; `details {currentVersion}` |
| `COMPANY_CODE_TAKEN` | 409 | refusal | Company `code` already held by a live company; `details {companyId}` |
| `COMPANY_IN_USE` | 409 | refusal | Deleting a company with live accounts; `details {accountIds}` |
| `ACCOUNT_IN_USE` | 409 | refusal | Deleting an account, or changing its currency, while live items, schedules or balances reference it (`details {itemCount, scheduleCount, balanceCount}`); or deactivating it while it has owed one-offs, a schedule with an occurrence on or after today, or an overdue/unresolved instance (D17; `details {owedItems, liveSchedules, owedInstances}`, keys capped at 50 per kind) |
| `CATEGORY_IN_USE` | 409 | refusal | Deleting a category, or changing its direction, while live items or schedules use it; `details {itemCount, scheduleCount}` |
| `FX_RATE_EXISTS` | 409 | refusal | `(currency, effective_from)` already present; `details {fxRateId}` |
| `ITEM_NOT_EDITABLE` | 409 | refusal | `PUT /items/:id` sending `status`, `amount` or `currency` on a `paid`/`part_paid` item; `details {status}` |
| `BALANCE_DATE_IN_FUTURE` | 422 | refusal | `balance_date > today` on `PUT …/balances/:date` or `POST /balances/bulk`; `details {balanceDate, today}` |
| `PAID_ON_IN_FUTURE` | 422 | refusal | `paid_on > today` on any pay; `details {paidOn, today}` |
| `PAID_AMOUNT_INVALID` | 422 | refusal | A payment's `amount <= 0`, or above the remaining amount, or nothing remains; `details {paidAmount, remainingAmount}` |
| `REMAINDER_DATE_REQUIRED` | 422 | refusal | Partial pay on an item or instance whose effective date is before `today` without `remainderDueDate`; `details {dueDate, today}` |
| `ITEM_KEY_INVALID` | 422 | refusal | A key `lib/keys.js` rejects; `details {key}` |
| `ADJUSTMENT_DATE_IN_PAST` | 422 | refusal | `newDate < today` on an adjustment write; `details {newDate, today}` |
| `FX_RATE_MISSING` | 422 | refusal | `/forecast`: a non-GBP currency in scope has no rate with `effective_from <= today`; `details {currencies}` |
| `OVERRIDE_HAS_PAYMENT` | 409 | refusal | Revert of an override carrying payment state, or a tune of `amount`/`status` on one; `details {naturalDate, status, paidAmount, paidOn}` |
| `SCHEDULE_STRUCTURE_LOCKED` | 409 | refusal | A structural field (D37) changed in place on a schedule with `start_date <= today` or an override row; `details {fields, reason, split}` |
| `SCHEDULE_HAS_PAYMENTS` | 409 | refusal | Split/end: an override from *k* carries payment state; `details {naturalDates}` |
| `SCHEDULE_HAS_OVERRIDES` | 409 | refusal | Split/end: unpaid overrides from *k* and no `dropOverrides`; `details {naturalDates}` |
| `SCHEDULE_HAS_ADJUSTMENTS` | 409 | refusal | Split/end: draft adjustments from *k* that cannot be re-keyed (natural dates change, currency changes, or the schedule is being ended) and no `dropAdjustments`; `details {adjustments: [{scenarioId, scenarioName, itemKey, naturalDate}]}` |
| `SCENARIO_NOT_DRAFT` | 409 | refusal | Adjustment write or delete, rebase, apply on a scenario that is not `draft`; `details {status}` |
| `SCENARIO_STALE` | 409 | refusal | Apply: at least one adjustment is stale under the locks; `details {stale: [{itemKey, reason}]}` with `reason` one of the four below; nothing written |
| `BASE_CHANGED` | — | reason | The target's current effective date (compared as `YYYY-MM-DD` strings) or amount (compared as parsed minor units) differs from `base_date`/`base_amount` |
| `DATE_PASSED` | — | reason | An `adjust` whose `new_date < today` at read time (D38); rebase cannot fix it, `dropStale` removes it |
| `TARGET_SETTLED` | — | reason | The target's status is not `expected` (paid, part_paid, skipped), or the override row carries payment state |
| `TARGET_SETTLED` | 409 | refusal | Adjustment `PUT` against such a target; `details {key, status}` |
| `TARGET_MISSING` | — | reason | The target is gone: deleted, not an occurrence, orphaned, or a `ship.` key in phase 1 |
| `TARGET_MISSING` | 404 | refusal | Adjustment `PUT` against such a target; `details {key}` |
| `NO_ANCHOR` | 200 | warning | `/forecast`: an in-scope account has no recorded balance and is excluded; `{accountId}` |
| `ORPHAN_OVERRIDE` | 200 | warning | `/forecast` and `/instances`: an override row whose `natural_date` is not an occurrence; `{scheduleId, naturalDate, overrideId}` |
| `STALE` | 200 | warning | `/forecast` `scenario.warnings`: an adjustment not applied; `{key, reason}` |
| `ADJUSTMENT_OUT_OF_SCOPE` | 200 | warning | `/forecast` `scenario.warnings`: the target's account is outside the requested company scope; `{key}` |

`GET /meta/enums.errorCodes` lists every refusal code above; `warningCodes` lists
`NO_ANCHOR`, `ORPHAN_OVERRIDE`, `STALE`, `ADJUSTMENT_OUT_OF_SCOPE`; `staleReasons` lists
`BASE_CHANGED`, `TARGET_SETTLED`, `TARGET_MISSING`, `DATE_PASSED`.

---

## 8. Load rules (`services/forecastLoad.js`)

The loader turns rows into engine input and holds **no logic**: no classification, no
FX, no arithmetic beyond the date bounds below. Inputs: `conn`, `today`, `to` (already
clamped), the account set, `scenarioId?`. `minA` = the earliest anchor date among the
in-scope accounts that have one; accounts without one are reported (`NO_ANCHOR`) and
their rows are not loaded. If no account has an anchor the loader returns an empty input
and the engine answers an empty forecast with one warning per account.

It loads, for the in-scope accounts (`account_id IN (…)`, live rows only):

1. **Dated `[minA, to]`**: every `cash_items` row with `due_date BETWEEN minA AND to`, any
   status; every `schedules` row (`active` and `ended`) whose occurrences can fall in
   `[minA, to]` — i.e. `start_date <= to` and (`end_date IS NULL OR end_date >= minA`) — and
   for each its natural dates in `[minA, to]` via `occurrences`.
2. **Paid late**: `cash_items` with `paid_on >= minA` (the cache), whatever `due_date`;
   `schedule_overrides` with `paid_on >= minA`, and their schedules.
3. **Every override row of every loaded schedule**, whatever its dates or columns
   (`schedule_id IN (…)` over the schedules loaded by rules 1, 2, 5 and 6 — D31, replacing
   PLAN's "due_date in the window" and "carries a status or a payment amount" rules, which
   miss an amount-only tune, an override moving an instance out of the window, and a
   settle-mode-only "Didn't happen"). Each override's instance is generated whatever its
   natural date, so a part-paid remainder behind `minA` is still owed and a manual
   instance older than the window still reaches the classifier. Overrides are few per
   schedule.
4. **Payments**: every `payments` row of a loaded `cash_items` row or a loaded override
   with `paid_on >= minA` (payments before `minA` are inside the anchor; the remainder uses
   the parent's cached `paid_amount`, so they are not needed).
5. **Manual and still owed, no 45-day floor**:
   - one-off items with `status = 'part_paid'` (any settle mode — the remainder is forced
     manual) or (`settle_mode = 'manual' AND status = 'expected' AND due_date < today`), all
     of them (served by `idx_status_due` / `idx_account_status_due`);
   - `schedules` with `settle_mode = 'manual'`: occurrences scanned back to
     `max(start_date, today − 730 days)`;
   - an override with `settle_mode = 'manual'` (loaded by rule 3) makes its instance owed
     whatever its date; no scan is needed because the override names the instance.
6. **Every target of the scenario's adjustments, by key** (`scenarioId` given): for each
   adjustment, `item.` → that `cash_items` row even if outside every bound above (deleted →
   absent → `TARGET_MISSING`); `sched.` → the schedule row and that natural date's
   instance (plus its override row) even if outside the window, so an instance an
   adjustment moves into the window is present; `ship.` → nothing (D8). Targets whose
   account is outside the scope are loaded too (D20).
7. **Schedule rows** for every override or instance loaded by rules 2–6 (then rule 3 runs
   again for any schedule that joined here), so the engine can run `isOccurrence` on each
   (orphan detection) and resolve settle modes.
8. **Rates**: for each **currency in scope** (§3.4) other than GBP, the `fx_rates` row with
   the latest `effective_from <= today` (one query, `ROW_NUMBER` or a correlated max).
   Missing → the route answers `FX_RATE_MISSING` before the engine runs.
9. **Anchors**: per account, the `bank_balances` row with the latest `balance_date`.
10. **Adjustments**: every `scenario_adjustments` row of the scenario, ascending id.

Output shape (`engineInput`): `{today, from, to, bucket, accounts: [{id, companyId, name,
currency, anchorDate, anchorBalance}], rates: {CUR: {rateToGbp, effectiveFrom}}, items: [rows],
schedules: [rows], overrides: [rows], payments: [rows], adjustments: [rows], externalItems: [],
scenario: row | null, warnings: [NO_ANCHOR…]}` — rows in their camelCase JSON shape, money
still DECIMAL strings. Duplicates from overlapping rules are removed by id / by
`(scheduleId, naturalDate)` before handing over. Rows of accounts outside the scope reach
the engine only through rule 6 and carry `inScope: false`.

`loadTarget(conn, parsedKey, today)` is the same module's single-target read used by the
adjustment write, rebase and apply, called **after the caller has locked the target's rows**
in the standing order (§10.1): it returns `{kind, id, naturalDate, status, effectiveDate,
effectiveAmount, currency, accountId, settleMode, hasPaymentState, overrideId}` or `null`,
computed with the same effective-value rules (§3.4) and nothing else. It returns `null`
when the `cash_items` or `schedules` row is not live (`deleted_at` set or absent), when
`isOccurrence(schedule, naturalDate)` is false, or for a `ship.` key (D8).

---

## 9. Engine (`lib/engine.js`, pure)

`run(engineInput) → response body of §6.10` (minus `meta.generatedAt`). No DB, no clock,
no `Date`; money as `bigint` minor units internally, converted to JSON numbers at the
edge; dates as strings with epoch-day arithmetic. `lib/classify.js` is imported for step
6; nothing else classifies. `externalItems` is accepted and, in phase 1, must be `[]`.

The eleven steps, in order:

### 9.1 `today`
Given. Never derived inside the engine. `A == today` is a normal case.

### 9.2 Anchors
Per account, **A** = its latest recorded `balance_date`, anchor balance = that row's
`balance` (start-of-day cash). No balance → the account is excluded and `NO_ANCHOR` is
emitted. Consequence used everywhere: with anchor **A**, anything dated `< A` is already in
the figure; anything dated `>= A` is not.

### 9.3 Load
Done by §8 before the engine runs; the engine trusts the set it is given and never asks
for more.

### 9.4 Effective date
§5.3: override `due_date` verbatim (weekend rule bypassed) else the weekend-adjusted
natural date. One-off items: `due_date`. Effective amount, status and settle mode per
§3.4. An override whose `natural_date` fails `isOccurrence` is dropped here with
`ORPHAN_OVERRIDE`.

### 9.5 Apply scenario adjustments — before classifying
Build the **baseline set** (every loaded line with its effective values). With a scenario,
build the **scenario set** as a copy, then for each adjustment (ascending id), matched by
key against the **loaded targets** (§8 rule 6 loads every target whatever its scope —
matching against the in-scope set would make every out-of-scope target read
`TARGET_MISSING`). The stale checks run on the target's **native** values:

| Check, in order | Outcome |
|---|---|
| no loaded target with that key (deleted, not an occurrence, orphan, `ship.`) | stale `TARGET_MISSING`; not applied |
| target's effective status ≠ `expected` (paid, part_paid, skipped), or its override carries payment state | stale `TARGET_SETTLED`; not applied |
| `base_date ≠` effective date (string compare) or `base_amount ≠` effective amount (parsed minor units; both pre-adjustment, override-adjusted — D11) | stale `BASE_CHANGED`; not applied |
| `kind = 'adjust'` and `new_date` set and `new_date < today` | stale `DATE_PASSED` (D38); not applied |
| target's account outside the requested scope (`inScope: false`) | `ADJUSTMENT_OUT_OF_SCOPE`; not applied; the target stays out of both sets |
| `kind = 'adjust'` | scenario line's date := `new_date` when set, amount := `new_amount` when set; flag `adjusted` |
| `kind = 'exclude'` | scenario line flagged `excluded`, contributes nothing (D30) |

A stale adjustment flags its line `stale` in the scenario set and adds `{code: 'STALE',
key, reason}` to `scenario.warnings`. From here on **every step runs twice**, once per set,
and the response is built from the scenario set with the baseline's summary in
`scenario.baselineSummary`. Because adjustments come first, moving an overdue item to next
week makes it a normal future item in the scenario while it stays overdue in the baseline.

### 9.6 Classify each set — `lib/classify.js`

```
classify(line, A, today) → { payments: PaidLine[], owed: OwedLine | null }
line     = { status, settleMode, effectiveDate, amountMinor, paidAmountMinor,
             payments: [{ paymentId, paidOn, amountMinor }] }
PaidLine = { paymentId, band: 'settledBeforeAnchor' | 'paid', date: paidOn, amountMinor, partial: boolean }
OwedLine = { band: 'skipped' | 'assumedSettled' | 'assumed' | 'future' | 'overdue' | 'unresolved',
             date, amountMinor, remainder: boolean }
```

Settle mode is **already resolved by the caller** (override's when set, else the
schedule's; a one-off's own). `paidAmountMinor` is the parent's cache (`Σ payments`).
`A` may be `null` (D12: treated as minus infinity). `A <= today` always holds otherwise, so
the overdue floor is `today`. `OVERDUE_WINDOW_DAYS = 45`. **Invariant asserted by BUILD_PLAN
step 4's matrix test**: `payments` has exactly one entry per input payment row, each in
exactly one paid band; `owed` is `null` iff `status = 'paid'`, otherwise exactly one owed
band — so every case lands in exactly one row of the table per line.

| # | State | Treatment (band) |
|---|---|---|
| 1 | a payment row with `paidOn < A` | excluded — already in the bank balance (`settledBeforeAnchor`) |
| 2 | a payment row with `paidOn >= A` | included at its `paidOn` for its `amountMinor` (`paid`); `paidOn < today` → absorbed, `paidOn = today` → today's bucket. Rows 1–2 run **per payment row** on its own date, for `paid` and `part_paid` parents alike (`partial = status === 'part_paid'`) |
| 3 | `part_paid` | its payment rows follow rows 1–2; the **remainder** `amountMinor − paidAmountMinor` is the owed line (`remainder: true`) whose settle mode is **forced to `manual`** for the run, then rows 7–9 apply to it (never rows 5–6) |
| 4 | `skipped` | excluded (`skipped`) |
| 5 | `expected`, `auto`, `effectiveDate < A` | assumed settled, excluded (`assumedSettled`) |
| 6 | `expected`, `auto`, `A <= effectiveDate < today` | included at its effective date, flagged `assumed`; moves today's opening; listed in the account's `absorbed[]` (`assumed`) |
| 7 | `expected`, any mode, `effectiveDate >= today` | normal future item (`future`) |
| 8 | `expected`, `manual`, `effectiveDate < today`, `today − effectiveDate <= 45` | **overdue**, placed at `today`, flagged `overdue` (`overdue`) |
| 9 | `expected`, `manual`, `today − effectiveDate > 45` | `unresolved[]`, not in the series (`unresolved`) |

Boundaries, exactly: row 5 is `effectiveDate < A`; row 6 is `A <= effectiveDate` and
`effectiveDate < today`; row 7 is `effectiveDate >= today` (so an item dated `today` is in
today's bucket, and when `A == today` row 6 is empty and row 5 is every auto item before
today). Row 8 includes `today − 45`; row 9 starts at `today − 46` (D9). The unit test
enumerates `{auto, manual} × {< A, A..today−1, == today, > today} × {A < today, A == today}`
plus `paid`, `part_paid` (payments straddling A) and `skipped`, and asserts the invariant
above.

**`derivedStatus`** (`/items`, `/instances`) is a projection of the same call on the
baseline: `skipped` → `skipped`; `owed === null` (status `paid`) → `paid`; owed band `assumedSettled`
→ `assumedSettled`, `assumed` → `assumed`, `future` → `expected`, `overdue` → `overdue`,
`unresolved` → `unresolved`. A `part_paid` row reports its remainder's band (D10). Because
both callers pass the same resolved settle mode, effective date and anchor, `derivedStatus`
on a list agrees with the flags and lists of `/forecast` for the same data; a test compares
them.

"Assumed settled" is visible, not silent: nothing is written, so deleting or correcting a
balance un-settles it; the client offers **Confirm paid** (pay) or **Didn't happen**
(`settleMode: 'manual'` on the item or the instance's override), after which the line
reappears as overdue.

### 9.7 FX — one rate set per run
For each **currency in scope** (§3.4) other than GBP: the latest `effective_from <= today`, used for
**every date** in the run (past, today, future). GBP is rate `1.000000` with no row (D3).
Rates are parsed to micro-units once (`parseRate`). Anchor balances are re-valued at this
set. A missing rate is `422 FX_RATE_MISSING` from the route before the engine runs; the
engine itself throws if asked to convert a currency it has no rate for.

### 9.8 Rounding invariant
GBP is fixed **per item, once**: `gbpMinor = toGbp(nativeMinor, rateMicro) =
roundHalfUp(nativeMinor × rateMicro, 1_000_000)` in `bigint` arithmetic. Every GBP inflow,
outflow and net, at day, bucket, row and summary level, is a plain **integer sum** of those
per-item values. An account's GBP closing is `openingGbp + Σ item gbpMinor`, never a
re-conversion of the native closing. `anchorGbp = toGbp(anchorNative, rate)` is computed
once, and `openingGbp = anchorGbp + Σ absorbed gbpMinor`. An item in a currency other than
its account's converts **item → GBP → account currency**, each step rounded once:
`gbpMinor = toGbp(itemMinor, itemRate)`, `accountMinor = fromGbp(gbpMinor, accountRate)`
(for a line in the account's own currency `accountMinor = amountMinor`); the account's
native series uses `accountMinor` only — never a mixed-currency `amountMinor` — and every
GBP figure uses `gbpMinor`. Both ride on every line (`absorbed[]`, `rows[].items[]`). Tests
assert `opening + net = closing` and "cells sum to totals" at rates `1.234567` and
`0.005234`.

### 9.9 Roll each account from its own anchor
Per account: `openingNative(today) = anchorNative + Σ accountMinor of lines dated in
[A, today)` — row 2 payment lines before today and row 6 (assumed) — and
`openingGbp = anchorGbp + Σ gbpMinor` of the same lines; those lines are returned on the
account as `absorbed[]` with flags `['paid']`, `['paid','partial']` or `['assumed']`
(one entry per payment row, `paymentId` set). Overdue lines (row 8) are placed at
`today`, not absorbed. The **combined GBP line** is summed from `today` onward:
`days[0].opening = Σ accounts.openingGbp`, then per day `inflow = Σ gbpMinor of 'in' lines`,
`outflow = Σ gbpMinor of 'out' lines`, `net = inflow − outflow`, `closing = opening + net`,
next day's `opening = closing`.

### 9.10 The forecast starts today
Output window is `[today, to]`. An earlier `from` is clamped and `meta.fromClamped` says
so. It is not a ledger: no GBP line is ever computed for a past date at today's rate; the
only pre-today figures in the response are the per-account `anchor*`, `opening*` and
`absorbed[]`.

### 9.11 Window cap
`to − today <= 730` days; a larger `to` is clamped (`meta.toClamped`, D25).

### 9.12 Buckets, rows, summary
- `day`: one bucket per date. `week`: Monday–Sunday. `month`: calendar month. First and last
  clipped to `[today, to]` (D6). `bucketIndex` of a line = the bucket containing its placed
  date (today for overdue lines).
- Bucket `opening` = its first day's opening; `closing` = its last day's closing; `inflow`,
  `outflow`, `net` = integer sums over its days; `minClosing`/`minDate` = the minimum daily
  closing in the bucket and its date.
- `rows[]` per §6.10 from the lines placed in the window (bands `paid` at today, `future`,
  `overdue`, plus `excluded` lines in the scenario set).
- `summary`: `opening = days[0].opening`, `closing = last day's closing`, sums over the
  window, `minClosing/minDate` over `days[]`, `unresolvedCount/unresolvedTotal` = count and
  `Σ gbpMinor` (magnitudes, `in` and `out` alike) of row 9, `absorbedCount` = `Σ
  accounts.absorbed.length`.
- `scenario.deltaByBucket[i]` = scenario bucket − baseline bucket for `inflow, outflow, net,
  closing`.

---

## 10. Transactions and lock discipline

### 10.1 Standing rule

Never rely on InnoDB gap locks. **Every writer of an instance locks the parent `schedules`
row (`SELECT … FOR UPDATE`) before it reads or writes any `schedule_overrides` row**: tune,
pay, unpay, revert, split, end and scenario apply. That serialises them against the split
guard at any isolation level, including "mark paid" on an instance that has no override
row yet. Lock order, always:

**scenarios (ascending id) → schedules (ascending id) → cash_items (ascending id) → schedule_overrides → payments**

A writer that will need a lock earlier in that order takes it up front, which is why the
split finds and locks its draft scenarios before locking the schedule. `payments` rows
are only ever touched under their parent's lock — the `cash_items` row, or (for an
instance) the `schedules` row and then the override row, per the standing rule — so they
are last and never locked on their own. Reference rows (companies, accounts, categories,
fx_rates, bank_balances) sit outside the order: they are locked alone by their own routes;
when a reference route locks several rows of one table (`POST /balances/bulk`, `isDefault`
clearing siblings) it locks them **ascending by id**. **One exception, and it comes
first:** an item or schedule write that sets or changes `account_id` / `category_id`
(create, structural edit, split) takes `SELECT … FROM bank_accounts WHERE id = ? FOR
SHARE` and the same on `categories`, then re-checks that both are live (and the account
active), **before any lock in the standing order**. Account deactivation / delete and
category delete take `FOR UPDATE` on their own row before reading the in-use sets, so the
two serialise and an item can never slip onto an account that is being deactivated.
Reference rows are never locked after a standing-order row, so no cycle is possible.

`withTransaction(fn)` (`src/db/index.js`) retries the **whole body once** on
`ER_LOCK_DEADLOCK` (D27). Bodies keep **every read inside the transaction** — validation
that depends on a row's current state happens after the row lock, never from a read made
before `beginTransaction` — so the retry is safe. Bodies do no network I/O and never nest a
`withConnection`/`withTransaction`. A refusal is thrown as `apiError` so the transaction
rolls back; an early-return sentinel is used only before any write.

Every transaction below is numbered; validation of body shape (grammar, enums, dates
parse) happens **before** the transaction opens and is 400; everything that reads state
happens inside it.

### 10.2 Reference data
1. Lock the row (`FOR UPDATE`, live) → 404. 2. `baseVersion` → `STALE_WRITE`.
3. In-use counts for deletes and guarded changes (`*_IN_USE`), read under the lock.
4. Write, `row_version + 1`, audit. Balances: lock the account (live) first, then
`SELECT … FROM bank_balances WHERE account_id = ? AND balance_date = ? FOR UPDATE`, insert or
update, audit `create`/`update`; bulk sorts its entries by `accountId` ascending, locks
the accounts in that order, then repeats per entry inside one transaction. `isDefault:
true` locks the company's live accounts ascending by id before clearing the siblings.
Deactivation (`isActive: false`, D17) computes the owed sets under the account lock with
the same `classify` call the lists use.

### 10.3 Item pay / unpay
Pay:
1. Lock `cash_items` row (live) → 404; `baseVersion`.
2. `remaining = amount − COALESCE(paid_amount, 0)`; `remaining <= 0` → `PAID_AMOUNT_INVALID`.
   `paidAmount` defaults to `remaining`; `paidAmount > remaining` → `PAID_AMOUNT_INVALID`.
   (`paidOn > today` was `PAID_ON_IN_FUTURE` before the transaction.)
3. Partial (`paidAmount < remaining`) with `due_date < today` and no `remainderDueDate` →
   `REMAINDER_DATE_REQUIRED {dueDate, today}` (`remainderDueDate >= today` was checked
   before the transaction).
4. `INSERT INTO payments (cash_item_id, paid_on, amount, note, created_by)`; audit
   `payment`/`create`.
5. Rewrite the cache from the rows: `paid_amount = SUM(payments.amount)`, `paid_on =
   MAX(payments.paid_on)` for this item; `status = 'paid'` when `paid_amount = amount`,
   else `part_paid`; `due_date = remainderDueDate` when sent. A `skipped` item may be paid;
   it becomes `paid`/`part_paid`.
6. `row_version + 1`; audit `cash_item`/`pay` (before/after of the cache, status and
   due_date); return the row with `payments[]`.

Unpay: lock the item; `SELECT … FROM payments WHERE cash_item_id = ? FOR UPDATE`; if any →
`DELETE` them (audit `payment`/`delete` each, before-snapshot), then `status = 'expected'`,
`paid_on = NULL`, `paid_amount = NULL`, `row_version + 1`, audit `cash_item`/`unpay`; else
200 unchanged, no audit. `due_date` is not restored (D23).

### 10.4 Instance tune / revert / pay / unpay
Common prologue:
1. Lock the `schedules` row (live) → 404; `baseVersion` (the schedule's row is not bumped
   by instance writes — `baseVersion` here is checked against the **override** row when one
   exists, and ignored when none does).
2. `isOccurrence(schedule, naturalDate)` false → 404.
3. `SELECT … FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ? FOR UPDATE`
   (zero or one row).

Tune: 4. Merge the body over the row (absent field = unchanged, `null` = clear). If the
row carries payment state and `amount` or `status` is in the body → `OVERRIDE_HAS_PAYMENT`.
5. If every tunable column (`amount, due_date, status, settle_mode, note`) is NULL after the
merge and there is no payment state → 400 ("nothing to tune; DELETE reverts"). 6. Insert or
update; audit `create`/`update`; return the instance.

Revert: 4. No row → 404. 5. Payment state → `OVERRIDE_HAS_PAYMENT`. 6. `DELETE`; audit
`delete` with `before` = full row; 204.

Pay: 4. Effective amount/status from the row and the schedule; `remaining` and the amount
checks as §10.3 step 2. 5. Partial with **effective date** `< today` and no
`remainderDueDate` → `REMAINDER_DATE_REQUIRED`. 6. Insert the override row when none
exists (audit `schedule_override`/`create`, so the payment has a parent id). 7. `INSERT
INTO payments (override_id, paid_on, amount, note, created_by)`; audit `payment`/`create`.
8. Rewrite the override's cache (`paid_amount = SUM`, `paid_on = MAX`), `status = 'paid'`
when the cache reaches the effective amount else `part_paid`, `due_date =
remainderDueDate` when sent; `row_version + 1`; audit `schedule_override`/`pay`; return the
instance with `payments[]`.

Unpay: 4. Row with `status IN ('paid','part_paid')` → `SELECT … FROM payments WHERE
override_id = ? FOR UPDATE`, `DELETE` them (audit `payment`/`delete` each), then set
`status`, `paid_on`, `paid_amount` to NULL (row kept), `row_version + 1`; audit
`schedule_override`/`unpay`. Otherwise 200 unchanged.

### 10.5 Split and end — PLAN.md's seven steps, in PLAN.md's order

Body checks first (400): `fromNaturalDate` / `lastNaturalDate` is a date; `changes` has
≥ 1 structural field and no `activeFrom` (split); `dropOverrides`/`dropAdjustments`
booleans. Then one transaction. The **draft-scenario locks (step 1) come before the
schedule lock (step 2)** — that is what keeps the standing order. *k* is not known until
the schedule is read in step 2, so step 1 binds the request's date directly.

1. **Find and lock the draft scenarios first.** Read the scenario ids holding adjustments
   that target this schedule from the request's date:
   `SELECT DISTINCT a.scenario_id FROM scenario_adjustments a JOIN scenarios s ON s.id =
   a.scenario_id WHERE a.target_kind = 'sched' AND a.target_id = ? AND a.target_date <op> ?
   AND s.status = 'draft' AND s.deleted_at IS NULL` — `<op> ?` is `>= fromNaturalDate` for a
   split and `> lastNaturalDate` for an end (`target_id` bound as the id's string). Lock
   those `scenarios` rows **ascending** with `SELECT … FOR UPDATE`, then **re-read the
   adjustments under the lock** with the same predicate. A scenario that has stopped being
   `draft` in the meantime is left alone: its adjustments are history.
2. **Lock the `schedules` row** (live) → 404; `baseVersion`. Split: `k = fromNaturalDate`;
   `isOccurrence(schedule, k)` and `k > firstActiveOccurrence(schedule)` (D21) → else 400.
   End: `isOccurrence(schedule, lastNaturalDate)` → else 400; `k =
   nextOccurrenceAfter(schedule, lastNaturalDate)`; `null` → 200 no-op (nothing follows).
   Compute the **successor shape** now (split only): `keepSeries = changes` leaves
   `frequency`, `intervalCount`, `startDate` and `weekendRule` untouched;
   `endBefore(schedule, k, {keepSeries}).successor` merged with `changes` (D21).
3. **Payment guard.** `SELECT natural_date FROM schedule_overrides WHERE schedule_id = ? AND
   natural_date >= ? AND (status IN ('paid','part_paid') OR paid_amount > 0 OR paid_on IS
   NOT NULL) FOR UPDATE` — the **cache columns**, which are exact because every `payments`
   write rewrites them under this same schedule lock (D23). Any row →
   `409 SCHEDULE_HAS_PAYMENTS {naturalDates}`.
4. **Unpaid overrides** from *k* (`natural_date >= k`, no payment state, `FOR UPDATE`) →
   `409 SCHEDULE_HAS_OVERRIDES {naturalDates}` unless `dropOverrides: true`.
5. **Decide, per draft adjustment from step 1** (this step writes nothing). An adjustment
   is **re-keyable** iff all four hold: (a) `keepSeries` — `changes` leaves `frequency`,
   `intervalCount`, `startDate` and `weekendRule` untouched; (b) the currency is unchanged
   (a re-keyed `new_amount` would silently be in the wrong currency); (c) the action is a
   split, never an end; (d) `isOccurrence(successorShape, target_date)` holds. Partition
   into `rekey[]` and `drop[]`. If `drop[]` is empty, every adjustment is re-keyed. If
   `drop[]` is non-empty and `dropAdjustments` is not `true` → `409 SCHEDULE_HAS_ADJUSTMENTS
   {adjustments}` listing **only** `drop[]`. With `dropAdjustments: true`, `drop[]` is
   deleted and `rekey[]` still re-keyed.
6. **Deletes.** `DELETE FROM schedule_overrides WHERE schedule_id = <old> AND natural_date
   >= <k>` — one audit row per deleted override (`schedule_override`/`delete`,
   before-snapshot); `DELETE` each `drop[]` adjustment — one `scenario_adjustment`/`delete`
   each.
7. **End the old schedule, insert the successor, then re-key.** Old: `endBefore(schedule,
   k)` → `end_date = k − 1 day`, `occurrence_count = NULL`, `status = 'ended'`,
   `row_version + 1`, audit `schedule`/`split` or `schedule`/`end` (both actions end the old
   row the same way, D22). Successor (split only): the successor shape from step 2 —
   `keepSeries`: `start_date = old.start_date`, `active_from = k`, `occurrence_count` /
   `end_date` inherited verbatim unless `changes` set one; otherwise `start_date =
   changes.startDate ?? k`, `active_from = NULL`, the remaining end per D21 — with the rest
   of `changes` applied, `predecessor_id = old id`, `status = 'active'`, `created_by` =
   caller; audit `schedule`/`create`. **Then**, with the successor's id in hand, update each
   `rekey[]` adjustment: `item_key := buildSchedKey(successorId, target_date)`, `target_id :=
   String(successorId)`, `base_*` untouched, `row_version + 1`, one
   `scenario_adjustment`/`update` audit row each (`before.itemKey → after.itemKey`). Their
   base no longer matches when the amount changed, so they read `BASE_CHANGED` until
   rebased, which is the truth.

The response lists `rekeyedAdjustments` and `droppedAdjustments` so the client can tell. A
pay issued during a split waits on the schedule lock (step 2) and then either lands on the
old schedule's row (if its date is before *k*) or is refused 404 (no longer an occurrence),
never lost. The successor's `start_date <= today` (or its `active_from = k` sits inside a
used series), so it is born structure-locked (D37); its amount is what the split set.

### 10.6 Schedule structural edit
1. Lock the schedule (live) → 404; `baseVersion`. 2. Diff the body's structural fields
against the row; if any **changes** and (`start_date <= today` or `SELECT 1 FROM
schedule_overrides WHERE schedule_id = ? LIMIT 1` finds a row) →
`409 SCHEDULE_STRUCTURE_LOCKED {fields, reason, split}`. 3. Otherwise write descriptive and
structural fields together, `row_version + 1`, audit `update`.

### 10.7 Scenario adjustment write / delete
1. `parseKey` → 422 `ITEM_KEY_INVALID` (before the transaction); body grammar; `newDate <
   today` → 422 `ADJUSTMENT_DATE_IN_PAST` (before the transaction).
2. Lock the `scenarios` row (live) → 404; `status ≠ 'draft'` → `SCENARIO_NOT_DRAFT`.
3. **Lock the target in the standing order** (§10.1): `sched.` → the `schedules` row
   (live, `FOR UPDATE`) then its override row for `target_date` if one exists (`FOR
   UPDATE`); `item.` → the `cash_items` row (live, `FOR UPDATE`); `ship.` → nothing.
4. `loadTarget(conn, parsed, today)` (§8) under those locks: `null` → 404 `TARGET_MISSING`;
   `status ≠ 'expected'` or `hasPaymentState` → 409 `TARGET_SETTLED`. **Base values** = the
   target's current pre-adjustment effective date and amount from the loader
   (override-adjusted, D11), never client-supplied.
5. Upsert on `(scenario_id, item_key)` with `target_kind/target_id/target_date` from the
   parse; `row_version + 1` on update; audit `create`/`update`. Delete: lock scenario
   (draft), `DELETE` by `(scenario_id, item_key)` → 404 when none; audit `delete`; 204 (no
   target lock — nothing about the target is read).

### 10.8 Rebase
1. Lock the scenario (live, draft) → 404 / `SCENARIO_NOT_DRAFT`.
2. Read the adjustments ascending id; **lock every target in the standing order** exactly
   as apply does (§10.9 step 2): schedules asc → cash_items asc → overrides.
3. For each adjustment ascending id: `loadTarget` under the locks; `null` → stale
   `TARGET_MISSING`; not `expected` or payment state → `TARGET_SETTLED`; `adjust` with
   `new_date < today` → `DATE_PASSED` (D38, reported even when the base also changed);
   else set `base_date`/`base_amount` to the current values (`rebased: true` when they
   changed; audit `update`).
4. `dropStale: true` → delete every `TARGET_SETTLED`, `TARGET_MISSING` and `DATE_PASSED` row
   (audit `delete`, `dropped: true`); `BASE_CHANGED` rows are rebased, never dropped.
5. Audit `scenario`/`rebase` with the counts; return.

### 10.9 Apply — all or nothing
1. Lock the `scenarios` row (live) → 404; **require `draft`** → else `SCENARIO_NOT_DRAFT`;
   `baseVersion`.
2. Read the adjustments ascending id; collect target ids. Lock, in the standing order:
   `schedules` rows for every `sched.` target, ascending id, `FOR UPDATE` (live); then
   `cash_items` rows for every `item.` target, ascending id, `FOR UPDATE` (live); then the
   `schedule_overrides` rows for the `sched.` targets, `FOR UPDATE` (those that exist).
3. **Re-check every adjustment under those locks** with the §9.5 definitions:
   `TARGET_MISSING` (row absent or deleted, `isOccurrence` false, `ship.`), `TARGET_SETTLED`
   (item status ≠ `expected`; override row with status other than NULL/`expected` or with
   payment state), `BASE_CHANGED` (current effective date ≠ `base_date` as strings, or
   current effective amount ≠ `base_amount` as parsed minor units), `DATE_PASSED` (`adjust`
   with `new_date < today` — D38).
4. **Any stale → throw `409 SCENARIO_STALE {stale: [{itemKey, reason}]}`** listing each key
   and reason; the transaction rolls back and nothing is written. An apply can never
   quietly skip part of a scenario.
5. Otherwise write, ascending id: `item.` + `adjust` → `due_date = new_date ?? due_date`,
   `amount = new_amount ?? amount`; `item.` + `exclude` → `status = 'skipped'`; both set
   `source_scenario_id = scenario id`, `row_version + 1`, audit `cash_item`/`apply`.
   `sched.` + `adjust` → upsert the override with `due_date = new_date` (when set) and
   `amount = new_amount` (when set); `sched.` + `exclude` → upsert with `status = 'skipped'`;
   both stamp `source_scenario_id`; audit `schedule_override`/`apply`.
6. `status = 'applied'`, `applied_at = NOW()`, `applied_by` = caller, `row_version + 1`; audit
   `scenario`/`apply`. Adjustments are now immutable (`SCENARIO_NOT_DRAFT` on every write)
   and are the audit trail of what was applied. Return `{scenario, applied}`.

### 10.10 Duplicate
1. Read the source scenario (live, any status; plain read — nothing on it is written).
2. Insert the new `draft` row (`company_id`, `description` copied; `name` per §6.11);
   audit `scenario`/`duplicate` with `after.copiedFrom`.
3. Insert every adjustment with the same `item_key`, `target_*`, `kind`, `new_*`, `base_*`,
   `note` (bases as-is); audit `create` each. 201.

---

## 11. Deferred

Recorded so nothing is dropped silently. PLAN.md's list:

- Transfers between accounts.
- Hypothetical items added inside a scenario (`rows[].items[].baseline` reserves `null`).
- Bank holidays (the weekend rule knows only Saturday and Sunday).
- Bank-feed import.
- Forecast snapshots.
- OpenAPI document and `spec:diff`.
- A combined GBP **history** line across currencies (needs daily FX snapshots).

BUILD_PLAN.md's additions:

- Adjusting `part_paid` remainders inside a scenario (they read `TARGET_SETTLED`; use pay
  with `remainderDueDate`).
- Re-keying draft adjustments across a currency split.
- Anchor-age warnings (`anchorAgeDays` is served; no threshold, no warning code).

Consciously left out of this contract:

- Restore routes for soft-deleted rows (D18).
- Per-currency minor-unit exponents (D2) and ISO 4217 validation.
- Editing or deleting a single `payments` row (unpay removes them all, D23).
- `manager` type, reviewer flag, delete-is-admin (D5).
- Per-account daily series in `/forecast` (only the combined GBP `days[]`).
- Un-archiving a scenario (D36).
- `HEAD`/`OPTIONS` beyond the CORS shim; ETags; rate limiting.

---

## 12. File map (what lives where)

| Path | Holds |
|---|---|
| `src/handlers/jflow.js` | Express app, request id, auth + local bypass, `health`, `me`, `meta/enums`, `users`, `audit`, router mounts, 404, error handler, Lambda export |
| `src/db/index.js` | pool (`dateStrings: ['DATE']`, `timezone: 'Z'`), `withConnection`, `withTransaction` (deadlock retry default 1) |
| `src/db/migrations/2026-09-29_jflow_core.sql` | §3 DDL (14 tables incl. `payments`) + seed |
| `src/lib/shape.js` | `fail`, `apiError`, `serverError`, `listResponse`, `keysetResponse`, `parseId`, `parseListParams`, `normalizeEmail`, every `*ToJson` |
| `src/lib/audit.js`, `logger.js`, `sql.js`, `schema.js`, `secrets.js`, `timeout.js`, `roles.js` | copied from workflows per PLAN.md's table (`roles.js` = `USER_TYPES`, `isAdmin`, `requireAdmin`) |
| `src/lib/dates.js` | §2.5 |
| `src/lib/money.js` | §2.6 |
| `src/lib/keys.js` | §4 — the only key builder/parser |
| `src/lib/recurrence.js` | §5 |
| `src/lib/classify.js` | §9.6 — the only place the classification table lives; `OVERDUE_WINDOW_DAYS` |
| `src/lib/engine.js` | §9 |
| `src/services/forecastLoad.js` | §8 — rows in, engine input out, `loadTarget`; no logic |
| `src/routes/{companies,accounts,balances,fxRates,categories,items,schedules,forecast,scenarios}.js` | §6; router factories `({schemaReady, fail, serverError}) => router` as workflows; `schedules.js` owns instances, split and end |
| `test/unit` | dates, money, keys, recurrence, classify (the matrix), engine, loader shaping |
| `test/e2e` | per-run `jflow_test_<runid>` schema; the headline flow and every refusal in §7 |
