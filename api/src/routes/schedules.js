'use strict';

// Schedule routes (CONTRACT §6.8, §6.9, §10.1, §10.4–§10.6; D4, D14, D17–D23, D35,
// D37): schedules CRUD, their virtual instances, split and end.
//
// Rules:
//   - Structure (D37: amount, currency, accountId, frequency, intervalCount,
//     startDate, occurrenceCount, endDate, weekendRule, settleMode) edits in place
//     only while start_date > today and no override row exists; otherwise 409
//     SCHEDULE_STRUCTURE_LOCKED pointing at split. name, counterparty, categoryId and
//     notes always edit in place; direction follows the category (D14).
//   - Instances are virtual: an override row per tuned instance, keyed by its natural
//     date. Tune upserts it, revert hard-deletes it (refused with payment state), pay
//     and unpay write `payments` rows under it and rewrite its cache (D23).
//   - Split and end are PLAN's seven steps (§10.5), in splitOrEnd below.
//   - Soft delete, no in-use guard (D18).
//
// Locks (§10.1, standing order: scenarios → schedules → cash_items → overrides →
// payments). Create and structural edit take FOR SHARE on the account / category
// FIRST (services/references.js). EVERY INSTANCE WRITER LOCKS THE PARENT `schedules`
// ROW BEFORE IT READS OR WRITES ANY `schedule_overrides` ROW: lockInstance is the only
// way in for tune, revert, pay and unpay, and splitOrEnd locks its draft scenarios,
// then the schedule, then the overrides. `payments` rows are touched only under the
// override (services/payments.js).

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit, recordAuditBulk } = require('../lib/audit');
const { addDays, diffDays, isValidDate } = require('../lib/dates');
const { buildSchedKey } = require('../lib/keys');
const { DERIVED_STATUSES } = require('../lib/classify');
const { parseMinor, formatMinor } = require('../lib/money');
const {
    FREQUENCIES, WEEKEND_RULES, isOccurrence, firstActiveOccurrence, nextOccurrenceAfter, endBefore, effectiveValues,
} = require('../lib/recurrence');
const { STRUCTURAL_FIELDS, changedStructure, successorShape, partitionAdjustments } = require('../lib/split');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams, parseBaseVersion,
    assertBaseVersion, scheduleToJson, overrideToJson, adjustmentToJson,
} = require('../lib/shape');
const { SCHEDULE_SELECT, readSchedule, decorateSchedules, listInstances, readInstance } = require('../services/schedules');
const { insertPayment, paymentCache, deletePayments } = require('../services/payments');
const { shareReferences, requireAccount, requireCategory, assertDirection } = require('../services/references');

const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_NAME = 255;              // name, counterparty: VARCHAR(255)
const MAX_NOTE = 500;              // schedule_overrides.note, payments.note: VARCHAR(500)
const MAX_NOTES = 16000;           // notes: TEXT, as items
const MAX_INTERVAL = 1000;         // interval_count: a sanity cap that keeps every natural date computable
const INT_MAX = 2147483647;        // occurrence_count: INT
const INSTANCE_SPAN_DAYS = 730;    // D35
const DEFAULT_BACK_DAYS = 90;      // D35: from = today − 90
const DEFAULT_AHEAD_DAYS = 365;    // D35: to = today + 365
const DESCRIPTIVE_FIELDS = ['name', 'counterparty', 'categoryId', 'notes'];
const PUT_FIELDS = [...DESCRIPTIVE_FIELDS, 'direction', ...STRUCTURAL_FIELDS];
const TUNE_FIELDS = ['amount', 'dueDate', 'note', 'settleMode', 'status'];
const TUNE_STATUSES = ['expected', 'skipped'];   // D19: paid / part_paid belong to pay and unpay
const BOTH_ENDS = 'A schedule ends by occurrenceCount or endDate, not both (D22).';

const marks = (list) => list.map(() => '?').join(', ');

function parseName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= MAX_NAME ? name : null;
}

/**
 * Optional text: undefined = absent, null = clear (null or blank), else the trimmed
 * string of at most `max` characters. NaN = invalid (400).
 */
function parseText(value, max) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > max) return NaN;
    return value.trim() || null;
}

/** A DECIMAL money string (D1) → bigint minor units, or null (a JSON number is refused). */
function parseMoney(value) {
    try {
        return parseMinor(value);
    } catch {
        return null;
    }
}

/** A body id: a positive integer as a JSON number or numeric string, else null. */
function bodyId(value) {
    return typeof value === 'number' || typeof value === 'string' ? parseId(value) : null;
}

/** A whole number 1..max, as a JSON number or canonical digits, else null. */
function parseCount(value, max) {
    const n = typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

const isCurrency = (value) => typeof value === 'string' && CURRENCY_RE.test(value);

/**
 * The structural fields (D37) present in `body`, each checked: `{values}` (JSON names,
 * money normalised to two decimals, `null` kept for the two ends) or `{error}`.
 */
function parseStructure(body, { settleModes }) {
    const values = {};
    const has = (k) => body[k] !== undefined;
    if (has('amount')) {
        const minor = parseMoney(body.amount);
        if (minor === null || minor <= 0n) return { error: 'amount must be a decimal string greater than zero, e.g. "1024.00".' };
        values.amount = formatMinor(minor);
    }
    if (has('currency')) {
        if (!isCurrency(body.currency)) return { error: 'currency must be three capital letters, e.g. GBP.' };
        values.currency = body.currency;
    }
    if (has('accountId')) {
        const accountId = bodyId(body.accountId);
        if (!accountId) return { error: 'accountId must be a positive integer.' };
        values.accountId = accountId;
    }
    if (has('frequency')) {
        if (!FREQUENCIES.includes(body.frequency)) return { error: `frequency must be one of: ${FREQUENCIES.join(', ')}.` };
        values.frequency = body.frequency;
    }
    if (has('intervalCount')) {
        const n = parseCount(body.intervalCount, MAX_INTERVAL);
        if (n === null) return { error: `intervalCount must be a whole number from 1 to ${MAX_INTERVAL}.` };
        values.intervalCount = n;
    }
    if (has('startDate')) {
        if (!isValidDate(body.startDate)) return { error: 'startDate must be a real date, YYYY-MM-DD.' };
        values.startDate = body.startDate;
    }
    if (has('occurrenceCount')) {
        const n = body.occurrenceCount === null ? null : parseCount(body.occurrenceCount, INT_MAX);
        if (body.occurrenceCount !== null && n === null) return { error: 'occurrenceCount must be a whole number of at least 1, or null.' };
        values.occurrenceCount = n;
    }
    if (has('endDate')) {
        if (body.endDate !== null && !isValidDate(body.endDate)) return { error: 'endDate must be a real date, YYYY-MM-DD, or null.' };
        values.endDate = body.endDate;
    }
    if (has('weekendRule')) {
        if (!WEEKEND_RULES.includes(body.weekendRule)) return { error: `weekendRule must be one of: ${WEEKEND_RULES.join(', ')}.` };
        values.weekendRule = body.weekendRule;
    }
    if (has('settleMode')) {
        if (!settleModes.includes(body.settleMode)) return { error: `settleMode must be one of: ${settleModes.join(', ')}.` };
        values.settleMode = body.settleMode;
    }
    return { values };
}

/** D22 and the start / end order on a whole structure; null when fine. */
function endsError({ startDate, occurrenceCount, endDate }) {
    if (occurrenceCount != null && endDate != null) return BOTH_ENDS;
    if (endDate != null && endDate < startDate) return 'endDate must be on or after startDate.';
    return null;
}

/** `dropOverrides` / `dropAdjustments`: absent = false, else a boolean. */
function parseDrops(body) {
    const values = {};
    for (const key of ['dropOverrides', 'dropAdjustments']) {
        const v = body[key];
        if (v === undefined || v === null) values[key] = false;
        else if (typeof v === 'boolean') values[key] = v;
        else return { error: `${key} must be true or false.` };
    }
    return { values };
}

const sameAmount = (a, b) => (a == null || b == null ? a == null && b == null : parseMinor(a) === parseMinor(b));

/** §3.4's "payment state" on an override (JSON): the cache columns. */
function hasPaymentState(o) {
    return o.status === 'paid' || o.status === 'part_paid'
        || (o.paidAmount != null && parseMinor(o.paidAmount) > 0n) || o.paidOn != null;
}

function overrideHasPayment(o, message) {
    return apiError(409, 'OVERRIDE_HAS_PAYMENT', message,
        { naturalDate: o.naturalDate, status: o.status, paidAmount: o.paidAmount, paidOn: o.paidOn });
}

/**
 * Lock the live schedule row FOR UPDATE (only the schedule: `OF s` leaves the joined
 * account unlocked, §10.1) → 404; the D4 check under the lock when `baseVersion` is
 * the schedule's. Returns the row (with company_id).
 */
async function lockSchedule(conn, id, baseVersion) {
    const [rows] = await conn.query(`${SCHEDULE_SELECT} WHERE s.id = ? AND s.deleted_at IS NULL FOR UPDATE OF s`, [id]);
    if (!rows.length) throw apiError(404, undefined, 'Schedule not found.');
    assertBaseVersion(rows[0], baseVersion);
    return rows[0];
}

/**
 * §10.4's common prologue, the ONLY way an instance writer reaches an override:
 *   1. lock the `schedules` row (live) → 404 — BEFORE any override read or write;
 *   2. isOccurrence(schedule, naturalDate) → 404;
 *   3. lock the override row (zero or one) FOR UPDATE; `baseVersion` is checked
 *      against it when it exists and ignored when it does not.
 */
async function lockInstance(conn, scheduleId, naturalDate, baseVersion) {
    const row = await lockSchedule(conn, scheduleId);
    const schedule = scheduleToJson(row);
    if (!isOccurrence(schedule, naturalDate)) {
        throw apiError(404, undefined, `${naturalDate} is not an instance of this schedule.`);
    }
    const [overrides] = await conn.query(
        'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ? FOR UPDATE', [scheduleId, naturalDate]
    );
    const overrideRow = overrides[0] || null;
    if (overrideRow) assertBaseVersion(overrideRow, baseVersion);
    return { schedule, override: overrideToJson(overrideRow) };
}

async function readOverride(conn, id) {
    const [[row]] = await conn.query('SELECT * FROM schedule_overrides WHERE id = ?', [id]);
    return overrideToJson(row);
}

/** Insert an override row (under the schedule lock) and audit `schedule_override`/`create`. */
async function insertOverride(conn, scheduleId, naturalDate, cols, userEmail) {
    const [ins] = await conn.query(
        `INSERT INTO schedule_overrides (schedule_id, natural_date, amount, due_date, status, settle_mode, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [scheduleId, naturalDate, cols.amount ?? null, cols.dueDate ?? null, cols.status ?? null,
            cols.settleMode ?? null, cols.note ?? null, userEmail]
    );
    const created = await readOverride(conn, ins.insertId);
    await recordAudit(conn, {
        entityType: 'schedule_override', entityId: created.id, action: 'create', before: null, after: created, userEmail,
    });
    return created;
}

/**
 * A synthetic deadlock: withTransaction (D27) re-runs the whole body once. Thrown when
 * a draft adjustment on this schedule was written between the split's step-1 read and
 * its schedule lock — its scenario cannot be locked now without breaking the order.
 */
function lockOrderRestart() {
    const err = new Error('A draft adjustment on this schedule was written while the split waited for its locks.');
    err.code = 'ER_LOCK_DEADLOCK';
    return err;
}

/**
 * Split and end, PLAN's seven steps in PLAN's order (§10.5), inside the caller's
 * transaction. `action` is 'split' (`date` = fromNaturalDate, `changes` validated
 * structural fields) or 'end' (`date` = lastNaturalDate). Returns the response body:
 * split {ended, successor, deletedOverrides, rekeyedAdjustments, droppedAdjustments},
 * end {ended, deletedOverrides, droppedAdjustments}. Refusals are thrown (rollback).
 */
async function splitOrEnd(conn, {
    action, scheduleId, date, changes = {}, dropOverrides = false, dropAdjustments = false, baseVersion, today, userEmail,
}) {
    const isSplit = action === 'split';
    // k needs the locked schedule, so step 1 binds the request's date: >= fromNaturalDate
    // (which is k) for a split, > lastNaturalDate for an end.
    const op = isSplit ? '>=' : '>';
    const targetId = String(scheduleId);   // D32

    // §10.1's one exception, before any standing-order lock: a split moving the series to
    // another account shares that account (the category never changes on a split).
    const refs = isSplit && changes.accountId !== undefined
        ? await shareReferences(conn, { accountId: changes.accountId }) : null;

    // 1. The draft scenarios holding adjustments on this schedule from the date, locked
    //    ascending FOR UPDATE, then the adjustments re-read under those locks. A scenario
    //    that has stopped being draft meanwhile is left alone: its adjustments are history.
    const [holders] = await conn.query(
        `SELECT a.scenario_id, s.status, s.deleted_at
           FROM scenario_adjustments a
           JOIN scenarios s ON s.id = a.scenario_id
          WHERE a.target_kind = 'sched' AND a.target_id = ? AND a.target_date ${op} ?
          ORDER BY a.scenario_id ASC`,
        [targetId, date]
    );
    const seen = new Set(holders.map((r) => Number(r.scenario_id)));
    const draftIds = [...new Set(holders.filter((r) => r.status === 'draft' && r.deleted_at == null)
        .map((r) => Number(r.scenario_id)))];
    const scenarioNames = new Map();
    for (const sid of draftIds) {                                             // ascending id
        const [rows] = await conn.query(
            'SELECT id, name, status FROM scenarios WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [sid]
        );
        if (rows.length && rows[0].status === 'draft') scenarioNames.set(sid, rows[0].name);
    }
    let adjustments = [];
    if (scenarioNames.size) {
        const ids = [...scenarioNames.keys()];
        const [rows] = await conn.query(
            `SELECT * FROM scenario_adjustments
              WHERE scenario_id IN (${marks(ids)}) AND target_kind = 'sched' AND target_id = ? AND target_date ${op} ?
              ORDER BY scenario_id ASC, target_date ASC, id ASC
              FOR UPDATE`,
            [...ids, targetId, date]
        );
        adjustments = rows;
    }

    // 2. The schedule row — after the scenario locks, which keeps the standing order.
    const row = await lockSchedule(conn, scheduleId, baseVersion);
    const schedule = scheduleToJson(row);
    // An adjustment write locks its scenario, then this schedule (§10.7), so from here the
    // set is frozen. One written between step 1's read and this lock belongs to a
    // scenario step 1 never saw: restart rather than lock it out of order.
    const [late] = await conn.query(
        `SELECT scenario_id FROM scenario_adjustments
          WHERE target_kind = 'sched' AND target_id = ? AND target_date ${op} ?
          FOR SHARE`,
        [targetId, date]
    );
    if (late.some((r) => !seen.has(Number(r.scenario_id)))) throw lockOrderRestart();

    let k;
    let successor = null;
    let currencyChanged = false;
    if (isSplit) {
        k = date;
        if (!isOccurrence(schedule, k)) {
            throw apiError(400, undefined, `fromNaturalDate ${k} is not an instance of this schedule.`, { fromNaturalDate: k });
        }
        const first = firstActiveOccurrence(schedule);
        if (k <= first) {
            throw apiError(400, undefined,
                `A split starts after the schedule's first instance (${first}): edit that one in place, or delete the schedule.`,
                { fromNaturalDate: k, firstNaturalDate: first });
        }
        successor = successorShape(schedule, k, changes);
        if (!successor.keepSeries && successor.startDate < k) {
            throw apiError(400, undefined,
                `changes.startDate must be on or after fromNaturalDate (${k}): the successor cannot start inside the old series.`,
                { startDate: successor.startDate, fromNaturalDate: k });
        }
        if (firstActiveOccurrence(successor) === null) {
            throw apiError(400, undefined, `The successor would have no instances from ${k}: check the end in changes.`,
                { fromNaturalDate: k, occurrenceCount: successor.occurrenceCount, endDate: successor.endDate });
        }
        if (changes.accountId !== undefined && changes.accountId !== schedule.accountId) requireAccount(refs.account);
        currencyChanged = changedStructure(schedule, changes).includes('currency');
    } else {
        if (!isOccurrence(schedule, date)) {
            throw apiError(400, undefined, `lastNaturalDate ${date} is not an instance of this schedule.`, { lastNaturalDate: date });
        }
        k = nextOccurrenceAfter(schedule, date);
        if (k === null) {   // nothing follows it: a no-op, nothing written
            return { ended: (await decorateSchedules(conn, [row], today))[0], deletedOverrides: [], droppedAdjustments: [] };
        }
    }

    // 3. Payment guard, on the cache columns — exact because every payments write
    //    rewrites them under this same schedule lock (D23).
    const [paid] = await conn.query(
        `SELECT natural_date FROM schedule_overrides
          WHERE schedule_id = ? AND natural_date >= ?
            AND (status IN ('paid', 'part_paid') OR paid_amount > 0 OR paid_on IS NOT NULL)
          ORDER BY natural_date ASC
          FOR UPDATE`,
        [scheduleId, k]
    );
    if (paid.length) {
        throw apiError(409, 'SCHEDULE_HAS_PAYMENTS',
            'Instances from that date carry payments. Unpay them first, or split or end from a later date.',
            { naturalDates: paid.map((r) => r.natural_date) });
    }

    // 4. Unpaid overrides from k.
    const [overrides] = await conn.query(
        'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND natural_date >= ? ORDER BY natural_date ASC FOR UPDATE',
        [scheduleId, k]
    );
    if (overrides.length && !dropOverrides) {
        throw apiError(409, 'SCHEDULE_HAS_OVERRIDES',
            'Instances from that date are tuned. Send dropOverrides: true to discard those tunes.',
            { naturalDates: overrides.map((o) => o.natural_date) });
    }

    // 5. Decide, write nothing: rekey[] when the natural dates and the currency survive a
    //    split and the successor generates the date; everything else is drop[].
    const { rekey, drop } = partitionAdjustments(
        adjustments.map((a) => ({ row: a, targetDate: a.target_date })),
        { action, keepSeries: successor ? successor.keepSeries : false, currencyChanged, successor }
    );
    if (drop.length && !dropAdjustments) {
        throw apiError(409, 'SCHEDULE_HAS_ADJUSTMENTS',
            'Draft scenarios adjust instances that will no longer exist. Send dropAdjustments: true to delete those adjustments.',
            {
                adjustments: drop.map(({ row: a }) => ({
                    scenarioId: Number(a.scenario_id), scenarioName: scenarioNames.get(Number(a.scenario_id)),
                    itemKey: a.item_key, naturalDate: a.target_date,
                })),
            });
    }

    // 6. Deletes: the overrides from k and drop[], one audit row per deleted row.
    if (overrides.length) {
        await conn.query('DELETE FROM schedule_overrides WHERE schedule_id = ? AND natural_date >= ?', [scheduleId, k]);
        await recordAuditBulk(conn, overrides.map((o) => ({
            entityType: 'schedule_override', entityId: Number(o.id), action: 'delete',
            before: overrideToJson(o), after: null, userEmail,
        })));
    }
    if (drop.length) {
        await conn.query(`DELETE FROM scenario_adjustments WHERE id IN (${marks(drop)})`, drop.map(({ row: a }) => a.id));
        await recordAuditBulk(conn, drop.map(({ row: a }) => ({
            entityType: 'scenario_adjustment', entityId: Number(a.id), action: 'delete',
            before: adjustmentToJson(a), after: null, userEmail,
        })));
    }

    // 7. End the old schedule (D22: end_date = k − 1, no count), insert the successor, and
    //    only then — with its id in hand — re-key rekey[].
    const { endDate } = endBefore(schedule, k);
    await conn.query(
        `UPDATE schedules SET end_date = ?, occurrence_count = NULL, status = 'ended', row_version = row_version + 1
          WHERE id = ?`,
        [endDate, scheduleId]
    );
    const endedRow = await readSchedule(conn, scheduleId);
    await recordAudit(conn, {
        entityType: 'schedule', entityId: scheduleId, action: isSplit ? 'split' : 'end',
        before: scheduleToJson(row), after: scheduleToJson(endedRow), userEmail,
    });
    const deletedOverrides = overrides.map((o) => o.natural_date);
    const droppedAdjustments = drop.map(({ row: a }) => ({ scenarioId: Number(a.scenario_id), itemKey: a.item_key }));
    if (!isSplit) {
        return { ended: (await decorateSchedules(conn, [endedRow], today))[0], deletedOverrides, droppedAdjustments };
    }

    const [ins] = await conn.query(
        `INSERT INTO schedules
            (account_id, category_id, direction, name, counterparty, amount, currency, frequency, interval_count,
             start_date, active_from, occurrence_count, end_date, weekend_rule, settle_mode, predecessor_id,
             status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [successor.accountId, schedule.categoryId, schedule.direction, schedule.name, schedule.counterparty,
            successor.amount, successor.currency, successor.frequency, successor.intervalCount, successor.startDate,
            successor.activeFrom, successor.occurrenceCount, successor.endDate, successor.weekendRule,
            successor.settleMode, scheduleId, schedule.notes, userEmail]
    );
    const successorId = ins.insertId;
    const successorRow = await readSchedule(conn, successorId);
    await recordAudit(conn, {
        entityType: 'schedule', entityId: successorId, action: 'create',
        before: null, after: scheduleToJson(successorRow), userEmail,
    });

    const rekeyedAdjustments = [];
    for (const { row: a } of rekey) {
        const itemKey = buildSchedKey(successorId, a.target_date);
        await conn.query(
            'UPDATE scenario_adjustments SET item_key = ?, target_id = ?, row_version = row_version + 1 WHERE id = ?',
            [itemKey, String(successorId), a.id]
        );
        const [[after]] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [a.id]);
        await recordAudit(conn, {
            entityType: 'scenario_adjustment', entityId: Number(a.id), action: 'update',
            before: adjustmentToJson(a), after: adjustmentToJson(after), userEmail,
        });
        rekeyedAdjustments.push({ scenarioId: Number(a.scenario_id), from: a.item_key, to: itemKey });
    }

    const [ended, next] = await decorateSchedules(conn, [endedRow, successorRow], today);
    return { ended, successor: next, deletedOverrides, rekeyedAdjustments, droppedAdjustments };
}

function factory({ schemaReady, fail, serverError, todayFor, enums }) {
    const router = express.Router();
    const DIRECTIONS = enums.directions;
    const SETTLE_MODES = enums.settleModes;
    const SCHEDULE_STATUSES = enums.scheduleStatuses;
    const structureOf = (body) => parseStructure(body, { settleModes: SETTLE_MODES });

    const handle = (where, fn) => async (req, res) => {
        try {
            await schemaReady;
            await fn(req, res);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, where, err);
        }
    };

    /** A path id → the id, or answers 404 and returns null. */
    const pathId = (req, res) => {
        const id = parseId(req.params.id);
        if (!id) fail(res, 404, 'Schedule not found.');
        return id;
    };

    // ── Schedules ───────────────────────────────────────────────────────────

    router.get('/schedules', handle('schedules-list', async (req, res) => {
        const { page, limit, offset } = parseListParams(req.query);
        const where = [];
        const params = [];
        if (req.query.includeDeleted !== '1') where.push('s.deleted_at IS NULL');
        for (const [key, column] of [['accountId', 's.account_id'], ['companyId', 'a.company_id'], ['categoryId', 's.category_id']]) {
            if (req.query[key] === undefined) continue;
            const value = parseId(req.query[key]);
            if (!value) return fail(res, 400, `${key} must be a positive integer.`);
            where.push(`${column} = ?`);
            params.push(value);
        }
        if (req.query.status !== undefined) {
            const statuses = String(req.query.status).split(',').map((s) => s.trim());
            if (statuses.some((s) => !SCHEDULE_STATUSES.includes(s))) {
                return fail(res, 400, `status must be a comma list of: ${SCHEDULE_STATUSES.join(', ')}.`);
            }
            where.push(`s.status IN (${marks(statuses)})`);
            params.push(...statuses);
        }
        if (req.query.settleMode !== undefined) {
            const mode = String(req.query.settleMode);
            if (!SETTLE_MODES.includes(mode)) return fail(res, 400, `settleMode must be one of: ${SETTLE_MODES.join(', ')}.`);
            where.push('s.settle_mode = ?');
            params.push(mode);
        }
        if (req.query.q) {
            where.push('(s.name LIKE ? OR s.counterparty LIKE ?)');
            params.push(`%${String(req.query.q)}%`, `%${String(req.query.q)}%`);
        }
        const today = todayFor(req);
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const out = await withConnection(async (c) => {
            const [[{ total }]] = await c.query(
                `SELECT COUNT(*) AS total FROM schedules s LEFT JOIN bank_accounts a ON a.id = s.account_id ${whereSql}`,
                params
            );
            const [rows] = await c.query(
                `${SCHEDULE_SELECT} ${whereSql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
            return { total, data: await decorateSchedules(c, rows, today) };
        });
        res.json(listResponse(out.data, { page, limit, total: Number(out.total) }));
    }));

    router.post('/schedules', handle('schedules-create', async (req, res) => {
        const body = req.body || {};
        const accountId = bodyId(body.accountId);
        if (!accountId) return fail(res, 400, 'accountId is required (a positive integer).');
        const categoryId = bodyId(body.categoryId);
        if (!categoryId) return fail(res, 400, 'categoryId is required (a positive integer).');
        const name = parseName(body.name);
        if (!name) return fail(res, 400, `name is required (at most ${MAX_NAME} characters).`);
        for (const [key, what] of [
            ['amount', 'a decimal string greater than zero, e.g. "1024.00"'],
            ['frequency', `one of ${FREQUENCIES.join(', ')}`],
            ['startDate', 'a real date, YYYY-MM-DD'],
        ]) {
            if (body[key] === undefined || body[key] === null) return fail(res, 400, `${key} is required: ${what}.`);
        }
        const { values, error } = structureOf(body);
        if (error) return fail(res, 400, error);
        const structure = {
            intervalCount: 1, occurrenceCount: null, endDate: null, weekendRule: 'none', settleMode: 'auto', ...values,
        };
        const endError = endsError(structure);
        if (endError) return fail(res, 400, endError);
        if (body.direction !== undefined && !DIRECTIONS.includes(body.direction)) {
            return fail(res, 400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
        }
        const counterparty = parseText(body.counterparty, MAX_NAME);
        if (Number.isNaN(counterparty)) return fail(res, 400, `counterparty must be text of at most ${MAX_NAME} characters.`);
        const notes = parseText(body.notes, MAX_NOTES);
        if (Number.isNaN(notes)) return fail(res, 400, `notes must be text of at most ${MAX_NOTES} characters.`);
        const today = todayFor(req);

        const created = await withTransaction(async (conn) => {
            // §10.1: the reference share first.
            const refs = await shareReferences(conn, { accountId, categoryId });
            const account = requireAccount(refs.account);
            const category = requireCategory(refs.category);
            assertDirection(body.direction, category);
            const [ins] = await conn.query(
                `INSERT INTO schedules
                    (account_id, category_id, direction, name, counterparty, amount, currency, frequency, interval_count,
                     start_date, occurrence_count, end_date, weekend_rule, settle_mode, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [accountId, categoryId, category.direction, name, counterparty ?? null, structure.amount,
                    structure.currency ?? account.currency, structure.frequency, structure.intervalCount,
                    structure.startDate, structure.occurrenceCount, structure.endDate, structure.weekendRule,
                    structure.settleMode, notes ?? null, req.userEmail]
            );
            const row = await readSchedule(conn, ins.insertId);
            await recordAudit(conn, {
                entityType: 'schedule', entityId: ins.insertId, action: 'create',
                before: null, after: scheduleToJson(row), userEmail: req.userEmail,
            });
            return (await decorateSchedules(conn, [row], today))[0];
        });
        res.status(201).json(created);
    }));

    router.get('/schedules/:id', handle('schedules-get', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const today = todayFor(req);
        const schedule = await withConnection(async (c) => {
            const row = await readSchedule(c, id, { includeDeleted: req.query.includeDeleted === '1' });
            return row ? (await decorateSchedules(c, [row], today))[0] : null;
        });
        if (!schedule) return fail(res, 404, 'Schedule not found.');
        res.json(schedule);
    }));

    // §10.6: descriptive fields always; structural ones only while unlocked (D37).
    router.put('/schedules/:id', handle('schedules-update', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const body = req.body || {};
        const has = (k) => body[k] !== undefined;
        if (!PUT_FIELDS.some(has)) return fail(res, 400, `Nothing to update: send any of ${PUT_FIELDS.join(', ')}.`);
        const name = has('name') ? parseName(body.name) : null;
        if (has('name') && !name) return fail(res, 400, `name cannot be blank (at most ${MAX_NAME} characters).`);
        const counterparty = parseText(body.counterparty, MAX_NAME);
        if (Number.isNaN(counterparty)) return fail(res, 400, `counterparty must be text of at most ${MAX_NAME} characters.`);
        const categoryId = has('categoryId') ? bodyId(body.categoryId) : null;
        if (has('categoryId') && !categoryId) return fail(res, 400, 'categoryId must be a positive integer.');
        const notes = parseText(body.notes, MAX_NOTES);
        if (Number.isNaN(notes)) return fail(res, 400, `notes must be text of at most ${MAX_NOTES} characters.`);
        if (has('direction') && !DIRECTIONS.includes(body.direction)) {
            return fail(res, 400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
        }
        const { values: structural, error } = structureOf(body);
        if (error) return fail(res, 400, error);
        const baseVersion = parseBaseVersion(body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const today = todayFor(req);

        const updated = await withTransaction(async (conn) => {
            // §10.1: the reference share first, then the schedule row.
            const refs = await shareReferences(conn, { accountId: structural.accountId, categoryId });
            const row = await lockSchedule(conn, id, baseVersion);
            const current = scheduleToJson(row);

            const changed = changedStructure(current, structural);
            if (changed.length) {
                let reason = null;
                if (row.start_date <= today) reason = 'started';
                else {
                    const [tuned] = await conn.query('SELECT 1 FROM schedule_overrides WHERE schedule_id = ? LIMIT 1', [id]);
                    if (tuned.length) reason = 'has_overrides';
                }
                if (reason) {
                    throw apiError(409, 'SCHEDULE_STRUCTURE_LOCKED',
                        `This schedule has ${reason === 'started' ? 'started' : 'tuned instances'}, so ${changed.join(', ')} cannot change in place. Split it from the instance where the change applies.`,
                        { fields: changed, reason, split: `/schedules/${id}/split` });
                }
                if (changed.includes('accountId')) requireAccount(refs.account);
            }
            const category = categoryId !== null && categoryId !== current.categoryId ? requireCategory(refs.category) : null;
            const pick = (f) => (structural[f] !== undefined ? structural[f] : current[f]);
            const next = {
                categoryId: categoryId ?? current.categoryId,
                direction: category ? category.direction : current.direction,
                name: name ?? current.name,
                counterparty: counterparty === undefined ? current.counterparty : counterparty,
                notes: notes === undefined ? current.notes : notes,
            };
            for (const f of STRUCTURAL_FIELDS) next[f] = pick(f);
            assertDirection(body.direction, { direction: next.direction });
            if (changed.length) {
                const endError = endsError(next);
                if (endError) throw apiError(400, undefined, endError);
            }

            const descriptive = next.categoryId !== current.categoryId || next.direction !== current.direction
                || next.name !== current.name || next.counterparty !== current.counterparty || next.notes !== current.notes;
            if (!descriptive && !changed.length) return (await decorateSchedules(conn, [row], today))[0];

            await conn.query(
                `UPDATE schedules
                    SET category_id = ?, direction = ?, name = ?, counterparty = ?, notes = ?,
                        amount = ?, currency = ?, account_id = ?, frequency = ?, interval_count = ?, start_date = ?,
                        occurrence_count = ?, end_date = ?, weekend_rule = ?, settle_mode = ?,
                        row_version = row_version + 1
                  WHERE id = ?`,
                [next.categoryId, next.direction, next.name, next.counterparty, next.notes,
                    formatMinor(parseMinor(next.amount)), next.currency, next.accountId, next.frequency,
                    next.intervalCount, next.startDate, next.occurrenceCount, next.endDate, next.weekendRule,
                    next.settleMode, id]
            );
            const after = await readSchedule(conn, id);
            await recordAudit(conn, {
                entityType: 'schedule', entityId: id, action: 'update',
                before: current, after: scheduleToJson(after), userEmail: req.userEmail,
            });
            return (await decorateSchedules(conn, [after], today))[0];
        });
        res.json(updated);
    }));

    router.delete('/schedules/:id', handle('schedules-delete', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const baseVersion = parseBaseVersion(req.body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        await withTransaction(async (conn) => {
            const row = await lockSchedule(conn, id, baseVersion);
            await conn.query(
                'UPDATE schedules SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?', [id]
            );
            await recordAudit(conn, {
                entityType: 'schedule', entityId: id, action: 'delete', before: scheduleToJson(row),
                after: scheduleToJson(await readSchedule(conn, id, { includeDeleted: true })), userEmail: req.userEmail,
            });
        });
        res.status(204).end();
    }));

    // ── Instances ───────────────────────────────────────────────────────────

    /** `?from&to` with D35's defaults → {from, to}, or answers 400 and returns null. */
    const instanceWindow = (req, res, today) => {
        const from = req.query.from === undefined ? addDays(today, -DEFAULT_BACK_DAYS) : req.query.from;
        const to = req.query.to === undefined ? addDays(today, DEFAULT_AHEAD_DAYS) : req.query.to;
        let message = null;
        let details;
        if (!isValidDate(from)) message = 'from must be a real date, YYYY-MM-DD.';
        else if (!isValidDate(to)) message = 'to must be a real date, YYYY-MM-DD.';
        else if (to < from) message = 'to must be on or after from.';
        else if (diffDays(to, from) > INSTANCE_SPAN_DAYS) {
            message = `The window spans at most ${INSTANCE_SPAN_DAYS} days.`;
            details = { from, to };
        }
        if (message !== null) {
            fail(res, 400, message, undefined, details);
            return null;
        }
        return { from, to };
    };

    // §6.9 across schedules (Dev, 2026-10-07): every instance in the window of every live
    // schedule in scope, each with its schedule's name and account, so one screen can list
    // what a recorded balance assumed — money in and out — without opening each schedule.
    router.get('/instances', handle('instances-across', async (req, res) => {
        const today = todayFor(req);
        const window = instanceWindow(req, res, today);
        if (!window) return;
        const where = ['s.deleted_at IS NULL'];
        const params = [];
        for (const [key, column] of [['accountId', 's.account_id'], ['companyId', 'a.company_id'], ['categoryId', 's.category_id']]) {
            if (req.query[key] === undefined || req.query[key] === 'all') continue;
            const value = parseId(req.query[key]);
            if (!value) return fail(res, 400, `${key} must be a positive integer.`);
            where.push(`${column} = ?`);
            params.push(value);
        }
        let bands = null;
        if (req.query.derivedStatus !== undefined) {
            bands = String(req.query.derivedStatus).split(',').map((s) => s.trim());
            if (!bands.length || bands.some((b) => !DERIVED_STATUSES.includes(b))) {
                return fail(res, 400, `derivedStatus must be a comma list of: ${DERIVED_STATUSES.join(', ')}.`);
            }
        }
        const data = await withConnection(async (c) => {
            const [rows] = await c.query(`${SCHEDULE_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.id ASC`, params);
            const out = [];
            for (const row of rows) {
                const s = scheduleToJson(row);
                const schedule = {
                    id: s.id, name: s.name, counterparty: s.counterparty, accountId: s.accountId, companyId: s.companyId,
                    categoryId: s.categoryId, status: s.status,
                };
                const { data: instances } = await listInstances(c, s, { ...window, today });
                for (const i of instances) if (bands === null || bands.includes(i.derivedStatus)) out.push({ ...i, schedule });
            }
            return out.sort((x, y) => (x.dueDate < y.dueDate ? -1 : x.dueDate > y.dueDate ? 1 : x.scheduleId - y.scheduleId
                || (x.naturalDate < y.naturalDate ? -1 : x.naturalDate > y.naturalDate ? 1 : 0)));
        });
        res.json({ data });
    }));

    router.get('/schedules/:id/instances', handle('instances-list', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const today = todayFor(req);
        const window = instanceWindow(req, res, today);
        if (!window) return;
        const { from, to } = window;
        const out = await withConnection(async (c) => {
            const row = await readSchedule(c, id);
            return row ? listInstances(c, scheduleToJson(row), { from, to, today }) : null;
        });
        if (!out) return fail(res, 404, 'Schedule not found.');
        res.json(out);
    }));

    /** The `:naturalDate` path segment → the date, or answers 400 and returns null. */
    const pathDate = (req, res) => {
        const date = req.params.naturalDate;
        if (!isValidDate(date)) {
            fail(res, 400, 'The instance date must be a real date, YYYY-MM-DD.');
            return null;
        }
        return date;
    };

    // §10.4 tune: upsert the override. `null` clears a column back to the schedule's.
    router.put('/schedules/:id/instances/:naturalDate', handle('instances-tune', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const naturalDate = pathDate(req, res);
        if (!naturalDate) return;
        const body = req.body || {};
        const has = (k) => body[k] !== undefined;
        if (!TUNE_FIELDS.some(has)) return fail(res, 400, `Nothing to tune: send any of ${TUNE_FIELDS.join(', ')}.`);
        let amount;
        if (has('amount') && body.amount !== null) {
            const minor = parseMoney(body.amount);
            if (minor === null || minor <= 0n) return fail(res, 400, 'amount must be a decimal string greater than zero, or null.');
            amount = formatMinor(minor);
        } else if (has('amount')) amount = null;
        if (has('dueDate') && body.dueDate !== null && !isValidDate(body.dueDate)) {
            return fail(res, 400, 'dueDate must be a real date, YYYY-MM-DD, or null.');
        }
        const note = parseText(body.note, MAX_NOTE);
        if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
        if (has('settleMode') && body.settleMode !== null && !SETTLE_MODES.includes(body.settleMode)) {
            return fail(res, 400, `settleMode must be one of: ${SETTLE_MODES.join(', ')}, or null.`);
        }
        if (has('status') && body.status !== null && !TUNE_STATUSES.includes(body.status)) {
            return fail(res, 400, 'status may only be expected or skipped here; pay and unpay set paid and part_paid.');
        }
        const baseVersion = parseBaseVersion(body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const today = todayFor(req);

        const tuned = await withTransaction(async (conn) => {
            const { schedule, override } = await lockInstance(conn, id, naturalDate, baseVersion);
            const paymentState = override !== null && hasPaymentState(override);
            if (paymentState) {
                const locked = [];
                if (has('amount') && !sameAmount(amount, override.amount)) locked.push('amount');
                if (has('status') && body.status !== override.status) locked.push('status');
                if (locked.length) {
                    throw overrideHasPayment(override,
                        `This instance carries payments: unpay it before changing ${locked.join(' or ')}. Its date, note and settle mode stay editable.`);
                }
            }
            const was = override || { amount: null, dueDate: null, status: null, settleMode: null, note: null };
            const next = {
                amount: has('amount') ? amount : was.amount,
                dueDate: has('dueDate') ? body.dueDate : was.dueDate,
                status: has('status') ? body.status : was.status,
                settleMode: has('settleMode') ? body.settleMode : was.settleMode,
                note: note === undefined ? was.note : note,
            };
            if (!paymentState && Object.values(next).every((v) => v == null)) {
                throw apiError(400, undefined, "Nothing to tune: every field would be the schedule's again. DELETE reverts the instance.");
            }
            if (!override) {
                await insertOverride(conn, id, naturalDate, next, req.userEmail);
            } else if (!sameAmount(next.amount, was.amount) || next.dueDate !== was.dueDate || next.status !== was.status
                || next.settleMode !== was.settleMode || next.note !== was.note) {
                await conn.query(
                    `UPDATE schedule_overrides
                        SET amount = ?, due_date = ?, status = ?, settle_mode = ?, note = ?, row_version = row_version + 1
                      WHERE id = ?`,
                    [next.amount, next.dueDate, next.status, next.settleMode, next.note, override.id]
                );
                await recordAudit(conn, {
                    entityType: 'schedule_override', entityId: override.id, action: 'update',
                    before: override, after: await readOverride(conn, override.id), userEmail: req.userEmail,
                });
            }
            return readInstance(conn, schedule, naturalDate, today);
        });
        res.json(tuned);
    }));

    // §10.4 revert: hard-delete the override; never one carrying payment state.
    router.delete('/schedules/:id/instances/:naturalDate', handle('instances-revert', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const naturalDate = pathDate(req, res);
        if (!naturalDate) return;
        const baseVersion = parseBaseVersion(req.body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

        await withTransaction(async (conn) => {
            const { override } = await lockInstance(conn, id, naturalDate, baseVersion);
            if (!override) throw apiError(404, undefined, 'This instance is not tuned: there is nothing to revert.');
            if (hasPaymentState(override)) {
                throw overrideHasPayment(override, 'This instance carries payments: unpay it before reverting it.');
            }
            await conn.query('DELETE FROM schedule_overrides WHERE id = ?', [override.id]);
            await recordAudit(conn, {
                entityType: 'schedule_override', entityId: override.id, action: 'delete',
                before: override, after: null, userEmail: req.userEmail,
            });
        });
        res.status(204).end();
    }));

    // §10.4 pay: the override row (created when none), one payments row, the cache
    // rewritten from the rows, the status — all under the schedule lock.
    router.post('/schedules/:id/instances/:naturalDate/pay', handle('instances-pay', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const naturalDate = pathDate(req, res);
        if (!naturalDate) return;
        const body = req.body || {};
        const paidOn = body.paidOn;
        if (!isValidDate(paidOn)) return fail(res, 400, 'paidOn is required: a real date, YYYY-MM-DD.');
        const sentAmount = body.paidAmount !== undefined && body.paidAmount !== null;
        const paidAmount = sentAmount ? parseMoney(body.paidAmount) : undefined;
        if (paidAmount === null) {
            return fail(res, 400, 'paidAmount must be a decimal string with up to two decimals, e.g. "250.00".');
        }
        const note = parseText(body.note, MAX_NOTE);
        if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
        const hasRemainderDate = body.remainderDueDate !== undefined && body.remainderDueDate !== null;
        const remainderDueDate = hasRemainderDate ? body.remainderDueDate : null;
        if (hasRemainderDate && !isValidDate(remainderDueDate)) {
            return fail(res, 400, 'remainderDueDate must be a real date, YYYY-MM-DD.');
        }
        const baseVersion = parseBaseVersion(body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const today = todayFor(req);
        if (paidOn > today) {
            throw apiError(422, 'PAID_ON_IN_FUTURE', 'A payment cannot be dated after today.', { paidOn, today });
        }
        if (hasRemainderDate && remainderDueDate < today) {
            return fail(res, 400, 'remainderDueDate must be today or later.', undefined, { remainderDueDate, today });
        }

        const paid = await withTransaction(async (conn) => {
            const { schedule, override: existing } = await lockInstance(conn, id, naturalDate, baseVersion);
            const effective = effectiveValues(schedule, naturalDate, existing);   // §3.4
            const amountMinor = parseMinor(effective.amount);
            const remaining = amountMinor - (existing && existing.paidAmount != null ? parseMinor(existing.paidAmount) : 0n);
            const payMinor = paidAmount === undefined ? remaining : paidAmount;
            if (remaining <= 0n || payMinor <= 0n || payMinor > remaining) {
                throw apiError(422, 'PAID_AMOUNT_INVALID',
                    remaining <= 0n ? 'Nothing remains to be paid on this instance.'
                        : payMinor <= 0n ? 'paidAmount must be greater than zero.'
                            : `paidAmount is more than the ${formatMinor(remaining)} still owed.`,
                    { paidAmount: formatMinor(payMinor), remainingAmount: formatMinor(remaining) });
            }
            if (payMinor < remaining && effective.effectiveDate < today && !hasRemainderDate) {
                throw apiError(422, 'REMAINDER_DATE_REQUIRED',
                    'This instance is already due: a part payment needs a date (today or later) for the remainder.',
                    { dueDate: effective.effectiveDate, today });
            }

            const override = existing || await insertOverride(conn, id, naturalDate, {}, req.userEmail);
            await insertPayment(conn, { overrideId: override.id }, { paidOn, amountMinor: payMinor, note, userEmail: req.userEmail });
            const cache = await paymentCache(conn, { overrideId: override.id });
            const status = parseMinor(cache.paidAmount) >= amountMinor ? 'paid' : 'part_paid';
            await conn.query(
                `UPDATE schedule_overrides
                    SET paid_amount = ?, paid_on = ?, status = ?, due_date = ?, row_version = row_version + 1
                  WHERE id = ?`,
                [cache.paidAmount, cache.paidOn, status, hasRemainderDate ? remainderDueDate : override.dueDate, override.id]
            );
            await recordAudit(conn, {
                entityType: 'schedule_override', entityId: override.id, action: 'pay',
                before: override, after: await readOverride(conn, override.id), userEmail: req.userEmail,
            });
            return readInstance(conn, schedule, naturalDate, today);
        });
        res.json(paid);
    }));

    // §10.4 unpay: every payment row deleted (one audit row each); status and the cache
    // cleared on the override, which is kept. Nothing to undo → unchanged, no audit.
    router.post('/schedules/:id/instances/:naturalDate/unpay', handle('instances-unpay', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const naturalDate = pathDate(req, res);
        if (!naturalDate) return;
        const baseVersion = parseBaseVersion(req.body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const today = todayFor(req);

        const unpaid = await withTransaction(async (conn) => {
            const { schedule, override } = await lockInstance(conn, id, naturalDate, baseVersion);
            if (override) {
                const deleted = await deletePayments(conn, { overrideId: override.id }, req.userEmail);
                if (deleted || override.status === 'paid' || override.status === 'part_paid'
                    || override.paidAmount != null || override.paidOn != null) {
                    await conn.query(
                        `UPDATE schedule_overrides
                            SET status = NULL, paid_on = NULL, paid_amount = NULL, row_version = row_version + 1
                          WHERE id = ?`,
                        [override.id]
                    );
                    await recordAudit(conn, {
                        entityType: 'schedule_override', entityId: override.id, action: 'unpay',
                        before: override, after: await readOverride(conn, override.id), userEmail: req.userEmail,
                    });
                }
            }
            return readInstance(conn, schedule, naturalDate, today);
        });
        res.json(unpaid);
    }));

    // ── Split and end (§10.5) ───────────────────────────────────────────────

    router.post('/schedules/:id/split', handle('schedules-split', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const body = req.body || {};
        if (!isValidDate(body.fromNaturalDate)) return fail(res, 400, 'fromNaturalDate is required: a real date, YYYY-MM-DD.');
        const raw = body.changes;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            return fail(res, 400, 'changes is required: an object of the structural fields to change.');
        }
        if (raw.activeFrom !== undefined) return fail(res, 400, 'activeFrom is set by the server (D21); leave it out of changes.');
        const other = Object.keys(raw).filter((k) => !STRUCTURAL_FIELDS.includes(k));
        if (other.length) {
            return fail(res, 400,
                `changes holds structural fields only (${STRUCTURAL_FIELDS.join(', ')}): edit ${other.join(', ')} with PUT /schedules/:id.`,
                undefined, { fields: other });
        }
        if (!STRUCTURAL_FIELDS.some((k) => raw[k] !== undefined)) {
            return fail(res, 400, `changes must hold at least one structural field: ${STRUCTURAL_FIELDS.join(', ')}.`);
        }
        const { values: changes, error } = structureOf(raw);
        if (error) return fail(res, 400, error);
        if (changes.occurrenceCount != null && changes.endDate != null) return fail(res, 400, BOTH_ENDS);
        const drops = parseDrops(body);
        if (drops.error) return fail(res, 400, drops.error);
        const baseVersion = parseBaseVersion(body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const today = todayFor(req);

        const result = await withTransaction((conn) => splitOrEnd(conn, {
            action: 'split', scheduleId: id, date: body.fromNaturalDate, changes, ...drops.values,
            baseVersion, today, userEmail: req.userEmail,
        }));
        res.status(201).json(result);
    }));

    router.post('/schedules/:id/end', handle('schedules-end', async (req, res) => {
        const id = pathId(req, res);
        if (!id) return;
        const body = req.body || {};
        if (!isValidDate(body.lastNaturalDate)) return fail(res, 400, 'lastNaturalDate is required: a real date, YYYY-MM-DD.');
        const drops = parseDrops(body);
        if (drops.error) return fail(res, 400, drops.error);
        const baseVersion = parseBaseVersion(body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const today = todayFor(req);

        const result = await withTransaction((conn) => splitOrEnd(conn, {
            action: 'end', scheduleId: id, date: body.lastNaturalDate, ...drops.values,
            baseVersion, today, userEmail: req.userEmail,
        }));
        res.json(result);
    }));

    return router;
}

module.exports = factory;
// The split / end transaction body, for the two-connection e2e test that holds it open.
module.exports.splitOrEnd = splitOrEnd;
