# JFlow

Cashflow forecasting for the business: record each account's cash at bank at the start
of the day, schedule one-off and recurring income and outgoings, tune individual recurring
instances as their dates approach, and try what-ifs as named scenarios. Per company, with a
combined GBP view (each account and item keeps its own currency; a hand-maintained FX
table converts).

Express on AWS Lambda (`nodejs22.x`, Serverless v3), MySQL 8 on the shared estate via the
RDS Proxy, Google sign-in. A sibling of Workflows: same structure, deploy, migration method
and serverless config.

## Sources of truth (read in this order)

1. `CLAUDE.md`: working rules, naming, what is copied from Workflows.
2. `docs/PLAN.md`: the spec.
3. `docs/BUILD_PLAN.md`: the build order, step by step.
4. `api/docs/CONTRACT.md`: schema, routes, error codes, engine, lock discipline.
5. `api/docs/PROGRESS.md`: what is built, and the current step.

## Layout

```
api/                  the API: run every npm / jest / serverless command from here
  src/handlers/jflow.js   one Express app, serverless-http export
  src/db/                 pool + transactions; migrations/*.sql
  src/lib/                shared helpers (and, later, the pure engine libraries)
  src/routes/             resource routers (from step 2)
  tools/                  migrate.js, put-secret.js, the jest reporter
  test/unit  test/e2e
web/                  Vite + React client (from step 8)
mobileweb/            the PWA (from step 10)
docs/                 PLAN.md, BUILD_PLAN.md
```

## Local development

```bash
cd api
npm install
# api/.env: copy api/.env.example and fill it in. Never commit, print or echo .env.
npm run migrate       # converge the local database (dev and test share it)
npm run dev           # http://localhost:<PORT>/api/v1/health
```

The local server bypasses sign-in (every request is `local@dev`) only when `NODE_ENV` is
`development` or `IS_OFFLINE` is set, and never inside Lambda.

## Scripts (from `api/`)

| Command | What |
|---|---|
| `npm run dev` | Local server on `api/.env` |
| `npm run lint` | ESLint |
| `npm run test:unit` | Unit tests, no database |
| `npm run test:e2e` | End-to-end suite against a per-run `jflow_test_<runid>` schema |
| `npm run migrate` | Migrate the `api/.env` database |
| `bash deploy.sh test\|prod` | The only deploy path: migrates the stage, then deploys. Git Bash, stage required, Dev only |

## Environments

`dev` is local only. `test` and `prod` are the deployed stages, and the stage name is the
environment name; each reads its own secret (`jflow/test`, `jflow/prod`, eu-north-1).
Deploys and stage migrations are Dev's: see `CLAUDE.md` before touching anything in AWS.
