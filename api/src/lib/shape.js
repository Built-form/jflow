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
const { buildItemKey } = require('./keys');
const { parseMinor, formatMinor } = require('./money');

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

/**
 * The optional optimistic-lock token (CONTRACT D4, §2.9) from a request body.
 * Absent or null → undefined (last write wins); a non-negative integer → that
 * integer; anything else → NaN, which the route answers 400.
 */
function parseBaseVersion(body) {
    const v = body ? body.baseVersion : undefined;
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return Number.isInteger(n) && n >= 0 ? n : NaN;
}

/**
 * The D4 check, made under the row lock: a sent baseVersion that is not the
 * row's row_version is 409 STALE_WRITE {currentVersion}. Thrown, so the
 * surrounding withTransaction rolls back. `row` null (the row the caller loaded
 * is gone) reads as stale with currentVersion null.
 */
function assertBaseVersion(row, baseVersion) {
    if (baseVersion === undefined) return;
    const currentVersion = row ? Number(row.row_version) : null;
    if (currentVersion !== baseVersion) {
        throw apiError(409, 'STALE_WRITE',
            currentVersion == null
                ? 'That record no longer exists. Reload and try again.'
                : 'Someone else changed this since you loaded it. Reload and try again.',
            { currentVersion });
    }
}

/** A display order: absent/'' → the default; an INT-range integer → it; else NaN (400). */
function parseSortOrder(value, def = 0) {
    if (value === undefined || value === null || value === '') return def;
    const n = Number(value);
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : NaN;
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

// id()    BIGINT UNSIGNED → JSON number (null stays null).
// bool()  TINYINT(1) → boolean.
// DATE columns arrive as 'YYYY-MM-DD' strings (pool dateStrings), DECIMAL as
// strings (D1) and DATETIME as UTC Dates that res.json writes as ISO 8601 —
// all three pass through untouched.

const id = (v) => (v == null ? null : Number(v));
const bool = (v) => (v == null ? null : Boolean(Number(v)));

function companyToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        code: r.code,
        name: r.name,
        sortOrder: r.sort_order,
        rowVersion: r.row_version,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
    };
}

/**
 * `anchorDate`/`anchorBalance` (the latest recorded balance) ride on the list
 * and single read only (CONTRACT §6.3): they appear when the query selected
 * `anchor_date`/`anchor_balance`, never on a mutation response.
 */
function accountToJson(r) {
    if (!r) return null;
    const out = {
        id: id(r.id),
        companyId: id(r.company_id),
        name: r.name,
        currency: r.currency,
        sortOrder: r.sort_order,
        isActive: bool(r.is_active),
        isDefault: bool(r.is_default),
        rowVersion: r.row_version,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
    };
    if ('anchor_date' in r) {
        out.anchorDate = r.anchor_date ?? null;
        out.anchorBalance = r.anchor_balance ?? null;
    }
    return out;
}

function categoryToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        name: r.name,
        direction: r.direction,
        sortOrder: r.sort_order,
        rowVersion: r.row_version,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
    };
}

function fxRateToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        currency: r.currency,
        rateToGbp: r.rate_to_gbp,
        effectiveFrom: r.effective_from,
        note: r.note,
        rowVersion: r.row_version,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/** `balance` is cash at bank at the START of `balanceDate` (CONTRACT §6.6). */
function balanceToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        accountId: id(r.account_id),
        balanceDate: r.balance_date,
        balance: r.balance,
        note: r.note,
        enteredBy: r.entered_by,
        rowVersion: r.row_version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/**
 * One `payments` row (CONTRACT D23). Its parent is exactly one of `cashItemId`
 * (a one-off) or `overrideId` (an instance). Append-only: no rowVersion.
 */
function paymentToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        cashItemId: id(r.cash_item_id),
        overrideId: id(r.override_id),
        paidOn: r.paid_on,
        amount: r.amount,
        note: r.note,
        createdBy: r.created_by,
        createdAt: r.created_at,
    };
}

/**
 * A one-off item (CONTRACT §6.7). `companyId` is derived through the account,
 * so the query must select `company_id` from bank_accounts; `key` is
 * buildItemKey(id); `remainingAmount` = amount − COALESCE(paid_amount, 0) (§3.4).
 *
 * `extras.payments` (payment JSON rows, ascending by paidOn, id) and
 * `extras.derivedStatus` appear on API responses only: they are left out when
 * `extras` does not carry them — audit snapshots and the loader's engine rows.
 */
function itemToJson(r, extras = {}) {
    if (!r) return null;
    const paid = r.paid_amount == null ? 0n : parseMinor(r.paid_amount);
    const out = {
        id: id(r.id),
        key: buildItemKey(Number(r.id)),
        accountId: id(r.account_id),
        companyId: id(r.company_id),
        categoryId: id(r.category_id),
        direction: r.direction,
        name: r.name,
        counterparty: r.counterparty,
        amount: r.amount,
        currency: r.currency,
        dueDate: r.due_date,
        status: r.status,
        paidOn: r.paid_on,
        paidAmount: r.paid_amount,
        remainingAmount: formatMinor(parseMinor(r.amount) - paid),
    };
    if (extras.payments) {
        out.payments = extras.payments.map((p) => ({
            id: p.id, paidOn: p.paidOn, amount: p.amount, note: p.note, createdBy: p.createdBy, createdAt: p.createdAt,
        }));
    }
    out.settleMode = r.settle_mode;
    out.notes = r.notes;
    out.sourceScenarioId = id(r.source_scenario_id);
    if ('derivedStatus' in extras) out.derivedStatus = extras.derivedStatus;
    out.rowVersion = r.row_version;
    out.createdBy = r.created_by;
    out.createdAt = r.created_at;
    out.updatedAt = r.updated_at;
    out.deletedAt = r.deleted_at;
    return out;
}

/**
 * A schedule (CONTRACT §6.8). `companyId` is derived through the account, so the
 * query must select `company_id` from bank_accounts. `successorId` and
 * `structureLocked` are derived (the live schedule split from this one; D37's
 * `start_date <= today OR an override exists`) and appear only when `extras`
 * carries them — API responses, never audit snapshots.
 */
function scheduleToJson(r, extras = {}) {
    if (!r) return null;
    const out = {
        id: id(r.id),
        accountId: id(r.account_id),
        companyId: id(r.company_id),
        categoryId: id(r.category_id),
        direction: r.direction,
        name: r.name,
        counterparty: r.counterparty,
        amount: r.amount,
        currency: r.currency,
        frequency: r.frequency,
        intervalCount: r.interval_count == null ? null : Number(r.interval_count),
        startDate: r.start_date,
        activeFrom: r.active_from ?? null,
        occurrenceCount: r.occurrence_count == null ? null : Number(r.occurrence_count),
        endDate: r.end_date,
        weekendRule: r.weekend_rule,
        settleMode: r.settle_mode,
        predecessorId: id(r.predecessor_id),
    };
    if ('successorId' in extras) out.successorId = extras.successorId;
    out.status = r.status;
    out.notes = r.notes;
    if ('structureLocked' in extras) out.structureLocked = extras.structureLocked;
    out.rowVersion = r.row_version;
    out.createdBy = r.created_by;
    out.createdAt = r.created_at;
    out.updatedAt = r.updated_at;
    out.deletedAt = r.deleted_at;
    return out;
}

/**
 * A `schedule_overrides` row (CONTRACT §3.2): the audit snapshot, and the source
 * of the instance's `override` object (lib/instances.js drops the parent ids).
 * NULL columns mean "the schedule's" (§3.4).
 */
function overrideToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        scheduleId: id(r.schedule_id),
        naturalDate: r.natural_date,
        amount: r.amount,
        dueDate: r.due_date,
        status: r.status,
        settleMode: r.settle_mode,
        paidOn: r.paid_on,
        paidAmount: r.paid_amount,
        note: r.note,
        sourceScenarioId: id(r.source_scenario_id),
        rowVersion: r.row_version,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/** A `scenario_adjustments` row (CONTRACT §6.11). `targetId` stays a string (D32). */
function adjustmentToJson(r) {
    if (!r) return null;
    return {
        id: id(r.id),
        scenarioId: id(r.scenario_id),
        itemKey: r.item_key,
        targetKind: r.target_kind,
        targetId: r.target_id == null ? null : String(r.target_id),
        targetDate: r.target_date,
        kind: r.kind,
        newDate: r.new_date,
        newAmount: r.new_amount,
        baseDate: r.base_date,
        baseAmount: r.base_amount,
        note: r.note,
        rowVersion: r.row_version,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/**
 * A `scenarios` row (CONTRACT §6.11). `adjustmentCount` is derived: it appears
 * when the query selected `adjustment_count` (every API read and response),
 * never in an audit snapshot.
 */
function scenarioToJson(r) {
    if (!r) return null;
    const out = {
        id: id(r.id),
        name: r.name,
        description: r.description,
        companyId: id(r.company_id),
        status: r.status,
        appliedAt: r.applied_at,
        appliedBy: r.applied_by,
    };
    if ('adjustment_count' in r) out.adjustmentCount = Number(r.adjustment_count);
    out.rowVersion = r.row_version;
    out.createdBy = r.created_by;
    out.createdAt = r.created_at;
    out.updatedAt = r.updated_at;
    out.deletedAt = r.deleted_at;
    return out;
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
    companyToJson,
    accountToJson,
    categoryToJson,
    fxRateToJson,
    balanceToJson,
    itemToJson,
    paymentToJson,
    scheduleToJson,
    overrideToJson,
    adjustmentToJson,
    scenarioToJson,
    parseId,
    parseListParams,
    parseCap,
    parseBaseVersion,
    assertBaseVersion,
    parseSortOrder,
    normalizeEmail,
    isValidEmail,
};
