// Copied from workflows/api/src/db/index.js — changes: `withTransaction` retries the body once on ER_LOCK_DEADLOCK by default (`retryOnDeadlock` default 1, was 0 / opt-in; CONTRACT D27, §10.1) and its comment says why that is safe here; names
'use strict';

// mysql2/promise connection pool for JFlow. Copied from Workflows, which took it
// verbatim from DispatchLine (src/db/index.js), which took it from ShipLine.
// Config originally copied from
// ShipLine (c:\Users\OpsLondon\shipping\src\db\index.js): dateStrings ['DATE'],
// relaxed SSL, client-side idle reaping + TCP keepalive. Deliberate divergence:
// connectionLimit 3 (ShipLine uses 1) so independent reads in one request can run
// in parallel and a held connection (e.g. the preview GET_LOCK) doesn't starve
// the rest of the container. The RDS Proxy multiplexes client connections onto
// the backend, so worst case is 3 × 20 reserved concurrency = 60 client-side
// connections at the proxy, not 60 backend connections.

const mysql = require('mysql2/promise');

let pool;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT || 3306,
            ssl: { rejectUnauthorized: false },
            waitForConnections: true,
            connectionLimit: 3,
            // Return DATE columns as 'YYYY-MM-DD' strings rather than Date
            // objects. Otherwise mysql2 builds the Date at Node's local-tz
            // midnight, which on a BST client shifts a UTC DATE back by a day
            // when rendered via .toISOString(). DATETIME/TIMESTAMP still come
            // back as Date objects.
            dateStrings: ['DATE'],
            // Interpret DATETIME/TIMESTAMP columns as UTC. They are stored via
            // DEFAULT CURRENT_TIMESTAMP on a UTC RDS session, but mysql2 defaults
            // to timezone:'local' and would build the Date at Node's local tz —
            // on a BST client that shifts a stored 10:00:00 UTC to 09:00Z when
            // serialized through .toISOString(). 'Z' reads them back as UTC.
            timezone: 'Z',
            // Reap idle connections client-side (driver level) rather than with
            // a server-side `SET SESSION wait_timeout`: through the RDS Proxy a
            // SET SESSION pins the connection and defeats multiplexing, whereas
            // idleTimeout closes idle pooled connections without touching
            // session state.
            queueLimit: 0,
            idleTimeout: 60000,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
        });
    }
    return pool;
}

// Acquire a connection, run `fn(conn)`, and always release it. Every handler
// wraps its DB work in this so a thrown error never leaks a connection from the
// small pool. Matches ShipLine's orders.js withConnection.
async function withConnection(fn) {
    const connection = await getPool().getConnection();
    try {
        return await fn(connection);
    } finally {
        connection.release();
    }
}

// Like withConnection, but wraps `fn(conn)` in a single transaction: commit on a
// normal return, roll back on a thrown error. Use this for any route that issues
// more than one write which must all land together (status + history + audit,
// the parent/child split, the stock-drop finalize). Early-return sentinels such
// as { notFound } are committed harmlessly because they run before any write; a
// handler that needs to abort AFTER writing should throw (which rolls back).
//
// NOTE: a transaction holds its connection (1 of only 3 in the pool) for its
// whole duration — never do network I/O inside `fn`, and never nest a
// withConnection/withTransaction call inside it (under concurrent requests the
// pool can be exhausted and the nested acquire deadlocks waiting on itself).
//
// `retryOnDeadlock` (default 1 — ON for every caller, CONTRACT D27) re-runs
// `fn` ONCE in a fresh transaction after ER_LOCK_DEADLOCK. A deadlock is a
// normal InnoDB outcome, not a bug — it rolls the loser back entirely, so a
// re-run is safe AS FAR AS THE DATABASE IS CONCERNED. Workflows made it opt-in
// because its closures could touch state OUTSIDE the transaction (queued
// events would have been queued twice). JFlow has no out-of-transaction side
// effects, and CONTRACT §10.1 binds every body to keep all reads inside the
// transaction and do no network I/O, so the retry is safe for every caller. A
// second deadlock, or any other error, propagates. Pass `{ retryOnDeadlock: 0 }`
// only from a body that breaks that rule.
async function withTransaction(fn, { retryOnDeadlock = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
        const connection = await getPool().getConnection();
        try {
            await connection.beginTransaction();
            try {
                const result = await fn(connection);
                await connection.commit();
                return result;
            } catch (err) {
                try { await connection.rollback(); } catch (_e) { /* connection dead — release below */ }
                if (attempt < retryOnDeadlock && err && err.code === 'ER_LOCK_DEADLOCK') continue;
                throw err;
            }
        } finally {
            connection.release();
        }
    }
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = { getPool, withConnection, withTransaction, closePool };
