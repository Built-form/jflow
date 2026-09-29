'use strict';

// Scenario reads, locks and target resolution for routes/scenarios.js (CONTRACT §6.11,
// §10.1, §10.7–10.10).
//
// Reads under REPEATABLE READ. loadTarget (services/forecastLoad.js) reads with plain
// SELECTs, and a plain SELECT sees the snapshot taken by the transaction's FIRST plain
// read. So the transactions that re-check targets (adjustment write, rebase, apply) take
// every lock with locking reads first — the scenario row, its adjustments, the target
// rows — and only then read plainly. The snapshot is then taken after every lock is held,
// and a pay that committed while we waited on a schedule or item lock is visible to the
// re-check.

const { apiError, adjustmentToJson } = require('../lib/shape');
const { adjustmentStale } = require('../lib/stale');
const { loadTarget } = require('./forecastLoad');

/** A scenario row with its derived `adjustment_count` (§6.11 row JSON). Callers append `WHERE …`. */
const SCENARIO_SELECT = `SELECT s.*,
            (SELECT COUNT(*) FROM scenario_adjustments a WHERE a.scenario_id = s.id) AS adjustment_count
       FROM scenarios s`;

/** One scenario row with `adjustment_count` (API responses), or null. Live only unless `includeDeleted`. */
async function readScenario(conn, id, { includeDeleted = false } = {}) {
    const [rows] = await conn.query(
        `${SCENARIO_SELECT} WHERE s.id = ?${includeDeleted ? '' : ' AND s.deleted_at IS NULL'}`, [id]
    );
    return rows.length ? rows[0] : null;
}

/** The bare row (audit snapshots carry no derived count), deleted or not. */
async function readScenarioRow(conn, id) {
    const [rows] = await conn.query('SELECT * FROM scenarios WHERE id = ?', [id]);
    return rows.length ? rows[0] : null;
}

/** `SELECT … FOR UPDATE` on the live scenario row (§10.7–10.9 step 1) → 404 when not live. */
async function lockScenario(conn, id) {
    const [rows] = await conn.query('SELECT * FROM scenarios WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows.length) throw apiError(404, undefined, 'Scenario not found.');
    return rows[0];
}

/** Adjustments are writable, rebased and applied only on a draft (§6.11, §2.7). */
function requireDraft(row) {
    if (row.status !== 'draft') {
        throw apiError(409, 'SCENARIO_NOT_DRAFT',
            `This scenario is ${row.status}: its adjustments are history now. Duplicate it to rework it.`,
            { status: row.status });
    }
}

/**
 * The scenario's adjustments ascending by id. `lock` makes it a locking read (rebase and
 * apply), which also keeps it from fixing the transaction's snapshot before the target
 * locks (see the header).
 */
async function readAdjustments(conn, scenarioId, { lock = false } = {}) {
    const [rows] = await conn.query(
        `SELECT * FROM scenario_adjustments WHERE scenario_id = ? ORDER BY id ASC${lock ? ' FOR UPDATE' : ''}`,
        [scenarioId]
    );
    return rows;
}

/** An adjustment row's parsed key, from its `target_*` columns (§4: lookups never parse strings). */
const targetOf = (row) => ({
    targetKind: row.target_kind,
    targetId: String(row.target_id),
    targetDate: row.target_date ?? null,
});

/** Ascending numeric order on decimal id strings (up to 18 digits: beyond a double). */
const byId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * Lock the targets of `parsedKeys` in the standing order (§10.1, §10.9 step 2):
 * `schedules` rows of the `sched.` targets ascending by id, then `cash_items` rows of the
 * `item.` targets ascending by id, then the `schedule_overrides` rows of the `sched.`
 * targets that exist. A `ship.` key locks nothing (D8). A row that is not live is simply
 * not there; loadTarget then answers null (TARGET_MISSING).
 *
 * The override rows: every writer of an override holds its schedule's lock (taken just
 * above), so the set of overrides for these schedules cannot change now. The plain read
 * that finds them is the transaction's first non-locking read — its snapshot is taken
 * after every schedule and item lock — and the rows it finds are then locked by primary
 * key, a record lock with no gap.
 */
async function lockTargets(conn, parsedKeys) {
    const ids = (kind) => [...new Set(parsedKeys.filter((p) => p && p.targetKind === kind).map((p) => p.targetId))].sort(byId);
    for (const id of ids('sched')) {
        await conn.query('SELECT id FROM schedules WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    }
    for (const id of ids('item')) {
        await conn.query('SELECT id FROM cash_items WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    }
    const instances = parsedKeys.filter((p) => p && p.targetKind === 'sched');
    if (!instances.length) return;
    const [rows] = await conn.query(
        `SELECT id FROM schedule_overrides
          WHERE (schedule_id, natural_date) IN (${instances.map(() => '(?, ?)').join(', ')})
          ORDER BY schedule_id ASC, natural_date ASC`,
        instances.flatMap((p) => [p.targetId, p.targetDate])
    );
    for (const r of rows) {
        await conn.query('SELECT id FROM schedule_overrides WHERE id = ? FOR UPDATE', [r.id]);
    }
}

/**
 * loadTarget (§8) plus the target's `name`, which loadTarget does not return and an
 * adjustment's `current` carries (the web's scenario screen shows it). Same null cases:
 * not live, not an occurrence, a `ship.` key.
 */
async function loadCurrent(conn, parsed, today) {
    const target = await loadTarget(conn, parsed, today);
    if (!target) return null;
    const table = target.kind === 'item' ? 'cash_items' : 'schedules';
    const [rows] = await conn.query(`SELECT name FROM ${table} WHERE id = ?`, [target.id]);
    return { ...target, name: rows.length ? rows[0].name : null };
}

/** An adjustment's `current` (§6.11, plus name and currency): the target's pre-adjustment effective values, or null. */
function currentJson(target) {
    if (!target) return null;
    return {
        date: target.effectiveDate,
        amount: target.effectiveAmount,
        status: target.status,
        name: target.name,
        currency: target.currency,
    };
}

/**
 * Adjustment rows → JSON with `stale` and `current` (§6.11): resolved against `today`
 * while the scenario is a draft, null on an applied or archived one (history, not a live
 * comparison).
 */
async function resolveAdjustments(conn, scenario, rows, today) {
    const out = [];
    for (const row of rows) {
        const adj = adjustmentToJson(row);
        if (scenario.status !== 'draft') {
            out.push({ ...adj, stale: null, current: null });
            continue;
        }
        const target = await loadCurrent(conn, targetOf(row), today);
        out.push({ ...adj, stale: adjustmentStale(adj, target, today), current: currentJson(target) });
    }
    return out;
}

module.exports = {
    SCENARIO_SELECT,
    readScenario,
    readScenarioRow,
    lockScenario,
    requireDraft,
    readAdjustments,
    targetOf,
    lockTargets,
    loadCurrent,
    currentJson,
    resolveAdjustments,
};
