# JFlow — build progress

Resume point for a fresh session. Read this straight after `CLAUDE.md`, `docs/PLAN.md`,
`docs/BUILD_PLAN.md` and `api/docs/CONTRACT.md`. One section per step, written when the
step's "Done when" holds and its commit is made.

## Current step

**Steps 2 and 3 are done. Step 4 (items) and step 8 (web) are in progress**; step 4's
classifier is built. Dev asked for multiple agents, so independent steps run in parallel,
and each still gets its own commit. Steps 5–7 wait for Dev to set `/effort xhigh`.

| Step | Title | State |
|---|---|---|
| 0 | Adopt the spec | done |
| 1 | Scaffold, CI, migration tooling | done |
| 2 | Reference data | done |
| 3 | Pure libraries (tests first) | done |
| 4 | Classifier and one-off items | classifier built (committed with the step); items in progress |
| 5 | Schedules, overrides, split and end (tests first) | not started |
| 6 | Engine, loader and `/forecast` (tests first) | not started |
| 7 | Scenarios | not started |
| 8 | Web shell, settings, cash at bank | in progress (ahead of order; its "Done when" needs step 6) |
| 9 | Web forecast, items, schedules, scenarios | not started |
| 10 | Mobileweb | not started |
| 11 | First deploy — STOP (Dev) | not started |
| 12 | Phase 2 plan (write, do not build) | in progress (written early; no code) |

## Step 0 — Adopt the spec (2026-09-29)

**Shipped**
- `git init` on `master`; `docs/PLAN.md` and `docs/BUILD_PLAN.md` committed.
- `api/docs/CONTRACT.md` written from PLAN.md, with the decisions PLAN.md leaves open
  logged as D1–D38 in its §1.
- `CLAUDE.md`: working rules, naming table, copy-from-workflows table with concrete
  paths (every source checked to exist), never-list, model and effort per step.
- This file.

**Review at the STOP gate.** An independent adversarial review found 2 blockers and
18 other defects. Dev reviewed too: approved with 1 must-fix, 2 should-fixes and
3 confirmations. Everything was folded into CONTRACT.md, and PLAN.md was edited to match
(PLAN.md wins, so the two must agree):
- **Payments are rows** (`payments` table; `paid_amount` / `paid_on` become a cache).
  Before this, two part payments straddling an anchor double-counted the earlier one in
  today's opening.
- **`schedules.active_from`**: an amount-only split keeps the predecessor's date grid,
  so a month-end series stays on the 31st, and re-keyed adjustments still point at real
  occurrences.
- **Every override of a loaded schedule is loaded.** PLAN.md's rules missed amount-only
  tunes such as the headline "June 983", and overrides that move an instance out of the
  window.
- **New stale reason `DATE_PASSED`**: an adjustment's `new_date` has fallen behind
  today. `dropStale` removes it too.
- **Split re-keys after inserting the successor** (step 5 decides, step 7 writes).
  **End binds `target_date > lastNaturalDate`** in step 1, because *k* needs the locked
  schedule.
- Payments come last in the standing lock order. Adjustment writes and rebase now lock
  their targets.
- D17: deactivating an account with open items is refused (`ACCOUNT_IN_USE`).
- D5 (roles `standard | admin`, the pre-2026-09-16 workflows meaning) and D26 (company
  code `HW` for Hangerworld) were confirmed by Dev.
- Rejected from the review: making schedule `settleMode` editable in place. It stays
  structural, because flipping it would retroactively reclassify past instances (D37).

**Validation**: every "Done when" grep passes on CONTRACT.md:
- no `closing_balance`, no `nodejs18`, no `nodejs20`;
- `company_id` appears only on `bank_accounts` / `scenarios`;
- no `#` or `:` inside a key example;
- the split section's step 1 (scenario locks) comes before its step 2 (schedule lock).

**Deviations**
- CONTRACT.md and PROGRESS.md live in `api/docs/`, not `docs/`. PLAN.md's repository
  layout puts them there and PLAN.md wins over BUILD_PLAN.md; this also mirrors workflows.
- BUILD_PLAN.md is unchanged. Where it names three stale reasons (steps 6 and 7),
  PLAN.md / CONTRACT.md's four apply. Step 7's "`dropStale` removes only the
  settled/missing ones" now also removes `DATE_PASSED`.

**Deferred**
- Nothing beyond PLAN.md's list and CONTRACT.md §11.

## Step 1 — Scaffold, CI, migration tooling (2026-09-29)

**Shipped**
- Root: `.gitignore`, `.editorconfig`, `.gitattributes`, `.github/workflows/ci.yml` (lint + unit
  on Node 22, working-directory `api`, no `spec:diff`), `README.md`.
- `api/`: `package.json` (engines 22.x), `serverless.yml` (`nodejs22.x`; VPC, JWT authorizer,
  CORS, `ANY` + `OPTIONS`, `SECRET_ID` kept; S3, EventBridge, JFPRO, UPLOADS, sharp removed),
  `deploy.sh` (no sharp step), `jest.config.js`, `eslint.config.js`, `.env.example`,
  `tools/{migrate,put-secret,test-report}.js` (secret `jflow/<stage>`).
- `src/db/index.js` (`withTransaction` retries once on `ER_LOCK_DEADLOCK` by default, D27),
  `src/lib/{logger,sql,audit,schema,secrets,timeout,shape,roles}.js`, `src/handlers/jflow.js`
  (request id, auth + local bypass, health, me, meta/enums, users, audit, 404, error
  handler, Lambda export).
- `src/db/migrations/2026-09-29_jflow_core.sql`: CONTRACT §3, 14 tables + seed (JFA, HW).
- Unit tests: `audit`, `secrets`, `shape`, `roles`, `db` (deadlock retry: once, second
  deadlock propagates, other errors not retried), `handler` (routes via the local bypass).

**Validation**
- `npm run migrate` against local `.env`: first run created database `jflow` on
  explorer-test and applied 1 file; **second run: 0 applied, 1 already recorded.**
- 15 tables in `jflow` (14 + `schema_migrations`); companies JFA (1), HW / Hangerworld (2).
- `node src/handlers/jflow.js` on :5055 → `GET /api/v1/health` 200 `{status: ok, database:
  up, schema: ready}`; `/me` → `local@dev` admin; unknown route → 404 envelope;
  `/meta/enums` serves the CONTRACT enums.
- `npm run lint` clean; unit **93/93** (6 suites).
- CI: the workflow file is in place, but the repo has no remote yet, so it has not run on
  GitHub; the local equivalent (lint + unit on the step-1 files) is green.

**Deviations / notes**
- Copied JSON with no header: `api/package.json` (name `jflow`, `main`/`dev` →
  `jflow.js`, engines 22.x, eventbridge/s3/presigner/pdfkit/sharp/uuid/js-yaml and
  `spec:diff` dropped).
- `shape.js` keeps more than PLAN.md's list, because the handler and `apiError` need them:
  `isApiError`, `sendApiError`, `keysetResponse`, `parseCap`, `normalizeEmail`,
  `isValidEmail`, `auditToJson`.
- `withTimeout` was in workflows' `services/events.js`, not a lib file; it was extracted to
  `lib/timeout.js`.
- `schema.js`'s admin seed inserted workflows' `is_reviewer` column; changed to
  `(email, type)`. Workflows' reviewer route under `/users` was dropped.
- Copied files were converted from workflows' CRLF working copies to LF (`.editorconfig`).
- `tools/test-report.js` (copied as-is) writes `web/public/test-results/api.json` on
  every jest run, for the About screen.
- `.env.example` adds a commented `NODE_ENV=development`: the local auth bypass needs it.
- `npm run test:e2e` exits 1 ("no tests") until step 2 adds suites, as in workflows.

**Deferred**: none.

## Step 3 — Pure libraries, tests first (2026-09-29)

Built in parallel with step 2, and **committed before step 2** because step 2's routes import
`dates.js` and `money.js`.

**Shipped**
- `src/lib/dates.js`:
  - `toEpochDay`/`fromEpochDay`, `addDays`, `diffDays(a, b)`, `addMonthsClamped` (month-end
    clamp, negative n);
  - `dayOfWeek` (ISO: Monday 1 … Sunday 7), `isWeekend`, `isValidDate` (strict);
  - `londonToday(now)` via `Intl.DateTimeFormat`.
- `src/lib/money.js`:
  - `parseMinor` (DECIMAL string → bigint, `^-?\d{1,12}(\.\d{1,2})?$`), `formatMinor`;
  - `parseRate` (→ bigint micro-units, `> 0`);
  - `roundHalfUp` (half away from zero), `toGbp`/`fromGbp`.
- `src/lib/keys.js`: `buildItemKey`, `buildSchedKey`, `buildShipKey`, `parseKey` →
  `{targetKind, targetId, targetDate}` or null, `isValidKey`, `formatKey`, `TARGET_KINDS`.
- `src/lib/recurrence.js`:
  - the six §5.4 functions: `occurrences`, `isOccurrence`, `occurrenceIndex`,
    `firstActiveOccurrence`, `nextOccurrenceAfter`, `endBefore(schedule, k, {keepSeries})`;
  - `weekendAdjust` (§5.3 puts it here, not in dates);
  - `normalizeSchedule`, `effectiveDate`, `effectiveValues` (§3.4).

**Validation**
- Tests were written first: each suite failed on the missing module before its
  implementation existed.
- Unit counts: dates 117, money 144, keys 138, recurrence 78.
- Lint clean. None of the four files imports from `src/db/`; the only internal import is
  `./dates`.
- Covered:
  - dates: 31 Jan → 28 Feb → 31 Mar computed from the start, never chained.
  - recurrence:
    - every frequency with `interval_count`, plus `occurrence_count` and `end_date` ends;
    - weekend `previous | next | none`, and the override date bypassing the weekend rule;
    - `isOccurrence` rejecting non-occurrences, pre-start / pre-`active_from` dates and
      post-end dates;
    - `active_from` (monthly from 31 Jan, amount-only split at 30 Jun → 31 Jul, 31 Aug).
  - money: the rates 1.234567 and 0.005234 at the half cases.
  - keys: round-trips, and rejecting `#`, `:`, `/`, spaces, percent-encoding and bad dates.

**Decisions where CONTRACT was silent**
- The today function is named `londonToday`; the `?today=` override lives in the route layer.
- `parseMinor` accepts negatives and leading zeros (CONTRACT's grammar); `> 0` is enforced
  by the routes.
- `firstActiveOccurrence` / `nextOccurrenceAfter` return null when no occurrence is left.
  `endBefore` throws `RangeError` when *k* is not an occurrence.

**Deferred**: none.

## Step 2 — Reference data (2026-09-29)

**Shipped**
- `src/routes/{companies,accounts,categories,fxRates,balances}.js` per CONTRACT §6.2–6.6,
  plus `GET /fx-rates/current`.
- `src/handlers/jflow.js`:
  - the router mounts;
  - `todayFor(req)`: Europe/London today; `?today=` only locally or under test, with a 400 if
    it is malformed there;
  - `STALE_REASONS` gains `DATE_PASSED`.
- `src/lib/shape.js`: the five `*ToJson` mappers, `parseBaseVersion`, `assertBaseVersion`
  (`STALE_WRITE`), `parseSortOrder`.
- `test/e2e/harness.js`:
  - creates `jflow_test_<runid>` and runs the core migration through `splitStatements`;
  - its DROP refuses any schema it did not create;
  - has SQL helpers that seed items and schedules for the in-use guards.
- Five e2e suites.

**Validation**
- Lint clean; unit 657/657 (11 suites); **e2e 43/43** (companies 11, accounts 10,
  categories 6, fx-rates 7, balances 9).
- `PORT=5000 npm run dev` answered every step-2 route; no `jflow_test_*` schema was left
  behind.
- What the e2e suites cover:
  - `BALANCE_DATE_IN_FUTURE`, one `is_default` per company, `fx_rates`
    `UNIQUE(currency, effective_from)`, GBP refused;
  - `*_IN_USE`, `COMPANY_CODE_TAKEN`, `STALE_WRITE`;
  - hard deletes audit the before-row; soft deletes everywhere else;
  - a no-op PUT writes nothing (no version bump, no audit row).

**Decisions / deviations**
- `/balances` sorts `balance_date DESC, account_id` (§6.6), not D28's "date ascending":
  §6.6 is the specific rule.
- Accounts `q` searches `name` only. A `baseVersion` on a balance PUT with no row → 409
  `STALE_WRITE {currentVersion: null}`. An omitted `note` keeps the stored one; `null`
  clears it.
- Immutable fields (`companyId` on accounts, `currency` on FX rates): the same value is
  accepted, a different one is 400.
- Bulk errors: `details.entries` is parallel to the request (`null` = entry ok).
- Step 1's `shape.test.js` (pins the export list) and `handler.test.js` (its 404 test used
  `/companies`) were updated.
- **CONTRACT §10.1 amended** (coordinator, found by the step-2 agent): an item or schedule
  write that sets or changes `account_id` / `category_id` takes `FOR SHARE` on the
  account and category **before any standing-order lock**. Deactivation / delete take
  `FOR UPDATE` on their own row first, so an item can't slip onto an account being
  deactivated. Reference rows are never locked after a standing-order row, so no cycle is
  possible.

**Left for later steps**
- `accounts.js` `owedOnAccount` is `TODO(step 4/5)`. Until then the D17 deactivation guard
  refuses more than intended:
  - every live `expected`/`part_paid` one-off counts;
  - every live schedule counts;
  - `owedInstances` is empty.
  Step 4 drops `assumedSettled` one-offs; step 5 counts only schedules with an occurrence
  on or after today, and fills `owedInstances`.

**Deferred**: none.
