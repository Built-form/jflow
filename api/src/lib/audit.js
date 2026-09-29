// Copied from workflows/api/src/lib/audit.js — changes: none
'use strict';

// Shared audit-log helpers. Every mutation writes a before/after JSON row to
// `audit_log` via recordAudit — it diffs the snapshots, skips no-op updates, and
// NEVER throws (a missing audit row must not fail the mutation). Same
// contract/behaviour as the DispatchLine helper it was copied from.
//
// Contract §6 signature:
//   recordAudit(conn, { entityType, entityId, action, before, after, userEmail })

const log = require('./logger');

function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
}

// Return only the keys that differ between `before` and `after`. When either
// side is falsy, pass both through untouched (create/delete snapshots).
function diffSnapshots(before, after) {
    if (!before || !after) return { before, after };
    const beforeOut = {};
    const afterOut = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
        if (!deepEqual(before[k], after[k])) {
            beforeOut[k] = before[k];
            afterOut[k] = after[k];
        }
    }
    return { before: beforeOut, after: afterOut };
}

async function recordAudit(conn, { entityType, entityId, action, before, after, userEmail }) {
    try {
        const diffed = diffSnapshots(before, after);
        // Skip no-op updates (e.g. PUT with identical values).
        if (action === 'update' && diffed.before && Object.keys(diffed.before).length === 0) {
            return;
        }
        await conn.query(
            `INSERT INTO audit_log (entity_type, entity_id, action, before_json, after_json, user_email)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                entityType,
                entityId,
                action,
                diffed.before ? JSON.stringify(diffed.before) : null,
                diffed.after ? JSON.stringify(diffed.after) : null,
                userEmail || null,
            ]
        );
    } catch (err) {
        log.warn('[audit] insert failed', { entityType, entityId, action, error: err.message });
    }
}

// Batch form of recordAudit: same per-entry diff / no-op-skip semantics, ONE
// multi-row INSERT for everything that survives. Never throws.
async function recordAuditBulk(conn, entries) {
    try {
        const rows = [];
        for (const e of entries || []) {
            const diffed = diffSnapshots(e.before, e.after);
            if (e.action === 'update' && diffed.before && Object.keys(diffed.before).length === 0) {
                continue;
            }
            rows.push([
                e.entityType,
                e.entityId,
                e.action,
                diffed.before ? JSON.stringify(diffed.before) : null,
                diffed.after ? JSON.stringify(diffed.after) : null,
                e.userEmail || null,
            ]);
        }
        if (!rows.length) return;
        await conn.query(
            `INSERT INTO audit_log (entity_type, entity_id, action, before_json, after_json, user_email)
             VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
            rows.flat()
        );
    } catch (err) {
        log.warn('[audit] bulk insert failed', { count: (entries || []).length, error: err.message });
    }
}

/**
 * [13.4] Read the audit trail for ONE entity and its children.
 *
 * `GET /audit?entityType=&entityId=` answers for a single row; an inspection's
 * history is spread across its iterations, answers, attachments and comments,
 * and a template's across its reference media — asking for it one entity type at
 * a time is N calls the client then has to merge and re-sort.
 *
 * Scopes are (type, ids) pairs OR-ed together, so one keyset page walks the
 * merged trail newest-first. Same cursor scheme as `GET /audit`: `id < cursor`,
 * `nextCursor` null when exhausted.
 *
 * @param {object} conn
 * @param {Array<{type: string, ids: number[]}>} scopes empty id lists are dropped
 * @param {{cursor?: number|null, limit: number}} opts
 * @returns {Promise<object[]>} raw audit rows, newest first
 */
async function readScopedAudit(conn, scopes, { cursor = null, limit }) {
    const clauses = [];
    const params = [];
    for (const scope of scopes || []) {
        const ids = [...new Set((scope.ids || []).filter((n) => Number.isInteger(n) && n > 0))];
        if (!ids.length) continue;
        clauses.push(`(entity_type = ? AND entity_id IN (${ids.map(() => '?').join(', ')}))`);
        params.push(scope.type, ...ids);
    }
    // No child rows and no entity of its own means nothing can match — return
    // empty rather than emitting `WHERE ()`.
    if (!clauses.length) return [];

    const where = [`(${clauses.join(' OR ')})`];
    if (cursor) { where.push('id < ?'); params.push(cursor); }

    const [rows] = await conn.query(
        `SELECT id, entity_type, entity_id, action, before_json, after_json, reason, user_email, created_at
           FROM audit_log
          WHERE ${where.join(' AND ')}
          ORDER BY id DESC
          LIMIT ?`,
        [...params, limit]
    );
    return rows;
}

module.exports = { recordAudit, recordAuditBulk, readScopedAudit, deepEqual, diffSnapshots };
