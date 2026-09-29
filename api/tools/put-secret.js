#!/usr/bin/env node
// Copied from workflows/api/tools/put-secret.js — changes: secret `jflow/<stage>` (and the temp-file prefix and secret description); OPTIONAL_DEPLOY_KEYS is `DB_PROXY_HOST` plus Phase 2's `SHIPPING_DB_SCHEMA` (in place of JFPRO_API_BASE / JFPRO_API_KEY and their 503 hint); dropped the UPLOADS_* omission note and log line; header comment trimmed to JFlow's keys; CONTRACT section reference §4 → §2.10
'use strict';

// Creates or updates the Secrets Manager secret for a DEPLOYED stage, from the
// values in api/.env.
//
//   node tools/put-secret.js test
//   node tools/put-secret.js prod --from .env.prod
//
// Why a script rather than a hand-typed `aws secretsmanager put-secret-value`:
//   · the password never appears on a command line (visible in shell history, and
//     in the command line of a running process) and is never echoed here. It is
//     handed over as a short-lived 0600 temp file that is deleted in a finally,
//     because `--secret-string` is otherwise an argv entry. stdin would be
//     tidier, but the AWS CLI reads it as file:///dev/stdin, which does not exist
//     on Windows — and this is a Windows shop;
//   · only the SIX deploy keys (plus the optional keys below, when set) are copied. .env
//     also carries local-only keys (PORT, LOG_LEVEL, NODE_ENV). NODE_ENV in
//     particular must never reach a deployed environment;
//   · it is idempotent: create when absent, put-secret-value when it exists.
//
// Needs secretsmanager:GetSecretValue + CreateSecret/PutSecretValue.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REGION = 'eu-north-1';
const DEPLOYED_STAGES = ['test', 'prod'];

// Exactly what serverless.yml's provider.environment reads off custom.secrets.
// REQUIRED: absent or empty is a hard error — the deploy would be broken anyway.
const DEPLOY_KEYS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'BOOTSTRAP_ADMIN_EMAILS'];

// OPTIONAL: copied when set, OMITTED when not. They must be omitted rather than
// written as '' — serverless.yml gives each a `, ''` fallback, and the gotcha
// documented there is that an empty string is a PRESENT value that beats the
// fallback. Writing '' would pin the key to empty instead of leaving it unset.
//
// DB_PROXY_HOST is what makes the deployed Lambda connect through the RDS Proxy
// (serverless.yml: DB_HOST: ${self:custom.secrets.DB_PROXY_HOST, self:custom.secrets.DB_HOST}).
// prod sets it; test omits it (the explorer-test replica has no proxy). It must
// be OMITTED, not '', when unset — same fallback-chain gotcha as above.
// migrate.js always uses the direct DB_HOST regardless, so both keys are needed.
//
// SHIPPING_DB_SCHEMA (Phase 2, CONTRACT §2.1) names shipping's schema on the same DB
// instance, which src/services/shippingSource.js reads READ ONLY with this stage's own
// DB user. Absent means `jfa`, which is right for test and prod; set it only to point
// elsewhere. The DB user needs SELECT on that schema — nothing else.
const OPTIONAL_DEPLOY_KEYS = ['DB_PROXY_HOST', 'SHIPPING_DB_SCHEMA'];

const argv = process.argv.slice(2);
const stage = argv[0];
const fromIdx = argv.indexOf('--from');
const envFile = fromIdx === -1 ? '.env' : argv[fromIdx + 1];

if (!DEPLOYED_STAGES.includes(stage)) {
    console.error(`usage: node tools/put-secret.js <${DEPLOYED_STAGES.join('|')}> [--from .env]`);
    if (stage === 'dev') console.error('"dev" is the LOCAL environment — it has no secret, it reads api/.env directly.');
    process.exit(1);
}

const envPath = path.join(__dirname, '..', envFile);
if (!fs.existsSync(envPath)) {
    console.error(`[secret] ${envFile} not found at ${envPath}`);
    process.exit(1);
}
require('dotenv').config({ path: envPath });

const payload = {};
const missing = [];
for (const key of DEPLOY_KEYS) {
    const val = process.env[key];
    if (val == null || String(val).trim() === '') missing.push(key);
    else payload[key] = String(val);
}

const skipped = [];
for (const key of OPTIONAL_DEPLOY_KEYS) {
    const val = process.env[key];
    if (val == null || String(val).trim() === '') skipped.push(key);
    else payload[key] = String(val);
}

// BOOTSTRAP_ADMIN_EMAILS is not optional. A deployed stage starts with an EMPTY
// allowed_emails table, and every route re-checks the caller against it — with
// no bootstrap admin nobody can get in, and nobody can add themselves either.
// That is the bootstrap deadlock CONTRACT §2.10 guards against, and the only fix once
// deployed is a hand-written INSERT against the database.
if (missing.length) {
    console.error(`[secret] ${envFile} is missing: ${missing.join(', ')}`);
    if (missing.includes('BOOTSTRAP_ADMIN_EMAILS')) {
        console.error('[secret] BOOTSTRAP_ADMIN_EMAILS is REQUIRED — without it the deployed');
        console.error('[secret] API locks everyone out of an empty allowed_emails table.');
        console.error('[secret] Add it to .env, or pass it inline:');
        console.error(`[secret]   BOOTSTRAP_ADMIN_EMAILS=you@built-form.co.uk node tools/put-secret.js ${stage}`);
    }
    process.exit(1);
}

// Say what was left out, by name. A silently-omitted key looks identical to a
// key that was written — and the symptom is a long way from the cause.
if (skipped.length) {
    console.log(`[secret] optional key(s) not in ${envFile}, omitted: ${skipped.join(', ')}`);
}

const secretId = `jflow/${stage}`;
const body = JSON.stringify(payload);

// Windows: an aws CLI installed as a .cmd shim is not directly spawnable.
function aws(args) {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    try {
        return execFileSync('aws', args, opts);
    } catch (err) {
        if (err.code === 'ENOENT' && process.platform === 'win32') {
            return execFileSync('aws', args, { ...opts, shell: true });
        }
        throw err;
    }
}

let exists = true;
try {
    aws(['secretsmanager', 'describe-secret', '--secret-id', secretId, '--region', REGION]);
} catch (err) {
    const detail = (err.stderr || '').toString();
    if (!/ResourceNotFoundException/.test(detail)) {
        console.error(`[secret] could not check ${secretId}: ${detail.trim() || err.message}`);
        process.exit(1);
    }
    exists = false;
}

if (stage === 'prod' && !exists) {
    console.log('[secret] about to CREATE the PRODUCTION secret. Ctrl-C within 5s to abort.');
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
}

// The value is passed as file://<tmp>, never as a literal argv entry: an
// argument is visible to anyone who can list processes, and on Windows the aws
// CLI is a .cmd shim so the call goes through cmd.exe as well.
//
// Forward slashes even on Windows — the CLI parses file:// as a URL, and a
// backslash path silently becomes a relative filename.
const tmpFile = path.join(os.tmpdir(), `jflow-secret-${crypto.randomBytes(8).toString('hex')}.json`);
const fileArg = `file://${tmpFile.split(path.sep).join("/")}`;

try {
    fs.writeFileSync(tmpFile, body, { mode: 0o600 });
    if (exists) {
        aws(['secretsmanager', 'put-secret-value', '--secret-id', secretId,
             '--region', REGION, '--secret-string', fileArg]);
        console.log(`[secret] UPDATED ${secretId} (${REGION})`);
    } else {
        aws(['secretsmanager', 'create-secret', '--name', secretId, '--region', REGION,
             '--description', `JFlow API - ${stage} stage deploy config`,
             '--secret-string', fileArg]);
        console.log(`[secret] CREATED ${secretId} (${REGION})`);
    }
} catch (err) {
    console.error(`[secret] failed: ${(err.stderr || '').toString().trim() || err.message}`);
    process.exitCode = 1;
} finally {
    // Must run on every path, including the failure above — a credentials file
    // left in the temp directory is exactly what this was avoiding.
    try { fs.unlinkSync(tmpFile); } catch { /* never written */ }
}
if (process.exitCode) process.exit(process.exitCode);

// Keys only, never values.
console.log(`[secret] keys written: ${Object.keys(payload).join(', ')}`);
console.log(`[secret] verify with: npx serverless print --stage ${stage}`);
