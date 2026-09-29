#!/bin/bash
# Copied from workflows/api/deploy.sh — changes: names (Workflows → JFlow), secret `jflow/<stage>`; dropped the sharp Linux-build block (`==> Installing sharp's Linux x64…`, `npm install --os=linux …`) and the uploads-bucket wording
# Deploys JFlow to AWS via the serverless framework. Copied from DispatchLine
# (via Workflows) verbatim apart from the names — the EMFILE workaround below is
# the whole point of the file and must not drift from the sibling services.
#
# Why this script exists: on Windows, packaging the full node_modules tree
# (especially @aws-sdk) blows past the OS file-handle limit and
# `serverless deploy` bails with EMFILE: too many open files. Pruning to
# production-only deps trims the working set enough to fit, then we restore
# devDeps so local tooling keeps working.
#
# graceful-fs is preloaded via NODE_OPTIONS so fs.open calls queue instead of
# erroring with EMFILE — pruning alone wasn't enough on Node 24 + sls 3.40.
# It's installed into .deploy-tools/ so package.json and the project's own
# node_modules stay clean, and only during the deploy window.
#
# Usage:  bash deploy.sh test     -> the test stack
#         bash deploy.sh prod     -> PRODUCTION
#
# Runs the database migration for the stage FIRST, then deploys. `set -e` means
# a failed migration aborts before anything is packaged or uploaded.
#
# The stage is REQUIRED and there is no default: the stage name IS the
# environment name, and it picks the Secrets Manager secret (jflow/<stage>).
# "dev" is LOCAL ONLY (npm run dev) and is refused here. The deploying user
# needs secretsmanager:GetSecretValue.
set -e

STAGE="${1:-}"

case "$STAGE" in
    test|prod) ;;
    dev)
        echo "ERROR: 'dev' is the LOCAL environment (npm run dev) and is never deployed." >&2
        echo "       Use: bash deploy.sh test   or   bash deploy.sh prod" >&2
        exit 1
        ;;
    "")
        echo "ERROR: no stage given, and there is deliberately no default —" >&2
        echo "       a bare deploy must not be able to reach production." >&2
        echo "       Use: bash deploy.sh test   or   bash deploy.sh prod" >&2
        exit 1
        ;;
    *)
        echo "ERROR: unknown stage '$STAGE'. Use: test | prod" >&2
        exit 1
        ;;
esac

if [ "$STAGE" = "prod" ]; then
    echo "==> Deploying to PRODUCTION. Ctrl-C within 5s to abort."
    sleep 5
fi

# ── Schema first ─────────────────────────────────────────────────────────────
# BEFORE packaging, and before the prune, so a schema failure costs nothing and
# nothing ships against a database that cannot take it.
#
# The Lambda deliberately does NOT converge the schema at runtime. Workflows
# used to, at module init, and its first test deploy showed why that is wrong:
# the connect raced the VPC ENI coming up, failed with ETIMEDOUT, and the
# promise latched as resolved — so the bootstrap admin was never seeded and the
# stage came up with nobody able to log in. Schema changes belong here: once,
# deterministically, with a human watching a command that fails loudly.
#
# This reaches the database over the secret's DIRECT DB_HOST. That works from a
# workstation; the RDS Proxy endpoint would not, being VPC-private.
echo "==> Migrating the '$STAGE' database..."
node tools/migrate.js --stage "$STAGE"

# From the prune to the restore the tree is production-only, and `set -e`
# means any failure in between (the deploy itself included) used to abort the
# script with node_modules still pruned and .deploy-tools/ left behind — the
# next `npm test` then fails mysteriously. The trap restores on ANY exit;
# on success the explicit restore below has already run and the trap's
# `npm install` is a fast no-op.
restore_dev_tree() {
    echo "==> (exit trap) restoring dev dependencies..."
    rm -rf .deploy-tools
    npm install
}
trap restore_dev_tree EXIT

echo "==> Pruning dev dependencies..."
npm prune --production

# Install graceful-fs into an isolated dir. Running `npm install graceful-fs`
# in the project root re-syncs the *entire* package.json (devDeps included)
# regardless of --no-save, undoing the prune above. --prefix gives it its
# own node_modules so the project tree stays minimal.
echo "==> Installing graceful-fs into .deploy-tools/..."
rm -rf .deploy-tools
mkdir -p .deploy-tools
npm install --prefix .deploy-tools graceful-fs --no-save --no-package-lock --no-fund --no-audit

echo "==> Deploying stage '$STAGE' with graceful-fs preloaded..."
GFS_PATH="$(pwd -W 2>/dev/null || pwd)/.deploy-tools/node_modules/graceful-fs"
# Plain `serverless` (the global 3.40 CLI), not npx — the prune above removes
# the devDependency copy from node_modules, and npx would try to fetch it.
NODE_OPTIONS="--require $GFS_PATH" serverless deploy --stage "$STAGE"

echo "==> Cleaning up .deploy-tools/..."
rm -rf .deploy-tools

echo "==> Restoring dev dependencies..."
npm install

# The tree is restored; the trap's second run would just repeat the no-op.
trap - EXIT

echo "==> Done."
