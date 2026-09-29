# JFlow — cashflow forecasting app (plan)

## Context

The business needs a cashflow tool: record daily cash at bank, schedule one-off and
recurring income/outgoings, tune individual recurring instances as dates approach
(June 983, July 1024), test moving a payment date, and save those what-ifs as named
scenarios. Phase 2 layers in stock payments from the shipping system.

It must be a sibling of `C:\Users\OpsLondon\workflows` with the same structure, deploy and
migration method, serverless config and RDS Proxy access.

**Decisions made:** name **JFlow**; forecast shown in **GBP** with a hand-maintained FX
table (each account/item keeps its own currency); **per company with a combined view**;
Phase 2 reads a **new read-only feed endpoint in the shipping API**.

**Findings that shape the plan**
- Workflows' deployed Lambda runs **no DDL**. `bash deploy.sh test|prod` runs
  `tools/migrate.js --stage X` first, then deploys. Cold-start `ensureSchema` is local-dev
  only. Frontends deploy via Vercel, not bash. JFlow mirrors this, not the brief's
  "IIFE at cold start".
- Stock payment *projections* are not in the shipping API. They are computed in the
  browser by `ShipLine/src/components/payments/paymentsFlowMath.ts`
  (`buildPaymentsFlow`, 2,786 lines at the frozen commit `f9499bc`). Phase 2 moves them
  to the shipping API (below).
- "Cashboard" and "Payments" already exist in the estate; JFlow avoids both names.

## Naming

| Thing | Value |
|---|---|
| Repo | `C:\Users\OpsLondon\jflow` (own git repo, branch `master`) |
| Serverless service / function | `jflow` / `jflowApi` |
| Secrets | `jflow/test`, `jflow/prod` (eu-north-1) |
| DB schema | `jflow` (dev + test share explorer-test; prod via RDS Proxy) |
| Hosts | `jflow.built-form.co.uk`, `mjflow.built-form.co.uk` |
| Runtime | **`nodejs22.x`** (see Risks) |

## Repository layout

```
jflow/
  CLAUDE.md  README.md  .gitignore  .editorconfig  .gitattributes
  .github/workflows/ci.yml            lint + unit tests, working-directory api
  api/
    package.json  serverless.yml  deploy.sh  jest.config.js  eslint.config.js  .env.example
    docs/CONTRACT.md  docs/PROGRESS.md
    tools/migrate.js  tools/put-secret.js
    src/handlers/jflow.js             one Express app, serverless-http export
    src/db/index.js                   pool, withConnection, withTransaction
    src/db/migrations/2026-09-29_jflow_core.sql
    src/lib/     logger sql schema secrets timeout shape audit roles
                 money dates keys recurrence engine
    src/services/forecastLoad.js      DB rows -> engine input (no logic)
    src/routes/  companies accounts balances fxRates categories
                 items schedules forecast scenarios
    test/unit  test/e2e
  web/        Vite + React 18 + TS, react-router 6, vitest, vercel.json
  mobileweb/  same + vite-plugin-pwa
```

### Copy from workflows, changing names only
| Source (`workflows/`) | Notes |
|---|---|
| `api/deploy.sh` | drop the sharp Linux-build step |
| `api/serverless.yml` | same VPC (`sg-015a76ba77bb50587`, 3 private subnets), same Google JWT authorizer + audience, same CORS block, `ANY` + `OPTIONS` routes, `SECRET_ID` runtime password fetch, package patterns. Remove S3 bucket, EventBridge, JFPRO and sharp entries. Runtime `nodejs22.x` |
| `api/tools/migrate.js`, `api/tools/put-secret.js` | secret id `jflow/<stage>` |
| `api/src/db/index.js`, `lib/logger.js`, `lib/sql.js`, `lib/audit.js`, `lib/secrets.js`, `lib/schema.js` | `withTimeout` moves to `lib/timeout.js` (no events service); meta table `jflow_schema_meta`; `withTransaction` gains the deadlock retry described under Lock discipline |
| `api/src/lib/shape.js` | envelopes + parsers only (`fail`, `apiError`, `serverError`, `listResponse`, `parseId`, `parseListParams`) |
| `api/src/handlers/workflows.js` | request id, auth middleware, local bypass, health/me/users/audit, 404 + error handler, Lambda export |
| `web/src/auth/sharedSession.ts` | **byte-identical**, do not edit |
| `web/src/config/env.ts`, `api/client.ts`, `app/auth.tsx`, `app/session.tsx`, `app/useQuery.ts`, `components/{Shell,ui,Dialog,ErrorBoundary,EnvBanner,PageHeader}`, `styles/*`, `vercel.json`, `vite.config.ts` | JFlow hosts/URLs |
| `mobileweb/` equivalents | each copied file carries the "Copied verbatim from web/…" header |

## What a recorded balance means

**A balance is the cash at bank at the START of `balance_date`**, before that day's
movements: last night's closing figure, which is what someone reads at 9am. The column
is `balance`, not `closing_balance`, and every entry screen labels it
"Cash at bank at start of day". `balance_date <= today` is enforced on write.

Consequences, used everywhere below: with anchor date **A**, anything dated `< A` is
already in the figure; anything dated `>= A` is not. Entering today's balance leaves
today's items in today's bucket.

## Database schema (one migration, all `CREATE TABLE IF NOT EXISTS`)

Conventions as workflows: snake_case, no FKs, VARCHAR enums validated in code,
`DECIMAL(14,2)`, `DATE` as strings, `row_version`, `created_by`, audit row per mutation.
Later ALTERs use the `information_schema` guard pattern from
`workflows/api/src/db/migrations/2026-09-08_stages.sql`.

| Table | Key columns |
|---|---|
| `jflow_schema_meta`, `allowed_emails`, `audit_log` | as workflows (`type` standard \| admin) |
| `companies` | code, name, sort_order, deleted_at. Seeded: JFA, Hangerworld |
| `bank_accounts` | company_id, name, currency, sort_order, is_active, is_default, deleted_at |
| `bank_balances` | account_id, balance_date, balance, note, entered_by. `UNIQUE(account_id, balance_date)`. **Hard delete** |
| `fx_rates` | currency, rate_to_gbp `DECIMAL(12,6)`, effective_from, note. `UNIQUE(currency, effective_from)` |
| `categories` | name, direction, sort_order, deleted_at |
| `cash_items` (one-offs) | account_id, category_id, direction `in\|out`, name, counterparty, amount, currency, due_date, status `expected\|part_paid\|paid\|skipped`, paid_on, paid_amount, settle_mode `auto\|manual`, notes, source_scenario_id, deleted_at. `KEY(account_id, status, due_date)` |
| `schedules` (recurring rule) | same descriptive fields + frequency `weekly\|fortnightly\|four_weekly\|monthly\|quarterly\|annually`, interval_count, start_date, **active_from NULL**, occurrence_count NULL, end_date NULL, weekend_rule `none\|previous\|next`, predecessor_id NULL, status `active\|ended`, deleted_at. `KEY(account_id, status)` |
| `schedule_overrides` | schedule_id, **natural_date**, amount NULL, due_date NULL, status NULL, **settle_mode NULL**, paid_on, paid_amount, note, source_scenario_id NULL. `UNIQUE(schedule_id, natural_date)`. **Hard delete** = revert to predicted; refused while the row carries payment state |
| `payments` | cash_item_id NULL, override_id NULL (exactly one set), paid_on, amount, note, created_by. `KEY(cash_item_id)`, `KEY(override_id)`. One row per pay. **Hard delete** (unpay removes all of the parent's rows) |
| `scenarios` | name, description, company_id NULL (view scope), status `draft\|applied\|archived`, applied_at, applied_by, deleted_at |
| `scenario_adjustments` | scenario_id, item_key, **target_kind, target_id, target_date NULL**, kind `adjust\|exclude`, new_date NULL, new_amount NULL, base_date, base_amount, note. `UNIQUE(scenario_id, item_key)`, `KEY(target_kind, target_id)`. **Hard delete while the scenario is `draft` only**; immutable afterwards |

- **No `company_id` on items or schedules.** Company is derived through the account, so
  the two can never disagree.
- **An instance's settle mode is its override's `settle_mode` when set, else the
  schedule's.** This is how one instance of an `auto` schedule becomes `manual`
  ("Didn't happen", below) without touching the series.
- Remaining amount is derived (`amount − paid_amount`), not stored.
- **Payments are rows, one per pay.** `paid_amount` / `paid_on` on `cash_items` and
  `schedule_overrides` are a cache (`SUM(amount)`, `MAX(paid_on)`) rewritten in the same
  transaction as every payment write. The engine classifies each payment on its own
  `paid_on`, so two part payments straddling an anchor are never counted twice.
- `paid_on <= today` and `paid_amount > 0` enforced on every pay write.
- **`active_from`** keeps a successor on its predecessor's date grid: natural dates before
  it belong to the predecessor; NULL means from `start_date`.

## Item keys

Unreserved URL characters only, so a key is safe in a path, a log line and through API
Gateway with no encoding: `item.123`, `sched.45.2026-06-01`, later `ship.<id>` with
`<id>` limited to `[A-Za-z0-9_-]`. `lib/keys.js` is the only builder and parser; the API
rejects a key that does not match. `target_kind/target_id/target_date` on an adjustment
are the parsed form, so lookups never pattern-match strings.

## Recurring instances

- **Virtual**, expanded at read time, never materialised. Identity is the **natural
  (unadjusted) date**.
- Tuning an instance = upsert one `schedule_overrides` row. The series is untouched.
- **Structure is immutable once used.** Name/category/notes edit in place. Changing
  amount, frequency, start, account or currency is a **split**: end the old schedule
  before instance *k*, insert a successor with `predecessor_id`. This also delivers
  "1050 from July onwards". When the split leaves the date grid alone (frequency,
  interval, start and weekend rule unchanged), the successor keeps the old `start_date`
  with `active_from = k`, so a month-end series stays on the 31st; otherwise it starts at
  `changes.startDate` or *k*.

### Split (and "end early") transaction
1. **Find and lock the draft scenarios first.** Read the draft scenarios holding
   adjustments that target this schedule from *k* (`target_kind='sched' AND
   target_id=? AND target_date>=?`, bound to `fromNaturalDate` for a split and
   `target_date > lastNaturalDate` for an end, since *k* needs the locked schedule), lock
   those `scenarios` rows ascending with `FOR UPDATE`, then re-read the adjustments under
   the lock. A scenario that has stopped being `draft` in the meantime is left alone: its
   adjustments are history. Taking these locks before the schedule lock is what keeps the
   standing lock order.
2. Lock the `schedules` row; compute *k*.
3. **Payment guard.** `SELECT … FROM schedule_overrides WHERE schedule_id = ? AND
   natural_date >= ? AND (status IN ('paid','part_paid') OR paid_amount > 0 OR paid_on
   IS NOT NULL)`. Any row → `409 SCHEDULE_HAS_PAYMENTS` with the dates.
4. **Unpaid overrides** from *k* → `409 SCHEDULE_HAS_OVERRIDES` listing them, unless
   `dropOverrides: true`.
5. **Draft scenario adjustments** from step 1 — decide only, write nothing yet:
   - natural dates survive **and the currency is unchanged** (amount/account-only
     split): **re-key to the successor** (written in step 7, once it has an id). Their
     base no longer matches, so they read as stale until rebased, which is the truth.
   - natural dates change (frequency/interval/start/weekend rule), the currency changes
     (a re-keyed `new_amount` would silently be in the wrong currency), or the schedule
     is being ended: `409 SCHEDULE_HAS_ADJUSTMENTS` listing scenario and date, unless
     `dropAdjustments: true`.
6. `DELETE FROM schedule_overrides WHERE schedule_id = <old> AND natural_date >= <k>`,
   and delete the dropped adjustments; one audit row per deleted override and per
   dropped adjustment.
7. End the old schedule, insert the successor, then re-key the adjustments from step 5
   to it, one audit row each — all in this transaction.

**Engine defence in depth.** An override is only ever attached to an instance the
schedule actually generates. One whose `natural_date` is not an occurrence, or lies past
the schedule's end, is never projected; it is returned as warning `ORPHAN_OVERRIDE`.

### Lock discipline (standing rule, written into CONTRACT.md)
Never rely on InnoDB gap locks. **Every writer of an instance locks the parent
`schedules` row before it touches any override row**: tune, pay, unpay, revert, split,
end, and scenario apply. That serialises them against the split guard at any isolation
level, including "mark paid" on an instance that has no override row yet. Lock order,
always: scenarios (ascending id) → schedules (ascending id) → cash_items (ascending id)
→ external_items (ascending id, Phase 2) → overrides → payments (only ever touched under their parent's lock). A writer that will need a lock earlier in that order takes it up front,
which is why the split finds its draft scenarios before locking the schedule.
`withTransaction` retries the whole body once on `ER_LOCK_DEADLOCK`; bodies keep every
read inside the transaction so the retry is safe.

## Forecast engine — `api/src/lib/engine.js`

Pure function: no DB, no clock. Money as integer minor units parsed from DECIMAL
strings (never via floats). Dates by epoch-day arithmetic on `YYYY-MM-DD`.
`lib/recurrence.js` computes monthly as start + n months, clamped to month end.

1. `today` = Europe/London date, computed in the route with `Intl.DateTimeFormat`.
   A `?today=` parameter is honoured only in local/test.
2. Per account, anchor **A** = latest recorded balance date. No balance: account
   excluded, warning `NO_ANCHOR`.
3. **Load** (in `forecastLoad.js`; the rules are part of CONTRACT.md):
   - dated `[min(A), to]`: all items and schedule occurrences;
   - paid with `paid_on >= min(A)`, whatever the due date (paid late), and their
     `payments` rows with `paid_on >= min(A)`;
   - **every override row of a loaded schedule, whatever its dates or columns** — an
     amount-only tune has no `due_date`, a moved date may leave the window, a part-paid
     remainder may have slipped behind `min(A)`, and a "Didn't happen" row carries only
     `settle_mode`; overrides are sparse;
   - **manual and still owed, with no 45-day floor**: one-off items `expected` or
     `part_paid` dated before today, all of them (indexed by status); manual schedules
     scanned back to `max(start_date, today − 730d)`;
   - **every target of the scenario's adjustments, by key**, so an instance an
     adjustment moves into the window is present.
4. Effective date = override date verbatim (weekend rule bypassed), else the
   weekend-adjusted natural date.
5. **Apply scenario adjustments, before classifying.** Baseline and scenario are two
   item sets from here on. `adjust` replaces date and/or amount; `exclude` removes.
   `new_date >= today` is enforced on write. An adjustment is **stale** when the base
   date/amount no longer matches (`BASE_CHANGED`), the target is no longer `expected`
   (`TARGET_SETTLED`), the target is gone (`TARGET_MISSING`), or an `adjust`'s
   `new_date` is now before today (`DATE_PASSED`; rebase cannot fix it, the user
   re-dates or drops it). Stale adjustments are not applied and are flagged on the item
   and in `scenario.warnings`.
6. **Classify each set** (A `<=` today always, so the overdue floor is `today`; an
   instance's settle mode is its override's when set, else the schedule's):

| State | Treatment |
|---|---|
| each payment row, `paid_on < A` | excluded (already in the bank balance) |
| each payment row, `paid_on >= A` | included at its `paid_on` |
| part_paid | remainder is expected and **forced to `manual`** for the run |
| skipped | excluded |
| expected, `auto`, effective `< A` | assumed settled, excluded |
| expected, `auto`, `A <= effective < today` | **included at its effective date**, flagged `assumed`; moves today's opening; listed in the account's `absorbed[]` |
| expected, effective `>= today` | normal future item |
| expected, `manual`, effective `< today`, within 45 days | **overdue**, placed at `today` |
| expected, `manual`, older than 45 days | `unresolved[]`, not in the series |

   Because adjustments come first, moving an overdue item to next week makes it a normal
   future item in the scenario while it stays overdue in the baseline.
   A unit test enumerates `{auto, manual} × {< A, A..today, >= today}` plus `A == today`
   and asserts every item lands in exactly one row.
7. FX: one rate set per run (latest `effective_from <= today`), used for every date.
   Anchor balances are re-valued at it. Missing rate: 422 `FX_RATE_MISSING`.
8. **Rounding invariant.** GBP is fixed **per item, once**:
   `gbpMinor = roundHalfUp(nativeMinor × rate)` in integer arithmetic (rate parsed from
   its DECIMAL string to micro-units, BigInt multiply). Every GBP inflow, outflow and
   net, at day, bucket, row and summary level, is a plain integer sum of those values.
   An account's GBP closing is `openingGbp + Σ item gbpMinor`, never a re-conversion of
   the native closing. An item in another currency than its account converts
   item → GBP → account currency, each step rounded once.
9. Roll **each account from its own anchor** to `today`; items in that gap are returned
   on the account (`absorbed[]`). The combined GBP line is summed from `today` onward.
10. **The forecast starts today.** Output window is `[today, to]`; an earlier `from` is
    clamped and `meta.fromClamped` says so. It is not a ledger: no GBP line is ever
    computed for a past date at today's rate.
11. Window capped at 730 days ahead.

**Part payments must say when the rest is due.** A partial pay on an item whose
effective date is before today answers `422 REMAINDER_DATE_REQUIRED` unless
`remainderDueDate` (today or later) is sent. `summary` carries `unresolvedCount` /
`unresolvedTotal`, shown as a banner above the grid.

**"Assumed settled" is visible, not silent.** List responses carry a server-derived
`derivedStatus: 'assumedSettled'` for an `auto` item still `expected` and dated `< A`.
Nothing is written, so deleting or correcting a balance un-settles it. Income &
outgoings and the schedule's instance table show these as a filterable group with two
actions: **Confirm paid**, or **Didn't happen**, which writes `settle_mode = 'manual'`
on the one-off item or on the instance's override row, so it reappears as overdue.
That is where a bounced payment gets noticed.

## API (all under `/api/v1`, Google JWT + allowlist)

```
health, me, meta/enums, users, audit                     (from workflows)
companies  accounts  categories  fx-rates                CRUD
GET  /balances?accountId&from&to
PUT  /accounts/:id/balances/:date     POST /balances/bulk   DELETE …
items       CRUD + POST /items/:id/pay | /unpay
schedules   CRUD + POST /schedules/:id/split | /end
GET  /schedules/:id/instances
PUT|DELETE /schedules/:id/instances/:naturalDate           tune (amount, date, note, settleMode) / revert
POST /schedules/:id/instances/:naturalDate/pay | /unpay
GET  /forecast?companyId=<id>|all&from&to&bucket=day|week|month&scenarioId&include=summary|grid
scenarios   CRUD + duplicate
PUT|DELETE /scenarios/:id/adjustments/:itemKey
POST /scenarios/:id/rebase            refresh bases; dropStale:true removes settled/missing/date-passed
POST /scenarios/:id/apply
```

**Forecast response** (camelCase, money in minor units): `meta` (today, window, bucket,
fromClamped, ratesUsed), `accounts[]` (anchorDate, anchorAgeDays, openingNative,
openingGbp, absorbed[]), `days[]` (daily series for the chart), `buckets[]` (opening,
inflow, outflow, net, closing, **minClosing/minDate from the daily series**), `rows[]`
(category → items with key, amounts, date, naturalDate, flags, `editable`, `baseline`),
`summary`, `scenario` (baselineSummary, deltaByBucket, warnings), `unresolved[]`,
`warnings[]`. `include=summary` omits `rows` for mobile. Flags and `editable` come from
the server so clients hold no engine rules.

**Apply is all or nothing.** One transaction: lock the scenario row, require `draft`,
lock targets in the standing order, then re-check **every** adjustment under those
locks. If any is stale by the definition in step 5, the whole apply answers
`409 SCENARIO_STALE` listing each key and reason, and writes nothing. Otherwise write
`cash_items` / `schedule_overrides` stamped with `source_scenario_id` and flip to
`applied`. An apply can never quietly skip part of a scenario.

**Adjustments are the audit trail once applied.** Every adjustment write, delete and
rebase answers `409 SCENARIO_NOT_DRAFT` unless the parent is `draft`. Deleting an applied
scenario is a soft delete that keeps its adjustments. To rework one, duplicate it.

## Web (`web/`)

| Screen | Purpose |
|---|---|
| Forecast | Balance chart (hand-rolled SVG, baseline vs scenario) + timeline grid: columns = day/week/month buckets, rows = categories → items, header rows opening/in/out/closing, negative cells flagged. Click an item to change amount or date (date picker, +7/+14/+30). Unresolved banner |
| Cash at bank | Start-of-day balance entry for all accounts on one date. History is the **recorded** balances, per account in its own currency. A combined history line only when every account in view is GBP |
| Income & outgoings | One-off items; mark paid / part paid; "assumed settled" group |
| Schedules / Schedule | Recurring rules; instance table showing predicted vs tuned, revert, pay, split, end; "assumed settled" group |
| Scenarios / Scenario | Named sandboxes; while one is open, Forecast edits write adjustments instead of real data, with a banner and stale markers; rebase, apply or discard |
| Settings | Companies, accounts, categories, FX rates |
| People, About, Sign-in | from workflows |

State: `useQuery` + replace-from-response, a `ScenarioContext` holding the active
scenario id, company filter in the URL. No state library.

## Mobile (`mobileweb/`)

PWA, read-mostly: today's cash and lowest point in 30/60/90 days, chart, upcoming 14
days, enter this morning's start-of-day balances, mark paid / tune an amount, view a
scenario. Scenario editing stays on web. API GETs network-first; writes online only.

## Phase 2 — stock payments (plan adopted 2026-09-29)

The plan is `docs/PHASE2.md` (decisions P1–P12, steps 13–23, risks); the contract detail is
`api/docs/CONTRACT.md` (§1.1, §3.5, §6.12, §8 rule 11, §9.3.1, §10.11–10.12, §11). This
section states only what PLAN fixes; where the three disagree, this file wins.

- **Dev, 2026-09-29: ShipLine is read-only.** This work never changes ShipLine; steps 16 (shadow) and 17 (cut-over) are dropped, and shipping's JWT `GET /api/v1/payments-flow` (whose only consumer was ShipLine) is not built. Consequence: there are **two copies** of the payment math — ShipLine's TS in the browser and shipping's JS port serving JFlow's feed. They are kept equal by **re-syncing**: when ShipLine's `paymentsFlowMath.ts` changes, re-run `tools/payments-flow-oracle.mjs` against the new ShipLine commit, update the port until the golden tests deep-equal again, and record the new commit here.
- **Phase 2 was planned to end with ONE implementation of the payment math** (superseded by
  the note above). Of the two
  routes considered (a shared package built to CJS + ESM, or moving the math into the
  shipping API), **route 2 is chosen (P1)**: `buildPaymentsFlow` and its callees move to
  `shipping/src/lib/payments-flow/` (CommonJS), ShipLine's Payments page reads shipping's
  `GET /api/v1/payments-flow` (JWT), and the math is deleted from ShipLine at step 17.
  Route 1 was rejected because the inputs are all shipping tables, no repo in the estate
  shares a package, shipping has no TS build, and a shared package would still answer
  differently in the browser (London) and on Lambda (UTC).
- **shipping**: read-only `GET /api/internal/payments-forecast`, app-to-app `X-Api-Key`
  route with **a new shipping key, not JFPRO's** (P12), returning stable id (grammar
  `[A-Za-z0-9_-]{1,64}`, P2), supplier, company, amount, currency, due date,
  estimated/firm/undated, **paid status** (P3). Shipping stays on **its current Lambda
  runtime for now** (risk 1 accepted by Dev); if AWS blocks an update, Phase 2 pauses there.
- **jflow**: `src/services/shipping.js` modelled on `workflows/api/src/services/jfpro.js`
  (5s timeout, degrade to a warning). Snapshot table `external_items` refreshed
  **outside** transactions, on demand (P4). The refresh writes **feed columns only**; it
  never touches the overlay — `planned_date` / `planned_amount` / `planned_skipped` (P7,
  the "exclude" column) — which is written only by scenario apply or a user edit. That
  overlay is the only home for an applied `ship.` adjustment, since nothing writes back to
  shipping. `planned_amount` holds only while the feed amount is unchanged (P6). The
  account is resolved at read time, currency-matched then the company default (P5); POs
  with no company stay unmapped and are counted (`SHIP_UNMAPPED`). Ship lines are always
  `manual` (P9) and use the 45-day cut-off like everything else; a ship currency with no
  rate is the same `FX_RATE_MISSING`. The "Stock payments" category is a system row (P10).
  `external_items` joins the lock order after `cash_items` (P11).
- The engine already accepts `externalItems`; Phase 2 adds only the mapping of a feed row
  to a line (P9). No engine rewrite.
- **Source of truth**: ShipLine commit `f9499bc` (GitHub main/test, 2026-09-29);
  `paymentsFlowMath.ts` there is 2,786 lines, last changed 2026-09-28 (`ec1cd76`), and is
  the port matches it exactly. ShipLine is not frozen; its later changes are picked up by a
  re-sync (above). PHASE2.md's line numbers refer to an older 2,470-line copy.
- **Deferred by Dev: supplier tags on the server (Q5).** The server assembler passes
  suppliers with `tags: []`. Consequence: Golden A is unaffected (the port and the frozen
  TS see the same input), Golden B must compare with tags stripped from the page-built
  input, and tag-driven payment rules do not apply server-side until tags are wired.

## Build order

1. Scaffold repo, CLAUDE.md, CONTRACT.md, CI, API skeleton, core migration, local migrate.
2. Companies, accounts, categories, FX, balances.
3. `keys.js`, `recurrence.js`, items, schedules, overrides, pay, split/end (tests first).
4. `engine.js` + `forecastLoad.js` + `/forecast` (tests first).
5. Scenarios, adjustments, rebase, apply.
6. Web shell, settings, cash at bank.
7. Web forecast grid, schedules, scenario sandbox.
8. Mobileweb.
9. First deploy to test (gated, below).

`docs/BUILD_PLAN.md` expands this into steps with tests and stop points.

## Needs you (I will stop and ask)

- Create secrets `jflow/test` and `jflow/prod` (`node tools/put-secret.js <stage>`), and
  DB grants on schema `jflow`; prod also needs `DB_PROXY_HOST`.
- `bash deploy.sh test|prod` and `migrate:test|prod`.
- Two Vercel projects (roots `web`, `mobileweb`), DNS, and the Google OAuth origins.
- After the first deploy, the gateway URLs go into both `src/config/env.ts` files.

## Risks

- **Runtime.** Node 18 and Node 20 are both past end of life, so JFlow starts on
  `nodejs22.x` (`engines`, CI and `serverless.yml`). Serverless v3 predates that
  runtime and may warn about the string; the first test deploy confirms it deploys.
  The exact dates on which AWS blocks creating or updating functions on the old
  runtimes are reported inconsistently and I have not verified them.
- **Outside this work, but you should know:** `workflows` and `shipping` both pin
  `nodejs18.x`. When AWS blocks updates on it, their `deploy.sh` stops working.

## Deferred

Transfers between accounts, hypothetical items added inside a scenario, bank holidays,
bank-feed import, forecast snapshots, openapi + `spec:diff`, and a combined GBP
**history** line across currencies (needs daily FX snapshots).

## Verification

- `cd api && npm run lint && npm run test:unit`
  - recurrence: month-end clamp, weekend rule, override bypass.
  - engine: mixed anchors; the full settle-mode × date-band matrix; **`A == today`
    keeps today's items in today's bucket**; part-paid remainder on an `auto` schedule
    shows as overdue; an override with `settle_mode = 'manual'` makes that one instance
    of an `auto` schedule overdue while its siblings stay `auto`; FX re-valuation;
    rounding invariant at rates such as 1.234567; `from` in the past is clamped; min
    balance inside a month bucket; `ORPHAN_OVERRIDE`.
  - scenarios in the engine: moving an overdue item forward clears its overdue flag in
    the scenario only; an adjustment that moves an out-of-window instance into the
    window appears; each of the three stale reasons is flagged and not applied.
  - loader: a manual one-off 200 days old and a never-marked manual schedule both
    appear in `unresolved[]`; a part-paid override whose remainder date is older than
    `min(A)` is still loaded and owed.
  - keys: round-trip, and rejection of anything outside the unreserved set.
- `npm run migrate` twice against local `.env`: second run reports 0 applied.
- `npm run test:e2e` against a per-run `jflow_test_<runid>` schema:
  - the headline flow: 1000 × 12 monthly, tune June/July, shift a date in a scenario,
    baseline vs scenario delta, apply, overrides written, re-apply refused.
  - refusals: `SCHEDULE_HAS_PAYMENTS`, `SCHEDULE_HAS_OVERRIDES`,
    `SCHEDULE_HAS_ADJUSTMENTS`, `SCENARIO_NOT_DRAFT`, `REMAINDER_DATE_REQUIRED`,
    `paid_on` in the future.
  - split: amount-only split re-keys a draft adjustment to the successor and it reads
    stale; a currency-only split with a draft adjustment refuses with
    `SCHEDULE_HAS_ADJUSTMENTS`; a frequency split with `dropOverrides` +
    `dropAdjustments` leaves no rows for the old schedule from *k* and an audit row for
    each; on two connections, a pay issued during a split waits on the schedule lock
    and then lands or is refused, never lost.
  - "Didn't happen" on an assumed-settled instance writes the override and the next
    forecast shows it overdue.
  - apply with one target paid at the same amount and date → `409 SCENARIO_STALE`,
    nothing written.
  - an adjustment key called un-encoded through `curl` reaches the right row.
- `PORT=5000 npm run dev` + `curl /api/v1/health` and `/forecast`.
- `cd web && npm run test && npm run dev` with `VITE_API_BASE_URL` on localhost; walk
  the headline flow in the browser. Repeat for `mobileweb` with `npm run preview`.
