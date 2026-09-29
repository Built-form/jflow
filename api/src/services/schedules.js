'use strict';

// Schedule and instance reads shared by the schedule routes and the D17 deactivation
// guard (routes/accounts.js): `schedules` rows → the schedule JSON of CONTRACT §6.8
// (with `successorId` and `structureLocked`), and a schedule's instances → the
// instance JSON of §6.9 with `payments[]` and `derivedStatus`.
//
// `derivedStatus` is ONE classify call per instance through lib/lines.js, against the
// account's anchor (D12: none → null) and the request's `today` — the same call
// /forecast makes (§9.6). Instances themselves are shaped by lib/instances.js.
//
// Reads only: nothing here takes a lock, except where a caller asks for `FOR SHARE`
// (the D17 guard, which reads under its account lock in the standing order).

const { instanceDerivedStatus } = require('../lib/lines');
const { buildInstance, expandInstances, hasOccurrenceOnOrAfter, owedCandidateDates } = require('../lib/instances');
const { scheduleToJson, overrideToJson, paymentToJson } = require('../lib/shape');
const { loadAnchors } = require('./forecastLoad');

/**
 * A `schedules` row with its company, derived through the account (§3.4). Callers append
 * `WHERE …`. A locking read through it names the schedule alone (`FOR UPDATE OF s`), so
 * the joined reference row is never locked after a standing-order row (§10.1).
 */
const SCHEDULE_SELECT = `SELECT s.*, a.company_id
       FROM schedules s
       LEFT JOIN bank_accounts a ON a.id = s.account_id`;

const marks = (list) => list.map(() => '?').join(', ');

/** Distinct positive integer ids, ascending. */
function uniqueIds(ids) {
    return [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/** One schedule row (with `company_id`), or null. Live only unless `includeDeleted`. */
async function readSchedule(conn, id, { includeDeleted = false } = {}) {
    const [rows] = await conn.query(
        `${SCHEDULE_SELECT} WHERE s.id = ?${includeDeleted ? '' : ' AND s.deleted_at IS NULL'}`, [id]
    );
    return rows.length ? rows[0] : null;
}

/**
 * Rows selected through SCHEDULE_SELECT → schedule JSON with `successorId` (the live
 * schedule whose predecessor_id is this one; the latest when a series was split twice)
 * and `structureLocked` (D37: start_date <= today, or an override row exists).
 */
async function decorateSchedules(conn, rows, today) {
    if (!rows.length) return [];
    const ids = uniqueIds(rows.map((r) => r.id));
    const [successors] = await conn.query(
        `SELECT predecessor_id, MAX(id) AS id FROM schedules
          WHERE predecessor_id IN (${marks(ids)}) AND deleted_at IS NULL
          GROUP BY predecessor_id`,
        ids
    );
    const [tuned] = await conn.query(
        `SELECT DISTINCT schedule_id FROM schedule_overrides WHERE schedule_id IN (${marks(ids)})`, ids
    );
    const successorOf = new Map(successors.map((r) => [Number(r.predecessor_id), Number(r.id)]));
    const hasOverrides = new Set(tuned.map((r) => Number(r.schedule_id)));
    return rows.map((r) => scheduleToJson(r, {
        successorId: successorOf.get(Number(r.id)) ?? null,
        structureLocked: r.start_date <= today || hasOverrides.has(Number(r.id)),
    }));
}

/**
 * The override rows of these schedules as override JSON, ascending by schedule and
 * natural date. `lock: 'FOR SHARE'` makes it a locking read (the caller holds the
 * schedule rows, so this is in the standing order).
 */
async function loadOverrides(conn, scheduleIds, { lock = '' } = {}) {
    const ids = uniqueIds(scheduleIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `SELECT * FROM schedule_overrides WHERE schedule_id IN (${marks(ids)})
          ORDER BY schedule_id ASC, natural_date ASC${lock ? ` ${lock}` : ''}`,
        ids
    );
    return rows.map(overrideToJson);
}

/** Every payment row of these overrides (the instance JSON's `payments[]`), ascending by paid_on, id. */
async function loadOverridePayments(conn, overrideIds) {
    const ids = uniqueIds(overrideIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `SELECT * FROM payments WHERE override_id IN (${marks(ids)}) ORDER BY paid_on ASC, id ASC`, ids
    );
    return rows.map(paymentToJson);
}

function groupBy(list, key) {
    const out = new Map();
    for (const x of list) {
        if (!out.has(x[key])) out.set(x[key], []);
        out.get(x[key]).push(x);
    }
    return out;
}

/** The account's anchor date for `today`, or null (D12). */
async function anchorOf(conn, accountId, today) {
    const anchor = (await loadAnchors(conn, [accountId], today)).get(Number(accountId));
    return anchor ? anchor.anchorDate : null;
}

/**
 * Instances of `schedule` (schedule JSON) at these natural dates with these overrides
 * (override JSON by natural date) → instance JSON with `payments[]` and `derivedStatus`.
 */
async function decorateInstances(conn, schedule, entries, today) {
    const payments = groupBy(
        await loadOverridePayments(conn, entries.filter((e) => e.override).map((e) => e.override.id)),
        'overrideId'
    );
    const A = await anchorOf(conn, schedule.accountId, today);
    return entries.map(({ naturalDate, override }) => {
        const inst = buildInstance(schedule, naturalDate, override, override ? payments.get(override.id) || [] : []);
        inst.derivedStatus = instanceDerivedStatus(inst, A, today);
        return inst;
    });
}

/**
 * GET /schedules/:id/instances: the natural dates in [from, to] with their overrides,
 * and every orphan override of the schedule (§5.5).
 */
async function listInstances(conn, schedule, { from, to, today }) {
    const overrides = await loadOverrides(conn, [schedule.id]);
    const { instances, orphans } = expandInstances(schedule, overrides, from, to);
    return { data: await decorateInstances(conn, schedule, instances, today), orphans };
}

/**
 * One instance, read fresh: the caller has checked `naturalDate` is an occurrence (and,
 * for a write, holds the schedule lock, so this read sees its own writes).
 */
async function readInstance(conn, schedule, naturalDate, today) {
    const [rows] = await conn.query(
        'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND natural_date = ?', [schedule.id, naturalDate]
    );
    const override = rows.length ? overrideToJson(rows[0]) : null;
    return (await decorateInstances(conn, schedule, [{ naturalDate, override }], today))[0];
}

/**
 * The D17 guard's schedule side, for the account's live schedules (rows the caller has
 * read FOR SHARE under its account lock):
 *   liveScheduleIds  the schedules that still generate an instance on or after today;
 *   instances        every instance that can be owed (lib/instances.js
 *                    owedCandidateDates), with `derivedStatus`, ascending by natural
 *                    date then schedule — the caller keeps the overdue / unresolved ones.
 * Overrides are read FOR SHARE: after the schedule rows and the caller's cash_items
 * read, which is the standing order (§10.1).
 */
async function scheduleOwedState(conn, scheduleRows, today) {
    const schedules = scheduleRows.map((r) => scheduleToJson(r));
    const overrides = groupBy(await loadOverrides(conn, schedules.map((s) => s.id), { lock: 'FOR SHARE' }), 'scheduleId');
    const liveScheduleIds = [];
    const instances = [];
    for (const schedule of schedules) {
        const own = overrides.get(schedule.id) || [];
        if (hasOccurrenceOnOrAfter(schedule, own, today)) liveScheduleIds.push(schedule.id);
        const byDate = new Map(own.map((o) => [o.naturalDate, o]));
        const dates = owedCandidateDates(schedule, own, today);
        if (!dates.length) continue;
        instances.push(...await decorateInstances(
            conn, schedule, dates.map((d) => ({ naturalDate: d, override: byDate.get(d) || null })), today
        ));
    }
    instances.sort((x, y) => (x.naturalDate < y.naturalDate ? -1 : x.naturalDate > y.naturalDate ? 1 : x.scheduleId - y.scheduleId));
    return { liveScheduleIds: liveScheduleIds.sort((a, b) => a - b), instances };
}

module.exports = {
    SCHEDULE_SELECT,
    readSchedule,
    decorateSchedules,
    loadOverrides,
    listInstances,
    readInstance,
    scheduleOwedState,
};
