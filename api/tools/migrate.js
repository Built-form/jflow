// Copied from workflows/api/tools/migrate.js — changes: secret `jflow/<stage>` (was `workflows/<stage>`), in the code and the header comment
'use strict';

// Idempotent migration runner — `npm run migrate`.
//
// Applies every src/db/migrations/*.sql in filename (chronological) order exactly
// once, tracked in a `schema_migrations` table. Safe to run on ANY database —
// brand new, or one already migrated by hand / by the app's ensureSchema() —
// because of two layers:
//
//   1. Tracking table: a file recorded in schema_migrations is never re-run, so
//      repeated `npm run migrate` calls are no-ops.
//   2. Per-statement tolerance: on the FIRST reconciling run the tracking table
//      is empty, so every historical file executes. Statements whose effect is
//      already present (column already added, already dropped, table exists) or
//      whose cross-schema dependency is absent (the jfpro view) are logged and
//      skipped instead of aborting — so an existing DB reconciles cleanly.
//
// Reads DB_* from the environment / .env, exactly like the app (src/db/index.js).
// No DELIMITER / stored-procedure support (the migrations don't use any).
//
// Stage-targeted runs — migrate a DEPLOYED environment's DB instead of .env's:
//
//   npm run migrate               .env / shell env (unchanged local behaviour)
//   npm run migrate:test          the test stack's DB
//   npm run migrate:prod          the prod stack's DB
//   node tools/migrate.js --stage test     (what the shortcuts expand to)
//
// `--stage` resolves the SAME Secrets Manager secret the deploy bakes into the
// Lambdas (jflow/<stage>, eu-north-1 — serverless.yml custom.secrets) and
// uses its DB_* values, overriding .env so the two can never mix. The stage name
// IS the environment name: only test and prod are deployed, and "dev" is the
// LOCAL environment, which is a plain `npm run migrate` against .env rather than
// a --stage at all. Fetched via the AWS CLI, so it needs the same
// secretsmanager:GetSecretValue as a deploy.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mysql = require('mysql2/promise');
// Shared with lib/schema.js so local convergence and deploy-time migration seed
// the allow-list identically — a second copy would drift.
const { seedAdminEmails } = require('../src/lib/schema');

// The only stages that exist as DEPLOYED environments, and therefore the only
// ones with a secret. "dev" is local (plain `npm run migrate` on .env) and is
// rejected rather than quietly mapped to something else — that mapping is the
// bug this list replaces.
const DEPLOYED_STAGES = ['test', 'prod'];
const SECRETS_REGION = 'eu-north-1';

// `--stage test` or `--stage=test`, else null (plain .env run).
function readStageArg(argv) {
    const i = argv.findIndex((a) => a === '--stage' || a.startsWith('--stage='));
    if (i === -1) return null;
    const val = argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
    if (!val || val.startsWith('--')) {
        console.error('[migrate] --stage needs a value: test | prod.');
        process.exit(1);
    }
    return val.trim();
}

// Overwrite process.env DB_* with the stage secret's values. Keys the secret
// doesn't carry are DELETED rather than left to fall back to .env — half prod
// credentials, half test is the one outcome this flag exists to prevent.
//
// Always the secret's direct DB_HOST, never DB_PROXY_HOST: the RDS Proxy
// endpoint is VPC-private and unreachable from a workstation (deployed Lambdas
// are the only thing that can use it).
function applyStageSecrets(stage) {
    if (!DEPLOYED_STAGES.includes(stage)) {
        console.error(`[migrate] unknown stage "${stage}" — deployed stages are ${DEPLOYED_STAGES.join(' | ')}.`);
        if (stage === 'dev') {
            console.error('[migrate] "dev" is the LOCAL environment: run `npm run migrate` with no --stage.');
        }
        process.exit(1);
    }
    const secretId = `jflow/${stage}`;
    const args = [
        'secretsmanager', 'get-secret-value',
        '--secret-id', secretId, '--region', SECRETS_REGION,
        '--query', 'SecretString', '--output', 'text',
    ];
    let raw;
    try {
        try {
            raw = execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            // Windows: a CLI installed as a .cmd/.bat shim isn't spawnable
            // directly — retry through the shell (fixed args, nothing user-supplied
            // beyond the validated stage name).
            if (err.code !== 'ENOENT' || process.platform !== 'win32') throw err;
            raw = execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true });
        }
    } catch (err) {
        const detail = (err.stderr || err.message || '').toString().trim();
        console.error(`[migrate] could not read secret ${secretId}: ${detail}`);
        console.error('[migrate] (needs the AWS CLI and secretsmanager:GetSecretValue — same as a deploy)');
        process.exit(1);
    }
    let secret;
    try {
        secret = JSON.parse(raw);
    } catch {
        console.error(`[migrate] secret ${secretId} is not the expected flat JSON object.`);
        process.exit(1);
    }
    for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT']) {
        const val = secret[key];
        if (val != null && String(val) !== '') process.env[key] = String(val);
        else delete process.env[key]; // no silent fallback to .env's values
    }
    console.log(`[migrate] stage ${stage} → ${secretId} → ${process.env.DB_HOST || '(secret has no DB_HOST!)'} / ${process.env.DB_NAME || '?'}`);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

// "Already in the desired state" — the statement is a no-op on this DB. Tolerate
// and keep going; the migration still counts as applied.
const ALREADY_DONE = new Set([
    1050, // ER_TABLE_EXISTS_ERROR      — CREATE TABLE, table already there
    1060, // ER_DUP_FIELDNAME           — ADD COLUMN already exists
    1061, // ER_DUP_KEYNAME             — ADD KEY/INDEX already exists
    1091, // ER_CANT_DROP_FIELD_OR_KEY  — DROP COLUMN/KEY that isn't there
]);

// Cross-schema dependency absent (e.g. the jfpro.* schema on a DispatchLine-only
// DB, which the v_product_info view reads). Tolerate, but DON'T record the file —
// so it retries on a later run once the dependency exists. The app reads the view
// best-effort and degrades to null meanwhile, so deferring is harmless.
const DEPENDENCY_MISSING = new Set([
    1049, // ER_BAD_DB_ERROR            — unknown database (jfpro absent)
    1146, // ER_NO_SUCH_TABLE           — referenced table absent
    1044, // ER_DBACCESS_DENIED_ERROR   — no access to the cross-schema DB
    1142, // ER_TABLEACCESS_DENIED_ERROR— no access to the cross-schema table
]);

// The splitter moved to src/lib/sql.js so this runner and src/lib/schema.js
// (ensureSchema) execute migration files through exactly ONE implementation —
// a divergence between them would mean the CLI and the Lambda disagree about
// what a migration file contains. Re-exported below for backwards compatibility.
const { splitStatements } = require('../src/lib/sql');

// Tiny dependency-free spinner. Animates ONLY on an interactive TTY; when output
// is piped / in CI (not a TTY) it degrades to plain one-line-per-event logging so
// migration logs stay clean. `log()` persists a permanent line above the live
// spinner (clears the spinner line, prints, then the next tick repaints below).
function makeSpinner() {
    const isTTY = Boolean(process.stdout.isTTY);
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let timer = null, i = 0, start = 0, text = '';

    function paint() {
        const s = Math.floor((Date.now() - start) / 1000);
        process.stdout.write(`\r\x1b[K${frames[i++ % frames.length]} ${text} (${s}s)`);
    }
    return {
        start(t) {
            if (timer) { clearInterval(timer); timer = null; } // never leak a prior timer
            text = t;
            i = 0;
            if (!isTTY) return;              // quiet until an end event in non-TTY
            start = Date.now();
            process.stdout.write('\x1b[?25l'); // hide cursor
            paint();
            timer = setInterval(paint, 90);
        },
        // Persist a line above the spinner (or just print it when non-TTY).
        log(line) {
            if (!isTTY) { console.log(line); return; }
            process.stdout.write(`\r\x1b[K${line}\n`); // spinner repaints on next tick
        },
        stop(finalLine) {
            if (timer) { clearInterval(timer); timer = null; }
            if (!isTTY) { if (finalLine) console.log(finalLine); return; }
            process.stdout.write(`\r\x1b[K${finalLine || ''}${finalLine ? '\n' : ''}\x1b[?25h`);
        },
    };
}

// One connection from the same DB_* environment the app reads. `database` is a
// parameter rather than inline because the bootstrap path in main() needs the
// identical credentials with NO database selected.
function connect(database) {
    return mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database,
        port: process.env.DB_PORT || 3306,
        ssl: { rejectUnauthorized: false },
        multipleStatements: false,
    });
}

async function main() {
    const stage = readStageArg(process.argv.slice(2));
    if (stage) applyStageSecrets(stage);

    // The same 5-second abort window deploy.sh gives a prod DEPLOY — DDL
    // against the production database is the more destructive of the two and
    // had no pause at all.
    if (stage === 'prod') {
        console.log('[migrate] target is PRODUCTION — ctrl-c within 5s to abort...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const spinner = makeSpinner();
    const missing = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter((k) => !process.env[k]);
    if (missing.length) {
        console.error(`[migrate] missing env: ${missing.join(', ')}. Set DB_* (see .env), same as the app.`);
        process.exit(1);
    }

    spinner.start(`connecting to ${process.env.DB_HOST}`);
    let conn;
    try {
        conn = await connect(process.env.DB_NAME);
    } catch (err) {
        // ER_BAD_DB_ERROR — the SERVER answered, the database just is not there
        // yet. A migration runner that can create every table but not the thing
        // that holds them is a gap: a brand-new environment dead-ends on a bare
        // "Unknown database" with no next step to take.
        //
        // Only on 1049, never pre-emptively: an unconditional CREATE DATABASE
        // IF NOT EXISTS would demand the privilege from every operator on every
        // database that is already fine, and prod's migration user should not
        // hold it. An existing database takes the identical path it always did.
        if (err.errno !== 1049) {
            spinner.stop();
            throw err;
        }
        const name = process.env.DB_NAME;
        // Interpolated into DDL — no placeholder can carry an identifier — so
        // the name is whitelisted rather than escaped. It comes from .env or
        // the stage secret rather than a caller, but "trusted source" is how
        // injection through config happens.
        if (!/^[A-Za-z0-9_$]+$/.test(name)) {
            spinner.stop();
            console.error(`[migrate] database "${name}" does not exist, and its name is not a plain identifier — refusing to CREATE it.`);
            process.exit(1);
        }
        spinner.log(`   · database "${name}" does not exist on ${process.env.DB_HOST} — creating it`);
        let admin;
        try {
            admin = await connect(undefined);   // same credentials, no database selected
            await admin.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        } catch (createErr) {
            spinner.stop();
            console.error(`[migrate] could not create database "${name}": ${createErr.code || ''} ${createErr.message}`);
            console.error('[migrate] (DB_USER needs the CREATE privilege, or a DBA must create the database by hand)');
            throw createErr;
        } finally {
            if (admin) await admin.end();
        }
        spinner.log(`   ✓ created database "${name}" — empty; the migrations below populate it`);
        try {
            conn = await connect(name);
        } catch (retryErr) {
            spinner.stop();
            throw retryErr;
        }
    }

    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
              filename   VARCHAR(255) NOT NULL PRIMARY KEY,
              applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Checksum column, added in place (guarded — 1060 means it is already
        // there). Editing an APPLIED migration file used to be a silent no-op;
        // PROGRESS records having to hand-delete a row to work around exactly
        // that. Now it is a loud refusal instead.
        try {
            await conn.query('ALTER TABLE schema_migrations ADD COLUMN checksum CHAR(64) NULL');
        } catch (err) {
            if (err.errno !== 1060) throw err;
        }

        const [doneRows] = await conn.query('SELECT filename, checksum FROM schema_migrations');
        const done = new Set(doneRows.map((r) => r.filename));
        const recordedChecksum = new Map(doneRows.map((r) => [r.filename, r.checksum]));
        // Checksums are computed over LF-normalized content: git's autocrlf
        // rewrites the working copy's line endings on Windows, and a checksum
        // that changes with the checkout would refuse files nobody edited.
        // Rows recorded from raw content before this change are upgraded in
        // the drift check below when the raw hash still matches.
        const sha256 = (text) => require('crypto').createHash('sha256')
            .update(String(text).replace(/\r\n/g, '\n')).digest('hex');
        const sha256raw = (text) => require('crypto').createHash('sha256').update(text).digest('hex');

        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith('.sql'))
            .sort(); // date-prefixed names sort chronologically

        // Apply one file: returns 'applied' or 'deferred' (dependency absent).
        // A hard error throws. Deferred files are NOT recorded so a later pass
        // (or run) can retry them.
        async function applyFile(file) {
            spinner.start(`applying ${file}`);
            const statements = splitStatements(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
            let depMissing = false;
            try {
                for (const stmt of statements) {
                    try {
                        await conn.query(stmt);
                    } catch (err) {
                        if (ALREADY_DONE.has(err.errno)) {
                            // LOUD, with the statement: "already in desired
                            // state" is an assumption, not a fact — an ADD
                            // COLUMN x VARCHAR(64) against an existing
                            // VARCHAR(16) also lands here, and recording it as
                            // applied is exactly how prod and test come to
                            // disagree silently. The operator gets what they
                            // need to eyeball the claim.
                            spinner.log(`   ⚠ ${file}: treated as already-done (${err.code}) — VERIFY the DB truly matches:\n     ${stmt.replace(/\s+/g, ' ').slice(0, 160)}`);
                        } else if (DEPENDENCY_MISSING.has(err.errno)) {
                            spinner.log(`   · ${file}: dependency absent (${err.code}) — deferring file`);
                            depMissing = true;
                        } else {
                            spinner.stop();
                            console.error(`[migrate] FAILED in ${file}:\n  ${stmt}\n  ${err.code || ''} ${err.message}`);
                            throw err;
                        }
                    }
                }
            } catch (err) {
                spinner.stop(); // ensure cursor is restored on a hard failure
                throw err;
            }
            if (depMissing) {
                spinner.stop(`~ deferred ${file}`);
                return 'deferred';
            }
            await conn.query(
                'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
                [file, sha256(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))]
            );
            spinner.stop(`✓ ${file}`);
            return 'applied';
        }

        // An APPLIED file whose content changed is refused loudly — a silent
        // no-op is how "I edited the migration" becomes "prod never got it".
        // Legit re-application means a NEW file, not an edit. Rows from before
        // the checksum column (checksum NULL) are backfilled instead of judged.
        for (const file of files) {
            if (!done.has(file)) continue;
            const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            const current = sha256(content);
            const recorded = recordedChecksum.get(file);
            if (recorded == null || recorded === sha256raw(content)) {
                // Backfill, or upgrade a pre-normalization row whose RAW hash
                // still matches (same bytes as when recorded — only the
                // recording scheme changed, not the file).
                if (recorded !== current) {
                    await conn.query('UPDATE schema_migrations SET checksum = ? WHERE filename = ?', [current, file]);
                }
            } else if (recorded !== current) {
                spinner.stop();
                console.error(
                    `[migrate] REFUSED: ${file} is recorded as applied but its content has CHANGED since.\n`
                    + '  An edit to an applied migration never reaches databases that already ran it.\n'
                    + '  Put the change in a NEW migration file instead.'
                );
                process.exit(1);
            }
        }

        // Multi-pass: a file whose dependency is another migration in THIS run
        // (e.g. the lane seed depends on the core table, but sorts before it
        // lexicographically) is deferred on the first pass and retried on the
        // next. Keep passing while any file makes progress, so a single
        // `npm run migrate` fully converges. Files whose dependency is a truly
        // absent external schema (jfpro) never make progress and stay deferred.
        let applied = 0, already = 0;
        let pending = files.filter((f) => (done.has(f) ? (already++, false) : true));
        let progress = true;
        while (pending.length && progress) {
            progress = false;
            const stillPending = [];
            for (const file of pending) {
                if (await applyFile(file) === 'applied') { applied++; progress = true; }
                else stillPending.push(file);
            }
            pending = stillPending;
        }
        const deferred = pending.length;
        if (deferred) {
            spinner.log(`~ ${deferred} file(s) deferred (external dependency absent — will retry next run): ${pending.join(', ')}`);
        }

        // Bootstrap the allow-list. This is NOT part of the DDL — it is
        // environment convergence, and it belongs to whoever converges the
        // environment. For a deployed stage that is now this script (deploy.sh
        // runs it before packaging), so if it did not happen here it would not
        // happen at all: the stage would come up with an empty allowed_emails,
        // 401 every caller, and offer no way in, because the only route that can
        // add an admin is itself admin-only.
        //
        // The first test deploy hit exactly that. Idempotent (INSERT IGNORE) and
        // it never demotes a row the /users routes have since changed.
        await seedAdminEmails(conn);

        spinner.stop(); // clear the "connecting"/last spinner if nothing was pending
        console.log(`[migrate] done — ${applied} applied, ${already} already recorded, ${deferred} deferred.`);
    } finally {
        await conn.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        if (process.stdout.isTTY) process.stdout.write('\r\x1b[K\x1b[?25h'); // restore cursor if a spinner was live
        console.error('[migrate] error:', err.message);
        process.exit(1);
    });
}

module.exports = { splitStatements };
