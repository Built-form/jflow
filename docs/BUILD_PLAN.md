# JFlow — build plan for Claude (Opus 5.5)

Companion to `docs/PLAN.md`, which is the spec. **Where the two differ, PLAN.md wins.**
This file only says in what order to build it, what to test at each step, and where to
stop. Work the steps in order; do not start a step until the previous step's "Done when"
holds.

## Working rules

- At the start of every session read `CLAUDE.md`, `docs/PLAN.md`, this file, then
  `docs/PROGRESS.md` to find the current step.
- One step at a time. A step ends with `npm run lint` and its tests green,
  `docs/PROGRESS.md` updated (what shipped, what was deferred), and one commit on
  `master`: `step N: <title>`.
- Tests before implementation for `keys`, `recurrence`, `classify`, `engine`, split and
  apply.
- Decisions live in PLAN.md and, from step 0, in `docs/CONTRACT.md`. Ask Dev only for a
  decision that is in neither. Do not invent scope; do not drop scope silently — record
  it under "Deferred" in PROGRESS.md.
- If a `workflows/` file is not where PLAN.md's copy table says, adapt and note it in
  PROGRESS.md; do not stop.
- Never: run DDL from the Lambda; edit `web/src/auth/sharedSession.ts`; use floats for
  money; put engine rules in a client; add a state library; add foreign keys; take a
  lock out of the standing order in PLAN.md.
- Money: integer minor units parsed from DECIMAL strings. Dates: `YYYY-MM-DD` strings,
  epoch-day arithmetic. `today` = Europe/London date, computed once per request in the
  route and passed down; `?today=` honoured only in local/test.
- Files copied from `workflows/` carry a header:
  `// Copied from workflows/<path> — changes: <list, or "none">`.
- **STOP** markers are gates: stop, report, and wait for Dev.

## Error codes PLAN.md does not name

Use these and record them in CONTRACT.md next to PLAN.md's own
(`NO_ANCHOR`, `FX_RATE_MISSING`, `ORPHAN_OVERRIDE`, `REMAINDER_DATE_REQUIRED`,
`SCHEDULE_HAS_PAYMENTS`, `SCHEDULE_HAS_OVERRIDES`, `SCHEDULE_HAS_ADJUSTMENTS`,
`SCENARIO_STALE` with reasons `BASE_CHANGED` / `TARGET_SETTLED` / `TARGET_MISSING`,
`SCENARIO_NOT_DRAFT`):

| Code | Status | When |
|---|---|---|
| `BALANCE_DATE_IN_FUTURE` | 422 | `balance_date > today` |
| `PAID_ON_IN_FUTURE` | 422 | `paid_on > today` |
| `PAID_AMOUNT_INVALID` | 422 | `paid_amount <= 0` or above the remaining amount |
| `ITEM_KEY_INVALID` | 422 | key does not match `lib/keys.js` |
| `ADJUSTMENT_DATE_IN_PAST` | 422 | `new_date < today` |
| `OVERRIDE_HAS_PAYMENT` | 409 | revert on an override carrying payment state |
| `SCHEDULE_STRUCTURE_LOCKED` | 409 | structural edit on a schedule that must be split |

## Steps

### Step 0 — Adopt the spec
Do: `git init` at `C:\Users\OpsLondon\jflow`. Add `docs/PLAN.md` and
`docs/BUILD_PLAN.md`. Write `docs/CONTRACT.md` from PLAN.md so the code follows one
document: schema (including `schedule_overrides.settle_mode` and the `target_*`
columns), routes, every error code, key grammar, the load rules, the classification
table, the split transaction in PLAN.md's order (scenario locks before the schedule
lock), the lock discipline. Write `CLAUDE.md` (working rules, naming table,
copy-from-workflows table with concrete paths, the never-list). Create
`docs/PROGRESS.md`.
Done when: `grep` of CONTRACT.md finds no `closing_balance`, no `company_id` on items or
schedules, no `#` or `:` inside a key example, no `nodejs18`, no `nodejs20`; its split
section lists the scenario locks before the schedule lock.
**STOP** — Dev skims CONTRACT.md before any code is written.

### Step 1 — Scaffold, CI, migration tooling
Do: `api/` from workflows per PLAN.md's copy table. `serverless.yml`: `runtime:
nodejs22.x`, `engines` in `package.json`, Node 22 in CI (a Serverless v3 schema warning
about the runtime string is acceptable — the first test deploy is the real check);
remove S3, EventBridge, JFPRO and sharp; keep VPC, authorizer, CORS, routes,
`SECRET_ID`. `deploy.sh` without the sharp step. `tools/migrate.js` + `tools/put-secret.js`
for `jflow/<stage>`; meta table `jflow_schema_meta`. `withTransaction` with the single
`ER_LOCK_DEADLOCK` retry. Core migration `2026-09-29_jflow_core.sql` per CONTRACT.md:
`bank_balances.balance`; no `company_id` on `cash_items` / `schedules`;
`schedule_overrides.settle_mode NULL`; `scenario_adjustments.target_kind / target_id /
target_date` with `KEY(target_kind, target_id)`; seed companies JFA and Hangerworld.
`.github/workflows/ci.yml` lint + unit. Handler skeleton: request id, auth middleware,
local bypass, `health`, `me`, `meta/enums`, `users`, `audit`, 404, error handler,
Lambda export.
Tests: `npm run migrate` twice → second run reports 0 applied; `curl /api/v1/health`.
Done when: CI green on the empty suite; migration idempotent locally.

### Step 2 — Reference data
Do: routes `companies`, `accounts`, `categories`, `fx-rates`, `balances`
(`GET ?accountId&from&to`, `PUT /accounts/:id/balances/:date`, `POST /balances/bulk`,
`DELETE`). Validation: `BALANCE_DATE_IN_FUTURE`; one `is_default` per company;
`fx_rates` `UNIQUE(currency, effective_from)`. Soft delete everywhere except
`bank_balances` and `fx_rates` (hard delete, audit row with the before-snapshot).
Tests: e2e per route — validation, audit row, list params — against a per-run
`jflow_test_<runid>` schema.
Done when: e2e green; `npm run dev` serves every route locally.

### Step 3 — Pure libraries (tests first)
Do: `lib/dates.js` (epoch-day arithmetic, add-months with month-end clamp, weekend
rule, Europe/London today), `lib/money.js` (DECIMAL string ↔ minor units, rate to
micro-units, BigInt multiply, `roundHalfUp`), `lib/recurrence.js`
(`occurrences(schedule, from, to)`, `isOccurrence(schedule, date)`,
`endBefore(schedule, naturalDate)`), `lib/keys.js` (build / parse / validate
`item.<id>`, `sched.<id>.<YYYY-MM-DD>`, `ship.<id>`; returns `target_kind / target_id /
target_date`).
Tests: 31 Jan → 28 Feb → 31 Mar; weekly, fortnightly, four-weekly, monthly, quarterly,
annually with `interval_count`; `occurrence_count` and `end_date` ends; weekend
`previous|next|none`; `isOccurrence` rejects non-occurrences and post-end dates; keys
round-trip and reject anything outside the unreserved set (`#`, `:`, `/`, spaces).
Done when: unit green; these files import nothing from `db/`.

### Step 4 — Classifier and one-off items
Do: `lib/classify.js` — pure `(itemState, settleMode, A, today) → row` per PLAN.md's
table; the caller resolves an instance's settle mode (override's if set, else the
schedule's). `items` CRUD (`settle_mode` editable in place — that is "Didn't happen"
for a one-off). `POST /items/:id/pay` (`PAID_ON_IN_FUTURE`, `PAID_AMOUNT_INVALID`;
partial + effective date before today needs `remainderDueDate` else
`REMAINDER_DATE_REQUIRED`). `POST /items/:id/unpay`. `GET /items` returns
`derivedStatus` (`assumedSettled` and the rest) computed against each account's
anchor; `services/forecastLoad.js` starts here (rows in, no logic).
Tests: matrix test enumerates `{auto, manual} × {< A, A..today, == today, > today}` ×
`{A < today, A == today}` plus paid / part_paid / skipped and asserts every case lands
in exactly one row; pay/unpay state machine; the three 422s; audit rows;
`derivedStatus` values.
Done when: green; `classify.js` is the only place the table lives.

### Step 5 — Schedules, overrides, split and end (tests first)
Do: `schedules` CRUD. Structure (amount, frequency, interval, start, account,
currency, weekend rule, settle mode) is editable in place only while `start_date >
today` and no override exists; otherwise `SCHEDULE_STRUCTURE_LOCKED` pointing at split.
Name/category/notes edit in place always. `GET /schedules/:id/instances?from&to`
(predicted vs tuned, with `derivedStatus`). `PUT /schedules/:id/instances/:naturalDate`
(tune amount / date / note / `settleMode` — `settleMode: 'manual'` is "Didn't happen"
for an instance). `DELETE` (revert; `OVERRIDE_HAS_PAYMENT`). `POST
…/instances/:naturalDate/pay | /unpay` (same rules as items; remainder date lands in
`override.due_date`). `POST /schedules/:id/split` `{ fromNaturalDate, changes,
dropOverrides?, dropAdjustments? }` and `POST /schedules/:id/end` `{ lastNaturalDate }`,
both exactly as PLAN.md's seven-step transaction: draft scenarios found and locked
ascending **first**, then the schedule row, payment guard, unpaid overrides, draft
adjustments (re-key when natural dates and currency survive; otherwise
`SCHEDULE_HAS_ADJUSTMENTS`), deletes with one audit row each, end + successor.
Tests: e2e refusals for `SCHEDULE_HAS_PAYMENTS`, `SCHEDULE_HAS_OVERRIDES`,
`SCHEDULE_HAS_ADJUSTMENTS`, `SCHEDULE_STRUCTURE_LOCKED`, `OVERRIDE_HAS_PAYMENT`;
amount-only split re-keys a draft adjustment to the successor (stale `BASE_CHANGED` on
next read); currency-only split with a draft adjustment refuses; frequency split with
both drops leaves no overrides or adjustments for the old schedule from *k* and an
audit row for each; end-early mirrors the guard; on two connections, a pay issued during
a split waits on the schedule lock and then lands or is refused, never lost.
Done when: green; `grep` shows every override writer takes the schedule lock before any
override read or write, and the split takes its scenario locks before the schedule lock.

### Step 6 — Engine, loader and `/forecast` (tests first)
Do: `lib/engine.js` — pure, per PLAN.md's eleven steps, using `classify.js`; two item
sets (baseline, scenario) from step 5 of the engine onward. `services/forecastLoad.js`
completes PLAN.md's load list: `[min(A), to]` items and occurrences; paid with `paid_on
>= min(A)`; overrides by `due_date` in window; **every override row with a status or
payment amount, whatever its dates**; owed manual one-offs with no lower bound; manual
schedules back to `max(start_date, today − 730d)`; every adjustment target by key. `GET
/forecast?companyId=<id>|all&from&to&bucket=day|week|month&scenarioId&include=summary|grid`;
company scope resolved through `bank_accounts`.
Tests (unit): mixed anchors; `A == today` keeps today's items in today's bucket; auto
item in `[A, today)` absorbed and moving today's opening; manual item at `today − 44d`
overdue at today and at `today − 46d` in `unresolved[]`; manual one-off 200 days old and
a never-marked manual schedule both in `unresolved[]`; part-paid remainder on an auto
schedule overdue; part-paid override with remainder date older than `min(A)` still
loaded and owed; override `settle_mode = 'manual'` makes one instance overdue while its
siblings stay auto; override moving an instance into and out of the window; override
past the schedule's end → `ORPHAN_OVERRIDE`, not projected; adjustment moving an
overdue item forward clears overdue in the scenario set only; adjustment moving an
out-of-window instance into the window appears; each stale reason flagged and not
applied; rounding invariant at rates 1.234567 and 0.005234 (`opening + net = closing`,
cells sum to totals, every level an integer sum); `from` in the past clamped; window
capped at 730d; `FX_RATE_MISSING`; min balance inside a month bucket comes from the
daily series.
Done when: green; `curl /forecast` on local data returns the CONTRACT shape;
`derivedStatus` in `/items` and `/instances` agrees with `/forecast` flags for the same
data.

### Step 7 — Scenarios
Do: `scenarios` CRUD + `duplicate` (new draft; bases copied as-is — the first read
shows what is stale). `PUT|DELETE /scenarios/:id/adjustments/:itemKey`: validate the
key (`ITEM_KEY_INVALID`), populate `target_*`, `ADJUSTMENT_DATE_IN_PAST`, set
`base_date` / `base_amount` from the loader's current pre-adjustment effective values
(never client-supplied). `POST …/rebase` (`dropStale: true` removes `TARGET_SETTLED` /
`TARGET_MISSING` adjustments). `POST …/apply` all-or-nothing as PLAN.md: lock the
scenario (draft), lock targets in the standing order, re-check every adjustment; any
stale → `SCENARIO_STALE` listing each key and reason, nothing written; else write
`cash_items` (`due_date`, `amount`, or `status = 'skipped'`) and `schedule_overrides`
(upsert; a row with payment state is `TARGET_SETTLED`) stamped `source_scenario_id`,
flip to `applied`. Soft delete keeps adjustments; non-draft adjustments are immutable
(`SCENARIO_NOT_DRAFT`).
Tests (e2e): the headline flow — 1000 × 12 monthly, tune June 983 / July 1024, shift a
date in a scenario, baseline vs scenario delta, apply, overrides written, re-apply
refused; adjustment edit on the applied scenario → `SCENARIO_NOT_DRAFT`; pay a target
at the same amount and date then apply → `SCENARIO_STALE` (`TARGET_SETTLED`), nothing
written; rebase then apply succeeds; `dropStale` removes only the settled/missing ones;
duplicate yields a fresh draft; an adjustment key called un-encoded through `curl`
reaches the right row.
Done when: green.

### Step 8 — Web shell, settings, cash at bank
Do: `web/` per PLAN.md's copy table; `sharedSession.ts` byte-identical. Settings
(companies, accounts, categories, FX). Cash at bank: one date, all accounts, labelled
"Cash at bank at start of day", default today; history per account in its own
currency; combined line only when every account in view is GBP.
Tests: vitest on date/money display helpers; manual walk against the local API.
Done when: a balance entered for today is the anchor in `/forecast` and today's items
still show in today's bucket.

### Step 9 — Web forecast, items, schedules, scenarios
Do: Forecast — SVG chart baseline vs scenario; grid day/week/month with opening / in /
out / closing header rows; negative cells; overdue and absorbed rendered from server
flags; unresolved banner; click an item → amount/date dialog with +7 / +14 / +30.
Income & outgoings — grouped by `derivedStatus`; "assumed settled" group with
**Confirm paid** and **Didn't happen**; pay / part-pay dialog pre-fills the remainder
date with today and explains why. Schedules / Schedule — instances predicted vs tuned
with the same "assumed settled" group and actions, revert, pay, split and end wizards
that surface the three 409s as confirmations. Scenarios / Scenario — open scenario =
banner, edits write adjustments, stale markers showing the reason, rebase (with
`dropStale`), apply, discard. Company filter in the URL; `ScenarioContext`; `useQuery`
+ replace-from-response.
Tests: vitest on grid bucketing and dialog validation; manual walk of the step-7
headline flow in the browser.
Done when: the browser walk matches the e2e numbers.

### Step 10 — Mobileweb
Do: PWA per PLAN.md, read-mostly, `include=summary`; "Enter this morning's start-of-day
balances"; mark paid / tune an amount; view a scenario. GETs network-first; writes
online only.
Done when: `npm run preview` walk; offline shows the last cached forecast.

### Step 11 — First deploy — **STOP** (Dev)
Dev: secrets `jflow/test` and `jflow/prod` (`node tools/put-secret.js <stage>`); DB
grants on schema `jflow`; `DB_PROXY_HOST` for prod; two Vercel projects (roots `web`,
`mobileweb`); DNS for `jflow.` and `mjflow.built-form.co.uk`; Google OAuth origins.
Then: `bash deploy.sh test` (migrates, then deploys) — this is also the check that
`nodejs22.x` deploys through Serverless v3; gateway URL into both `env.ts`; smoke
`/health`, `/me`, `/forecast`; a day on test; `bash deploy.sh prod`.

### Step 12 — Phase 2 plan (write, do not build)
`docs/PHASE2.md`: pick route 1 (shared package, CJS + ESM, published as a git
dependency or to a private registry) or route 2 (math moves to the shipping API and
ShipLine's Payments page reads the endpoint), stating the reason; shipping's
`GET /api/internal/payments-forecast` behind `X-Api-Key` with no JWT authorizer;
JFlow `external_items` snapshot with a refresh that writes feed columns only and never
`planned_date` / `planned_amount`; `ship.` keys already valid in the grammar.

## Deferred
PLAN.md's list, plus: adjusting `part_paid` remainders inside a scenario (they read
`TARGET_SETTLED` — use pay with `remainderDueDate`); re-keying draft adjustments across
a currency split; anchor-age warnings.
