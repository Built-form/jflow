# JFlow — Phase 2 plan: stock payments

BUILD_PLAN step 12. **Written, not built.** Companion to `docs/PLAN.md` ("Phase 2"),
`docs/BUILD_PLAN.md` and `api/docs/CONTRACT.md`. Decisions P1–P12 (§5) need Dev's sign-off at step 13
and are then folded into PLAN.md and CONTRACT.md; until then PLAN.md wins. Paths outside `jflow/` are
relative to `C:\Users\OpsLondon\`. All findings come from a read-only pass on 2026-09-29.

## 1. What the code says

1. **`ShipLine/src/components/payments/paymentsFlowMath.ts`** is 2,470 lines of TS (ESM).
   `buildPaymentsFlow(input)` (L1944) takes orders (already through `api.ts` `mapOrder`), PO bundles
   (with `companyId`), PI payments, JFPRO suppliers with tags, ShipsGo containers, payment rules,
   shipment events, shipment payments, supplier payments and `today`. It returns `items[]`
   (`PaymentItem`, L635), POs, rollups, `dataQuality[]` and KPIs per currency. Imports are types
   plus two helpers from `../shared/containerHelpers`; there is no DOM, fetch or storage.
2. **Host-dependent.** When `today` is absent, `localTodayYmd()` reads the clock (L1945).
   `dateOfInstant` (L128) uses the host time zone: London in the browser, UTC on Lambda, so a 23:00Z
   instant lands a day apart. Money is floats (`Math.round(n*100)/100`, L841; `EPS = 0.01`).
3. **Item ids are neither key-safe nor stable.** The forms are `derived:dep:<po>`,
   `stated:<pi>[:<ctr>]`, `derived:bal:<po>:<ctr|none>` and `shipment:<sp>:<po>:<ctr>`
   (L1693–1858). Container refs are free text (`104. Air Freight`, `DRAFT-SEA-… - 268`). Ids change
   when a PI arrives or a draft becomes real. A `shipment:` id **repeats** when one invoice both
   allocates to a PO and shares its remainder with that PO (L2116 + L2135 → L1758).
4. **Paid money is never emitted.** A paid or landed PO returns `null` (L1603, L1888). Dated payments
   live only in shipping: `supplier_payments.paid_on` + `supplier_payment_lines`, and
   `shipment_payments.paid_on`. PIs carry a status only.
5. **Company.** `PaymentItem` has none. The PO's `companyId` is nullable. Shipping's companies are
   `JFA Medical Ltd` and `Hangerworld Ltd` (`src/db/migrate/2026-09-21_12_seed_companies.sql`), with
   no code column and editable names.
6. **No tests, fast churn.** ShipLine has no test runner, and its 27 parser vectors (L44–69) are a
   comment. The file was created 2026-09-21 and changed 2026-09-22. On 2026-09-28 shipping added
   `payment_rules.air_owed_from/air_limit_days` "so the Payments flow page (ShipLine) keeps air
   delivered … as owed" (`src/db/migrate/2026-09-28_10_payment_rules_air.sql`). The local ShipLine
   checkout (last commit 09-22) has no trace of it, so **the TS I read already lags its backend**.
7. **Shipping** (`shipping/`) is Express in CommonJS JS, with no TS or build step. Tests run as
   `node --test tools/test-*.js`. It runs on `nodejs18.x`, and function `ordersApi` sits behind JWT
   on `/api/v1/{proxy+}`. Secrets `shipping/prod|test` are baked in at deploy; stage `dev` **is**
   prod. It has no `X-Api-Key` route; the estate pattern for one is JFPRO's
   `api/internal-auth.js` plus `/api/internal/*` routes with no authorizer.
8. **Every input except suppliers is a shipping table behind a route in
   `src/handlers/orders.js`**: `/orders` (L794), `/purchase-order-invoice-payments` (L6768),
   `/payment-rules` (L6804), `/containers` (L1841), `/shipment-payments` (L9862),
   `/supplier-payments` (L10892); `/shipments` is in `src/services/shipment-routes.js`. Suppliers
   come from JFPRO, but shipping already reads `jfpro.suppliers` via the `jfa.suppliers` view
   (`src/db/migrations/2026-06-30_suppliers_views.sql`).
9. **Server-side drift has started, and nothing is shared.** `src/lib/delivered-air.js` copies
   `LANDED_STATUSES`. `src/lib/payment-reviews.js` keys sign-offs off the page because "only [the
   page] knows today's figure". None of the estate's 22 `package.json` files has a git or `file:`
   dependency, and there is no `.npmrc`.
10. **JFlow.** CONTRACT §4 and `lib/keys.js` already accept `ship.<[A-Za-z0-9_-]{1,64}>`, but D8
    answers `TARGET_MISSING` and §9 says `externalItems` "must be `[]`". The loader, stale checks,
    apply and lock order all need Phase 2 text; `lib/classify.js` does not.

## 2. Decision: route 2 — the math moves to the shipping API

**P1.** `buildPaymentsFlow` and its callees move to `shipping/src/lib/payments-flow/` (CommonJS,
JSDoc types). ShipLine reads `GET /api/v1/payments-flow` (JWT); JFlow reads
`GET /api/internal/payments-forecast`. Both project one call.

**Why.** The inputs are shipping's own tables (8). Route 1 needs the same server-side assembly, plus
a package pipeline the estate lacks (9), a TS build shipping lacks (7), and two-repo releases of a
file that changes daily (6). Route 1 would also still disagree with itself:
- on dates between browser and Lambda (2);
- on inputs, since each caller assembles its own (REST + `mapOrder` vs SQL).

Shipping already needs the figure server-side (9).

**Costs.** A one-time TS→JS port; ShipLine refetches after writes; ShipLine keeps response types
only, in `paymentsFlowTypes.ts`.

**End state (grep gate, step 17).** `ShipLine/src` contains no `buildPaymentsFlow`, `summarizePo`,
`parsePaymentTerms`, `resolveTermsRule`, `matchSupplier`, `resolvePolicy` or `deriveGroupDue`. Only
display helpers stay (`fmtYmd`, `isoWeek`, `weekMonday`, `addDays`, `bucketize`, `describe*`).

**Proving ShipLine's numbers are unchanged.**
- **Golden A.** Fixtures are `PaymentsFlowInput` JSON: shipping-test snapshots plus edge cases
  (multi-container, allocated + shared invoice, part-paid transfer, unparseable terms, air). The
  oracle is the frozen TS via `npx tsx` (a ShipLine devDep), run under `TZ=Europe/London` with a
  fixed `today`. The JS port must `deepStrictEqual` it under both `TZ=Europe/London` and `TZ=UTC`.
- **Golden B.** A script builds the input as `PaymentsFlowView` does (L238–284) and diffs it with
  the server assembler's input for the same `today`. It must find zero diffs.
- **Shadow.** The page computes both models and reports differences. Cut over at zero.

## 3. Shipping: `GET /api/internal/payments-forecast`

- **Auth.** `src/lib/internal-auth.js` is JFPRO's middleware in CommonJS, on
  `SHIPPING_INTERNAL_API_KEY`. Unset → 503 `{error: 'Internal API not configured'}`. Missing or wrong
  `X-Api-Key` → 401 `{error: 'Unauthorized'}`. It is registered before the allowlist middleware
  (`orders.js` L320). `serverless.yml` adds
  `- httpApi: {path: /api/internal/payments-forecast, method: GET}` to `ordersApi` with **no
  authorizer**, and env `SHIPPING_INTERNAL_API_KEY: ${self:custom.secrets.SHIPPING_INTERNAL_API_KEY, ''}`.
- **Key (P12).** A new random 32-byte hex value, not JFPRO's. It is `SHIPPING_INTERNAL_API_KEY` in
  `shipping/test|prod` and `SHIPPING_API_KEY` (beside `SHIPPING_API_BASE`) in `jflow/test|prod`.
  Dev creates it. To rotate: update both secrets, redeploy both.
- **Query.** All optional; a bad value → 400 `{error, code: 'INVALID_PARAM', details: {param}}`.
  - `today` (default: London today).
  - `paidSince` (default `today − 60`).
  - `status=open,paid`.
  - `companyId=<id>[,…]|none`.

  No paging.
- **Response.** 200, `Cache-Control: no-store`, gzipped by the existing `compression()`:
```
{ meta: { today, paidSince, generatedAt, model: '<git sha>' },
  companies: [ { id: 1, name: 'JFA Medical Ltd' }, … ],
  items: [ { id: 'bal-812-s311',                  // stable id, [A-Za-z0-9_-]{1,64}
             kind: 'deposit' | 'balance', status: 'open' | 'paid', supplier,
             companyId: 1 | null, poId, poNumber, shipmentId | null, containerRef | null,
             currency: 'USD', amount: '12345.67',  // 2-dp string; open = still owed
             dueDate: 'YYYY-MM-DD' | null,         // open rows
             dateBasis: 'firm' | 'estimated' | 'undated', amountBasis: 'stated' | 'derived',
             blocked: null | 'shipment' | 'artwork' | 'pi' | 'pi_signed', arranged: bool,
             paidOn: 'YYYY-MM-DD' | null, settles: '<id>' | null,   // paid rows
             flags: [ …PaymentFlag ] } ] }
```
- **Rows (P3).** `open` rows are the model's `PaymentItem`s. `paid` rows are transfer lines with
  `paid_on >= paidSince`, plus balance records marked paid without a transfer
  (`settled_by_payment_id IS NULL`). Paid rows are split per PO by the model's claim shares, so each
  has one company. A PI marked paid with no transfer has no date and emits nothing. Tested: Σ open
  `amount` per currency = `kpis.outstanding`.
- **`dateBasis`** is `undated` with no `dueDate`, `estimated` if `flags` has `estimated`, else `firm`.
  **`amount`** = `toFixed(2)` of the model's cent-rounded value.
- **Ids (P2)** all come from `feedId` in the lib.
  - `<g>` = `s<shipmentId>`, or `r<10 hex of sha256(upper(ref))>` if the ref has no shipment, or `n`
    if unbooked.
  - Open rows: `dep-<po>`, `pi-<invoicePayment>[-<g>]`, `bal-<po>-<g>`,
    `inv-<shipmentPayment>-<po>-a|s` (allocated or shared, which fixes finding 3's duplicate).
  - Paid rows: `pay-<supplierPayment>-bal|pi|dep<target>` and `spd-<shipmentPayment>-<po>`.

  Ids survive date drift, amount changes, part payments and a draft becoming real. **A stage change
  mints a new id**: a PI replaces a derived deposit, lines get booked, an invoice is recorded.
- **Errors.** 500 `{error: 'An internal error occurred.'}`, logged without the key.

## 4. JFlow

### 4.1 `api/src/services/shipping.js`
It copies the shape of `workflows/api/src/services/jfpro.js`: `SHIPPING_TIMEOUT_MS = 5000` on an
`AbortController`, the key only in `X-Api-Key`, `SHIPPING_API_BASE` / `SHIPPING_API_KEY` read per
call, and `isConfigured()`.
- `fetchPaymentsForecast({today, paidSince})` returns the body or throws `unavailable(reason)`, with
  `reason` one of `unconfigured | timeout | unreachable | http_401 | http_<status> | bad_response`.
- `validateFeed` counts and rejects bad rows (id grammar, `parseMinor(amount)`, dates, currency).
- **Degrade.** `/forecast` keeps the last snapshot and adds warning
  **`SHIPPING_UNAVAILABLE {reason, lastSuccessAt}`**.
- Both keys join put-secret's `OPTIONAL_DEPLOY_KEYS` and `serverless.yml`
  (`${self:custom.secrets.SHIPPING_API_BASE, ''}`), as workflows does for `JFPRO_*`.

### 4.2 Schema — `api/src/db/migrations/<date>_jflow_ship.sql` (CONTRACT §3.1 style)
```sql
CREATE TABLE IF NOT EXISTS external_items (              -- feed snapshot; rows never deleted
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(8) NOT NULL, ext_id VARCHAR(64) NOT NULL,  -- 'ship'; key = ship.<ext_id>
  -- feed columns: written by the refresh only
  feed_kind VARCHAR(8) NOT NULL, feed_status VARCHAR(8) NOT NULL,     -- deposit|balance; open|paid
  supplier VARCHAR(255) NULL, shipping_company_id BIGINT UNSIGNED NULL,
  po_id BIGINT UNSIGNED NULL, po_number VARCHAR(64) NULL,
  shipment_id BIGINT UNSIGNED NULL, container_ref VARCHAR(100) NULL,
  currency CHAR(3) NOT NULL, amount DECIMAL(14,2) NOT NULL,           -- open: owed; paid: this payment
  due_date DATE NULL, paid_on DATE NULL, settles VARCHAR(64) NULL,
  date_basis VARCHAR(12) NOT NULL, amount_basis VARCHAR(8) NOT NULL,
  blocked VARCHAR(16) NULL, flags_json JSON NULL,
  feed_hash CHAR(64) NOT NULL,                           -- sha256 of the feed columns
  gone_at DATETIME NULL,                                 -- left the feed; kept for overlays/adjustments
  -- overlay: written by user edit or scenario apply only, never by the refresh
  planned_date DATE NULL, planned_amount DECIMAL(14,2) NULL,
  planned_skipped TINYINT(1) NOT NULL DEFAULT 0,
  planned_base_amount DECIMAL(14,2) NULL,                -- feed amount when planned_amount was set (P6)
  planned_note VARCHAR(500) NULL, source_scenario_id BIGINT UNSIGNED NULL,
  planned_by VARCHAR(255) NULL, planned_at DATETIME NULL,
  row_version INT NOT NULL DEFAULT 0, created_by VARCHAR(255) NULL,  -- 'shipping-feed'
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_source_ext (source, ext_id),
  KEY idx_status_due (source, feed_status, due_date), KEY idx_paid_on (paid_on), KEY idx_gone (gone_at)
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS external_sync (                -- one row per source; meta, outside §2.9
  source VARCHAR(8) NOT NULL PRIMARY KEY,
  last_attempt_at DATETIME NULL, last_success_at DATETIME NULL, feed_today DATE NULL,
  last_error VARCHAR(500) NULL, item_count INT NOT NULL DEFAULT 0, rejected_count INT NOT NULL DEFAULT 0,
  companies_json JSON NULL,                              -- feed companies[], for the Settings picker
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;
INSERT INTO external_sync (source)
SELECT 'ship' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM external_sync WHERE source = 'ship');

SET @ship_company_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'shipping_company_id');
SET @ddl := IF(@ship_company_missing = 1,
  'ALTER TABLE companies ADD COLUMN shipping_company_id BIGINT UNSIGNED NULL AFTER sort_order, ADD KEY idx_shipping_company (shipping_company_id)',
  'SELECT 1');
PREPARE ship_stmt1 FROM @ddl;
EXECUTE ship_stmt1;
DEALLOCATE PREPARE ship_stmt1;

SET @ship_syskey_missing := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'system_key');
SET @ddl := IF(@ship_syskey_missing = 1,
  'ALTER TABLE categories ADD COLUMN system_key VARCHAR(16) NULL AFTER sort_order, ADD KEY idx_system_key (system_key)',
  'SELECT 1');
PREPARE ship_stmt2 FROM @ddl;
EXECUTE ship_stmt2;
DEALLOCATE PREPARE ship_stmt2;

INSERT INTO categories (name, direction, sort_order, system_key)
SELECT 'Stock payments', 'out', 900, 'ship' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE system_key = 'ship');
```
The schema goes to 17 tables. A `system_key` category refuses delete and direction change with
`CATEGORY_IN_USE` (P10).

### 4.3 Refresh — `api/src/services/shippingRefresh.js`
The refresh runs **outside any transaction**, as one autocommit single-row statement at a time, with
`innodb_lock_wait_timeout = 5`. It never holds two row locks, so it cannot deadlock; a row it can't
lock waits for the next run.
1. **Claim.** `UPDATE external_sync SET last_attempt_at = UTC_TIMESTAMP() WHERE source = 'ship' AND
   (last_attempt_at IS NULL OR last_attempt_at < UTC_TIMESTAMP() - INTERVAL 60 SECOND)`. 0 rows →
   skip.
2. **Fetch** with no DB connection held. `today` is the route's. `paidSince` is the earliest of the
   live accounts' latest `balance_date`s, else `today − 60`.
3. **Diff** by `(ext_id, feed_hash, gone_at)`. A new id → `INSERT`. Changed, or back → `UPDATE` the
   feed columns, `gone_at = NULL`. Missing → `gone_at = UTC_TIMESTAMP()`. Each `UPDATE` bumps
   `row_version`. Never `DELETE`.
4. **Record** `last_success_at`, `feed_today`, counts and `companies_json`; on failure only
   `last_error`.

It **never writes `planned_*` or `source_scenario_id`**, and writes no per-row audit (P8); overlay
writes are audited. **When (P4):** `/forecast` runs it before taking a connection if
`last_success_at` is over 10 minutes old or `feed_today ≠ today`, costing at most 5s on one request
per 10 minutes. `POST /api/v1/external/refresh` forces a run (503 `SHIPPING_UNAVAILABLE` on failure);
`GET /api/v1/external/status` reads `external_sync`.

### 4.4 Keys
`buildShipKey(ext_id)` → `ship.<ext_id>`. The feed grammar is exactly §4's `[A-Za-z0-9_-]{1,64}`, so
nothing is escaped. The parsed form is `target_kind 'ship'`, `target_id = ext_id`,
`target_date NULL`. D8 is retired.

### 4.5 Loader and engine
- **Account (P5)**, resolved in SQL at load time and never stored. Find the JFlow company whose
  `shipping_company_id` matches the row. Use its live active account in the row's currency (lowest
  `sort_order`, id), else its `is_default` account. No match → the row is omitted, with warning
  `SHIP_UNMAPPED {shippingCompanyId, count}`.
- **Load rule 11 (§8).** Rows with `source 'ship'`, `gone_at IS NULL` and an account in scope, where
  `feed_status = 'open'` (dated or not) or `feed_status = 'paid' AND paid_on >= minA`. **Rule 6**
  adds `ship.` targets by `ext_id`, gone or not; `loadTarget` returns their effective values.
- **Engine (P9).** Before §9.4 each row becomes one line: `kind 'ship'`, `direction 'out'`, the
  `system_key = 'ship'` category, and settle mode **`manual`**. Shipping, not the calendar, says a
  supplier was paid, so a late unpaid balance is overdue, never assumed settled.

| Feed row | Line |
|---|---|
| paid | `status 'paid'`, one payment `{paidOn, amount}` → §9.6 rows 1–2 (before A excluded, A..today absorbed, today in today's bucket) |
| open + `planned_skipped` | `skipped` |
| open, dated | `expected`; date `planned_date ?? due_date`; amount `planned_amount` while `planned_base_amount = amount`, else `amount` + warning `SHIP_PLAN_STALE {key}` (P6); rows 7–9 |
| open, undated | no band; counted in `shipping.undatedCount` |
| gone | not projected; an overlay on it → warning `SHIP_PLAN_ORPHANED {key}` |

- **Flags only.** `estimated`, `projected`, `blocked` and `planned` never change a band.
- **Assumed-paid money** (a proof file, or goods that have moved) leaves the feed with no paid row,
  so it reads as settled before the anchor.
- **FX.** Ship currencies join the currencies in scope (§3.4); a missing rate → 422
  `FX_RATE_MISSING`.

### 4.6 `/forecast`
- **`rows[]`** gains a "Stock payments" category. Its items carry `kind: 'ship'`, `id: ext_id`, the
  name `<supplier> · <poNumber> · deposit|balance`, and `ship: {kind, poNumber, containerRef,
  dateBasis, amountBasis, blocked, feedDate, feedAmountMinor}`. Flags are §4.5's plus `overdue`,
  `paid`, `adjusted`, `excluded` and `stale`. `editable` follows §6.10, and edits write the overlay.
- **Absorbed and unresolved.** Paid lines in `[A, today)` go to `accounts[].absorbed[]`; lines more
  than 45 days overdue go to `unresolved[]`.
- **New `shipping` block**: `{lastSuccessAt, feedToday, openCount, undatedCount, undatedGbp,
  unmappedCount} | null`. `include=summary` keeps it.
- **`warnings[]`** gains `SHIPPING_UNAVAILABLE`, `SHIP_UNMAPPED`, `SHIP_PLAN_ORPHANED` and
  `SHIP_PLAN_STALE`.

### 4.7 Overlay writes: user edit and scenario apply
- **User edit.** `PUT /api/v1/external-items/:key {plannedDate?, plannedAmount?, skipped?, note?,
  baseVersion?}` locks the row. Refusals: gone → 404 `TARGET_MISSING`; paid → 409
  `TARGET_SETTLED`; past date → 422 `PLANNED_DATE_IN_PAST`. Setting an amount also stores
  `planned_base_amount = amount`. Audit `external_item`/`plan`. `DELETE` reverts (`unplan`), and
  `GET /api/v1/external-items` lists rows with `derivedStatus`.
- **Adjustment write and rebase (§10.7–10.8).** A `ship.` key locks its row (§4.8). `loadTarget`
  null or gone → `TARGET_MISSING`; paid or skipped → `TARGET_SETTLED`. The base includes the overlay
  (as D11). ETAs drift, so `BASE_CHANGED` will be common.
- **Apply (§10.9 step 5).** `adjust` → `planned_date = new_date ?? planned_date` and
  `planned_amount = new_amount ?? planned_amount` (plus `planned_base_amount`); `exclude` →
  `planned_skipped = 1` (P7). Apply stamps `source_scenario_id`, `planned_by`, `planned_at` and
  `row_version`, and audits `external_item`/`apply`. Nothing goes back to shipping, so the overlay is
  the only home of an applied `ship.` adjustment.

### 4.8 Lock order (CONTRACT §10.1, P11)
**scenarios (asc) → schedules (asc) → cash_items (asc) → external_items (asc id) →
schedule_overrides → payments.** `external_items` has no parent or children, so it sits with the
top-level targets. The refresh takes no transaction (§4.3). Apply does no network I/O and re-checks
against the snapshot, never against live shipping.

### 4.9 Company mapping
`companies.shipping_company_id` is picked in Settings from `external_sync.companies_json`: JFA →
`JFA Medical Ltd`, HW → `Hangerworld Ltd`. It isn't seeded, because the ids differ per shipping
stage. It is unique per JFlow company (409 `SHIPPING_COMPANY_TAKEN`). POs with no company are
unmapped.

## 5. Decisions for sign-off

| # | Decision |
|---|---|
| P1 | Route 2: one implementation, in `shipping/src/lib/payments-flow/` |
| P2 | Feed id grammar and `feedId` (§3); a stage change mints a new id |
| P3 | Paid rows = transfers + balance records marked paid; a PI marked paid with no transfer emits nothing |
| P4 | Refresh on demand (10-minute TTL or a new `today`) plus a manual refresh; no schedule |
| P5 | Account resolved at load: currency-matched, else the company default |
| P6 | `planned_amount` applies only while `planned_base_amount` equals the feed amount |
| P7 | `exclude` on `ship.` → `planned_skipped`, a third overlay column beyond PLAN's two |
| P8 | No per-row audit for the refresh |
| P9 | Ship lines are always `manual`; undated lines are counted, not banded |
| P10 | System category "Stock payments" via `categories.system_key` |
| P11 | `external_items` sits after `cash_items` in the lock order |
| P12 | A separate shipping key, not JFPRO's |

## 6. Build order (steps 13–23)

Steps 14–18 edit `shipping` and ShipLine, each on its own `test` branch and following its own
conventions. Each needs Dev's go-ahead. Every shipping deploy, secret, and ShipLine prod change is a
**STOP**.

### Step 13 — Adopt the plan — **STOP** (Dev)
Do: fold P1–P12 into PLAN.md and CONTRACT.md (§3, §4, §6.10, §7–§9, §10.1, §10.7–10.9, §12; D8
retired). Dev signs off, names the ShipLine commit that is the source of truth, freezes
`paymentsFlowMath.ts` until step 17, answers open question 5, and decides shipping's runtime (risk 1).
Done when: CONTRACT.md has no "must be `[]`" and no D8 rule for `ship.`.

### Step 14 — shipping: port the math, no routes (tests first)
Do: `src/lib/payments-flow/{dates,terms,suppliers,policy,po,flow,ids}.js` is a type-stripped port of
the frozen TS plus `feedId`. `dateOfInstant` is pinned to Europe/London, and `today` is required.
Tests: `tools/test-payments-terms-lib.js` (the 27 vectors), `test-payments-flow-golden.js` (Golden
A), `test-payments-ids-lib.js` (grammar, uniqueness, allocated + shared), all in `test:unit`.
Done when: every fixture deep-equals the oracle under both `TZ=UTC` and `TZ=Europe/London`.

### Step 15 — shipping: input assembler + `GET /api/v1/payments-flow` — **STOP** before deploy
Do: `src/services/payments-flow-input.js` reuses the routes' mappers (`rowToOrder` + `mapOrder`
rules, `loadPurchaseOrdersForOrders`, `invoicePaymentRowToJson`, `rowToContainer`,
`paymentRuleRowToJson`, shipment and supplier payments, `jfa.suppliers` + tags). Add the JWT route.
`delivered-air.js` imports `LANDED_STATUSES` from the lib.
Tests: assembler units; Golden B.
Done when: Golden B finds zero diffs on 3 snapshots from different days.
**STOP**: Dev runs `bash deploy.sh test`.

### Step 16 — ShipLine: shadow — **STOP** before each deploy
Do: the page also fetches `/payments-flow`, keeps rendering its own model, and shows admins a diff
count.
**STOP** for each deploy, in order: ShipLine test (Vercel), shipping prod, ShipLine prod.
Done when: zero diffs in prod for 5 working days.

### Step 17 — ShipLine: cut over and delete — **STOP** (ShipLine prod)
Do: render the server model and refetch after writes. `PaymentRulesPanel` previews via shipping's
`POST /api/v1/payment-terms/preview`. Keep only types (`paymentsFlowTypes.ts`); delete the math.
Tests: `npm run lint` (tsc); walk the page on test against the same day in prod.
Done when: §2's grep gate finds nothing. **One implementation from here.**

### Step 18 — shipping: `/api/internal/payments-forecast` — **STOP** (secret, deploy)
Do: §3's `internal-auth.js`, the route before the allowlist, `toForecastRows(flow, paidRows)`, and
the gateway and env lines.
Tests: `test-payments-forecast-lib.js` (ids, amount strings, `dateBasis`, one company per row, paid
split per PO, Σ open = `kpis.outstanding`); auth (401 with no key, 401 with a wrong key, 503 when
unset).
**STOP**: Dev adds `SHIPPING_INTERNAL_API_KEY` to `shipping/test|prod` and deploys test.
Done when: `curl` with the key → 200 that `validateFeed` accepts with 0 rejects. Without the key the
401 comes from Express, not the gateway's JWT authorizer.

### Step 19 — JFlow: schema, client, refresh
Do: §4.2 migration, `services/shipping.js`, `services/shippingRefresh.js`, `routes/external.js`,
`PUT /companies/:id {shippingCompanyId}`, put-secret, `serverless.yml`, `.env.example`.
Tests (stub HTTP server):
- timeout at 5s, 401, non-JSON, and unconfigured (which makes no call);
- bad rows are counted;
- insert, change, gone and back;
- an overlay survives a refresh that changes every feed column;
- the claim blocks a concurrent run;
- migrate twice → 0 applied.

Done when: green, and `grep -n planned_ src/services/shippingRefresh.js` finds nothing.

### Step 20 — JFlow: loader, engine, `/forecast` (tests first, `/effort xhigh`)
Tests:
- open lines: future, overdue at −45, unresolved at −46, undated counted;
- paid rows: A−1 excluded, A absorbed, today in today's bucket;
- overlays: `planned_date`, stale `planned_amount`, `planned_skipped`;
- `SHIP_PLAN_ORPHANED`, `SHIP_UNMAPPED`; account by currency, else the default;
- the rounding invariant with USD and CNY lines;
- `/external-items` agrees with `/forecast`;
- a failed refresh → 200 + `SHIPPING_UNAVAILABLE`.

Done when: green, and `curl /forecast` shows the Stock payments row.

### Step 21 — JFlow: overlay routes and `ship.` scenarios (tests first, `/effort xhigh`)
Tests (e2e):
- overlay PUT/DELETE and each refusal;
- a scenario moves a ship date, apply writes a stamped `planned_date`, and a refresh that moves the
  feed date leaves it;
- a gone target → `TARGET_MISSING`; a paid one → `TARGET_SETTLED`; drift → `BASE_CHANGED` → rebase →
  apply;
- on two connections, a refresh `UPDATE` during an apply waits (or is skipped after 5s) and never
  touches `planned_*`.

Done when: green, and `grep` shows `external_items` locked between `cash_items` and
`schedule_overrides`.

### Step 22 — Web and mobile
Do:
- a company picker in Settings;
- Forecast renders ship lines from server flags: estimated hatched, blocked and undated counts,
  "Refresh now", a `SHIPPING_UNAVAILABLE` banner;
- the item dialog writes the overlay, or an adjustment inside a scenario;
- mobile shows the summary only.

Tests: vitest on the display helpers, plus a browser walk.
Done when: the walk matches `/forecast`.

### Step 23 — Deploy — **STOP** (Dev)
Dev adds `SHIPPING_API_BASE` / `SHIPPING_API_KEY` to `jflow/test|prod`, runs `bash deploy.sh test`,
and maps JFA and HW. Per-currency open totals (mapped + unmapped) must match ShipLine's Payments page.
After a day on test: `bash deploy.sh prod`.

## 7. Risks and open questions for Dev

**Risks**
1. **Shipping pins `nodejs18.x`** (PLAN's Risks). Steps 15–18 each need a shipping deploy. If AWS
   already blocks updates on that runtime, `deploy.sh` fails and Phase 2 stops there. Moving to
   `nodejs22.x` is its own change and test deploy, done before step 15 (check `pdfkit`, `@aws-sdk`,
   the EMFILE workaround). I have not verified AWS's dates.
2. **The TS I read is stale** (finding 6). Golden A is only as good as its oracle: the commit Dev
   names, frozen until step 17.
3. **Stage changes retire ids.** An overlay or adjustment on `dep-812` does not follow the PI that
   replaces it; the user sees `SHIP_PLAN_ORPHANED` / `TARGET_MISSING` and re-plans. The refresh never
   writes `planned_*`, so it cannot move the plan.
4. **ETAs drift**, so draft scenarios on estimated ship lines go `BASE_CHANGED` often.
5. **Local dev and JFlow test share explorer-test** (`jflow`). Both must point at shipping **test**,
   or they overwrite each other's snapshot.
6. **Double counting**: stock payments entered by hand as `cash_items` must be removed at step 23.
7. **Assumed-paid money has no date.** If it actually left after the anchor, today's opening is
   overstated until the next balance. Recording transfers in ShipLine fixes this.

**Open questions**
1. Which ShipLine commit is the source of truth? Can payments-math changes be frozen for steps 13–17?
2. POs with no company: leave them unmapped, with the total in `SHIP_UNMAPPED` (recommended), or
   default them to one company?
3. P5: are suppliers paid from the account in their currency, else the company default?
4. FX: keep 422 `FX_RATE_MISSING` for a ship currency with no rate (recommended: one rule), or skip
   those lines with a warning?
5. Supplier tags on the server: a SELECT grant on `jfpro.supplier_tags` / `jfpro.tags`, or a DEFINER
   view run by admin, as on 2026-06-30?
6. Is it acceptable that the refresh writes no per-row audit (P8)? Keep `exclude` for `ship.` via
   `planned_skipped` (P7), or refuse it?
7. A new shipping key (recommended), or reuse JFPRO's?
8. Is 45 days the right overdue/unresolved cut-off for supplier money?
