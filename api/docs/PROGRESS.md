# JFlow — build progress

Resume point for a fresh session. Read this straight after `CLAUDE.md`, `docs/PLAN.md`,
`docs/BUILD_PLAN.md` and `api/docs/CONTRACT.md`. One section per step, written when the
step's "Done when" holds and its commit is made.

## Current step

**Steps 2, 3, 4 (classifier) and 8 are in progress in parallel** — Dev asked for multiple
agents. The pieces don't depend on each other's code (only on CONTRACT.md), and each step
still gets its own commit, in order. Steps 5–7 wait for Dev to set `/effort xhigh`.

| Step | Title | State |
|---|---|---|
| 0 | Adopt the spec | done |
| 1 | Scaffold, CI, migration tooling | done |
| 2 | Reference data | in progress |
| 3 | Pure libraries (tests first) | in progress |
| 4 | Classifier and one-off items | classifier in progress; items waits on steps 2–3 |
| 5 | Schedules, overrides, split and end (tests first) | not started |
| 6 | Engine, loader and `/forecast` (tests first) | not started |
| 7 | Scenarios | not started |
| 8 | Web shell, settings, cash at bank | in progress (ahead of order; its "Done when" needs step 6) |
| 9 | Web forecast, items, schedules, scenarios | not started |
| 10 | Mobileweb | not started |
| 11 | First deploy — STOP (Dev) | not started |
| 12 | Phase 2 plan (write, do not build) | not started |

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
