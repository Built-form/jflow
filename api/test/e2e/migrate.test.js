'use strict';

// tools/migrate.js over every src/db/migrations/*.sql, run as a child process against a
// per-run jflow_test_<runid> schema this suite creates and drops (CONTRACT §3.1, §3.5;
// step 19: "migrate twice → 0 applied").
//
//   1  a fresh schema: every file applies, no statement leans on the runner's
//      "already done" tolerance, and the schema holds 17 tables;
//   2  the same again: 0 applied, every file already recorded;
//   3  schema_migrations emptied, so every statement replays against a fully migrated
//      schema: still no tolerance used, and every seed row still exists exactly once.
//
// The runner reads DB credentials from api/.env itself (dotenv); only DB_NAME is
// overridden. Its output is parsed for the summary line and never printed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const mysql = require('mysql2/promise');

jest.setTimeout(180000);

const API_DIR = path.join(__dirname, '..', '..');
const SCHEMA_RE = /^jflow_test_[a-z0-9]+$/;
const FILES = fs.readdirSync(path.join(API_DIR, 'src', 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();

let conn;
let schema;
let created = false;

beforeAll(async () => {
    schema = `jflow_test_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}m`;
    if (!SCHEMA_RE.test(schema)) throw new Error(`[e2e] refusing schema name ${schema}`);
    conn = await mysql.createConnection({
        host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false },
    });
    await conn.query(`CREATE DATABASE \`${schema}\` DEFAULT CHARACTER SET utf8mb4`);
    created = true;
});

afterAll(async () => {
    if (!conn) return;
    try {
        if (created && SCHEMA_RE.test(schema)) await conn.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    } finally {
        await conn.end();
    }
});

/** Run the migration CLI against the per-run schema → {applied, already, deferred, tolerated}. */
function migrate() {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(API_DIR, 'tools', 'migrate.js')], {
            cwd: API_DIR,
            env: { ...process.env, DB_NAME: schema, LOG_LEVEL: 'error' },
            timeout: 120000,
        }, (err, stdout) => {
            if (err) return reject(new Error(`migrate.js exited ${err.code}`));
            const m = /\[migrate\] done — (\d+) applied, (\d+) already recorded, (\d+) deferred\./.exec(stdout);
            if (!m) return reject(new Error('migrate.js printed no summary line'));
            resolve({
                applied: Number(m[1]),
                already: Number(m[2]),
                deferred: Number(m[3]),
                // The runner prints "⚠ … treated as already-done" when it swallows an error.
                tolerated: stdout.split('\n').filter((l) => l.includes('treated as already-done')).length,
            });
        });
    });
}

const one = async (sql, params = []) => (await conn.query(sql, params))[0];

describe('tools/migrate.js on a per-run schema', () => {
    test('the core file sorts first and the Phase 2 file after it', () => {
        expect(FILES.slice(0, 2)).toEqual(['2026-09-29_jflow_core.sql', '2026-09-29_jflow_ship.sql']);
    });

    test('first run: every file applies with no tolerated error; 17 tables', async () => {
        expect(await migrate()).toEqual({ applied: FILES.length, already: 0, deferred: 0, tolerated: 0 });
        const [{ n }] = await one('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [schema]);
        expect(Number(n)).toBe(17);
    });

    test('second run: 0 applied, every file already recorded', async () => {
        expect(await migrate()).toEqual({ applied: 0, already: FILES.length, deferred: 0, tolerated: 0 });
    });

    test('every statement replays cleanly over a migrated schema, and every seed row stays single', async () => {
        await conn.query(`DELETE FROM \`${schema}\`.schema_migrations`);
        expect(await migrate()).toEqual({ applied: FILES.length, already: 0, deferred: 0, tolerated: 0 });
        expect(await one(`SELECT code FROM \`${schema}\`.companies ORDER BY id`)).toEqual([{ code: 'JFA' }, { code: 'HW' }]);
        expect(await one(`SELECT name, system_key FROM \`${schema}\`.categories`))
            .toEqual([{ name: 'Stock payments', system_key: 'ship' }]);
        expect(await one(`SELECT source FROM \`${schema}\`.external_sync`)).toEqual([{ source: 'ship' }]);
        const cols = await one(
            `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND COLUMN_NAME IN ('shipping_company_id', 'system_key') ORDER BY TABLE_NAME, COLUMN_NAME`,
            [schema]
        );
        expect(cols).toEqual([
            { t: 'categories', c: 'system_key' },
            { t: 'companies', c: 'shipping_company_id' },
            { t: 'external_items', c: 'shipping_company_id' },
        ]);
        expect(await migrate()).toEqual({ applied: 0, already: FILES.length, deferred: 0, tolerated: 0 });
    });
});
