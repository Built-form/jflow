'use strict';

// src/db/index.js — withTransaction's single ER_LOCK_DEADLOCK retry
// (CONTRACT D27, §10.1). JFlow retries by default; Workflows made it opt-in.
// Pinned here, against a stub pool (no MySQL):
//
//  - a deadlock on the first attempt re-runs the WHOLE body once, in a fresh
//    transaction on a fresh connection, and the second attempt's result wins;
//  - a second deadlock propagates (once means once);
//  - any other error is never retried;
//  - every attempt rolls back on failure and releases its connection;
//  - `{ retryOnDeadlock: 0 }` turns the retry off.

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));

const mysql = require('mysql2/promise');
const { withTransaction, withConnection } = require('../../src/db');

let connections;

/** A connection stub that records every transaction call made on it. */
function makeConnection(n) {
    const calls = [];
    return {
        n,
        calls,
        beginTransaction: jest.fn(async () => { calls.push('begin'); }),
        commit: jest.fn(async () => { calls.push('commit'); }),
        rollback: jest.fn(async () => { calls.push('rollback'); }),
        release: jest.fn(() => { calls.push('release'); }),
        query: jest.fn(async () => [[]]),
    };
}

// The pool is memoized inside src/db, so it is created once for the file and
// getConnection hands out a fresh stub per acquire.
mysql.createPool.mockImplementation(() => ({
    getConnection: jest.fn(async () => {
        const conn = makeConnection(connections.length + 1);
        connections.push(conn);
        return conn;
    }),
}));

beforeEach(() => { connections = []; });

function deadlock() {
    const err = new Error('Deadlock found when trying to get lock; try restarting transaction');
    err.code = 'ER_LOCK_DEADLOCK';
    err.errno = 1213;
    return err;
}

describe('withTransaction — the single deadlock retry', () => {
    test('first attempt deadlocks, second succeeds: exactly one retry, second result returned', async () => {
        let attempts = 0;
        const result = await withTransaction(async (conn) => {
            attempts++;
            await conn.query('UPDATE t SET x = 1');
            if (attempts === 1) throw deadlock();
            return { ok: attempts };
        });
        expect(result).toEqual({ ok: 2 });
        expect(attempts).toBe(2);
        expect(connections).toHaveLength(2);
        // The loser is rolled back and released; the retry runs in a fresh transaction.
        expect(connections[0].calls).toEqual(['begin', 'rollback', 'release']);
        expect(connections[1].calls).toEqual(['begin', 'commit', 'release']);
    });

    test('a second deadlock propagates — once means once', async () => {
        let attempts = 0;
        const err = await withTransaction(async () => {
            attempts++;
            throw deadlock();
        }).catch((e) => e);
        expect(err.code).toBe('ER_LOCK_DEADLOCK');
        expect(attempts).toBe(2);
        expect(connections).toHaveLength(2);
        for (const conn of connections) {
            expect(conn.calls).toEqual(['begin', 'rollback', 'release']);
            expect(conn.commit).not.toHaveBeenCalled();
        }
    });

    test('a non-deadlock error is not retried', async () => {
        let attempts = 0;
        const err = await withTransaction(async () => {
            attempts++;
            const e = new Error('Lock wait timeout exceeded');
            e.code = 'ER_LOCK_WAIT_TIMEOUT';
            throw e;
        }).catch((e) => e);
        expect(err.code).toBe('ER_LOCK_WAIT_TIMEOUT');
        expect(attempts).toBe(1);
        expect(connections).toHaveLength(1);
        expect(connections[0].calls).toEqual(['begin', 'rollback', 'release']);
    });

    test('a thrown refusal (apiError) is not retried either', async () => {
        const { apiError } = require('../../src/lib/shape');
        let attempts = 0;
        const err = await withTransaction(async () => {
            attempts++;
            throw apiError(409, 'STALE_WRITE', 'Stale.', { currentVersion: 4 });
        }).catch((e) => e);
        expect(err.code).toBe('STALE_WRITE');
        expect(attempts).toBe(1);
    });

    test('a clean body commits once, on one connection', async () => {
        const result = await withTransaction(async () => 'done');
        expect(result).toBe('done');
        expect(connections).toHaveLength(1);
        expect(connections[0].calls).toEqual(['begin', 'commit', 'release']);
    });

    test('{ retryOnDeadlock: 0 } turns the retry off', async () => {
        let attempts = 0;
        const err = await withTransaction(async () => {
            attempts++;
            throw deadlock();
        }, { retryOnDeadlock: 0 }).catch((e) => e);
        expect(err.code).toBe('ER_LOCK_DEADLOCK');
        expect(attempts).toBe(1);
    });

    test('a failing rollback (dead connection) still releases and rethrows the original error', async () => {
        const err = await withTransaction(async (conn) => {
            conn.rollback.mockImplementation(async () => { throw new Error('connection lost'); });
            const e = new Error('boom');
            e.code = 'ER_SOMETHING';
            throw e;
        }).catch((e) => e);
        expect(err.message).toBe('boom');
        expect(connections[0].release).toHaveBeenCalledTimes(1);
    });
});

describe('withConnection', () => {
    test('releases the connection even when the body throws', async () => {
        await expect(withConnection(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(connections).toHaveLength(1);
        expect(connections[0].release).toHaveBeenCalledTimes(1);
    });
});
