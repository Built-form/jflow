'use strict';

// Shared e2e harness (BUILD_PLAN step 2; CLAUDE.md "E2E schema").
//
// The per-run schema pattern of workflows/api/test/e2e/lifecycle.test.js:
//   · every suite file gets its OWN schema, jflow_test_<runid>, created here and
//     dropped in stop() — no docker, and never a TRUNCATE of the shared
//     explorer-test data;
//   · the migration SQL is run into it statement by statement through
//     lib/sql.js splitStatements (as tools/migrate.js and ensureSchema do);
//   · DB_NAME is pointed at the schema BEFORE the handler is required, because
//     db/index.js builds its pool from the environment;
//   · NODE_ENV=development turns on the local auth bypass (local@dev, an admin
//     via BOOTSTRAP_ADMIN_EMAILS), which also lets `?today=` pin the date.
//
// The only DROP anywhere in the suite is in stop(), and it refuses any name that
// is not jflow_test_<runid> and any schema this harness did not create.
//
// DB credentials come from api/.env through dotenv; nothing here reads or prints
// the file itself.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const request = require('supertest');
const { splitStatements } = require('../../src/lib/sql');

const SCHEMA_RE = /^jflow_test_[a-z0-9]+$/;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

const runIdOf = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * Create jflow_test_<runid>, migrate it, and load the app against it.
 * Call once per suite file in beforeAll, and `stop()` in afterAll.
 */
async function startHarness() {
    const runId = runIdOf();
    const schema = `jflow_test_${runId}`;
    if (!SCHEMA_RE.test(schema)) throw new Error(`[e2e] refusing schema name ${schema}`);

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: { rejectUnauthorized: false },
        dateStrings: ['DATE'],
        timezone: 'Z',
    });
    let created = false;
    const drop = async () => {
        if (created && SCHEMA_RE.test(schema)) await conn.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    };
    try {
        await conn.query(`CREATE DATABASE \`${schema}\` DEFAULT CHARACTER SET utf8mb4`);
        created = true;
        await conn.query(`USE \`${schema}\``);
        const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
        for (const file of files) {
            for (const stmt of splitStatements(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))) {
                await conn.query(stmt);
            }
        }
    } catch (err) {
        await drop();
        await conn.end();
        throw err;
    }

    process.env.DB_NAME = schema;
    process.env.NODE_ENV = 'development';           // local auth bypass → local@dev
    process.env.BOOTSTRAP_ADMIN_EMAILS = 'local@dev';
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.STAGE;

    const { app } = require('../../src/handlers/jflow');
    const db = require('../../src/db');
    // The first request converges the schema (ensureSchema, idempotent over the
    // migration just run) and seeds local@dev as admin.
    const health = await request(app).get('/api/v1/health');
    if (health.status !== 200 || health.body.database !== 'up') {
        await db.closePool();
        await drop();
        await conn.end();
        throw new Error(`[e2e] app did not come up against ${schema}: ${health.status} ${JSON.stringify(health.body)}`);
    }

    return {
        runId,
        schema,
        app,
        api: () => request(app),
        /** Direct SQL in the per-run schema — for rows no step-2 route writes (items, schedules). */
        async sql(query, params = []) {
            const [rows] = await conn.query(query, params);
            return rows;
        },
        /** The audit trail of one row, newest first, through GET /audit. */
        async audit(entityType, entityId) {
            const res = await request(app).get('/api/v1/audit').query({ entityType, entityId });
            if (res.status !== 200) throw new Error(`[e2e] audit read failed: ${res.status}`);
            return res.body.data;
        },
        async stop() {
            try {
                await db.closePool();
            } finally {
                await drop();
                await conn.end();
            }
        },
    };
}

/** Minimal live rows for the *_IN_USE guards (no item/schedule routes until steps 4-5). */
async function insertItem(h, { accountId, categoryId, status = 'expected', dueDate = '2026-01-10', deleted = false }) {
    const res = await h.sql(
        `INSERT INTO cash_items (account_id, category_id, direction, name, amount, currency, due_date, status, deleted_at)
         VALUES (?, ?, 'out', 'e2e item', '10.00', 'GBP', ?, ?, ${deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
        [accountId, categoryId, dueDate, status]
    );
    return res.insertId;
}

async function insertSchedule(h, { accountId, categoryId, deleted = false }) {
    const res = await h.sql(
        `INSERT INTO schedules (account_id, category_id, direction, name, amount, currency, frequency, start_date, deleted_at)
         VALUES (?, ?, 'out', 'e2e schedule', '10.00', 'GBP', 'monthly', '2026-01-01', ${deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
        [accountId, categoryId]
    );
    return res.insertId;
}

module.exports = { startHarness, insertItem, insertSchedule };
