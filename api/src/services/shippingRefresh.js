'use strict';

// The shipping snapshot refresh (CONTRACT §10.12; docs/PHASE2.md §4.3; P4, P8, P11).
//
// It runs OUTSIDE any transaction: every statement is its own autocommit single-row
// statement, on a connection with innodb_lock_wait_timeout = 5. It never holds two row
// locks, so it cannot deadlock with an overlay write or a scenario apply; a row it cannot
// lock within 5 s is logged and left for the next run.
//
//   1  claim   a conditional UPDATE on external_sync (the 60-second guard) — 0 rows means
//              another run holds it, and this one does not run;
//   2  read    shipping's data (services/shipping.js → shippingSource.js, on the source's own
//              READ ONLY connection) with none of the refresh's connections held; validateFeed;
//   3  diff    by (ext_id, feed_hash, gone_at): a new id → INSERT; a changed hash, or a
//              row back after gone_at → UPDATE the feed columns and clear gone_at; a row
//              missing from the feed → set gone_at. Rows are never removed;
//   4  record  success: last_success_at, feed_today, the counts, companies_json and
//              last_error = NULL. Failure: last_error only, so the snapshot's age stays
//              truthful.
//
// What it may write is exactly FEED_COLUMNS plus feed_hash, gone_at, row_version and (on
// insert) source, ext_id and created_by. The overlay columns belong to user edits and
// scenario apply (§10.9, §10.11); this file never names one. It writes no per-row audit
// (P8): feed columns are shipping's data, and feed_hash / updated_at say when they moved.
//
// Its connection is its own, not the pool's. The session variable would otherwise ride
// back into the pool on release and give some later request a 5 s lock wait, and through
// the RDS Proxy a SET SESSION pins the connection (db/index.js); a dedicated connection
// takes both with it when it closes.

const crypto = require('crypto');
const mysql = require('mysql2/promise');

const log = require('../lib/logger');
const { addDays, isValidDate } = require('../lib/dates');
const { withConnection } = require('../db');
const shipping = require('./shipping');

const SOURCE = 'ship';
const FEED_CREATED_BY = 'shipping-feed';
const CLAIM_GUARD_SECONDS = 60;          // a claim older than this is free to take
const REFRESH_TTL_SECONDS = 600;         // P4: /forecast refreshes a snapshot older than 10 minutes
const LOCK_WAIT_TIMEOUT_SECONDS = 5;
const PAID_SINCE_FALLBACK_DAYS = 60;
const LAST_ERROR_MAX = 500;              // external_sync.last_error VARCHAR(500)

// MySQL errors that mean "this row is busy": the statement was rolled back on its own and
// the row waits for the next run. 1205 ER_LOCK_WAIT_TIMEOUT, 1213 ER_LOCK_DEADLOCK.
const ROW_BUSY = new Set([1205, 1213]);

// The feed columns, in the one fixed order feed_hash is computed over (CONTRACT §3.5).
const FEED_COLUMNS = [
    'feed_kind', 'feed_status', 'supplier', 'shipping_company_id', 'po_id', 'po_number', 'shipment_id',
    'container_ref', 'currency', 'amount', 'due_date', 'paid_on', 'settles', 'date_basis', 'amount_basis',
    'blocked', 'flags_json',
];

/** A validated feed item (services/shipping.js validateFeed) → its feed-column values. */
function feedRow(item) {
    return {
        feed_kind: item.kind,
        feed_status: item.status,
        supplier: item.supplier,
        shipping_company_id: item.companyId,
        po_id: item.poId,
        po_number: item.poNumber,
        shipment_id: item.shipmentId,
        container_ref: item.containerRef,
        currency: item.currency,
        amount: item.amount,
        due_date: item.dueDate,
        paid_on: item.paidOn,
        settles: item.settles,
        date_basis: item.dateBasis,
        amount_basis: item.amountBasis,
        blocked: item.blocked,
        flags_json: JSON.stringify(item.flags),
    };
}

/**
 * sha256 (hex) over the feed columns in FEED_COLUMNS order. The values are JSON-encoded as
 * one array, so null and '' differ and no two columns can run into each other. It is
 * computed from the validated feed, never read back from MySQL, so the stored hash and the
 * next run's hash come from the same normal form.
 */
function feedHash(row) {
    const values = FEED_COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
    return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

// ── Connection ──────────────────────────────────────────────────────────────

/** A dedicated connection with the refresh's lock wait. Config as db/index.js, read per call. */
async function openConnection() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        ssl: { rejectUnauthorized: false },
        dateStrings: ['DATE'],
        timezone: 'Z',
    });
    try {
        await conn.query(`SET SESSION innodb_lock_wait_timeout = ${LOCK_WAIT_TIMEOUT_SECONDS}`);
    } catch (err) {
        conn.destroy();
        throw err;
    }
    return conn;
}

async function withRefreshConnection(fn) {
    const conn = await openConnection();
    try {
        return await fn(conn);
    } finally {
        try { await conn.end(); } catch { conn.destroy(); }
    }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The ship row of external_sync (raw columns), or null. It also carries `due_by_ttl`: 1
 * when the snapshot is over 10 minutes old by the database clock (the clock the claim
 * uses), else 0.
 */
async function readSync(conn) {
    const [rows] = await conn.query(
        `SELECT source, last_attempt_at, last_success_at, feed_today, last_error, item_count, rejected_count,
                companies_json, updated_at,
                (last_success_at IS NULL OR last_success_at < UTC_TIMESTAMP() - INTERVAL ${REFRESH_TTL_SECONDS} SECOND) AS due_by_ttl
           FROM external_sync WHERE source = ?`,
        [SOURCE]
    );
    return rows.length ? rows[0] : null;
}

/**
 * paidSince (CONTRACT §10.12 step 2): the earliest of the live active accounts' latest
 * balance_date on or before today — the oldest anchor, so every paid row the engine may
 * absorb is fetched — else today − 60.
 */
async function paidSinceFor(conn, today) {
    const [[row]] = await conn.query(
        `SELECT DATE_FORMAT(MIN(t.latest), '%Y-%m-%d') AS paid_since
           FROM (SELECT MAX(b.balance_date) AS latest
                   FROM bank_accounts a
                   JOIN bank_balances b ON b.account_id = a.id AND b.balance_date <= ?
                  WHERE a.deleted_at IS NULL AND a.is_active = 1
                  GROUP BY a.id) t`,
        [today]
    );
    return row && row.paid_since ? row.paid_since : addDays(today, -PAID_SINCE_FALLBACK_DAYS);
}

// ── The run ─────────────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO external_items (source, ext_id, ${FEED_COLUMNS.join(', ')}, feed_hash, created_by)
                    VALUES (?, ?, ${FEED_COLUMNS.map(() => '?').join(', ')}, ?, ?)`;
const UPDATE_FEED_SQL = `UPDATE external_items
                            SET ${FEED_COLUMNS.map((c) => `${c} = ?`).join(', ')}, feed_hash = ?, gone_at = NULL,
                                row_version = row_version + 1
                          WHERE id = ?`;
const MARK_GONE_SQL = `UPDATE external_items SET gone_at = UTC_TIMESTAMP(), row_version = row_version + 1
                        WHERE id = ? AND gone_at IS NULL`;

/** Run one single-row statement; a busy row (lock wait / deadlock) → false and the caller counts it deferred. */
async function writeRow(conn, sql, params, what) {
    try {
        await conn.query(sql, params);
        return true;
    } catch (err) {
        if (!ROW_BUSY.has(err.errno)) throw err;
        log.warn(`[shipping-refresh] ${what}: row busy (${err.code}); left for the next run`);
        return false;
    }
}

/** Step 3: the diff, one autocommit statement per row. → counts. */
async function applyFeed(conn, items) {
    const [existing] = await conn.query(
        'SELECT id, ext_id, feed_hash, gone_at FROM external_items WHERE source = ?', [SOURCE]
    );
    // Keyed as the unique key compares ext_id (the schema's collation is case-insensitive).
    const byExtId = new Map(existing.map((r) => [String(r.ext_id).toLowerCase(), r]));
    const counts = { inserted: 0, updated: 0, returned: 0, gone: 0, unchanged: 0, deferred: 0 };
    const seen = new Set();

    for (const item of items) {
        const key = item.id.toLowerCase();
        seen.add(key);
        const row = feedRow(item);
        const hash = feedHash(row);
        const values = FEED_COLUMNS.map((c) => row[c]);
        const prior = byExtId.get(key);
        if (!prior) {
            const ok = await writeRow(conn, INSERT_SQL, [SOURCE, item.id, ...values, hash, FEED_CREATED_BY], `insert ${item.id}`);
            counts[ok ? 'inserted' : 'deferred'] += 1;
        } else if (prior.feed_hash !== hash || prior.gone_at !== null) {
            const ok = await writeRow(conn, UPDATE_FEED_SQL, [...values, hash, prior.id], `update ${item.id}`);
            if (!ok) counts.deferred += 1;
            else counts[prior.gone_at !== null ? 'returned' : 'updated'] += 1;
        } else {
            counts.unchanged += 1;
        }
    }

    for (const prior of existing) {
        if (prior.gone_at !== null || seen.has(String(prior.ext_id).toLowerCase())) continue;
        const ok = await writeRow(conn, MARK_GONE_SQL, [prior.id], `gone ${prior.ext_id}`);
        counts[ok ? 'gone' : 'deferred'] += 1;
    }
    return counts;
}

async function recordFailure(err) {
    const text = `${err.reason}: ${err.message}`.slice(0, LAST_ERROR_MAX);
    return withRefreshConnection(async (conn) => {
        await conn.query('UPDATE external_sync SET last_error = ? WHERE source = ?', [text, SOURCE]);
        return readSync(conn);
    });
}

/**
 * One refresh run for `today` (the route's Europe/London date). The 10-minute TTL is not
 * checked here (POST /external/refresh forces a run); the 60-second claim always is.
 *
 * → {status, ran, sync, ...}:
 *   {status: 'skipped', ran: false, sync}                      another run holds the claim
 *   {status: 'ok',      ran: true,  sync, counts}              counts: inserted, updated,
 *                                                              returned, gone, unchanged,
 *                                                              deferred, rejected
 *   {status: 'failed',  ran: true,  sync, reason, message}     the read failed; only
 *                                                              last_error was written
 * `sync` is the external_sync row after the run (raw columns). A database error throws.
 */
async function runRefresh({ today } = {}) {
    if (!isValidDate(today)) throw new TypeError(`runRefresh: today must be YYYY-MM-DD, got ${String(today)}`);

    // 1 — claim, and read paidSince while the connection is open.
    const claim = await withRefreshConnection(async (conn) => {
        let res;
        try {
            [res] = await conn.query(
                `UPDATE external_sync SET last_attempt_at = UTC_TIMESTAMP()
                  WHERE source = ?
                    AND (last_attempt_at IS NULL OR last_attempt_at < UTC_TIMESTAMP() - INTERVAL ${CLAIM_GUARD_SECONDS} SECOND)`,
                [SOURCE]
            );
        } catch (err) {
            if (!ROW_BUSY.has(err.errno)) throw err;
            res = { affectedRows: 0 };   // the sync row is busy: another run is recording
        }
        if (!res.affectedRows) return { claimed: false, sync: await readSync(conn) };
        return { claimed: true, paidSince: await paidSinceFor(conn, today) };
    });
    if (!claim.claimed) return { status: 'skipped', ran: false, sync: claim.sync };

    // 2 — read the source with no connection of ours held.
    let feed;
    try {
        const body = await shipping.fetchPaymentsForecast({ today, paidSince: claim.paidSince });
        feed = shipping.validateFeed(body);
    } catch (err) {
        if (!shipping.isUnavailable(err)) throw err;
        const sync = await recordFailure(err);
        return { status: 'failed', ran: true, sync, reason: err.reason, message: err.message, missing: err.missing };
    }
    if (feed.rejected) {
        log.warn(`[shipping-refresh] ${feed.rejected} feed row(s) rejected:`, feed.problems);
    }

    // 3 + 4 — diff, then record. A database error here propagates (the route answers
    // 500); what was written stays written, and the next run's diff finishes the job.
    return withRefreshConnection(async (conn) => {
        const counts = { ...(await applyFeed(conn, feed.items)), rejected: feed.rejected };
        await conn.query(
            `UPDATE external_sync
                SET last_success_at = UTC_TIMESTAMP(), feed_today = ?, last_error = NULL,
                    item_count = ?, rejected_count = ?, companies_json = ?
              WHERE source = ?`,
            [today, feed.items.length, feed.rejected, JSON.stringify(feed.companies), SOURCE]
        );
        const sync = await readSync(conn);
        log.info(`[shipping-refresh] ${today}: ${JSON.stringify(counts)}`);
        return { status: 'ok', ran: true, sync, counts };
    });
}

/**
 * For /forecast (step 20, P4): run the refresh only when it is due — the snapshot is over
 * 10 minutes old (by the database clock) or was taken for another `today`. Call it before
 * taking the request's read connection.
 *
 * → {status: 'fresh', ran: false, sync} when nothing was due, else runRefresh's result.
 * A 'failed' result carries {reason} and sync.last_success_at for the SHIPPING_UNAVAILABLE
 * warning; 'skipped' means another run holds the claim (its outcome is on sync.last_error).
 */
async function refreshIfStale({ today } = {}) {
    if (!isValidDate(today)) throw new TypeError(`refreshIfStale: today must be YYYY-MM-DD, got ${String(today)}`);
    const sync = await withConnection(readSync);
    if (sync && !Number(sync.due_by_ttl) && sync.feed_today === today) return { status: 'fresh', ran: false, sync };
    return runRefresh({ today });
}

/** GET /external/status's read (pooled; no session variables). */
function readStatus() {
    return withConnection(readSync);
}

module.exports = {
    FEED_COLUMNS,
    CLAIM_GUARD_SECONDS,
    REFRESH_TTL_SECONDS,
    feedRow,
    feedHash,
    runRefresh,
    refreshIfStale,
    readStatus,
};
