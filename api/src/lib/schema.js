// Copied from workflows/api/src/lib/schema.js — changes: meta table `jflow_schema_meta` (was `workflows_schema_meta`); SCHEMA_VERSION restarted at '2026-09-29.1' (bumped per DDL change since); seedAdminEmails inserts (email, type) only — JFlow's allowed_emails has no is_reviewer column; comments say ensureSchema is local-dev only and cite CONTRACT §3.1 for the ALTER guard; names
'use strict';

// Single lazy-migration entry point for JFlow's LOCAL development. The handler
// calls ensureSchema(getPool()) into a `schemaReady` promise, and awaits that
// promise at the top of each route — but only when IS_LOCAL. The deployed
// Lambda never runs DDL (CONTRACT §3.1): `bash deploy.sh <stage>` runs
// tools/migrate.js first, and in Lambda `schemaReady` resolves at once.
// tools/migrate.js also imports seedAdminEmails from here.
//
// ONE DDL SOURCE, NOT TWO. DispatchLine's schema.js inlines every CREATE TABLE
// as a JS string array and carries a comment begging future editors to keep it
// in sync with the .sql files. Twenty-two tables in, that bargain does not hold —
// so this version READS src/db/migrations/*.sql and executes them. The migration
// files ship inside the Lambda package (nothing in serverless.yml's package
// patterns excludes src/), so the deployed function has them at cold start.
//
// Every statement in those files is idempotent — CREATE TABLE IF NOT EXISTS,
// or ALTERs guarded against information_schema (CONTRACT §3.1)
// — which is what makes running them on every cold start safe. If a migration is
// ever added that is NOT idempotent, it must not be executed from here —
// ensureSchema is a convergence mechanism, not a migration runner. `npm run
// migrate` (tools/) is the runner, and it is the one that tracks
// schema_migrations.
//
// The SCHEMA_VERSION sentinel means the full pass runs only when the deployed
// version string changes: every other cold start is one indexed SELECT.

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { splitStatements } = require('./sql');

// Bump whenever the DDL changes OR the admin seed must re-run (see
// seedAdminEmails). The value is opaque — date + counter is just convention.
// .2: Phase 2's 2026-09-29_jflow_ship.sql (a converged local schema at .1 would
// otherwise never replay it).
const SCHEMA_VERSION = '2026-09-29.2';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

let schemaReady = null;

/**
 * Converge the connected schema to SCHEMA_VERSION. Idempotent and safe to call
 * on every cold start; the returned promise is memoized per container.
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<void>}
 */
function ensureSchema(pool) {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
        const conn = await pool.getConnection();
        try {
            // Sentinel fast-path. Wrapped in its own try: on a fresh database the
            // meta table does not exist yet (ER_NO_SUCH_TABLE), which is not an
            // error — it is the signal to run the full pass, which creates it.
            try {
                const [rows] = await conn.query(
                    `SELECT v FROM jflow_schema_meta WHERE k = 'schema_version'`
                );
                if (rows[0] && rows[0].v === SCHEMA_VERSION) {
                    // The DDL is up to date, but the allow-list seeding is NOT
                    // part of "the schema" — see seedAdminEmails. It runs on
                    // every pass, including this fast one.
                    await seedAdminEmails(conn);
                    log.info(`[schema] up to date (sentinel ${SCHEMA_VERSION})`);
                    return;
                }
            } catch (err) {
                // ONLY a missing table means "fresh database, fall through".
                // Catching everything here turned a bad password, a revoked
                // grant or a dead connection into a silent full DDL pass whose
                // real failure surfaced later and elsewhere.
                if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
            }

            const files = fs.readdirSync(MIGRATIONS_DIR)
                .filter((f) => f.endsWith('.sql'))
                .sort();   // date-prefixed names sort chronologically
            if (!files.length) {
                throw new Error(`[schema] no .sql files in ${MIGRATIONS_DIR} — the Lambda package is missing src/db/migrations`);
            }

            let applied = 0;
            for (const file of files) {
                const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
                for (const stmt of splitStatements(sql)) {
                    await conn.query(stmt);
                    applied++;
                }
            }

            await seedAdminEmails(conn);
            await conn.query(
                `INSERT INTO jflow_schema_meta (k, v) VALUES ('schema_version', ?)
                 ON DUPLICATE KEY UPDATE v = VALUES(v)`,
                [SCHEMA_VERSION]
            );
            log.info(`[schema] ensureSchema complete — ${files.length} file(s), ${applied} statement(s), version ${SCHEMA_VERSION}`);
        } finally {
            conn.release();
        }
    })().catch((err) => {
        schemaReady = null; // allow a retry on the next request
        log.error('[schema] ensureSchema failed', err);
        throw err;
    });
    return schemaReady;
}

// Bootstrap the auth allow-list from BOOTSTRAP_ADMIN_EMAILS (comma-separated).
//
// This is load-bearing, not a convenience: JFlow owns its own schema, so
// allowed_emails starts EMPTY and the deployed API would 401 every caller —
// including whoever needs to call POST /users to fix it. There is no other door.
//
// INSERT IGNORE, so it never demotes or overwrites a row the /users routes have
// since changed. Day-to-day membership is the /users routes' job, not this
// function's.
//
// It runs on EVERY ensureSchema pass, including the sentinel fast-path. It used
// to run only on a full pass, which sounds harmless — the seeding is a
// first-boot concern, and the sentinel means the schema is already built — but
// Workflows' first test deploy walked straight into the hole: the test stage points at
// the SAME schema local development had already converged, so the sentinel was
// stamped, the fast path returned early, and the deployed environment came up
// with an allow-list containing no admin at all. Every caller 401s, and the only
// route that could add one is itself admin-only. That is the exact deadlock the
// seeding exists to prevent, reached because the seeding was treated as part of
// the DDL rather than as environment convergence.
//
// The cost of getting this wrong is a locked-out environment; the cost of
// running it every time is one INSERT IGNORE of a handful of rows per cold
// start. It also makes the obvious operator action work: put an email in the
// secret, redeploy, and it is there — no SCHEMA_VERSION bump required.
async function seedAdminEmails(conn) {
    const raw = process.env.BOOTSTRAP_ADMIN_EMAILS || '';
    const emails = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    await conn.query(
        // INSERT IGNORE never touches a row the People page has since changed.
        `INSERT IGNORE INTO allowed_emails (email, type) VALUES ${emails.map(() => '(?, \'admin\')').join(', ')}`,
        emails
    );
    log.info(`[schema] ensured ${emails.length} bootstrap admin email(s) in allowed_emails`);
}

// Test seam: drops the memoized promise so a suite can point ensureSchema at a
// second schema (the per-run E2E database) inside one process.
function _resetForTests() {
    schemaReady = null;
}

module.exports = { ensureSchema, seedAdminEmails, SCHEMA_VERSION, _resetForTests };
