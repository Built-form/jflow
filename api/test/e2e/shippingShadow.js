'use strict';

// A per-run shadow of shipping's schema for the source's e2e suite
// (test/e2e/shipping-source.test.js): `jflow_test_<runid>_jfa`, one table for every table
// services/shippingSource.js reads, each with the REAL column shapes of `jfa` on this
// database — so the source's SQL is proven against shipping's actual tables, and a column
// shipping renames breaks this suite before it breaks the refresh.
//
// How the shapes are copied, and why not `CREATE TABLE … LIKE jfa.<t>`: every connection
// that reads jfa must be READ ONLY first, and a READ ONLY session refuses DDL (MySQL
// 1792, ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION — checked on explorer-test). So a READ
// ONLY connection reads each definition (`SHOW CREATE TABLE`; for the `suppliers` view,
// its columns from information_schema), and the harness's own connection — which never
// names jfa — replays it into the shadow schema, dropping foreign keys and AUTO_INCREMENT
// as LIKE does. The view becomes a table with the view's columns.
//
// The only DROP is `drop()`, and it refuses any name but jflow_test_<runid>_jfa and any
// schema this module did not create. Nothing here writes to jfa.

const { openSourceConnection } = require('../../src/services/shippingSource');
const { SOURCE_COLUMNS } = require('../../src/services/shippingReads');

const SHADOW_RE = /^jflow_test_[a-z0-9]+_jfa$/;
const REAL_SCHEMA = 'jfa';

/** A CREATE TABLE statement from SHOW CREATE TABLE, retargeted, without FKs or AUTO_INCREMENT. */
function retarget(createSql, schema, table) {
    const lines = createSql.split('\n').filter((l) => !/^\s*CONSTRAINT .* FOREIGN KEY /.test(l));
    // A dropped constraint may leave the previous line's trailing comma before ')'.
    for (let i = 0; i < lines.length - 1; i++) {
        if (/^\)/.test(lines[i + 1])) lines[i] = lines[i].replace(/,\s*$/, '');
    }
    return lines.join('\n')
        .replace(/^CREATE TABLE `[^`]+`/, `CREATE TABLE \`${schema}\`.\`${table}\``)
        .replace(/ AUTO_INCREMENT=\d+/, '');
}

/**
 * Create `<h.schema>_jfa` with every source table, and return helpers:
 *   schema             the shadow schema's name (point SHIPPING_DB_SCHEMA at it);
 *   insert(table, rows)  rows as objects; NOT NULL columns without a default that a row
 *                      leaves out are filled with a neutral value of their type;
 *   sql(query, params) on the harness connection (never names jfa);
 *   drop()             the only DROP.
 */
async function createShadow(h) {
    const schema = `${h.schema}_jfa`;
    if (!SHADOW_RE.test(schema)) throw new Error(`[e2e] refusing shadow schema name ${schema}`);

    // Read the real definitions on a READ ONLY connection.
    const definitions = [];
    const ro = await openSourceConnection();
    try {
        const [[types]] = await ro.query(
            `SELECT GROUP_CONCAT(CONCAT(TABLE_NAME, ':', TABLE_TYPE)) AS list FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)`,
            [REAL_SCHEMA, Object.keys(SOURCE_COLUMNS)]
        );
        const typeOf = Object.fromEntries(String(types.list || '').split(',').filter(Boolean).map((p) => p.split(':')));
        for (const table of Object.keys(SOURCE_COLUMNS)) {
            if (typeOf[table] === 'BASE TABLE') {
                const [[row]] = await ro.query(`SHOW CREATE TABLE \`${REAL_SCHEMA}\`.\`${table}\``);
                definitions.push(retarget(row['Create Table'], schema, table));
            } else if (typeOf[table] === 'VIEW') {
                const [cols] = await ro.query(
                    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS
                      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
                    [REAL_SCHEMA, table]
                );
                const body = cols.map((c) => `  \`${c.name}\` ${c.type}${c.nullable === 'NO' ? ' NOT NULL' : ' NULL'}`).join(',\n');
                definitions.push(`CREATE TABLE \`${schema}\`.\`${table}\` (\n${body}\n) DEFAULT CHARSET=utf8mb4`);
            } else {
                throw new Error(`[e2e] ${REAL_SCHEMA}.${table} is not readable here (${typeOf[table] || 'missing'})`);
            }
        }
    } finally {
        await ro.end();
    }

    let created = false;
    const drop = async () => {
        if (created && SHADOW_RE.test(schema)) await h.sql(`DROP DATABASE IF EXISTS \`${schema}\``);
        created = false;
    };
    try {
        await h.sql(`CREATE DATABASE \`${schema}\` DEFAULT CHARACTER SET utf8mb4`);
        created = true;
        for (const ddl of definitions) await h.sql(ddl);
    } catch (err) {
        await drop();
        throw err;
    }

    // The shadow's own NOT NULL, no-default columns, for insert()'s fill-ins.
    const required = new Map();
    const cols = await h.sql(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d, COLUMN_TYPE AS ct, EXTRA AS e
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL`,
        [schema]
    );
    for (const c of cols) {
        if (/auto_increment|GENERATED/i.test(c.e)) continue;
        if (!required.has(c.t)) required.set(c.t, []);
        required.get(c.t).push(c);
    }
    const neutral = (c) => {
        if (/int|decimal|float|double|bit/.test(c.d)) return 0;
        if (c.d === 'json') return '{}';
        if (c.d === 'date') return '2026-01-01';
        if (/datetime|timestamp/.test(c.d)) return '2026-01-01 00:00:00';
        if (c.d === 'enum') return /^enum\('([^']*)'/.exec(c.ct)[1];
        return '';
    };

    async function insert(table, rows) {
        for (const row of rows) {
            const full = { ...row };
            for (const c of required.get(table) || []) if (!(c.c in full)) full[c.c] = neutral(c);
            const keys = Object.keys(full);
            const values = keys.map((k) => {
                const v = full[k];
                return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
            });
            await h.sql(
                `INSERT INTO \`${schema}\`.\`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
                values
            );
        }
    }

    return {
        schema,
        insert,
        sql: (query, params) => h.sql(query, params),
        drop,
    };
}

module.exports = { SHADOW_RE, createShadow, retarget };
