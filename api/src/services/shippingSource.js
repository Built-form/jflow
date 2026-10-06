'use strict';

// Phase 2's source of stock payments (docs/PLAN.md "Phase 2", Dev 2026-09-29: "pull
// required shipping code into this repo rather than modify it; same DB, different
// schema"). JFlow reads shipping's own tables in SHIPPING_DB_SCHEMA (default `jfa`) on
// its own database instance, READ ONLY, runs the ported ShipLine payment math
// (lib/payments-flow) on them, and returns the feed body the shipping HTTP route would
// have: {meta, companies, items}. services/shipping.js validates it (validateFeed) and
// services/shippingRefresh.js snapshots it into external_items.
//
//   1  its own connection (JFlow's DB credentials, no default schema: every table is
//      schema-qualified), `SET SESSION TRANSACTION READ ONLY` before anything else,
//      checked with @@transaction_read_only — nothing on it can write;
//   2  the schema check: every column shippingReads.SOURCE_COLUMNS names must exist
//      (information_schema.COLUMNS, which also hides what the user cannot read) —
//      else unavailable('source_schema'), never a wrong number;
//   3  one read-only transaction WITH CONSISTENT SNAPSHOT for every read, so the
//      orders, balances and transfers agree with each other;
//   4  the connection is closed, then the model runs (pure, no clock: `today` is the
//      caller's Europe/London date), and the feed rows are built (P2 ids, P3 paid
//      rows split per PO), with the few POs a payment names that have no bundle
//      looked up inside the same snapshot.
//
// Any other failure — a DB error, a timeout, the model throwing — is
// unavailable('source_error'); the refresh keeps the last snapshot and /forecast warns
// SHIPPING_UNAVAILABLE. This is the only file that knows SHIPPING_DB_SCHEMA.
//
// Connection settings match shipping's pool as it runs on Lambda: `dateStrings:
// ['DATE']` and `timezone: 'Z'` (Lambda's local zone is UTC), so every DATETIME reads
// as the instant shipping's API would have sent. It is a dedicated connection, not
// the pool: a SET SESSION would otherwise ride back into the pool, and through the
// RDS Proxy it pins the connection (db/index.js); closing it takes both away.

const mysql = require('mysql2/promise');

const log = require('../lib/logger');
const { isValidDate } = require('../lib/dates');
const flowLib = require('../lib/payments-flow');
const page = require('../lib/shippingCopy/shiplinePage');
const reads = require('./shippingReads');
const shipping = require('./shipping');

const DEFAULT_SCHEMA = 'jfa';
const SCHEMA_RE = /^[a-z0-9_]{1,64}$/;
// The port's source of truth (PLAN.md "Phase 2"): re-synced when ShipLine's math changes.
// 2026-10-06: re-pinned from f9499bc to 77577a1 (tools/payments-flow-oracle.mjs SOURCE).
const MODEL = 'ShipLine 77577a1';
const CONNECT_TIMEOUT_MS = 5000;
// The whole read, connect to close. /forecast runs a due refresh before it answers
// (P4) inside the Lambda's 29 s, so a stuck read must give up well before that.
const SOURCE_TIMEOUT_MS = 15000;
const MISSING_SHOWN = 10;

/** SHIPPING_DB_SCHEMA as configured (trimmed; unset or blank → `jfa`). Read per call. */
function configuredSchema() {
    const raw = String(process.env.SHIPPING_DB_SCHEMA || '').trim();
    return raw || DEFAULT_SCHEMA;
}

/** The schema to read, or null when SHIPPING_DB_SCHEMA is not a valid name (^[a-z0-9_]{1,64}$). */
function sourceSchema() {
    const schema = configuredSchema();
    return SCHEMA_RE.test(schema) ? schema : null;
}

/** `schema`.`table` — both validated names, so backquoting is enough. */
const qualifier = (schema) => (table) => `\`${schema}\`.\`${table}\``;

/**
 * A new connection with JFlow's DB credentials and a READ ONLY session. Exported for
 * the test that proves a write on it fails; the caller closes it.
 */
async function openSourceConnection() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 3306,
        ssl: { rejectUnauthorized: false },
        dateStrings: ['DATE'],
        timezone: 'Z',
        connectTimeout: CONNECT_TIMEOUT_MS,
    });
    try {
        await conn.query('SET SESSION TRANSACTION READ ONLY');
        const [[row]] = await conn.query('SELECT @@SESSION.transaction_read_only AS ro');
        if (Number(row.ro) !== 1) throw new Error('the session did not become read-only');
    } catch (err) {
        conn.destroy();
        throw err;
    }
    return conn;
}

/**
 * Step 2: every column the reads touch must exist and be readable in `schema`.
 * Throws unavailable('source_schema') naming what is missing (names only). The
 * OPTIONAL_COLUMNS tables (shipping's `payment_due_dates`, its users table) are looked
 * up in the same query but never fail the check: → `{optional: {<table>: whole?}}`,
 * which loadSources reads by.
 */
async function checkSchema(q, schema) {
    const tables = [...Object.keys(reads.SOURCE_COLUMNS), ...Object.keys(reads.OPTIONAL_COLUMNS)];
    const [rows] = await q.query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`,
        [schema, ...tables]
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase()));
    const has = (table, column) => have.has(`${table}.${column}`.toLowerCase());
    const missing = [];
    for (const [table, columns] of Object.entries(reads.SOURCE_COLUMNS)) {
        for (const column of columns) {
            if (!has(table, column)) missing.push(`${table}.${column}`);
        }
    }
    if (missing.length) {
        const shown = missing.slice(0, MISSING_SHOWN).join(', ') + (missing.length > MISSING_SHOWN ? ', …' : '');
        const err = shipping.unavailable('source_schema',
            `Shipping's schema ${schema} lacks ${missing.length} column(s) JFlow reads, or JFlow cannot read them: ${shown}.`);
        err.missing = missing;           // every `table.column`, for a caller that wants the list
        throw err;
    }
    const optional = {};
    for (const [table, columns] of Object.entries(reads.OPTIONAL_COLUMNS)) {
        optional[table] = columns.every((column) => has(table, column));
    }
    return { optional };
}

/** The feed rows from the loaded payloads (pure). → {flow, input, paid, shipmentIdByRef} */
function runModel(sources, { today, paidSince }) {
    const { input, shipmentIdByRef } = page.pageInput(sources, today);
    const flow = flowLib.buildPaymentsFlow(input, { claims: true });
    const paid = flowLib.collectPaidRows(input, { paidSince });
    return { flow, input, paid, shipmentIdByRef };
}

/** POs a paid row names that the bundles do not hold (a PO with no live lines). */
function missingPoIds(paid, pos) {
    const ids = paid.flatMap((f) => [f.purchaseOrderId, f.lineKind === 'po_deposit' ? f.targetId : null]);
    return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0 && !pos.has(id)))];
}

/** Per currency, the model's kpis.outstanding as a 2-dp string (Σ open rows must equal it). */
function outstandingOf(flow) {
    const out = {};
    for (const c of flow.currencies) out[c.currency] = c.kpis.outstanding.toFixed(2);
    return out;
}

/**
 * Read shipping's tables, run the model and return the feed body
 * `{meta: {today, paidSince, generatedAt, model, schema, outstanding}, companies, items}`.
 * `today` (the route's Europe/London date) and `paidSince` are 'YYYY-MM-DD'.
 * Throws only unavailable('source_schema' | 'source_error'), or a TypeError for bad
 * arguments.
 */
async function readPaymentsForecast({ today, paidSince } = {}) {
    if (!isValidDate(today)) throw new TypeError(`readPaymentsForecast: today must be YYYY-MM-DD, got ${String(today)}`);
    if (!isValidDate(paidSince)) throw new TypeError(`readPaymentsForecast: paidSince must be YYYY-MM-DD, got ${String(paidSince)}`);
    const schema = sourceSchema();
    if (!schema) {
        throw shipping.unavailable('source_schema', 'SHIPPING_DB_SCHEMA is not a valid schema name (^[a-z0-9_]{1,64}$).');
    }
    const t = qualifier(schema);
    const started = Date.now();

    let conn = null;
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        if (conn) conn.destroy();
    }, SOURCE_TIMEOUT_MS);
    try {
        conn = await openSourceConnection();
        if (timedOut) throw new Error('timed out while connecting');
        const q = { query: (sql, params) => conn.query(sql, params) };

        const { optional } = await checkSchema(q, schema);
        await conn.query('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');
        const sources = await reads.loadSources(q, t, { optional });
        const targets = page.documentTargets(page.pageState(sources));
        if (targets.length) sources.shipmentDocuments = await reads.loadShipmentDocuments(q, t, targets);

        const model = runModel(sources, { today, paidSince });
        const pos = flowLib.poDirectory(model.input.poBundles);
        for (const [id, po] of await reads.loadPoDirectory(q, t, missingPoIds(model.paid, pos))) pos.set(id, po);
        const companies = await reads.loadCompanies(q, t);
        await conn.query('COMMIT');

        const items = flowLib.toForecastRows(model.flow, model.paid, { pos, shipmentIdByRef: model.shipmentIdByRef });
        const countOf = (source) => (source?.read ? source.data.length : null);
        const dueDates = countOf(sources.paymentDueDates);
        const extras = countOf(sources.paymentExtras);
        const openShipments = countOf(sources.openShipments);
        const say = (n, what, absent) => (n == null ? `; ${absent}` : `; ${n} ${what}`);
        log.info(`[shipping-source] ${schema} ${today}: ${items.length} row(s) in ${Date.now() - started}ms`
            + say(dueDates, 'date(s) set by hand', 'payment_due_dates not readable (no dates set by hand)')
            + say(extras, 'extra(s)', 'payment_extras not readable (no extras)')
            + say(openShipments, 'open shipment(s)', 'drafts and plans not readable (unbooked goods dated by the old rules)'));
        return {
            meta: {
                today, paidSince, generatedAt: new Date().toISOString(), model: MODEL, schema,
                outstanding: outstandingOf(model.flow),
                // Whether each optional table was read (null = not there yet): the due dates set by
                // hand, the extras, the drafts and plans with their lines.
                dueDates, extras, openShipments,
            },
            companies,
            items,
        };
    } catch (err) {
        if (shipping.isUnavailable(err)) throw err;
        if (timedOut) {
            log.warn(`[shipping-source] ${schema}: gave up after ${SOURCE_TIMEOUT_MS}ms`);
            throw shipping.unavailable('source_error', `Reading shipping's data took longer than ${SOURCE_TIMEOUT_MS / 1000}s.`);
        }
        // Codes and messages only: no credentials ever reach an error here.
        log.error(`[shipping-source] ${schema}: failed (${err && err.code ? err.code : 'error'}):`, err);
        const what = err && err.code ? ` (${err.code})` : '';
        throw shipping.unavailable('source_error', `Shipping's data could not be read or computed${what}.`);
    } finally {
        clearTimeout(timer);
        if (conn) {
            try { await conn.end(); } catch { conn.destroy(); }
        }
    }
}

module.exports = {
    DEFAULT_SCHEMA,
    SCHEMA_RE,
    MODEL,
    SOURCE_TIMEOUT_MS,
    sourceSchema,
    openSourceConnection,
    checkSchema,
    readPaymentsForecast,
};
