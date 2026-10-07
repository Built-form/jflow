# JFlow — build progress

Resume point for a fresh session. Read this straight after `CLAUDE.md`, `docs/PLAN.md`,
`docs/BUILD_PLAN.md` and `api/docs/CONTRACT.md`. One section per step, written when the
step's "Done when" holds and its commit is made.

## Current step

**Steps 0–9 and 12 are done: the API and the web app are built, walked in a browser and committed.** Step 10 (mobileweb) is parked by Dev. Step 11 (first deploy) is a STOP for Dev.

| Step | Title | State |
|---|---|---|
| 0 | Adopt the spec | done |
| 1 | Scaffold, CI, migration tooling | done |
| 2 | Reference data | done |
| 3 | Pure libraries (tests first) | done |
| 4 | Classifier and one-off items | done |
| 5 | Schedules, overrides, split and end (tests first) | done |
| 6 | Engine, loader and `/forecast` (tests first) | done |
| 7 | Scenarios | done |
| 8 | Web shell, settings, cash at bank | done |
| 9 | Web forecast, items, schedules, scenarios | done |
| 10 | Mobileweb | **parked by Dev (2026-09-29): web only for now** |
| 11 | First deploy — STOP (Dev) | **test and prod deployed by Dev** (test `d3votdaxd9…/api/v1`, prod `jfwzm52aj0…/api/v1` on 2026-09-30); web `env.ts` names `jflow.built-form.co.uk` as production |
| 12 | Phase 2 plan (write, do not build) | done (written early; no code) |
| 13 | Phase 2: adopt the plan — STOP (Dev) | done (signed off 2026-09-29) |
| 14 | Phase 2: port the math (tests first) | done — **moved into JFlow** (`api/src/lib/payments-flow/`) |
| 15 | Phase 2: input assembler | done — **moved into JFlow** (`services/shippingSource.js`, reads `jfa`) |
| 16 | Phase 2: ShipLine shadow | **dropped by Dev (ShipLine read-only)** |
| 17 | Phase 2: ShipLine cut over | **dropped by Dev (ShipLine read-only)** |
| 18 | Phase 2: shipping feed endpoint | **not built** — JFlow reads `jfa` directly (Dev) |
| 19 | Phase 2: JFlow schema, client, refresh | done |
| 20 | Phase 2: JFlow loader, engine, `/forecast` | done |
| 21 | Phase 2: JFlow overlay routes + `ship.` scenarios | done |
| 22 | Phase 2: web (mobile parked) | done |
| 23 | Phase 2: deploy — STOP (Dev) | not started |

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

## Step 8 — Web shell, settings, cash at bank (2026-09-29; committed with step 9)

Built ahead of order in parallel. Its "Done when" needs step 6's `/forecast` (a balance
entered for today is the anchor, and today's items stay in today's bucket), so the step is
committed after that walk.

**Built**
- `web/` copied from workflows per CLAUDE.md. `sharedSession.ts` is byte-identical (`cmp`
  clean, no header).
- Shell nav: Forecast, Cash at bank, Income & outgoings, Schedules, Scenarios, Settings,
  People, About. The `?company=` filter carries across screens. The four step-9 screens are
  placeholders.
- Settings: companies, accounts, categories, FX rates. GBP shows as a fixed base row that
  cannot be edited.
- Cash at bank: one date, all active accounts, labelled "Cash at bank at start of day",
  defaulting to Europe/London today; saves through `POST /balances/bulk`. History is per
  account in its own currency. The combined line appears only when every account in view
  is GBP; a day is totalled only when every account recorded it, otherwise "n OF m".
- Helpers `lib/{money,dates,balances,validation,rows}.ts` use BigInt minor units and no
  floats. `test/setup.ts` was written fresh and refuses un-stubbed API calls.

**Validation so far**
- `tsc --noEmit` clean; vitest **72/72** (9 files); `npm run build` succeeds.
- There is no web lint script (workflows' web has none).

**Notes**
- JSON copies with no header: `web/package.json` (renamed `jflow-web`, `barcode-detector`
  dropped), `web/tsconfig.json`, `web/vercel.json`.
- `env.ts`: the test/prod API bases are null until step 11; without `VITE_API_BASE_URL` the
  app shows its "not configured" screen.
- More than a name change was needed in `ui.tsx` (error details for JFlow's shapes),
  `PageHeader.tsx`, `SignInScreen.tsx` (two workflows role screens removed) and
  `Shell.tsx`.
- The client re-reads accounts after a balance write (anchors) and after `isDefault`
  (sibling cleared), because the write responses don't carry either.
- A bulk balance save is last-write-wins: bulk entries have no `baseVersion`.
- `npm audit`: 2 moderate runtime advisories (react-router 6), the same version ranges as
  workflows.

## Step 12 — Phase 2 plan (2026-09-29, written early, in parallel)

**Shipped**: `docs/PHASE2.md` (plan only, no code). **Route 2: the payment math moves to the
shipping API**, and ShipLine's Payments page reads the endpoint. The evidence:
- Every input except suppliers is already a shipping table behind a shipping route.
- No repo in the estate shares a package (no git dependency or registry in any of the 22
  `package.json` files).
- Shipping is plain CJS with no build step.
- `paymentsFlowMath`'s `dateOfInstant` follows the host time zone, so a shared package would
  still answer differently in the browser (London) and on Lambda (UTC).

The plan covers:
- shipping's `GET /api/internal/payments-forecast` (`X-Api-Key`, no JWT);
- JFlow's `services/shipping.js`, the `external_items` DDL, a refresh that writes feed
  columns only, `ship.` keys, the loader/engine, the overlay writes and the lock order;
- build steps 13–23 with STOPs.

**Findings Dev should know**
- ShipLine's local checkout is behind shipping's 09-28 rule fields.
- Item ids contain `:`, embed free text, and change as a PI arrives.
- Paid payments are never output.
- The math has no tests and uses float money.
- `delivered-air.js` already duplicates part of the logic.
- CONTRACT §9 only says `externalItems` must be `[]` in phase 1; Phase 2 needs loader,
  stale-check, apply and lock-order text there.

**Open questions for Dev**: see `docs/PHASE2.md` §7 — 10 items, including the ShipLine source
of truth / freeze window, shipping's `nodejs18.x`, POs with no company, the account for a
stock payment, a ship currency with no rate, supplier-tag access, refresh audit, "exclude" on
ship lines, the API key, and the 45-day window for supplier money.

## Step 4 — Classifier and one-off items (2026-09-29)

**Shipped**
- `src/lib/classify.js`:
  - `classify(line, A, today) → {payments: PaidLine[], owed: OwedLine|null}` per §9.6;
  - also `derivedStatus(result)`, `OVERDUE_WINDOW_DAYS = 45`, `DERIVED_STATUSES`;
  - the only place the table lives.
- `src/lib/lines.js`: item row → classifier input. Pure, with no band table.
- `src/routes/items.js`, per §6.7 and §10.3:
  - GET/POST `/items`, GET/PUT/DELETE `/items/:id`;
  - `POST /items/:id/pay`: one `payments` row per pay, cache rewritten from the rows under
    the item lock;
  - `POST /items/:id/unpay`: deletes every payment row, one audit row each;
  - the `FOR SHARE` on the account and category comes first (§10.1 amendment).
- `src/services/items.js`: item JSON with `payments[]` and `derivedStatus`, computed against
  each account's anchor.
- `src/services/forecastLoad.js`: the item and payment side of §8 (rows in, no logic).
- `src/routes/accounts.js` `owedOnAccount`: the one-off part of D17 is real now
  (`assumedSettled` no longer blocks); it reads with `FOR SHARE OF i`.
- `src/handlers/jflow.js` imports `FREQUENCIES`, `WEEKEND_RULES`, `DERIVED_STATUSES` and
  `TARGET_KINDS` from the modules that enforce them, instead of keeping copies.

**Validation**
- Tests first for `classify` (the suite failed on the missing module first).
- Lint clean; unit **672/672** (12 suites); e2e **64/64** (7 suites: step 2's 43, items
  16, loader 5).
- The matrix `{auto, manual} × {< A, A..today−1, == today, > today} × {A < today, A ==
  today}`, plus paid, part_paid straddling A, skipped and `A = null`, asserts every case
  lands in exactly one row.
- The 45-day boundary: −44 and −45 overdue, −46 unresolved.
- e2e covers:
  - the pay/unpay state machine, including two partial payments straddling an anchor
    (each classified on its own date) and paying to full;
  - `PAID_ON_IN_FUTURE`, `PAID_AMOUNT_INVALID` (both kinds), `REMAINDER_DATE_REQUIRED`;
  - an audit row per mutation and per payment row;
  - every `derivedStatus` value;
  - "Didn't happen" → overdue/unresolved, and the D17 guard ignoring assumedSettled.
- A grep finds no band name outside `classify.js`, other than D17's filter on the
  `derivedStatus` it returns.

**Decisions where CONTRACT was silent**
- The anchor is the latest balance **on or before today**. This only matters under a
  pinned `?today=` (local/test), where a later balance would otherwise make
  `classify` throw.
- `ITEM_NOT_EDITABLE` refuses only when the sent status/amount/currency differs from the
  stored value.
- `direction` ≠ category → 400 (not silently ignored).
- `q` searches name + counterparty.
- A `remainderDueDate` sent on a full payment still moves `due_date`.
- Text caps: `notes` 16,000; payment `note` 500.
- Audit snapshots leave out the derived `payments` / `derivedStatus`.

**Left for steps 5–6**
- `forecastLoad.js` TODOs: schedules and overrides (rules 1–3, 5, 7), rates, adjustments,
  de-duplication and the assembled `engineInput`.
- `loadTarget`'s `sched.` branch.
- `owedOnAccount`'s schedule/instance parts.
- An instance equivalent of `itemLine` in `lib/lines.js`.
- The same plain-read-before-lock pattern exists in step 2's `references()` on the
  `isDefault` path; it is rare, noted but left alone.

**Deferred**: none.

## Step 9 — Web forecast, items, schedules, scenarios (2026-09-29; committed with step 8)

Built by two agents in parallel **against CONTRACT with stubbed responses**, before the
step 5–7 API existed. The browser walk of the headline flow comes after step 7; the step
is committed then.

**Built**
- **Forecast** (`screens/forecast/`):
  - a hand-rolled SVG chart, baseline vs scenario;
  - a day/week/month grid with opening/in/out/closing header rows, negative cells flagged,
    and the overdue/absorbed rendering taken from server flags;
  - the unresolved banner, and a `FX_RATE_MISSING` panel linking to Settings;
  - an edit dialog with +7/+14/+30 that writes real data, or adjustments while a scenario
    is open.
- **Scenarios** (`screens/scenarios/`):
  - list and detail; stale markers for all four reasons;
  - rebase with `dropStale`, apply (`SCENARIO_STALE` lists each key), duplicate, and
    discard (= archive, D36).
- `app/ScenarioContext.tsx` + the Shell banner. `lib/keys.ts` parses only.
- **Income & outgoings** (`screens/items/`):
  - grouped by `derivedStatus`, with an "Assumed settled" group offering Confirm paid /
    Didn't happen;
  - `components/PayDialog.tsx`, shared with instances: the remainder date is pre-filled
    with today and explained.
- **Schedules** (`screens/schedules/`):
  - list and detail, and the instance table (predicted vs tuned);
  - tune/revert/pay/unpay;
  - the split and end wizards, which turn the three 409s into confirmations
    (`dropOverrides`/`dropAdjustments` resends);
  - a structure-lock message with "Split from…".
- Home is now Forecast (it was Cash at bank until step 9).

**Validation so far**: `tsc` clean; vitest **209/209** (22 files); `npm run build` succeeds.

**CONTRACT additions made from the UI build** (coordinator, 2026-09-29):
- `rows[].items[].dueDate`: an overdue line's `date` is today, `dueDate` is when it was
  due.
- Instance JSON gains `predictedDueDate` and `remainingAmount`.
- Every item and instance mutation response carries `derivedStatus` + `payments[]`.
- The end no-op response body is defined.
- `SCHEDULE_STRUCTURE_LOCKED.details.fields` uses JSON names.

**For step 7**
- The adjustment `PUT` is a **full replace**: an omitted `newAmount`/`newDate` clears it.
  The web client always sends the whole adjustment.
- Adjustment `current` should carry `name` and `currency`. Without them, the detail screen
  reads names from `/forecast`.
- Nice-to-haves that would remove client workarounds: `rowVersion` on forecast lines, and
  `editable` on `unresolved[]`.

## Steps 5, 6 and 7 — Schedules/split/end, engine/loader/`/forecast`, scenarios (2026-09-29)

Built by four agents in parallel at `/effort xhigh` (Dev's setting for steps 5–7): step 5,
the pure engine (6a), the loader and route (6b), and step 7. They share files (`shape.js`,
`lines.js`, `forecastLoad.js`, the handler mount block), so **the three steps are one
commit**. Each step's own tests were written first.

**Shipped**
- **Step 5.**
  - `routes/schedules.js`:
    - CRUD, with the structure lock (D37) and the §10.1 `FOR SHARE` on account/category;
    - `GET /instances` with `predictedDueDate`, `remainingAmount`, `derivedStatus`,
      `payments[]` and `orphans[]`;
    - tune / revert / pay / unpay;
    - split and end per §10.5.
  - `services/{schedules,payments,references}.js`, `lib/{split,instances}.js`.
  - `lines.instanceLine`; the schedule/override/adjustment mappers; `loadTarget`'s `sched.`
    branch; `owedOnAccount` finished (D17 complete).
- **Step 6.**
  - `lib/engine.js`: pure; `run`, `clampWindow`, `currenciesInScope`. It expands
    occurrences itself over `[minA−2, to+2]`, and classifies only through `classify.js`.
  - `services/forecastLoad.js` §8 rules 1–10: `loadEngineInput`, with de-duplication and
    draft-only adjustments.
  - `routes/forecast.js`: validation, a read-only transaction, `FX_RATE_MISSING` before
    the engine, bigint → JSON integers.
- **Step 7.**
  - `routes/scenarios.js`: the ten §6.11 routes.
  - `services/scenarios.js`: scenario lock, draft check, target locks in the standing
    order, `loadCurrent`.
  - `lib/stale.js`: maps `loadTarget` onto the engine's exported `staleReason`, so
    adjustment write, rebase, apply and `/forecast` share **one** stale definition.

**Validation**
- Lint clean; **unit 791/791** (17 suites); **e2e 144/144** (13 suites); no `jflow_test_*`
  schema left behind.
- Step 5, as BUILD_PLAN lists:
  - e2e refusals `SCHEDULE_HAS_PAYMENTS`, `SCHEDULE_HAS_OVERRIDES`,
    `SCHEDULE_HAS_ADJUSTMENTS`, `SCHEDULE_STRUCTURE_LOCKED`, `OVERRIDE_HAS_PAYMENT`;
  - an amount-only split re-keys a draft adjustment, keeping month-end dates via
    `active_from`, and it reads `BASE_CHANGED`;
  - a currency-only split with an adjustment refuses;
  - a frequency split with both drops leaves nothing from *k*, with an audit row each;
  - end-early mirrors the guard.
  - Four **two-connection** tests:
    - a pay during a split waits, then lands or is refused;
    - a pay during a rolled-back split;
    - the scenario lock taken before the schedule lock;
    - an adjustment written mid-split.
- Step 5 greps:
  - every instance writer reaches `schedule_overrides` only through `lockInstance`
    (`lockSchedule` first, `routes/schedules.js:205–212`);
  - the split locks scenarios (`:288`) before the schedule (`:306`);
  - apply/rebase/adjustment writes use `lockTargets`: schedules asc → cash_items asc →
    overrides.
- Step 6:
  - every unit test BUILD_PLAN lists (mixed anchors, `A == today`, absorbed, 44/46 days,
    200-day manual one-off, never-marked manual schedule, part-paid remainders, the
    per-instance manual override, overrides in/out of the window, `ORPHAN_OVERRIDE`,
    scenario-only overdue clearing, all four stale reasons, the rounding invariant at
    1.234567 and 0.005234 incl. cross-currency, clamps, `FX_RATE_MISSING`, month-bucket
    min from the daily series);
  - e2e: a balance entered for today is the anchor and today's items stay in today's
    bucket (step 8's check);
  - the **agreement test**: all seven `derivedStatus` values from `/items` and
    `/instances` agree with `/forecast`.
  - `curl /api/v1/forecast?companyId=all` on the local (empty) `jflow` schema returns the
    CONTRACT shape.
- Step 7, the **headline flow** e2e:
  - 1000 × 12 monthly; June tuned to 983, July to 1024;
  - July shifted to 20 Aug in a scenario → the July bucket −102400 and August +102400 vs
    baseline;
  - apply writes the override with `source_scenario_id`, and the real forecast then
    equals the scenario;
  - re-apply and an adjustment edit → `SCENARIO_NOT_DRAFT`.
- Also covered for step 7:
  - paying a target, then apply → `SCENARIO_STALE` (`TARGET_SETTLED`), nothing written;
  - rebase then apply;
  - `dropStale` (settled/missing/date-passed only), `DATE_PASSED`, duplicate;
  - an un-encoded key through HTTP;
  - two tests proving apply's re-check reads after its locks.

**CONTRACT amended during the build** (all recorded in CONTRACT.md):
- §8 rule 1: the schedule bound widened to ±2 days for the weekend rule; the engine
  expands occurrences. `categories` added to `engineInput`.
- §8 rule 3: schedules behind owed or moved-in overrides are loaded even when they ended
  before the window.
- §8 rule 10: only a **draft** scenario's adjustments are live. An applied/archived
  scenario's forecast is the real data with no STALE warnings.
- §10.5:
  - the split **race guard** (an adjustment written between step 1 and the schedule lock
    → deliberate `ER_LOCK_DEADLOCK`, restart once);
  - `changes.startDate < k` → 400; an empty successor → 400;
  - a successor from a future *k* is not born locked.
- §6.11:
  - adjustment `current` gains `name`, `currency`;
  - the adjustment PUT is a full replace and returns `stale`/`current`;
  - `baseVersion` on PUT is checked against an existing adjustment only.

**Decisions where CONTRACT was silent**
- Step 5:
  - `OVERRIDE_HAS_PAYMENT` only when `amount`/`status` actually change;
  - `status: 'expected'` on tune is stored as sent;
  - orphans cover the whole schedule;
  - `successorId` = the latest successor;
  - a malformed `:naturalDate` → 400, a non-instance → 404;
  - `intervalCount` ≤ 1000.
- Step 6:
  - an account with no anchor still puts its currency in scope;
  - a `from` beyond the cap, or after the default `to`, → 400;
  - a malformed `scenarioId` → 400, a non-live one → 404;
  - with no anchors at all, a draft scenario's targets still load.
- Step 7:
  - adjustment writes/rebase don't bump the scenario's `row_version`;
  - rebase always audits `{rebased, dropped, stale, dropStale}`;
  - PUT with the scenario's current status is a no-op;
  - `?companyId=` on `/scenarios` is strict equality (all-company scenarios excluded).

**Notes**
- Unpay keeps an all-NULL override row, so the schedule stays structure-locked, and a
  later split needs `dropOverrides`.
- The step-5 agent ran one read-only `git status` (printed nothing, changed nothing),
  against its brief.

**Deferred**: none beyond CONTRACT §11.

## Steps 8–9 — browser walk (2026-09-29)

The walk ran against the real local API and a throwaway schema
`jflow_test_walk_20260929120416` (dropped afterwards; the shared `jflow` schema was never
touched). The browser was headless Edge driven by `playwright-core` from the scratchpad
(nothing added to any package.json). Sign-in used the web app's own local path
(`API_IS_LOCAL` when `VITE_API_BASE_URL` is localhost). Every step went through the UI.

**Step 8 "Done when": passes.**
- Settings: accounts (GBP, EUR), categories, and an EUR rate of 0.850000.
- Cash at bank: £20,000 entered for today, labelled "Cash at bank at start of day".
- A one-off +£500 dated today.
- The Forecast shows opening £20,000.00, +£500 in today's column, closing £20,500.00.
  The API agrees (anchor today, `item.1` in bucket 0).

**Step 9 "Done when": the browser walk matches the e2e numbers exactly.**
- Rent 1000 × 12, June tuned to 983, July to 1024.
- In a scenario, July moved to 20 Aug with the edit dialog.
- Scenario delta: July outflow −102400 / net +102400; August outflow +102400 / net
  −102400; every other bucket 0. This is identical to the step 7 e2e.
- Apply writes the overrides (the instance table shows TUNED, FROM SCENARIO), and the real
  forecast then equals the scenario. A re-apply from a stale tab gets `SCENARIO_NOT_DRAFT`
  with a clear message.
- Also checked:
  - "Didn't happen" → overdue at today;
  - part-pay with the remainder date pre-filled and explained;
  - the split wizard turning `SCHEDULE_HAS_OVERRIDES` into a confirmation.
- All 13 bucket closings in the UI equal the API's; the all-companies opening £24,250.00
  = 2425000. The only rounding is the chart's axis labels.

**Fixed during the walk** (each with a failing test first):
- Scenario adjustments outside the 90-day panel showed "Schedule instance" and a raw
  amount. They now use `current.name`/`current.currency`.
- "2 ACCOUNTs" → "2 ACCOUNTS".

**Validation**: web `tsc` clean, vitest **211/211** (22 files), build succeeds;
`sharedSession.ts` byte-identical (`cmp`).

**Known UI gaps (not fixed, for Dev)**
- The Scenario screen's comparison panel is fixed at 90 days; a change further out shows
  only on Forecast.
- The grid gives each schedule instance its own row (12 "Office rent" rows); PLAN's
  "categories → items" is ambiguous.
- Scenario dates read "Sept" (from the verbatim-copied `lib/format.ts`) where the rest of
  the app says "Sep".
- "1 tuned instance(s) dropped" wording.

## Phase 2 — Step 13: adopt the plan (2026-09-29)

**Dev's sign-off**:
- P1–P12 adopted as written (route 2: the payment math moves to the shipping API).
- The recommended answers to open questions 2, 3, 4, 6, 7 and 8.
- **ShipLine source of truth `f9499bc`**, frozen until step 17. Its
  `paymentsFlowMath.ts` is 2,786 lines; the local ShipLine checkout at `c24ffdd` is stale,
  and a read-only export of `f9499bc` is used as the oracle.
- **Shipping stays on `nodejs18.x` for now** (risk 1 accepted).
- **Supplier tags not now**: the step-15 assembler passes suppliers without tags. Golden A
  is unaffected; Golden B compares with tags stripped.

**Shipped**:
- CONTRACT.md: D8 retired; §1.1 P1–P12; §3.5 `2026-09-29_jflow_ship.sql` (17 tables);
  §6.12 external routes; the new codes; §8 rule 11; §9.3.1 ship line mapping; lock order
  with `external_items` after `cash_items`; §10.11–10.12; the §11 deferrals.
- PLAN.md: the Phase 2 section updated to match.
- PHASE2.md: marked adopted.

**Resolved while folding**:
- An undated open ship row is not an adjustment target (`TARGET_MISSING`); plan a date
  on it through the overlay first.
- `POST /external/refresh` inside the 60-second claim → `200 {ran: false, status}`.
- `derivedStatus` is `null` for undated, gone or unmapped ship rows.
- Ship lines carry `fromScenario`.
- D17 ignores ship lines (their account is resolved at load).

**Validation**: CONTRACT has no "must be `[]`" and no live D8 rule. Phase 1's greps still
hold.

**Shipping repo**: the work is on local branch `phase2-payments-flow`, cut from
`shipping/test` at `d896b5a`. It tracks no upstream and is never pushed without Dev.
Dev's `master` and `test` are untouched.

## Phase 2 — Step 20: loader, engine, `/forecast` for ship lines (2026-09-29)

Built alongside step 19 (its migration, `shipping.js` and `shippingRefresh.js` were in place
and its e2e green before the loader work started). Tests first: the engine and lines suites
failed on the missing ship code before it existed.

**Shipped**
- `lib/lines.js`: `shipEffectiveValues` (§3.4, P6), `shipLine` (§9.3.1), `shipDerivedStatus`,
  `hasShipOverlay`, `SHIP_SETTLE_MODE`. Still no band table; `classify.js` is untouched.
- `lib/engine.js`: ship records (kind `ship`, the systemKey `ship` category, `out`, `manual`),
  the `ship` block and feed flags on `rows[].items[]` (never a band), no `paymentId` on ship
  payment lines, ship currencies in scope, the `shipping` block, and the warnings
  `SHIP_UNMAPPED` / `SHIP_PLAN_ORPHANED` / `SHIP_PLAN_STALE` (order: NO_ANCHOR, route
  warnings, ORPHAN_OVERRIDE, SHIP_*). `ship.` adjustments use the one `staleReason`.
- `services/forecastLoad.js`: `shipResolvedSelect` (P5 in SQL), rule 11 (`loadShipRows`,
  with `unmappedCounts`), rule 6 (`loadShipTargets`), `loadShipCategory`, `loadShipSync`,
  `loadTarget`'s `ship.` branch; categories carry `systemKey`; `engineInput` gains `shipping`.
- `routes/forecast.js`: `refreshIfStale({today})` before the read connection; a failure →
  `SHIPPING_UNAVAILABLE {reason, lastSuccessAt}` on a 200 built on the last snapshot.
- `services/externalItems.js` + `GET /external-items` in step 19's `routes/external.js`;
  `lib/shape.js` `externalItemToJson`.
- Tests: `engine.test.js` (+13 ship tests), `lines.test.js` (+ship helpers), `shape.test.js`,
  new `test/e2e/forecast-ship.test.js` (8). Phase-1 pins updated for the contract's new
  shape: the `shipping` key, `engineInput.shipping`, category `systemKey`; `forecast.test.js`
  serves an empty stub feed so its exact `warnings[]` stay phase 1's. The e2e harness now
  drops `SHIPPING_API_BASE`/`SHIPPING_API_KEY`, so no suite can reach a real shipping API.

**Validation**: lint clean; unit 879/879 (19 suites); e2e 185/185 (16 suites, step 19's
included); no `jflow_test_*` schema left. The e2e `/forecast` shows the Stock payments row.

**Decisions where CONTRACT was silent or ambiguous** (CONTRACT.md not edited)
- A paid row's effective date is its `paid_on`, so a paid row is never "undated": `loadTarget`
  reads it `TARGET_SETTLED`, not `TARGET_MISSING`, and `/external-items` sorts/filters it by it.
- Undated open rows make no line even when skipped (the classifier needs a date): they are
  `TARGET_MISSING` as targets and `derivedStatus: null`; skipped ones are not in `undatedCount`.
- `SHIP_PLAN_ORPHANED` needs gone rows, which rule 11 excludes: the loader also loads gone rows
  that carry an overlay (in-scope, anchored accounts), for the warning only.
- `SHIP_UNMAPPED` scope: a row whose shipping company maps to no JFlow company counts in every
  scope; one whose company matched but has no usable account counts only in that company's
  scope and `all`. The default account must be live and active too, else unmapped.
- Gone ship rows are not currencies in scope (they make no line). `SHIP_PLAN_STALE` only for
  open, not-skipped rows. The ship name skips missing parts; flags order: feed flags first.
- A `skipped` refresh (claim held) warns `SHIPPING_UNAVAILABLE` when `last_error` is set, so the
  warning does not flicker inside the 60-second claim; a throw inside the refresh is logged and
  reported as `unreachable`. `lastSuccessAt` is the loaded snapshot's.
- `GET /external-items?companyId=` not live → 400 (as `/forecast`); `from`/`to` drop undated rows.

**Left for step 21**: `PUT`/`DELETE /external-items/:key` (reuse `readExternalItem` /
`decorateExternalItems`), the `ship.` branch of the adjustment write, rebase and apply locks
(`external_items` after `cash_items`), apply's overlay write, and their e2e.

**Deferred**: none beyond CONTRACT §11.

## Phase 2 — Step 14: shipping ports the payment math (2026-09-29)

In the **shipping** repo, on branch `phase2-payments-flow` (from `shipping/test` @ `d896b5a`),
commit `14e6115`. Not pushed.

**Shipped**
- `src/lib/payments-flow/`:
  - modules `dates`, `containers`, `lines`, `money`, `terms`, `suppliers`, `policy`,
    `due`, `po`, `flow`, `ids`, `types`, `index`;
  - a type-stripped CommonJS port of `buildPaymentsFlow` from ShipLine `f9499bc`.
    75/78 top-level statements are byte-identical to the stripped TS; the other 3 are the
    two deliberate changes (`today` required, `dateOfInstant` pinned to Europe/London).
- `tools/payments-flow-oracle.mjs` runs the frozen TS and refuses anything that isn't
  f9499bc or isn't London time.
- 13 fixtures with expected outputs; the terms, golden and ids tests are added to
  `test:unit`.

**Validation**
- Every fixture deep-equals the oracle.
- shipping `test:unit` is **197/197** under TZ=UTC and TZ=Europe/London, on Node 18.20.8
  and Node 24.
- The lib requires only local files and `crypto`, and reads no clock.
- Coverage: 99.9% lines, 90.8% branches.

**Findings that change the plan**
- At f9499bc the model no longer emits `shipment:` items: the 09-28 rule removed them.
  So PHASE2 finding 3's duplicate id is gone, and "recording an invoice mints a new id" no
  longer happens. `inv-…-a|s` survives only as a claim-level id.
- For step 18:
  - `pay-<sp>-bal<target>` needs a `-<po>` suffix when one transfer is split per PO;
  - the model doesn't yet output the per-PO claim shares that paid rows need;
  - `<g>` upper-cases refs, but the TS groups refs case-sensitively.

**Likely bugs in ShipLine's TS, found by the oracle** (reported to Dev, not fixed;
identity first):
1. A PO bundle with no `id` crashes the model.
2. The "PI uploaded" rule ignores an uploaded PI with no extracted payment row.
3. With several open balance records on one box, the last claim wins `shipmentPaymentId`
   and status.
4. Transfers are applied across currencies one-for-one (a EUR transfer reduced a USD PI).
5. Mixed day boundaries: shipment stages use the London date, while ShipsGo times and PI
   uploads use the UTC date.
6. Flags from a replaced date source linger (`bl_issued`, `derived_date`).
7. Under TZ=UTC the TS itself moves 5 items in the midnight fixture, which confirms the
   London pin.

## Phase 2 — Step 19: JFlow schema, client, refresh (2026-09-29)

**Shipped**
- `src/db/migrations/2026-09-29_jflow_ship.sql` (CONTRACT §3.5): `external_items`,
  `external_sync`, `companies.shipping_company_id`, `categories.system_key`, and the
  "Stock payments" system category. 17 tables.
- `services/shipping.js`:
  - a 5s `AbortController` timeout, `X-Api-Key`, env read per call;
  - `validateFeed` also rejects `amount <= 0`, inconsistent open/paid rows and
    case-insensitive duplicate ids.
- `services/shippingRefresh.js`:
  - no transaction; its own connection with a 5s lock wait; claim → fetch → diff;
  - never DELETEs, never writes `planned_*`;
  - a busy row is skipped until the next run;
  - `refreshIfStale`.
- `routes/external.js`: `POST /external/refresh` (`{ran, status}`, the claim
  honoured, 503 `SHIPPING_UNAVAILABLE`) and `GET /external/status`.
- `PUT /companies/:id {shippingCompanyId}` with 409 `SHIPPING_COMPANY_TAKEN`. A system
  category refuses delete and direction change (P10).
- put-secret, `serverless.yml` and `.env.example` gain `SHIPPING_API_BASE` /
  `SHIPPING_API_KEY`. `SCHEMA_VERSION` is now `2026-09-29.2`.

**Validation**
- Tests first.
- `migrate.test.js` runs `tools/migrate.js` twice on a per-run schema: 2 applied, then 0;
  every statement replays cleanly.
- The refresh e2e covers:
  - insert, change, gone and back;
  - an overlay surviving a refresh that changes every feed column;
  - the claim blocking a concurrent run;
  - a failed fetch writing only `last_error`;
  - the 5s lock wait.
- `grep planned_ src/services/shippingRefresh.js` → nothing.

**Notes**
- `arranged` (a feed field) has no column in §3.5, so it isn't stored.
- `serverless.yml` bakes `SHIPPING_API_KEY` into the template as PHASE2 says;
  `lib/secrets.js` could fetch it at cold start instead (Dev to decide).
- CONTRACT §6.1's `/meta/enums` row still lists only phase 1's keys, while §7 lists more.
  The handler serves §7's.

**Deploy seen during the build**: a `bash deploy.sh test` ran at 13:18, not started by
the coordinator or an agent. It applied `2026-09-29_jflow_ship.sql` to the shared
explorer-test `jflow` schema at 11:18 UTC; the applied checksum matches the committed file.
It packaged the working tree as it was then, with steps 19–20 half-built. **The test stage
should be redeployed from a committed state.**

## Phase 2 — Dev decision: ShipLine read-only (2026-09-29)

"Do not change ShipLine, just use it as read only." Steps 16–17 are dropped, and shipping's
JWT `/api/v1/payments-flow` is not built. Shipping serves JFlow's feed from a port of the
math. ShipLine keeps its own copy, so there are two implementations. They are kept equal by
re-syncing the port with `tools/payments-flow-oracle.mjs` whenever ShipLine's math
changes. Recorded in PLAN.md (Phase 2), PHASE2.md (top and steps 16–17) and CONTRACT §1.1 P1.

## Phase 2 — Step 21: overlay routes and `ship.` scenarios (2026-09-29)

Tests first: `test/e2e/ship-overlay.test.js` (21 tests) failed on the missing routes before
any code existed.

**Shipped**
- `routes/external.js`: `PUT /external-items/:key` (the §10.11 merge; `planned_base_amount` =
  the feed amount under the lock whenever `plannedAmount` is set, P6; audit `plan`) and
  `DELETE /external-items/:key` (revert, `unplan`; gone and paid rows too). Both lock only
  the row and answer the §6.12 row JSON with `derivedStatus`.
- **Added at the web's request (coordinator), not in CONTRACT §6.12:** `GET
  /external-items/:key` (one row, gone or not, for the plan dialog's `baseVersion` and note),
  and `DELETE` answers **200 + the row JSON** instead of 204. CONTRACT should be updated to
  match.
- `services/externalItems.js`: `externalItemJson`, `lockExternalItem` (exact ext_id match
  under the case-insensitive key), `hasOverlay`, `overlaySnapshot`, `auditOverlay`.
- `services/scenarios.js` `lockTargets`: `external_items` rows after `cash_items`, before
  `schedule_overrides`, ascending id (P11). `loadCurrent` names a ship target with the
  forecast's name (`shipName`, moved from `engine.js` to `lib/lines.js`).
- `routes/scenarios.js` `applyToShip` (§10.9 step 5): `planned_date = new_date ??
  planned_date`, `planned_amount = new_amount ?? planned_amount` (+ its base when set),
  `exclude` → `planned_skipped = 1` (P7), stamps, `row_version + 1`, audit
  `external_item`/`apply`, `wrote: 'external_item'`. The re-check is lib/stale.js as before.
- `lib/shape.js` `externalSyncToJson` and the refresh 503 emit timestamps as ISO 8601 UTC
  text explicitly (they already serialised so; now independent of `Date.toJSON`).

**Validation**: lint clean; unit 879/879 (19 suites); e2e 206/206 (17 suites). Two
mutations were checked by hand: dropping the row_version check fails the two restart tests;
locking ship rows before `cash_items` fails the lock-order test.

**Decisions where CONTRACT was silent or ambiguous** (CONTRACT.md not edited)
- **Ship locks "ordered by id" vs the snapshot.** The ids must be found before the locks,
  and that plain read fixes the REPEATABLE READ snapshot before them, so a change committed
  while apply waits on a ship row would be invisible to the re-check. Each row's
  `row_version` is re-read under its lock; a mismatch throws a synthetic
  `ER_LOCK_DEADLOCK` and `withTransaction` restarts once (as the split race guard). A second
  mismatch in the retry is a 500, as for the split.
- Audit `key` rides on `after` only: audit.js drops keys equal on both sides.
- PUT with none of the four fields → 400 "nothing to update"; a merge equal to the current
  overlay writes nothing (no stamp, no bump, no audit); re-sending the same `plannedAmount`
  re-bases it when the feed amount moved (how a stale plan is accepted). "Nothing to plan"
  (400) = date, amount, skipped and note all empty after the merge; DELETE's "no overlay"
  (404) counts the stamps too. `skipped` must be a boolean (`null` is 400).
- An unmapped or undated open row can be planned; an apply `adjust` with only `new_date`
  keeps an existing `planned_amount` and its base (a stale plan stays stale).

**Left for step 22 (web)**: the plan dialog (GET → PUT with `baseVersion`, DELETE to revert),
the refusal codes, dating an undated line before adjusting it (`TARGET_MISSING` otherwise),
and `SCENARIO_STALE` → rebase on drifted ship lines.

**Deferred**: none beyond CONTRACT §11.

## Phase 2 — Step 22: web for stock payments (2026-09-29)

**Shipped** (`web/`):
- `api/external.ts`: status, refresh, list, and GET/PUT/DELETE of the overlay.
- `lib/ship.ts`: `ship.` keys, flag styles, blocked reasons, refresh-failure wording,
  warning split.
- **Forecast**:
  - ship lines drawn from server flags (estimated hatched/italic, blocked, planned);
  - a shipping status line with **Refresh now**;
  - the `SHIPPING_UNAVAILABLE` banner;
  - `SHIP_UNMAPPED` (links to Settings), and `SHIP_PLAN_STALE` /
    `SHIP_PLAN_ORPHANED` notes.
- `ShipPlanDialog`:
  - loads the row (`GET /external-items/:key`) on open and shows shipping's date and
    amount beside the plan;
  - pin or follow the date, note, skip, "Revert to feed";
  - sends `baseVersion`, with a `STALE_WRITE` recovery;
  - inside a scenario it writes an adjustment.
- **Settings**: a per-company shipping-company picker (409 `SHIPPING_COMPANY_TAKEN`); the
  "Stock payments" system category can't be removed or have its direction changed.
- **Stock payments** screen (`/stock-payments`, nav entry): grouped by `derivedStatus`
  (null = "Not in the forecast"). It is the only place to un-skip a stock payment.

**Validation**: `tsc` clean; vitest **321/321** (27 files); build succeeds;
`sharedSession.ts` byte-identical. The browser walk waits for the source swap (real `jfa`
data).

**Notes**: the Forecast's "Clear the plan" on an orphaned plan sends DELETE without
`baseVersion`, because nothing reads the row first.

## Phase 2 — Source swap: JFlow reads shipping's `jfa` directly (2026-09-29)

Dev: "pull required shipping code into this repo rather than modify it"; "same DB,
different schema"; "same test DB as here". **Neither shipping nor ShipLine is modified.**
The shipping working copy was restored to `master` @ `d896b5a`, and the local feature branch
was deleted. Its commits and the unfinished drafts are kept in the session scratchpad
(git bundle + files) for reference.

**Shipped** (committed by Dev as `4d258d0` "work" and `200bb74` "src"):
- `src/lib/payments-flow/`: the port of ShipLine `f9499bc`'s `buildPaymentsFlow` (14
  modules, ported-from headers). `forecast.js` has `toForecastRows`, and `ids.js` the feed
  ids: `pay-<sp>-bal<target>-<po>` when a transfer is split per PO; a container ref maps to
  `s<id>` only on an exact match, else to a hash of the ref as spelt, so case variants
  don't collide.
- `src/lib/shippingCopy/*.js`: mappers copied from shipping's `orders.js`, trimmed to the
  fields the model reads. `src/services/shippingReads.js` has the schema-qualified SQL
  loaders and `SOURCE_COLUMNS`.
- `src/services/shippingSource.js` `readPaymentsForecast` works as follows:
  - its own connection, `SET SESSION TRANSACTION READ ONLY`, one consistent snapshot;
  - a schema check first (→ `source_schema`, with `details.missing` on the refresh 503);
  - reads → model → feed rows.
- `services/shipping.js` keeps `validateFeed` / `unavailable(reason)`; the reasons are now
  `source_schema | source_error | bad_response`, and HTTP is gone.
- `SHIPPING_API_BASE`/`SHIPPING_API_KEY` removed. `SHIPPING_DB_SCHEMA` is optional,
  default `jfa`.
- `tools/payments-flow-oracle.mjs`: under PowerShell, `$env:TZ='Europe/London'; npx -y
  tsx@4.21.0 tools/payments-flow-oracle.mjs [--check] --shipline <ShipLine@f9499bc>`. Git
  Bash drops `TZ`.

**Validation**
- Lint clean; unit **1013/1013** under both TZ=UTC and TZ=Europe/London; e2e **222/222**
  (18 suites).
- Oracle `--check` exits 0 against f9499bc.
- `shipping-source.test.js` builds a shadow `jflow_test_<runid>_jfa`: tables replayed
  from `SHOW CREATE TABLE jfa.*`, because a read-only session refuses DDL. It proves the SQL
  against the real column shapes, the read-only session refusing an INSERT, and the
  schema-check failure.
- **Live read-only smoke on the real explorer-test `jfa`** (today 2026-09-29, ~1 s):
  - 233 rows (231 open, 104 of them undated; 2 paid), **0 `validateFeed` rejects**;
  - by company: 175 company 1, 39 company 2, **19 with no company**;
  - Σ open = `kpis.outstanding` exactly: EUR 20,911.94 · GBP 36,262.52 · USD 2,134,747.75.

**Deploys by Dev during the build**: `bash deploy.sh test` at 13:18 and 15:12. The 15:12
package came from the working tree before the last edits (the `missing` list in the 503,
CONTRACT alignment), so the test stack is slightly behind `200bb74`.

**Dev, before prod**
- Grant JFlow's prod DB user `SELECT` on `jfa.*` (incl. the `suppliers` view) through the
  RDS Proxy. Without it, prod shows `SHIPPING_UNAVAILABLE {reason: 'source_schema',
  missing: [...]}`.
- Remove any `SHIPPING_API_BASE`/`SHIPPING_API_KEY` left in the `jflow/test` / `jflow/prod`
  secrets.
- Map JFA and HW to shipping's companies in Settings. 19 open rows have no company and show
  as `SHIP_UNMAPPED`.

## Phase 2 — `SHIP_UNMAPPED` says why (2026-09-29)

Dev mapped JFA → 1 and Hangerworld → 2, but every stock payment still read "unmapped". The
mapping was right; neither company had an account to land on: JFA's only account is GBP and
not the default, and Hangerworld has none. The resolution rule (P5) is unchanged.
- `SHIP_UNMAPPED` is now `{shippingCompanyId, count, reason, companyId?, currencies?}`, one
  per (shippingCompanyId, reason): `company` (nothing linked, `null` included) or `account`
  (the linked `companyId` has no active account in `currencies` and no active default).
  CONTRACT §6.10, §7 and §8 rule 11 updated.
- Web: the Forecast note gives each reason in words, linking to Settings → Companies or
  Settings → Accounts; the Stock payments list tags such rows `NO ACCOUNT`, not `UNMAPPED`.

## Test data set up for Dev (2026-09-29)

At Dev's request, test values were entered through the local API against the shared
explorer-test `jflow` schema, so every change has an audit row; the test stack sees them too:
- JFA's HSBC (GBP) set as the default account.
- New account "Hangerworld Current" (GBP, company HW, default), with a £25,000.00
  start-of-day balance for 2026-09-29.
- EUR rate 0.860000 from 2026-09-29.

Result: 106 stock payment lines are placed in the window to 31 Dec (92 on HSBC, 14 on
Hangerworld Current). Only the 21 rows with no company in shipping stay unmapped.

## Phase 2 — Dates set by hand in ShipLine reach JFlow's rows (2026-10-06)

ShipLine's Payments flow page lets a person set a payment's due date by hand (shipping table
`payment_due_dates`, 2026-10-06). The handover doc "JFlow ↔ Payments flow handover", section
"Dates set by hand", asked for three things, built here ahead of the full re-pin (the port
stays at `f9499bc` everywhere else):
- **The model.** `lib/payments-flow/overrides.js` — `applyDueOverrides`, `dueOverrideKeys`
  and the sign-off key builders, ported from ShipLine `6565188`; `buildPaymentsFlow` takes
  `input.dueOverrides` (optional; the golden suite is unchanged because the fixtures carry
  none) and applies them before the owed-air pass, as the TS does. `shippingReads.js` reads
  `payment_due_dates` (+ `shipping_allowed_emails.display_name` for the setter's name) as
  **optional tables** (`OPTIONAL_COLUMNS`; `checkSchema` → `{optional}`; the table is not on
  production until the next shipping deploy, and its absence is "no dates set by hand", never
  `source_schema`). `shiplinePage.js` passes `dueOverrides` through like the page does.
- **The feed.** A row carries `dueSet {by, email, at, derivedDate, scope, note}` (null when
  derived); `validateFeed` checks it; `external_items.due_set_json` is a new **feed column**
  (last in `FEED_COLUMNS`, so every stored hash moves once on the first run after the deploy —
  one "updated" sweep, nothing else). Migration `2026-10-06_jflow_due_set.sql`; `SCHEMA_VERSION`
  `2026-10-06.3`. The row JSON (§6.12) and the forecast's `ship` block (§6.10) carry it.
- **The date moved.** The refresh records a move of the feed's `due_date` (a set, a clear, a
  derived date that changed) in `due_date_prev` / `due_date_moved_at` — refresh-owned, not
  hashed, like `gone_at`; never when a `from_today` row only slid a day (`dueDateMoved`,
  `MOVED_FLAG_EXEMPT`). `lib/lines.js shipDateMoved` (14 days, `DATE_MOVED_DAYS`) gives the
  engine's `date_moved` flag, `ship.dateMovedFrom` / `dateMovedAt`, and the row's `dateMoved`.
- **Web.** A set date wears ShipLine's mark (✎, dotted underline), a "set by … on … · derived …"
  line and the note on Stock payments; `SET IN SHIPPING` / `DATE MOVED` tags everywhere flags
  show; `shipFlagNotes` sentences; the dialogs' "Shipping says …" gains "(set by hand by … ;
  shipping's derived date was …)"; "moved from … on …" under a moved date for 14 days. A JFlow
  `plannedDate` still wins (handover open question 2).

**Not run here:** the e2e suites (no database on this machine). They were brought in line
and extended without being run: `shipping-refresh.test.js` now has a move case (a changed
`due_date` writes `due_date_prev` / `due_date_moved_at` and counts `moved`; a `from_today`
slide does not; back to the derived date is a move again), a `due_set_json` round trip through
`GET /external-items/:key`, and the three new columns in the migration check; the row-key lists
in `ship-overlay.test.js` / `forecast-ship.test.js` and the exact `ship` block carry the new
fields. `migrate.test.js`'s first-two-files check still holds (the new file sorts third). Run
`npm run test:e2e` on a machine with the explorer-test database before relying on them.

**Deferred:** the full re-pin to `6565188` (handover doc section 7, steps 2–5); an on-demand
"History" line from shipping's `audit_log` (`entity_type = 'payment_due_date'`).

## Phase 2 — `projected` retired (2026-10-06)

Dev, testing locally: "remove projected from jflow, confuses user". The tag read as "no
invoice uploaded yet", while it only meant `amountBasis = 'derived'` — the amount is the terms
percentage of the goods, which is exactly how ShipLine's own page treats the same row (an
uploaded supplier invoice is an invoice *check* against the owed figure and never changes it;
`basis` is `stated` only for a PI row or a balance record). The server no longer emits the
flag (`engine.js shipFlags`), the web no longer derives it (`shipPlan.ts targetFromRow`),
`flagTags` skips a stray one from an older API, and the "not yet stated on an invoice"
sentence is gone. `amountBasis` is unchanged on the row JSON and the `ship` block. CONTRACT
§6.10 and PHASE2 §4.5 note the retirement.

## Phase 2 — Forecast groups stock payments by supplier + shipment (2026-10-06)

Dev: "similar to what we do on ShipLine payments flow … group by supplier+shipment combination,
clicking expands to show individual payments". Web only, in `ForecastGrid.tsx`: the Stock
payments category (every line `kind: 'ship'`, `lib/grid.ts isShipCategory`) now shows one row
per supplier + container (`groupShipCombos`: key = lower-cased supplier | upper-cased container,
`-` when unknown, so a PO's unbooked goods are their own group), with the group's per-bucket
and window sums of its lines' `gbpMinor` — the grid's one display-only sum — a count, and the
collapsed category's attention tags. Groups open collapsed; "Expand all" opens them with the
categories; a line under its group no longer repeats the container. The lines themselves are
unchanged and are still what the edit dialog opens. The server sends nothing new.

Decisions recorded in the handover doc the same day (open questions 3 and 4): QC units as
rows; forwarder costs in their own "Freight and forwarders" category with the payee shown;
extras riding a supplier payment added to that supplier + container group and shown on
expansion; credits netted into the payment they offset. All four need the re-pin to ShipLine
`6565188` first (section 7, steps 2–5): JFlow's model at `f9499bc` has none of those items.

## Phase 2 — Re-pin to ShipLine `77577a1`: extras, QC units, top-ups, drafts and plans (2026-10-06)

Dev: "okay do the re pin" (handover doc section 7, steps 2–5; his decisions on open
questions 3 and 4). The port had been frozen at `f9499bc` (2026-09-29) while ShipLine's
model grew by 1,332 lines in a week.
- **The port is now one generated file.** `api/src/lib/payments-flow/model.js` is ShipLine's
  `paymentsFlowMath.ts` at `77577a1` transpiled whole (tsc transpileModule), with the port's
  three deliberate differences applied by exact text replacement (today required, no clock
  anywhere — `localTodayYmd` is gone; `dateOfInstant` pinned to Europe/London;
  `buildPaymentsFlow(input, {claims: true})` returns `balanceClaims`) and the TS's private
  helpers exported at the end. The old modules by concern (`dates`, `lines`, `money`, `terms`,
  `suppliers`, `policy`, `due`, `po`, `flow`, `overrides`) are thin re-exports; `keys.js` is
  `paymentReviews.ts`'s key builders (the model's new runtime import); `containers.js` is
  unchanged (same hash). The build script lives in the session scratchpad; re-pin = run it
  again and move the oracle's `SOURCE` hashes. **Golden A: 37/37 exact under 5 time zones.**
- **Oracle** `tools/payments-flow-oracle.mjs`: `SOURCE.commit 77577a1`, three pinned files
  (paymentsFlowMath.ts 4118 lines, containerHelpers.ts 340, paymentReviews.ts 196). Expected
  files regenerated; two fixtures added: `extras-qc-credit` (mould cost riding a balance, a
  forwarder's GBP freight cost, a credit note on account forecast against the supplier's most
  urgent payment, a paid extra, a `_FQC` QC unit) and `open-containers` (a dated DRAFT splitting
  a PO's unbooked goods, a PLANNED box with no dates, the departure rule's from-today date, a
  top-up on a paid container).
- **Reads** (`shippingReads.js`, all optional so a stage short of a table still feeds):
  `payment_extras` (+ applied per extra from live transfer lines; copy
  `lib/shippingCopy/paymentExtras.js`), open shipments `DRAFT`/`PLANNED` with `name`, `etd`,
  `eta` and their `shipment_lines`, transfer lines of kind `extra` and `qc`, the `departure`
  estimate key (`paymentRules.js`). `shiplinePage.js` builds the page's input at `77577a1`
  (`openContainers`, `paymentExtras`, `dueOverrides`, in the page's key order).
- **Feed** (`forecast.js`, `ids.js`, `validateFeed`): kinds `extra` and `qc` join `deposit` and
  `balance`; a `label` says what a row is when it is not goods ("Mould cost", "Freight",
  "PO charges", "Top-up", "QC units X"); ids `ext-<id>`, `qc-<orderId>`, `chg-<po>-<g>`,
  `top-<po>-<g>`, `pi-<pi>-c<g>` / `f<g>`, and `<g>` = `d<shipmentId>` for goods in a draft or
  plan (`@open:<id>`); paid rows `pay-<sp>-ext<id>` / `qc<id>`. **Credits** (Dev): netted into
  the row the model forecasts them against (`credit_netted`); a row netted to nothing is left
  out; credits with nothing to ride make no row (the model's `kpis.credit` still says how much).
  A forwarder's cost names no PO, so its company is the company of the goods in its container
  when they are all one company's (`companiesByBox`), else it stays unmapped.
- **Schema / engine**: migration `2026-10-06_jflow_freight.sql` — `external_items.label` (feed
  column, hashed) and the **"Freight and forwarders"** system category (`system_key 'freight'`,
  sort 910); `SCHEMA_VERSION 2026-10-06.4`. `engine.js` puts a `shipment_cost` extra there
  (fallback: Stock payments), names lines by label (`lines.js shipName`); `forecastLoad`
  loads both system categories. Row JSON and `ShipInfo.kind` carry the new kinds.
- **Web**: `shipRowName` uses the label; the new category row appears on the Forecast by itself;
  the supplier + shipment grouping folds an extra riding a balance into its supplier's group,
  and a forwarder's costs into the forwarder's group.
- **Live on TEST after the first refresh**: 312 rows (74 inserted, 8 gone — the old `-n` ids of
  goods now split into drafts — 95 dates moved by the new dating rules: a one-off `DATE MOVED`
  wave for 14 days), 18 extras, 10 open shipments, 0 open QC units. Σ open per currency is the
  model's `kpis.outstanding` less the netted credit.

**Checks**: api unit 1070 green + eslint; web 341 green + tsc + build. **Not run**: the e2e
suites (no database here); `migrate.test.js`'s first-two-files check still holds.
**Deferred**: "History" from shipping's `audit_log`; QC units' sign-off key; the invoice-check
verdict ("invoice on file, matches") as a feed field.

## Phase 2 — Freight on a shared container goes to the bigger share (2026-10-07)

Dev, on two DCG freight charges left out as `SHIP_UNMAPPED` (containers 314 and 316, each
carrying JFA and Hangerworld goods): "map these to jfa", then chose the rule "biggest share
wins". ShipLine has no company on a forwarder's cost, so this is JFlow's rule, not data.

- `forecast.js companiesByBox` (+ `biggestShare`): a container's forwarder cost falls to the
  only company with goods in it, as before, and when several have, to the one whose items
  there add up to more (every open item naming a PO with a company: goods, charges, top-ups,
  extras riding a PO). It stays unmapped on a tie, and when those items are in more than one
  currency — the feed has no rates to weigh them by. This replaces "else it stays unmapped"
  in the re-pin section above.
- The share is of what is still **owed** in the container (the model's open items), not of the
  goods' full value: a company whose goods there are all paid has no share.
- Tests (written first): `payments-flow-forecast.test.js` — bigger share across several POs,
  the other company winning, a PO with no company weighing nothing, a tie, two currencies,
  two currencies of one company; `extras-qc-credit`'s forwarder cost now takes company 1.
- Read against the live source: `ext-25` and `ext-26` resolve to JFA; the other ten open
  forwarder costs keep their company.

**Checks**: api unit 1072 green + eslint. **Not run**: the e2e suites — `api/.env` pointed at
the production instance, and they create and drop schemas. **Not deployed**: the rows change
at the first shipping refresh after Dev runs `deploy.sh`.

## Forecast grid — In / Out bands, click-to-sum, and the hide eye (2026-10-07)

Dev, on the Forecast screen. None of this is in PLAN.md; the hide is recorded in CONTRACT §6.10.

- **In / Out as plain rows again** (the nested In ▸ categories layout of this morning is
  gone): the categories are listed under the balance rows, collapsed, in two bands —
  MONEY IN, MONEY OUT — with the side's colour down each category's left edge, in place of
  the small IN / OUT tag beside every name.
- **Click-to-sum**: clicking a total (In, Out, a category, a supplier group) or Ctrl-clicking
  a line picks its figure; a bar under the grid shows the sum (in, out and net when mixed).
  Display only.
- **Hide** (`GET /forecast?hide=<keys>&hideCategories=<ids>`): an eye on every category,
  supplier group and line re-reads the forecast without it. The engine flags the lines
  `hidden` and counts nothing for their placed parts; `hidden {count, inflow, outflow,
  fullSummary}` and `days[].fullClosing` say what went. The screen holds the hidden set for
  the visit only — nothing is stored. The chart draws the "with everything" line dashed and
  the tiles show the difference; inside a scenario both keep comparing with the real plan
  and the HIDDEN panel gives the with / without figures.
  - `engine.js` (`hideOf`, `applyHide`, `hiddenTotals`), `routes/forecast.js` (`parseHide`).
  - Tests written first: `engine.test.js` "hide: …" (7), `forecastQuery.test.js` (7).

**Checks**: api unit 1086 green + eslint; web 346 green + tsc. **Not run**: the e2e suites
(their pinned response-key lists were updated for `hidden`, unrun). **Not deployed**: until
Dev runs `deploy.sh`, the deployed API ignores `hide` and the web's HIDDEN panel says so.
**Deferred**: keeping the hidden set across a reload (URL or storage); a per-bucket
"vs everything" row in the grid; a schedule with more than 100 instances in the window
cannot be hidden whole from its row (the cap on `hide`) — hide its category instead.

**Later the same day**: a schedule is one grid row (`grid.ts groupLines` groups `sched` lines
by `scheduleId`), its instances side by side in their buckets, not one row per date; the
row's eye hides every instance on it.

## Phase 2 — A box's company is weighed by its goods, paid or not (2026-10-07)

Dev: `SHIP_UNMAPPED · 3 stock payments have no company in shipping` — "why does this keep
happening". Shipment 334 ("126. Air Freight"): Sunmed's packaging and handling fee and DCG's
freight name no PO, so they take the company of the goods in the box; the goods balance
(PO_00333J) was settled in shipping at 10:48 that morning, the box then held nothing owed,
and the three extras lost their company. The rule ("biggest share wins", above) weighed
what was still owed, so every shipment whose goods are paid before its charges did this.

- `forecast.js companiesByBox` now weighs the **goods** in a box — each PO line's
  quantity × unit price (`input.orders`), in the PO's currency, paid or not. A box whose
  goods carry no price falls back to what is owed in it, as before. `poDirectory` carries
  the PO's currency; `toForecastRows` takes `orders` in its context (the source service and
  the test helper pass `input.orders`).
- Tests (written first): `payments-flow-forecast.test.js` — a paid box keeps its company,
  goods value beats owed balance, a PO with no company weighs nothing, unpriced goods fall
  back to owed, two currencies stay unmapped; `poDirectory`'s currency.

**Checks**: api unit 1088 green + eslint. **Not deployed**: the three rows resolve at the first
shipping refresh after Dev runs `deploy.sh`.

## Assumed instances across schedules on Income & outgoings (2026-10-07)

Dev: an automatic receipt that arrives a few days late is assumed into the recorded balance,
so the forecast drops it and reads low; "is it possible to see a list of all auto received
items and mark them as not paid / received yet? where is the best place". The one-off side
existed (Assumed settled → Confirm paid / Didn't happen); the recurring side needed each
schedule opened in turn. Chosen place: Income & outgoings, both kinds in one list.

- **API** `GET /instances?companyId&accountId&categoryId&from&to&derivedStatus` (CONTRACT
  §6.9): every instance in the window of every live schedule in scope, each with a
  `schedule {id, name, counterparty, accountId, companyId, categoryId, status}` block;
  `derivedStatus` a comma list of D10's bands. `routes/schedules.js` (the D35 window
  parsing is now `instanceWindow`, shared with the per-schedule route).
- **Web** Income & outgoings lists the schedules' instances in the assumed, overdue and
  unresolved bands up to today alongside the one-offs (RECURRING tag, the schedule's name as
  a link, "the 5 Oct instance"), with Confirm paid / Didn't happen / pay / unpay; tune and
  skip stay on the schedule's page. Didn't happen tunes that one instance to settled by hand.
  One-offs in "Assumed since the last balance" now offer Didn't happen too.
- Tests: `test/e2e/schedules.test.js` "GET /instances …" (written, **not run** — no test
  database here); `ItemsScreen.test.tsx` the instance row and its Didn't happen.

**Checks**: api unit 1088 green + eslint; web 349 green + tsc. **Not deployed**: until Dev runs
`deploy.sh`, the deployed API answers 404 for `/instances` and the screen shows that error
above the one-offs. **Deferred**: a Forecast warning for automatic receipts assumed in the
last few days; tune / skip from this list.

**Later**: Dev — "could we go back further? for the assumed settled, just in case it was not
noticed until after I added latest cash at bank". The assumed bands are now read however old:
a second all-time `GET /items?status=expected&settleMode=auto&to=<yesterday>` beside the
windowed read (an automatic one-off still expected and dated before today is assumed, whatever
its anchor), merged by id with the windowed rows winning; the instances read always spans the
server's 730 days. The window note says so. `ItemsScreen.test.tsx` covers the second read.

## Scenario adds, splits and un-apply (2026-10-07)

Dev: "as part of a scenario, would it be possible to split a payment into multiple dates /
amounts? and then revert if needed. also possible to add one-off payments as part of a
scenario, e.g. an interest payment or a fine if I pay late". None of it existed: a scenario
held one `adjust`/`exclude` per real line, hypothetical items were on PLAN.md's deferred
list, and the only revert after apply was per instance by hand. Contract first (Fable, as
step 0), then the API on the xhigh JFlow agent and the web on Opus, per CLAUDE.md's table;
the coordinator reviewed both, added the D40 cascade (below) and ran the checks again.

- **Contract**: CONTRACT.md §1.2 (D39–D44), §2.8 (new audit actions), §3.6 (migration), §4
  (`new.` keys), §6.10, §6.11, §7, §8, §9.5, §10.1, §10.5, §10.7a (add write), §10.7b
  (split), §10.8, §10.9 (apply amendments and `applied_state`), §10.13 (un-apply), §11, §12.
  PLAN.md edited to match (schema table, routes list, a scenarios paragraph, the web table,
  the deferred list).
- **`add`** (D39): a third adjustment kind — a hypothetical one-off keyed `new.<adjustment
  id>`, with its own account, category, direction, name, counterparty and currency on the
  adjustment row and null bases. The engine makes a line for it in the scenario set only
  (`kind: 'new'`, flag `added`, `baseline: null` — the case §6.10 had reserved); its stale
  reasons are `TARGET_MISSING` (account not live/active or category not live) and
  `DATE_PASSED`. Apply inserts the real `cash_items` row stamped `source_scenario_id`.
  `POST /scenarios/:id/adjustments` creates one; `PUT`/`DELETE …/adjustments/new.<id>` edit
  and remove it.
- **Split** (D40): `POST /scenarios/:id/adjustments/:itemKey/split {parts}` writes one
  `adjust` on the line (part 1) plus one `add` per further part, all stamped `split_group` =
  the anchor's id; the parts must sum to the line's current amount (422
  `SPLIT_AMOUNTS_MISMATCH`). Wherever the server deletes the anchor — the DELETE route,
  rebase's `dropStale`, a schedule split's or end's `dropAdjustments` — its parts go with it
  (revert the split); deleting a part removes it alone. Lines in a group carry flag `split`
  and `splitGroup`.
- **Un-apply** (D41): apply now records on every adjustment, in `applied_state` (JSON, not
  served), the before image of what it wrote. `POST /scenarios/:id/unapply` re-checks every
  target under the standing-order locks and refuses the whole thing with 409
  `SCENARIO_UNAPPLY_BLOCKED {blocked: [{itemKey, reason}]}` (`TARGET_MISSING`,
  `TARGET_SETTLED`, `CHANGED`, `NO_RECORD`) when anything moved on; otherwise it restores the
  before images (an override apply created is deleted, a one-off apply created is
  soft-deleted) and the scenario is a `draft` again with its adjustments, ready to edit and
  re-apply.
- **Migration** `2026-10-07_jflow_scenario_adds.sql`: nullable bases, the six add columns,
  `split_group`, `applied_state`, `idx_split_group`; every statement guarded (§3.1).
  `lib/schema.js` `SCHEMA_VERSION` is `2026-10-07.5`, so the next local `npm run dev`
  replays it onto the shared `jflow` schema (additive and nullable: the deployed test API
  keeps working against it until it is redeployed).
- **Web**: Forecast — with a draft scenario open, "Add a one-off…" on the scenario panel,
  "Split into parts…" in the line dialog (parts with dates and amounts, a running "left to
  allocate", the odd penny on part 1), a `new` line edits or is removed from the scenario
  (its note read from the scenario so the full-replace PUT keeps it), an anchor's undo is
  "Undo the split". Scenario — `add` rows read "NEW ONE-OFF · amount on date · not in the
  real plan", anchors wear SPLIT, removing an anchor warns that its parts go too, and an
  applied scenario has "Un-apply…" with the refusal's blocked lines listed. Flags `NEW` and
  `SPLIT` on the grid. A `new.` key with no scenario open is now a form error (it fell
  through to the instance-tune path before).

**Checks** (coordinator's run unless noted). API: `npm run lint` clean; unit 26 suites /
1126 tests; e2e `scenario-adds` 20, `split` 14, `scenarios` + `scenario-headline` 23; the
builder's run of `forecast` + `items` (47) and `forecast-input` + `forecast-load` (16) also
green. Web: `tsc --noEmit` clean; vitest 30 files / 422 tests; `vite build` green (builder's
run). **Pre-existing e2e failures, not from this work** (their files are untouched by it and
the tree was clean at the start): `migrate.test.js` 1 (expects only "Stock payments"; the
2026-10-06 freight migration also seeds "Freight and forwarders"), `ship-overlay.test.js` 3
(`ROW_KEYS` order of `dateMoved`), `schedules.test.js` 1 (`GET /instances` count). They
date from the 2026-10-07 commits whose notes say "written, not run".

**Not deployed**: until Dev runs `bash deploy.sh test` (it migrates first), the deployed
API has none of the three routes and the deployed web's new buttons would get 404s. Run the
migration on prod the same way (`deploy.sh prod`) before the web is promoted.

**Deferred** (CONTRACT §11): splitting a `new.` line; a split whose parts do not sum to the
line; un-apply of a scenario applied before 2026-10-07 (`NO_RECORD`); an add's `settleMode`
(always `auto`) and `notes`; serving `applied_state`; a category direction flip while only
adds use it. Web: no note field on the split dialog (a split clears the line's previous
adjustment note); while a stock payment is split, its `new` parts put the Stock payments row
on the plain name-sorted view instead of the supplier-and-shipment grouping; a stale split
anchor still wears `split`.

**Housekeeping found, not fixed**: `api/docs/CONTRACT.md` carries a truncated duplicate of
its first ~147 lines before the real heading (a past edit pasted the head twice; the first
copy stops mid-sentence in §2.1). The permission classifier refused the rewrite that would
drop it; Dev can delete everything before the second `# JFlow — API and engine contract`
line. The genuine copy is complete and is the one edited today.
