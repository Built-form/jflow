// Copied from workflows/api/test/unit/audit.test.js — changes: none
'use strict';

// readScopedAudit (src/lib/audit.js) — the query builder behind both per-entity
// audit routes (13.4). It interpolates placeholder COUNTS derived from caller
// ids, so the tests pin the three properties that keep it safe and correct:
// ids are integer-filtered, params line up with placeholders in order, and an
// empty scope set never reaches SQL.

const { readScopedAudit, diffSnapshots, deepEqual } = require('../../src/lib/audit');

function capturingConn(rows = []) {
    const calls = [];
    return {
        calls,
        query: async (sql, params) => { calls.push({ sql, params }); return [rows]; },
    };
}

describe('readScopedAudit', () => {
    test('no scopes at all -> [] without touching the database', async () => {
        const conn = capturingConn();
        expect(await readScopedAudit(conn, [], { limit: 100 })).toEqual([]);
        expect(conn.calls).toHaveLength(0);
    });

    test('scopes whose id lists are all empty -> [] without touching the database', async () => {
        const conn = capturingConn();
        const scopes = [{ type: 'template', ids: [] }, { type: 'reference_attachment', ids: [] }];
        expect(await readScopedAudit(conn, scopes, { limit: 100 })).toEqual([]);
        expect(conn.calls).toHaveLength(0);
    });

    test('empty scopes are dropped; the rest are OR-ed', async () => {
        const conn = capturingConn();
        await readScopedAudit(conn, [
            { type: 'instance', ids: [7] },
            { type: 'comment', ids: [] },         // dropped
            { type: 'answer', ids: [1, 2] },
        ], { limit: 50 });
        const { sql, params } = conn.calls[0];
        expect(sql).not.toMatch(/comment/);
        expect(sql).toMatch(/\(entity_type = \? AND entity_id IN \(\?\)\) OR \(entity_type = \? AND entity_id IN \(\?, \?\)\)/);
        expect(params).toEqual(['instance', 7, 'answer', 1, 2, 50]);
    });

    test('non-integer and non-positive ids are filtered; duplicates collapse', async () => {
        const conn = capturingConn();
        await readScopedAudit(conn, [
            { type: 'instance', ids: [3, 3, 0, -1, 2.5, NaN, '9; DROP TABLE x', 4] },
        ], { limit: 10 });
        const { sql, params } = conn.calls[0];
        // Only 3 and 4 survive: one placeholder each, nothing string-interpolated.
        expect(sql).toMatch(/entity_id IN \(\?, \?\)/);
        expect(params).toEqual(['instance', 3, 4, 10]);
    });

    test('cursor lands between scope params and LIMIT, as `id < ?`', async () => {
        const conn = capturingConn();
        await readScopedAudit(conn, [{ type: 'template', ids: [5] }], { cursor: 900, limit: 25 });
        const { sql, params } = conn.calls[0];
        expect(sql).toMatch(/AND id < \?/);
        expect(sql).toMatch(/ORDER BY id DESC/);
        expect(params).toEqual(['template', 5, 900, 25]);
    });

    test('no cursor -> no id < clause', async () => {
        const conn = capturingConn();
        await readScopedAudit(conn, [{ type: 'template', ids: [5] }], { limit: 25 });
        expect(conn.calls[0].sql).not.toMatch(/id </);
        expect(conn.calls[0].params).toEqual(['template', 5, 25]);
    });
});

// The diff helpers recordAudit rests on — cheap to pin while in the file.
describe('diffSnapshots', () => {
    test('create/delete (one side falsy) pass through untouched', () => {
        expect(diffSnapshots(null, { a: 1 })).toEqual({ before: null, after: { a: 1 } });
        expect(diffSnapshots({ a: 1 }, null)).toEqual({ before: { a: 1 }, after: null });
    });

    test('updates keep only the keys that changed', () => {
        const out = diffSnapshots({ a: 1, b: 'x', c: [1] }, { a: 2, b: 'x', c: [1] });
        expect(out).toEqual({ before: { a: 1 }, after: { a: 2 } });
    });

    test('deepEqual understands nesting and array-vs-object', () => {
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(deepEqual([1], { 0: 1 })).toBe(false);
        expect(deepEqual(null, undefined)).toBe(false);
    });
});
