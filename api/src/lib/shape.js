// Copied from workflows/api/src/lib/shape.js — changes: trimmed to the envelopes, parsers and `auditToJson` (kept: fail, apiError, isApiError, sendApiError, serverError, listResponse, keysetResponse, parseId, parseListParams, parseCap, normalizeEmail, isValidEmail, auditToJson and its `json` helper); dropped every entity `*ToJson`, `bool`/`num`/`bigId`, `publicBaseUrl`/`urlFor`, `queueEvent`/`flushEvents`/`respond`, `normalizeCode` and `parseStatusFilter`; header comment and the `apiError` / `parseCap` doc comments rewritten without workflows file and route names
'use strict';

// Response shaping and request-parameter parsing.
//
// What every route needs: the {error, code, details?} refusal envelope, the list
// envelopes, the input normalizers, and the row → camelCase mappers. JFlow's
// entity mappers (`*ToJson`, CONTRACT §2.4) join this file with the routes that
// read those tables (steps 2+). There is no event plumbing: JFlow emits nothing,
// so a route answers with res.json / res.status(…).json directly.

const log = require('./logger');

// ── Error + success envelopes ───────────────────────────────────────────────

/**
 * The contract's refusal envelope: `{error, code?, details?}`. `error` is one
 * line safe to show the operator as-is; `code` is the stable machine string.
 */
function fail(res, status, message, code, details) {
    const body = { error: message };
    if (code) body.code = code;
    if (details !== undefined) body.details = details;
    return res.status(status).json(body);
}

/**
 * A refusal thrown from library or service code (anything running inside a
 * withTransaction body) rather than returned from a route.
 *
 * Library helpers run INSIDE withTransaction, where the only way to abort and
 * roll back is to throw — returning a sentinel would commit the partial write.
 * Routes catch these and hand them to sendApiError, so the envelope is identical
 * either way.
 */
function apiError(status, code, message, details) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    if (details !== undefined) err.details = details;
    err.isApiError = true;
    return err;
}

/** True for an error built by apiError — anything else is a real 500. */
const isApiError = (err) => Boolean(err && err.isApiError);

/** Route-side counterpart: translate a thrown apiError into its response. */
function sendApiError(res, err) {
    return fail(res, err.status || 409, err.message, err.code, err.details);
}

function serverError(res, where, error) {
    // The request id makes two concurrent 500s in one container attributable —
    // and it is the string the caller can quote from their X-Request-Id header.
    const requestId = res.req && res.req.requestId;
    log.error(`[${where}]${requestId ? ` [req ${requestId}]` : ''}`, error);
    if (!res.headersSent) {
        res.status(500).json({ error: 'An internal error occurred.', requestId: requestId || undefined });
    }
}

/** Ordinary list envelope. The audit routes use keysetResponse instead. */
function listResponse(rows, { page, limit, total }) {
    return { data: rows, page, limit, total };
}

/**
 * Keyset envelope — audit reads only. `OFFSET 50000` on a table that grows into
 * millions of rows scans and discards 50k rows; the cursor is the last id seen.
 * nextCursor is null when the page came back short, i.e. the stream is exhausted.
 */
function keysetResponse(rows, limit) {
    return {
        data: rows,
        limit,
        nextCursor: rows.length === limit && rows.length > 0 ? rows[rows.length - 1].id : null,
    };
}

// ── Input parsing / normalizing ─────────────────────────────────────────────

/** Positive integer path/query id, else null (caller decides 400 vs 404). */
function parseId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** page ≥ 1, limit clamped to 1..500 (DispatchLine's clamp). */
function parseListParams(query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const rawLimit = parseInt(query.limit, 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
    return { page, limit, offset: (page - 1) * limit };
}

/**
 * The cap for BARE-ARRAY reads (GET /users): no envelope, no pagination, but
 * never unbounded either. Defaults
 * to the contract's max (500) rather than the list default (100) because these
 * are parent-bounded or small sets whose existing consumers expect everything —
 * the cap is a safety ceiling, not a page size.
 */
function parseCap(rawLimit, def = 500) {
    const n = parseInt(rawLimit, 10);
    return Math.min(500, Math.max(1, Number.isFinite(n) ? n : def));
}

function normalizeEmail(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

// ── Row shapers ─────────────────────────────────────────────────────────────
//
// snake_case DB row -> camelCase JSON. Every read route goes through these, so a
// column rename is a one-line change here rather than a grep across the routes.
//
// json()  JSON columns are already parsed by mysql2; the guard is for a driver
//         or a legacy row that hands back text.

function json(value) {
    if (value == null || typeof value === 'object') return value ?? null;
    try { return JSON.parse(value); } catch { return null; }
}

function auditToJson(r) {
    if (!r) return null;
    return {
        id: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        action: r.action,
        before: json(r.before_json),
        after: json(r.after_json),
        reason: r.reason,
        userEmail: r.user_email,
        createdAt: r.created_at,
    };
}

module.exports = {
    fail,
    apiError,
    isApiError,
    sendApiError,
    serverError,
    listResponse,
    keysetResponse,
    auditToJson,
    parseId,
    parseListParams,
    parseCap,
    normalizeEmail,
    isValidEmail,
};
