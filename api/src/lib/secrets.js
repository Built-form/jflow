// Copied from workflows/api/src/lib/secrets.js — changes: `withTimeout` imported from `./timeout` (was `../services/events`); two comments no longer cite EventBridge, which JFlow does not use
'use strict';

// Runtime secret fetch — the deployed replacement for baking DB_PASSWORD into
// the CloudFormation template.
//
// Deploy-time resolution (`${ssm:/aws/reference/secretsmanager/...}` in
// serverless.yml) substitutes the SECRET VALUES into the template, which then
// persists them in plaintext in the deployment bucket, the CloudFormation
// stack (`cloudformation:GetTemplate`), the Lambda env config, and every
// workstation's .serverless/ folder — and rotating a value means redeploying.
// The non-secret config keys keep that path (they are config, not secrets, and
// some are needed at deploy time to build resources); DB_PASSWORD alone moves
// here: the template now carries only SECRET_ID, and the value is fetched once
// per container at the top of the first invocation. The VPC's existing NAT
// egress carries the call.
//
// Local dev and the test suites never enter this path: SECRET_ID is only set
// by serverless.yml, so `npm run dev` / jest keep reading .env via dotenv.

const log = require('./logger');
const { withTimeout } = require('./timeout');

let attempt = null;

/**
 * Overlay secret JSON onto process.env — ABSENT keys only. Anything the
 * template already set (the non-secret config) wins over the fetched copy, so
 * the two sources cannot fight; the keys this exists for (DB_PASSWORD) are
 * exactly the ones the template no longer carries. Empty values are skipped
 * for the same reason applyStageSecrets skips them in tools/migrate.js: an
 * empty string is a present value and would beat a meaningful fallback.
 */
function applySecretEnv(json) {
    const applied = [];
    for (const [key, value] of Object.entries(json || {})) {
        if (process.env[key] !== undefined) continue;
        if (value == null || String(value) === '') continue;
        process.env[key] = String(value);
        applied.push(key);
    }
    return applied;
}

/**
 * Fetch SECRET_ID once per container and overlay it. Memoized like
 * ensureSchema: concurrent invocations share one fetch, a failure clears the
 * latch so the next invocation retries, and a container that has it never
 * fetches again. No-op when SECRET_ID is unset (local dev, tests).
 */
function loadRuntimeSecrets() {
    if (!process.env.SECRET_ID) return Promise.resolve();
    if (attempt) return attempt;
    attempt = (async () => {
        const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
        // Bounded (lib/timeout.js): the Lambda has a 29s
        // budget, and a NAT/VPC misconfiguration should be a fast, loud 500
        // with a clear log line — not a gateway timeout on every cold start.
        const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-north-1' });
        const out = await withTimeout(
            client.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID })),
            5000,
            `Secrets Manager did not answer within 5s for ${process.env.SECRET_ID} — check the VPC's egress (NAT / endpoint)`
        );
        const applied = applySecretEnv(JSON.parse(out.SecretString || '{}'));
        log.info(`[secrets] loaded ${process.env.SECRET_ID} — applied ${applied.length} key(s): ${applied.join(', ') || '(none)'}`);
    })().catch((err) => {
        attempt = null;   // retry on the next invocation rather than latching a dead container
        log.error('[secrets] runtime fetch failed', { secretId: process.env.SECRET_ID, error: err.message });
        throw err;
    });
    return attempt;
}

module.exports = { loadRuntimeSecrets, applySecretEnv };
