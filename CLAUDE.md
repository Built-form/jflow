# JFlow — project memory (read first every session)

Cashflow forecasting app: start-of-day bank balances, one-off and recurring items, tuned
instances, named what-if scenarios, per company with a combined GBP view. Sibling of
`C:\Users\OpsLondon\workflows`: same structure, deploy, migration method, serverless config
and RDS Proxy access. The git repo is the repo root (`jflow/`, branch `master`), not `api/`.
`workflows/` is READ-ONLY reference. Never modify it.

## Read first, in this order
1. `CLAUDE.md` 2. `docs/PLAN.md` 3. `docs/BUILD_PLAN.md` 4. `api/docs/CONTRACT.md`
5. `api/docs/PROGRESS.md`, which gives the current step.

- CONTRACT.md and PROGRESS.md live in `api/docs/`, not `docs/`. PLAN.md's layout puts them
  there, and PLAN.md wins over BUILD_PLAN.md. Read every `docs/CONTRACT.md` or
  `docs/PROGRESS.md` in BUILD_PLAN.md as `api/docs/…`.
- Precedence for design: PLAN.md > BUILD_PLAN.md. BUILD_PLAN.md only orders the work,
  names the tests and marks the stops. From step 0 onward, CONTRACT.md is the working copy
  of PLAN.md, and the code follows it.

## Working rules
- One step at a time, in BUILD_PLAN order. Start a step only when the previous step's
  "Done when" holds.
- A step ends with `npm run lint` and its tests green, and with PROGRESS.md updated to say
  what shipped and what was deferred. Then make one commit on `master`: `step N: <title>`.
- Write tests before implementation for `keys`, `recurrence`, `classify`, `engine`, split
  and apply. Write the test, watch it fail, then implement.
- Ask Dev only when a decision is in neither PLAN.md nor CONTRACT.md. Don't invent scope.
  Don't drop scope silently: record it under **Deferred** in PROGRESS.md.
- If a `workflows/` file isn't where the copy table below says, adapt, note it in
  PROGRESS.md and carry on. Don't stop.
- **Money:** integer minor units parsed from DECIMAL strings, never through floats. Parse
  FX rates to micro-units and multiply with BigInt. Apply `roundHalfUp` once per item.
- **Dates:** `YYYY-MM-DD` strings with epoch-day arithmetic. **today** is the
  Europe/London date from `Intl.DateTimeFormat`, computed once per request in the route
  and passed down. `?today=` is honoured only in local/test. The engine has no DB and no
  clock.
- **Conventions (as workflows):**
  - snake_case, VARCHAR enums validated in code, `DECIMAL(14,2)`, `row_version`,
    `created_by`.
  - One audit row per mutation, written inside the transaction.
  - Refusal envelope `{error, code, details?}`.
- **Copied-file header:** `// Copied from workflows/<path> — changes: <list, or "none">`.
  - Use the language's comment syntax: `#` for yml, sh and ignore files; `/* */` for CSS;
    `--` for SQL.
  - In a shell script the header goes after the shebang.
  - JSON can't carry a header, so record those copies in PROGRESS.md instead.
- **STOP** markers are gates: stop, report, and wait for Dev.
  - **After step 0.** Dev skims `api/docs/CONTRACT.md` before any code is written.
  - **Step 11 (first deploy).** Dev creates the secrets, DB grants, Vercel projects, DNS
    and OAuth origins, then runs `bash deploy.sh test`.
- Without Dev, never run `deploy.sh`, `npm run migrate:test` or `npm run migrate:prod`,
  and never touch Secrets Manager or anything else in AWS. Local `npm run migrate`
  (against `api/.env`) is fine.
- Never DROP or TRUNCATE outside a `jflow_test_<runid>` schema.

## Naming
| Thing | Value |
|---|---|
| Repo | `C:\Users\OpsLondon\jflow`, branch `master` |
| Serverless service / function | `jflow` / `jflowApi` (handler `src/handlers/jflow.handler`) |
| Secrets | `jflow/test`, `jflow/prod` (eu-north-1) |
| DB schema | `jflow`: dev and test share explorer-test; prod goes through the RDS Proxy |
| Hosts | `jflow.built-form.co.uk` (web), `mjflow.built-form.co.uk` (mobileweb) |
| Runtime | `nodejs22.x` (`serverless.yml`, `engines`, CI) |
| Meta table | `jflow_schema_meta` |
| Core migration | `api/src/db/migrations/2026-09-29_jflow_core.sql` |
| E2E schema | `jflow_test_<runid>`, created and dropped per run |

## Copy from workflows
All sources are under `C:\Users\OpsLondon\workflows` and were checked to exist on 2026-09-29.
"same" means the file keeps the same path in `jflow/`. Unless a row says otherwise, the
only changes are `workflows` → `jflow` names.

**API, in step 1**
| Source (`workflows/`) | JFlow | Changes / notes |
|---|---|---|
| `api/deploy.sh` | same | Secret `jflow/<stage>`. Drop the sharp block (`==> Installing sharp's Linux x64…`, `npm install --os=linux …`) and the uploads-bucket wording |
| `api/serverless.yml` | same | Service `jflow`, function `jflowApi`, `runtime: nodejs22.x`. **Keep:** the VPC (`sg-015a76ba77bb50587`; subnets `subnet-0182666b07673d609`, `-023d894c20f906c27`, `-0f684d9b9cb010dfe`), the Google JWT authorizer and audience, the httpApi CORS block, the `ANY` route plus the authorizer-less `OPTIONS` route, `SECRET_ID: jflow/${self:custom.envName}` with its `secretsmanager:GetSecretValue` statement, the `DB_PROXY_HOST`→`DB_HOST` fallback, and the package patterns. **Remove:** `UploadsBucket` and its policy, the S3 IAM, `events:PutEvents`, `JFPRO_*`, `UPLOADS_*`, and the sharp patterns |
| `api/tools/migrate.js` | same | Secret `jflow/<stage>`. It requires `src/lib/schema.js` and `src/lib/sql.js` |
| `api/tools/put-secret.js` | same | Secret `jflow/<stage>`. The only optional key left is `DB_PROXY_HOST` (drop `JFPRO_*`) |
| `api/src/db/index.js` | same | `withTransaction` retries the body **once** on `ER_LOCK_DEADLOCK`, always. Workflows has it opt-in (`retryOnDeadlock`, default 0) |
| `api/src/lib/logger.js`, `sql.js`, `audit.js` | same | None |
| `api/src/lib/schema.js` | same | `workflows_schema_meta` → `jflow_schema_meta`. `ensureSchema` stays local-dev only |
| `api/src/lib/secrets.js` | same | Import `withTimeout` from `./timeout` (it was `../services/events`) |
| `api/src/services/events.js` (`withTimeout` only) | `api/src/lib/timeout.js` | Extract that one function. There is no events service |
| `api/src/lib/shape.js` | same | Keep `fail`, `apiError`, `serverError`, `listResponse`, `parseId`, `parseListParams`. Also keep what the copied handler and `apiError` need: `isApiError`, `sendApiError`, `keysetResponse`, `parseCap`, `normalizeEmail`, `isValidEmail`, `auditToJson`. Drop the entity `*ToJson` helpers, `queueEvent`/`flushEvents`/`respond` and `urlFor`. Record the extras in PROGRESS.md |
| `api/src/lib/roles.js` | same | Types are `standard \| admin` only: standard = trust-the-team, admin = + user management (the pre-2026-09-16 workflows model). Drop the `manager` tier and the reviewer flag |
| `api/src/handlers/workflows.js` | `api/src/handlers/jflow.js` | **Keep:** request id, auth middleware, local bypass, `health`, `me`, `meta/enums`, `users`, `audit`, the 404 and error handlers, the Lambda export (`app`, `handler`) and the unhandledRejection guard. **Drop:** the reviewer gate, s3, and every workflows route mount |

**Scaffold, in step 1**
| Source (`workflows/`) | JFlow | Changes / notes |
|---|---|---|
| `.gitignore` | same | Drop the `api/sample-serverless.yml` and `.events-stub.jsonl` lines |
| `.editorconfig`, `.gitattributes` | same | None. `.gitattributes` only covers About's `web/public/test-results/*.json` |
| `.github/workflows/ci.yml` | same | Node 22. Drop the `spec:diff` step, because openapi is deferred |
| `api/package.json` | same | `main`/`dev` → `src/handlers/jflow.js`; `engines.node: 22.x`. Drop `@aws-sdk/client-eventbridge`, `client-s3`, `s3-request-presigner`, `pdfkit`, `sharp`, `uuid`, the `js-yaml` devDependency and the `spec:diff` script |
| `api/jest.config.js`, `api/eslint.config.js` | same | None |
| `api/tools/test-report.js` | same | None. It is `jest.config.js`'s reporter and feeds About |
| not in workflows | `api/.env.example` | Write it fresh with key names only: `DB_HOST`, `DB_PORT`, `DB_NAME=jflow`, `DB_USER`, `DB_PASSWORD`, `BOOTSTRAP_ADMIN_EMAILS`, `PORT`, `LOG_LEVEL`. Take the format from `web/.env.example`. Never copy a value from any `.env` |
| not in workflows | `README.md` | Write it fresh |

**Web, in step 8.** Change names, hosts and URLs to JFlow's unless a row says otherwise.
| Source (`workflows/`) | JFlow | Changes / notes |
|---|---|---|
| `web/src/auth/sharedSession.ts` | same | **Byte-identical, with no header.** Byte-identical beats the header rule |
| `web/src/config/env.ts` | same | `PRODUCTION_HOSTS` → `jflow.built-form.co.uk`. The test and prod API bases go in after step 11 |
| `web/src/api/client.ts` | same | Error-code types come from JFlow's `api/types.ts` |
| `web/src/app/auth.tsx`, `session.tsx`, `useQuery.ts` | same | `session.tsx` drops the workflows-only boot reads |
| `web/src/components/ui.tsx`, `Dialog.tsx`, `ErrorBoundary.tsx`, `EnvBanner.tsx`, `PageHeader.tsx` | same | Names only |
| `web/src/components/Shell.tsx` | same | Rebuild the nav for JFlow's screens. It imports instances, lots, myChecks and roles, so the change is more than names |
| `web/src/styles/tokens.css`, `base.css`, `shell.css` | same | None |
| `web/vercel.json` | same | None |
| `web/vite.config.ts` | same | It pulls in `src/build.d.ts`, `src/config/build.ts`, `tools/test-report.mjs` and `src/test/setup.ts` (copy them) |
| Needed by the files above | same paths | `src/lib/tone.ts` (switch to JFlow statuses), `src/lib/format.ts`, `src/auth/roles.ts` (`standard \| admin`), `src/api/index.ts` and `api/types.ts` (rewrite the resources, keep `request`/`ApiError`). `src/test/setup.ts` imports workflows mocks, so write it fresh |
| PLAN's "People, About, Sign-in" | `src/screens/PeopleScreen.tsx`, `AboutScreen.tsx`, `SignInScreen.tsx` | Also copy About's `src/lib/testRun.ts` and `web/tools/test-report.mjs` |
| Vite scaffold | `web/package.json`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `.env.example` | Names. `App.tsx` routes are JFlow's. Drop `barcode-detector` |

**Mobileweb, in step 10.** Take shared files from **`jflow/web/`**, not `workflows/web/`,
exactly as `workflows/mobileweb` does from its own `web/`. Each shared file starts with one
of these headers:
- `// Copied verbatim from web/<path> @ <sha> — keep in sync by diffing against web/.`
- `// Adapted from web/<path> @ <sha> — <changes>. Keep in sync by diffing against web/.`

| Source | JFlow `mobileweb/` | Changes / notes |
|---|---|---|
| `jflow/web/src/auth/sharedSession.ts` | same | "Copied verbatim" header line, then a byte-identical body (as workflows) |
| `jflow/web/src/app/useQuery.ts`, `components/ui.tsx`, `components/ErrorBoundary.tsx`, `lib/tone.ts`, `styles/tokens.css`, `styles/base.css` | same | Copied verbatim |
| `jflow/web/src/config/env.ts`, `api/client.ts`, `app/auth.tsx`, `app/session.tsx`, `api/index.ts`, `api/types.ts`, `screens/SignInScreen.tsx` | same | Adapted. Set the host to `mjflow`. `signOut` drops the SW API cache (see `workflows/mobileweb/src/app/auth.tsx`) |
| `workflows/mobileweb/vite.config.ts`, `vercel.json`, `index.html`, `package.json`, `tsconfig.json`, `public/favicon.svg`, `public/icons/*` | same | PWA files with no web twin, so use the workflows header. Keep the `api-get` NetworkFirst route and drop the media CacheFirst routes. Use JFlow's name and icons |
| `workflows/mobileweb/src/app/swRoutes.ts`, `serviceWorker.ts`, `useOnline.ts`, `useKeyboardInset.ts`, `src/lib/viewport.ts`, `src/styles/mobile.css` | same | Names only. `mobile.css` replaces `shell.css` |

**Reference only, not copied**
- `api/src/db/migrations/2026-08-17_workflows_core.sql`: the DDL for `*_schema_meta`,
  `allowed_emails` and `audit_log`.
- `api/src/db/migrations/2026-09-08_stages.sql`: the `information_schema` guard for later
  ALTERs.
- `api/test/e2e/lifecycle.test.js`: the per-run schema pattern. `beforeAll` runs
  `CREATE DATABASE`, then sets `DB_NAME` before requiring the handler. `afterAll` drops the
  schema.
- `api/src/services/jfpro.js`: the model for Phase 2's `services/shipping.js`.

## Never
- Run DDL from the Lambda. Migrations run through `tools/migrate.js` only.
- Edit `web/src/auth/sharedSession.ts`.
- Use floats for money.
- Put engine rules in a client. Flags, `editable` and `derivedStatus` come from the server.
- Add a state library. Use `useQuery` with replace-from-response, plus `ScenarioContext`.
- Add foreign keys.
- Take a lock out of the standing order: scenarios (asc id) → schedules (asc id) →
  cash_items (asc id) → overrides. Every writer of an instance locks the parent
  `schedules` row before any override row.
- Run a plain `serverless deploy`. Use only `bash deploy.sh test|prod`, and only Dev runs it.
- Commit, print or echo `.env`.

## Environment
- Windows host. Run npm, jest and serverless in `api/`. Run `deploy.sh` from Git Bash only.
- Stage name = environment name, and there is no default stage.
  - `dev` is local only (`npm run dev` on `api/.env`, e.g. `PORT=5000`).
  - `test` and `prod` are the deployed stacks, each with its own secret.
- The DB is the shared **explorer-test**, schema `jflow`. Dev and test are the same
  database, so local `npm run migrate` serves both. Prod is migrated separately.
- `bash deploy.sh <stage>` migrates first, then deploys, using the **global** serverless v3
  CLI, because `npm prune --production` removes the devDependency copy mid-deploy.
- Frontends deploy through Vercel (project roots `web` and `mobileweb`), never through bash.
- E2E runs against a per-run `jflow_test_<runid>` schema that the suite creates and drops.

## Model and effort per step
Dev's instruction: use Opus 5.5 throughout and turn the effort dial per step.
| Steps | Model / effort |
|---|---|
| 0 | Fable 5.1 (`/model best`, which resolves to Fable where available, else Opus). CONTRACT.md is where extra reasoning pays for itself |
| 1, 2, 8, 10 (copy-heavy) | Opus 5.5, default effort (`medium`) |
| 5, 6, 7 (split transaction, engine, apply) | Opus 5.5, `/effort xhigh` |
| All other steps | Opus 5.5, default effort |
- Never use `max`. It has diminishing returns, tends to overthink, and scored below `xhigh`
  on agentic coding benchmarks at a higher cost.
- Fable 5.1 costs $10/M input and $50/M output tokens (Opus 5.5 is $4/$20). Beyond step 0,
  use it only as an escalation if Opus stalls on the step-6 engine tests.
