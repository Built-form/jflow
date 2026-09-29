// Copied from workflows/api/src/handlers/workflows.js — changes: names (service `jflow`, log prefix, unhandledRejection guard symbol); JFlow's vocabularies and error codes in ENUMS (CONTRACT §6.1, §7); body limit 1mb (was 4mb) and its 413 message; two account types — dropped the reviewer flag everywhere (auth, /me, /users, the PUT /users/:email/reviewer route, requireReviewer), the manager tier (requireManager), `standardGate` and `adminGate`; `requireAdmin` now comes from lib/roles.js; dropped the s3 import and upload limits; every workflows feature-router mount replaced by the (empty) JFlow mount point
'use strict';

// ── JFlow authed API (jflowApi Lambda) ──────────────────────────────────────
// One Express app implementing CONTRACT §2 and §6: health/me/meta, users, audit,
// and (from step 2 onward) the reference data, items, schedules, forecast and
// scenarios routers.
//
// Conventions copied from Workflows' src/handlers/workflows.js (itself from
// DispatchLine's src/handlers/dispatch.js):
//   - one Express app per Lambda, internal routing, serverless-http export;
//   - JWT auth middleware (local dev short-circuits to local@dev; else the email
//     from the API Gateway JWT authorizer is checked against allowed_emails);
//   - a lazy `schemaReady` promise awaited at each route;
//   - withConnection for reads, ONE withTransaction per mutating request;
//   - every mutation writes audit_log via recordAudit, inside the transaction;
//   - lists return {data, page, limit, total}; audit returns {data, limit,
//     nextCursor}; refusals return {error, code, details?}.

const serverless = require('serverless-http');
// .env exists only in local dev (excluded from the Lambda package via
// package.patterns) — skip the filesystem probe in Lambda.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const { getPool, withConnection, withTransaction } = require('../db');
const { ensureSchema } = require('../lib/schema');
const { loadRuntimeSecrets } = require('../lib/secrets');
const log = require('../lib/logger');
const { recordAudit } = require('../lib/audit');
const {
    fail,
    serverError,
    keysetResponse,
    parseId,
    parseListParams,
    parseCap,
    normalizeEmail,
    isValidEmail,
    auditToJson,
} = require('../lib/shape');
// Account types (CONTRACT D5): standard | admin. The vocabulary and the admin
// gate live in src/lib/roles.js.
const { USER_TYPES, isAdmin, requireAdmin } = require('../lib/roles');

// ── App + middleware ────────────────────────────────────────────────────────
const app = express();

// Request id, FIRST — before the body parser and cors, or exactly the failures
// a caller most needs to quote (a 400 for malformed JSON, a 413 for an
// oversized body) go out with no id. Sources, most-specific first: a caller's
// own x-request-id (sanitised — it lands in log lines and a response header),
// API Gateway's per-request id (already on the event via serverless-http; the
// X-Ray trace id is deliberately NOT used — it is per-trace, so two requests
// in one trace would share it), else a fresh UUID.
app.use((req, res, next) => {
    const supplied = req.get('x-request-id');
    req.requestId = (supplied && supplied.replace(/[^\x20-\x7e]/g, '').slice(0, 128))
        || req.requestContext?.requestId
        || crypto.randomUUID();
    res.set('X-Request-Id', req.requestId);
    next();
});

// level 1 + threshold: big list JSON still shrinks ~5-8x, but gzip CPU stops
// being measurable on the response path.
app.use(compression({ level: 1, threshold: 4096 }));
app.use(cors({ exposedHeaders: ['X-User-Type', 'X-Request-Id'] }));
// 1mb (CONTRACT §2.1): JFlow has no uploads, and the largest body is a bulk
// balance entry.
app.use(express.json({ limit: '1mb' }));

// Is this a real deployed Lambda, and is this a developer's machine?
//
// Defined up here because BOTH schema convergence (below) and the auth bypass
// (further down) turn on it. AWS always sets AWS_LAMBDA_FUNCTION_NAME in a real
// function, so gating on NOT being in Lambda means a stray NODE_ENV=development
// in the function's environment cannot silently change deployed behaviour.
const IS_LAMBDA = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const IS_LOCAL = !IS_LAMBDA && Boolean(process.env.IS_OFFLINE || process.env.NODE_ENV === 'development');

// Schema convergence. Every route awaits `schemaReady` first.
//
// WHO CONVERGES THE SCHEMA depends on where this is running:
//
//   deployed  NOBODY, at runtime. deploy.sh runs tools/migrate.js against the
//             stage's database BEFORE it packages and uploads, so by the time
//             this code exists the schema is already correct. Schema changes
//             then happen once, deterministically, with a human watching a
//             command that fails loudly — instead of on whichever cold start
//             happens to go first.
//   local     lazily, on first request. A developer cloning this repo runs
//             `npm run dev` against an empty database and it works; the E2E
//             suite builds its per-run jflow_test_<runid> schema the same
//             way. Same code path, same ensureSchema.
//
// Workflows used to converge at MODULE INIT everywhere, which its first deploy
// showed to be wrong twice over: module init races the VPC ENI coming up, so
// the connect died with ETIMEDOUT, and the .catch that (correctly) stopped that
// rejection from killing the container also latched the promise as resolved
// forever — so the work never ran again.
//
// Kept as a thenable rather than a function so every `await schemaReady` call
// site across the routers stays a plain await. A failed local attempt clears
// its own latch, so the next request retries.
// getPool() is memoized and called LAZILY (inside requests), never at module
// scope: in Lambda the DB password arrives via loadRuntimeSecrets() at the
// top of the first invocation, and a pool built at require time would capture
// an empty password before the fetch had run.
let schemaAttempt = null;
const schemaReady = {
    then(onFulfilled, onRejected) {
        if (!schemaAttempt) {
            schemaAttempt = IS_LOCAL
                ? ensureSchema(getPool()).catch((err) => {
                    // Never rethrow: an unhandled rejection here is
                    // Runtime.ExitError. Clearing the latch is what makes the
                    // next request retry rather than inherit the failure.
                    log.error('[jflow] ensureSchema failed (will retry on the next request)', err);
                    schemaAttempt = null;
                })
                : Promise.resolve();
        }
        return schemaAttempt.then(onFulfilled, onRejected);
    },
};

// ── Enum vocabularies (for /meta/enums + validation) ───────────────────────
// Statuses and kinds are VARCHAR app-side (DispatchLine idiom), validated in
// code from ONE list per vocabulary (CONTRACT §2.4). When the module that
// ENFORCES a vocabulary lands (lib/classify.js, lib/recurrence.js, lib/keys.js,
// the routes), the list moves there and this block imports it — as Workflows
// imports its status machines from lib/transitions.js — so validator and
// /meta/enums cannot drift.
const DIRECTIONS = ['in', 'out'];
const ITEM_STATUSES = ['expected', 'part_paid', 'paid', 'skipped'];
// NULL on the row means 'expected' (CONTRACT §3.2, §3.4).
const OVERRIDE_STATUSES = ['expected', 'part_paid', 'paid', 'skipped'];
const SETTLE_MODES = ['auto', 'manual'];
const { FREQUENCIES, WEEKEND_RULES } = require('../lib/recurrence');
const SCHEDULE_STATUSES = ['active', 'ended'];
const SCENARIO_STATUSES = ['draft', 'applied', 'archived'];
const ADJUSTMENT_KINDS = ['adjust', 'exclude'];
const STALE_REASONS = ['BASE_CHANGED', 'TARGET_SETTLED', 'TARGET_MISSING', 'DATE_PASSED'];
const { DERIVED_STATUSES } = require('../lib/classify');
const BUCKETS = ['day', 'week', 'month'];
const INCLUDE_MODES = ['summary', 'grid'];
const { TARGET_KINDS } = require('../lib/keys');

// Every refusal code in CONTRACT §7, in the catalogue's order. Message-only
// refusals (400/401/404/413 and the allowlist 409s) carry no code.
const ERROR_CODES = [
    'ADMIN_REQUIRED', 'STALE_WRITE',
    // Reference data.
    'COMPANY_CODE_TAKEN', 'COMPANY_IN_USE', 'ACCOUNT_IN_USE', 'CATEGORY_IN_USE', 'FX_RATE_EXISTS',
    // Items, balances, payments.
    'ITEM_NOT_EDITABLE', 'BALANCE_DATE_IN_FUTURE', 'PAID_ON_IN_FUTURE', 'PAID_AMOUNT_INVALID',
    'REMAINDER_DATE_REQUIRED',
    // Keys, adjustments, forecast.
    'ITEM_KEY_INVALID', 'ADJUSTMENT_DATE_IN_PAST', 'FX_RATE_MISSING',
    // Schedules, overrides, split and end.
    'OVERRIDE_HAS_PAYMENT', 'SCHEDULE_STRUCTURE_LOCKED', 'SCHEDULE_HAS_PAYMENTS',
    'SCHEDULE_HAS_OVERRIDES', 'SCHEDULE_HAS_ADJUSTMENTS',
    // Scenarios.
    'SCENARIO_NOT_DRAFT', 'SCENARIO_STALE', 'TARGET_SETTLED', 'TARGET_MISSING',
];
// 200-body warnings (warnings[], scenario.warnings[], orphans[]) — never a refusal.
const WARNING_CODES = ['NO_ANCHOR', 'ORPHAN_OVERRIDE', 'STALE', 'ADJUSTMENT_OUT_OF_SCOPE'];

const ENUMS = {
    directions: DIRECTIONS,
    itemStatuses: ITEM_STATUSES,
    overrideStatuses: OVERRIDE_STATUSES,
    settleModes: SETTLE_MODES,
    frequencies: FREQUENCIES,
    weekendRules: WEEKEND_RULES,
    scheduleStatuses: SCHEDULE_STATUSES,
    scenarioStatuses: SCENARIO_STATUSES,
    adjustmentKinds: ADJUSTMENT_KINDS,
    staleReasons: STALE_REASONS,
    derivedStatuses: DERIVED_STATUSES,
    buckets: BUCKETS,
    includeModes: INCLUDE_MODES,
    targetKinds: TARGET_KINDS,
    userTypes: USER_TYPES,
    errorCodes: ERROR_CODES,
    warningCodes: WARNING_CODES,
};

// ── Auth ────────────────────────────────────────────────────────────────────
// The local-dev short-circuit must NEVER be reachable in the deployed Lambda.
// AWS always sets AWS_LAMBDA_FUNCTION_NAME in a real function, so the bypass is
// gated on NOT being in Lambda — a stray NODE_ENV=development in the function's
// environment then cannot silently disable all auth in production.

// Paths that skip the ALLOWLIST LOOKUP only. When deployed, /health still sits
// behind the gateway JWT authorizer — there is deliberately no unauthenticated
// route. This exists so a probe with a valid token still answers when the DB
// (which the allowlist lives in) is exactly what is down.
const AUTH_EXEMPT_PATHS = new Set(['/api/v1/health']);

// No allowlist cache. Every request is one indexed SELECT on allowed_emails, so
// adding, demoting or removing someone takes effect on their very next request
// on every container.

app.use(async (req, res, next) => {
    // Checked FIRST: a probe must not be gated behind a DB lookup.
    if (AUTH_EXEMPT_PATHS.has(req.path)) return next();
    if (IS_LOCAL) {
        req.userEmail = 'local@dev';
        // The type is read for real, so the admin-only /users routes can be
        // exercised locally and by the e2e suites by editing that one row. No
        // row yet (the seed has not run) is admin, so a cold local start is
        // never locked out of anything.
        let type = 'admin';
        try {
            await schemaReady;
            const [rows] = await withConnection((c) => c.query(
                'SELECT type FROM allowed_emails WHERE email = ?', [req.userEmail]
            ).then(([r]) => [r]));
            if (rows.length) type = rows[0].type || 'standard';
        } catch {
            // Unreachable DB: the route's own await surfaces it properly.
        }
        req.userType = type;
        res.set('X-User-Type', type);
        return next();
    }
    try {
        const claimed = req.requestContext?.authorizer?.jwt?.claims?.email;
        if (!claimed) return fail(res, 401, 'Unauthorized: no email in token.');
        const email = normalizeEmail(claimed);
        // On a cold start the allowlist may not exist yet — wait for the
        // schema rather than racing it for a pool slot.
        await schemaReady;
        let userType;
        const conn = await getPool().getConnection();
        try {
            const [rows] = await conn.query('SELECT type FROM allowed_emails WHERE email = ?', [email]);
            if (rows.length === 0) return fail(res, 401, 'Unauthorized: email not in allowlist.');
            userType = rows[0].type || 'standard';
        } finally {
            conn.release();
        }
        req.userEmail = email;
        req.userType = userType;
        res.set('X-User-Type', userType);
        next();
    } catch (err) {
        serverError(res, 'auth-middleware', err);
    }
});

// Internal tool — never cache.
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// Trust-the-team (CONTRACT D5): every route is open to every allowlisted
// account. User management is the one exception — each admin-only route calls
// requireAdmin (src/lib/roles.js) itself.

// ── Health / me / meta ──────────────────────────────────────────────────────

app.get('/api/v1/health', async (req, res) => {
    // Reports DB reachability without failing the probe on it: a 200 with
    // database:'down' tells a human more than a 503 with no detail.
    //
    // Awaiting schemaReady makes this a READINESS probe rather than a liveness
    // one: locally, schema convergence is lazy, so without this /health could
    // answer long before the tables (and the bootstrap admin seeding) exist.
    // It is also what the E2E suite waits on before its first request.
    // schemaReady never rejects — a failed attempt resolves and clears its own
    // latch — so this cannot turn a DB blip into a failed probe.
    let database = 'unknown';
    try {
        await schemaReady;
        await withConnection((c) => c.query('SELECT 1'));
        database = 'up';
    } catch (err) {
        database = 'down';
        log.warn('[health] database unreachable', err.message);
    }
    res.json({
        status: 'ok',
        service: 'jflow',
        stage: process.env.STAGE || (IS_LOCAL ? 'local' : 'unknown'),
        database,
        // False only if schema convergence has not completed — the signal an
        // orchestrator should gate traffic on.
        schema: database === 'up' ? 'ready' : 'pending',
        time: new Date().toISOString(),
    });
});

app.get('/api/v1/me', async (req, res) => {
    try {
        await schemaReady;
        let displayName = null;
        if (!IS_LOCAL) {
            const rows = await withConnection(async (c) => {
                const [r] = await c.query('SELECT display_name FROM allowed_emails WHERE email = ?', [req.userEmail]);
                return r;
            });
            displayName = rows[0] ? rows[0].display_name : null;
        }
        res.json({ email: req.userEmail, displayName, type: req.userType });
    } catch (err) {
        serverError(res, 'me', err);
    }
});

app.get('/api/v1/meta/enums', (req, res) => res.json(ENUMS));

// ── Users ───────────────────────────────────────────────────────────────────
//
// The LIST is open to everyone on the allowlist (the People page, and who
// entered what). POST/PATCH/DELETE are admin-only (CONTRACT D5, §2.10).

app.get('/api/v1/users', async (req, res) => {
    try {
        await schemaReady;
        // Bare array with a 500 ceiling; `?page=` is the escape hatch past it
        // (page 2 = rows 501-1000, same shape). A full page means "ask for the
        // next one".
        const limit = parseCap(req.query.limit);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const rows = await withConnection(async (c) => {
            const [r] = await c.query(
                'SELECT email, type, display_name, created_at FROM allowed_emails ORDER BY email ASC LIMIT ? OFFSET ?',
                [limit, (page - 1) * limit]
            );
            return r;
        });
        res.json(rows.map((u) => ({
            email: u.email, type: u.type, displayName: u.display_name, createdAt: u.created_at,
        })));
    } catch (err) {
        serverError(res, 'users-list', err);
    }
});

app.post('/api/v1/users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        await schemaReady;
        const email = normalizeEmail(req.body?.email);
        const type = String(req.body?.type || 'standard').trim();
        const displayName = req.body?.displayName == null ? null : String(req.body.displayName).trim();
        if (!email || !isValidEmail(email)) return fail(res, 400, 'A valid email is required.');
        if (!USER_TYPES.includes(type)) {
            return fail(res, 400, `type must be one of: ${USER_TYPES.join(', ')}.`);
        }
        const result = await withTransaction(async (conn) => {
            const [existing] = await conn.query('SELECT email FROM allowed_emails WHERE email = ?', [email]);
            if (existing.length) return { conflict: true };
            await conn.query(
                'INSERT INTO allowed_emails (email, type, display_name) VALUES (?, ?, ?)',
                [email, type, displayName]
            );
            // Email-keyed rows audit as entityId 0 with the email in the JSON —
            // never the email as entity_id (strict mode rejects it and
            // recordAudit swallows the failure silently, losing the row).
            await recordAudit(conn, {
                entityType: 'allowed_email', entityId: 0, action: 'create',
                before: null, after: { email, type, displayName }, userEmail: req.userEmail,
            });
            return { created: { email, type, displayName } };
        });
        if (result.conflict) return fail(res, 409, 'That email is already on the allowlist.');
        res.status(201).json(result.created);
    } catch (err) {
        serverError(res, 'users-create', err);
    }
});

/**
 * In-transaction last-admin guard, shared by BOTH admin-losing doors (PATCH
 * demotion and DELETE of an admin row). Per-request checks cannot see a
 * concurrent removal: two admins demoting (or deleting) EACH OTHER lock
 * different target rows and both commit — zero admins remain, repairable only
 * by hand-written SQL. Locking the whole admin set serialises concurrent
 * removals, so the second one sees the first's commit and refuses.
 */
async function wouldRemoveLastAdmin(conn, email) {
    const [admins] = await conn.query(
        "SELECT email FROM allowed_emails WHERE type = 'admin' FOR UPDATE"
    );
    return admins.every((a) => a.email === email);
}

app.patch('/api/v1/users/:email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        await schemaReady;
        const email = normalizeEmail(req.params.email);
        const hasType = req.body?.type !== undefined;
        const hasName = req.body?.displayName !== undefined;
        if (!hasType && !hasName) return fail(res, 400, 'Nothing to update: send type and/or displayName.');
        const type = hasType ? String(req.body.type).trim() : null;
        if (hasType && !USER_TYPES.includes(type)) {
            return fail(res, 400, `type must be one of: ${USER_TYPES.join(', ')}.`);
        }
        // Self-lockout guard: an admin may not demote themselves. Removing the
        // last admin by accident means nobody can manage the allowlist again
        // without a hand-written INSERT.
        if (hasType && email === req.userEmail && type !== 'admin') {
            return fail(res, 400, 'You cannot remove your own admin access.');
        }
        const result = await withTransaction(async (conn) => {
            const [rows] = await conn.query(
                'SELECT email, type, display_name FROM allowed_emails WHERE email = ? FOR UPDATE', [email]
            );
            if (!rows.length) return { notFound: true };
            const before = { email: rows[0].email, type: rows[0].type, displayName: rows[0].display_name };
            const after = {
                email,
                type: hasType ? type : before.type,
                displayName: hasName ? (req.body.displayName == null ? null : String(req.body.displayName).trim()) : before.displayName,
            };
            if (before.type === 'admin' && after.type !== 'admin'
                && await wouldRemoveLastAdmin(conn, email)) {
                return { lastAdmin: true };
            }
            await conn.query(
                'UPDATE allowed_emails SET type = ?, display_name = ? WHERE email = ?',
                [after.type, after.displayName, email]
            );
            await recordAudit(conn, {
                entityType: 'allowed_email', entityId: 0, action: 'update',
                before, after, userEmail: req.userEmail,
            });
            return { updated: { email, type: after.type, displayName: after.displayName } };
        });
        if (result.notFound) return fail(res, 404, 'That email is not on the allowlist.');
        if (result.lastAdmin) {
            return fail(res, 409, 'That is the last admin — promote someone else first.');
        }
        res.json(result.updated);
    } catch (err) {
        serverError(res, 'users-update', err);
    }
});

app.delete('/api/v1/users/:email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        await schemaReady;
        const email = normalizeEmail(req.params.email);
        if (email === req.userEmail) {
            return fail(res, 400, 'You cannot remove your own access.');
        }
        const result = await withTransaction(async (conn) => {
            const [rows] = await conn.query(
                'SELECT email, type, display_name FROM allowed_emails WHERE email = ? FOR UPDATE', [email]
            );
            if (!rows.length) return { notFound: true };
            const before = { email: rows[0].email, type: rows[0].type, displayName: rows[0].display_name };
            if (before.type === 'admin' && await wouldRemoveLastAdmin(conn, email)) {
                return { lastAdmin: true };
            }
            await conn.query('DELETE FROM allowed_emails WHERE email = ?', [email]);
            await recordAudit(conn, {
                entityType: 'allowed_email', entityId: 0, action: 'delete',
                before, after: null, userEmail: req.userEmail,
            });
            return { deleted: true };
        });
        if (result.notFound) return fail(res, 404, 'That email is not on the allowlist.');
        if (result.lastAdmin) {
            return fail(res, 409, 'That is the last admin — promote someone else first.');
        }
        res.status(204).end();
    } catch (err) {
        serverError(res, 'users-delete', err);
    }
});

// ── Audit (keyset paginated) ────────────────────────────────────────────────

app.get('/api/v1/audit', async (req, res) => {
    try {
        await schemaReady;
        // The allowed_email trail is the record of the ONE admin-only surface
        // (who promoted/demoted/removed whom, with before/after payloads).
        // Reading it is therefore admin-only too — without this, any standard
        // user could enumerate the allowlist history that GET /users
        // deliberately does not expose. Every other entity type stays open:
        // trust-the-team. Both the filtered 403 and the unfiltered exclusion
        // key off this one name.
        const ADMIN_ONLY_ENTITY = 'allowed_email';
        if (String(req.query.entityType || '') === ADMIN_ONLY_ENTITY && !requireAdmin(req, res)) return;
        const { limit } = parseListParams(req.query);
        const where = [];
        const params = [];
        // ...and an UNFILTERED read must not leak them in passing either.
        if (!isAdmin(req.userType)) { where.push('entity_type <> ?'); params.push(ADMIN_ONLY_ENTITY); }
        if (req.query.entityType) { where.push('entity_type = ?'); params.push(String(req.query.entityType)); }
        if (req.query.entityId !== undefined) {
            const id = Number(req.query.entityId);
            if (!Number.isInteger(id) || id < 0) return fail(res, 400, 'entityId must be a non-negative integer.');
            where.push('entity_id = ?'); params.push(id);
        }
        if (req.query.action) { where.push('action = ?'); params.push(String(req.query.action)); }
        if (req.query.userEmail) { where.push('user_email = ?'); params.push(normalizeEmail(req.query.userEmail)); }
        if (req.query.cursor !== undefined) {
            const cursor = parseId(req.query.cursor);
            if (!cursor) return fail(res, 400, 'cursor must be a positive integer id.');
            where.push('id < ?'); params.push(cursor);
        }
        const sql = `SELECT id, entity_type, entity_id, action, before_json, after_json, reason, user_email, created_at
                       FROM audit_log
                      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                      ORDER BY id DESC
                      LIMIT ?`;
        const rows = await withConnection(async (c) => {
            const [r] = await c.query(sql, [...params, limit]);
            return r;
        });
        res.json(keysetResponse(rows.map(auditToJson), limit));
    } catch (err) {
        serverError(res, 'audit-list', err);
    }
});

// ── Feature routers ─────────────────────────────────────────────────────────
// MOUNT POINT for JFlow's resource routers (BUILD_PLAN steps 2+, CONTRACT §12).
// Mounted after the shared routes above and before the 404 fallback. Each
// factory receives schemaReady plus the shared refusal helpers:
//
//   app.use('/api/v1', require('../routes/companies')({ schemaReady, fail, serverError }));
//
// Two more deps ride along:
//   todayFor(req)  CONTRACT §2.5 / D24 — the Europe/London date, which a route
//                  calls ONCE per request and passes down. `?today=YYYY-MM-DD`
//                  overrides it only locally or under test (a malformed one is a
//                  400 there); anywhere else it is ignored. Kept here because
//                  IS_LOCAL is decided here.
//   enums          the vocabularies above, so validators and /meta/enums share
//                  one list per vocabulary.
//
// Step 2: companies, accounts, categories, fxRates, balances.
// Steps 4-7: items, schedules (instances, split, end), forecast, scenarios.
const { isValidDate, londonToday } = require('../lib/dates');
const { apiError } = require('../lib/shape');

function todayFor(req) {
    const override = req.query ? req.query.today : undefined;
    if (override !== undefined && (IS_LOCAL || process.env.NODE_ENV === 'test')) {
        if (!isValidDate(override)) throw apiError(400, undefined, 'today must be a real date, YYYY-MM-DD.');
        return override;
    }
    return londonToday();
}

const routerDeps = { schemaReady, fail, serverError, todayFor, enums: ENUMS };
app.use('/api/v1', require('../routes/companies')(routerDeps));
app.use('/api/v1', require('../routes/accounts')(routerDeps));
app.use('/api/v1', require('../routes/categories')(routerDeps));
app.use('/api/v1', require('../routes/fxRates')(routerDeps));
app.use('/api/v1', require('../routes/balances')(routerDeps));
app.use('/api/v1', require('../routes/items')(routerDeps));
app.use('/api/v1', require('../routes/schedules')(routerDeps));
app.use('/api/v1', require('../routes/forecast')(routerDeps));
app.use('/api/v1', require('../routes/scenarios')(routerDeps));

// ── Fallbacks ───────────────────────────────────────────────────────────────

app.use((req, res) => fail(res, 404, `No route for ${req.method} ${req.path}.`));

// Four-arg signature: Express only treats this as an error handler with it.
// Catches body-parser failures (malformed JSON, payload too large) that never
// reach a route.
app.use((err, req, res, _next) => {
    if (err && err.type === 'entity.too.large') {
        return fail(res, 413, 'Request body too large (limit 1mb).');
    }
    if (err && err.type === 'entity.parse.failed') {
        return fail(res, 400, 'Request body is not valid JSON.');
    }
    serverError(res, 'unhandled', err);
});

// ── Lambda export ───────────────────────────────────────────────────────────
// `app` is exported separately so supertest can mount it directly, without the
// serverless-http wrapper (the E2E suite depends on this).
const handler = serverless(app, {
    request(request, event) {
        // serverless-http does not surface requestContext by default; the auth
        // middleware reads the JWT claims from it.
        request.requestContext = event.requestContext;
    },
});

async function lambdaHandler(event, context) {
    // The pool must survive between invocations; without this Lambda waits for
    // the event loop to drain and adds seconds to every response.
    context.callbackWaitsForEmptyEventLoop = false;
    // DB_PASSWORD arrives here, not in the template — must complete before the
    // first getPool() (which is lazy for exactly this reason). Memoized: one
    // fetch per container, shared by concurrent invocations.
    await loadRuntimeSecrets();
    return handler(event, context);
}

// A rejected promise with no handler kills the container. Registered once per
// process — the Symbol guard stops a re-require (or a test that loads the app
// twice) from stacking duplicate listeners.
const GUARD = Symbol.for('jflow.unhandledRejection');
if (!global[GUARD]) {
    global[GUARD] = true;
    process.on('unhandledRejection', (reason) => log.error('[unhandledRejection]', reason));
}

if (require.main === module) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => log.info(`[jflow] listening on http://localhost:${port} (local auth bypass: ${IS_LOCAL})`));
}

module.exports = { app, handler: lambdaHandler, ENUMS };
