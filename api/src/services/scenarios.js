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
//
// Phase 2 (step 21): `ship.` targets lock their external_items rows after cash_items and
// before schedule_overrides, ascending id (P11). Their ids are found with a plain read, so
// for them the snapshot comes BEFORE the lock; lockTargets closes that gap with a
// row_version check and a restart (see there).
//
// Scenario adds (2026-10-07, D39–D41): an `add` row has no target. Its references (account,
// category) are read with forecastLoad.js loadAddReferences — plainly on a read, after a
// FOR SHARE on both when a write depends on them (§10.1's exception, which comes before any
// standing-order lock in the add write, §10.7a, and before lockTargets in apply, §10.9).
// lockTargets never sees a `new.` key (it locks item, sched and ship targets only).

const { randomUUID } = require('crypto');

const { apiError, adjustmentToJson, externalItemToJson } = require('../lib/shape');
const { buildNewKey } = require('../lib/keys');
const { shipName } = require('../lib/lines');
const { shipCategoryOf } = require('../lib/engine');
const { adjustmentStale } = require('../lib/stale');
const { loadTarget, loadAddReferences, loadShipCategory } = require('./forecastLoad');
const { readExternalItem } = require('./externalItems');

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

/** One adjustment row by id, or null. */
async function readAdjustmentRow(conn, id) {
    const [rows] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [id]);
    return rows.length ? rows[0] : null;
}

/**
 * INSERT one scenario_adjustments row → its id. `f` is in the adjustment JSON's names. An
 * `add` (D39) is keyed by its own id, so it goes in under a placeholder key
 * (`new.pending.<uuid>`, never visible) and target_id '0', and the same transaction then
 * writes item_key = new.<id>, target_kind 'new', target_id = '<id>' (§4, §10.7a step 4); its
 * bases are NULL. `anchor: true` makes the row its own split group (D40: split_group = its
 * id, §10.7b step 6); otherwise `f.splitGroup` (or NULL). No audit here: the caller writes
 * `create` with the final row.
 */
async function insertAdjustment(conn, f, { anchor = false } = {}) {
    const isAdd = f.kind === 'add';
    const [ins] = await conn.query(
        `INSERT INTO scenario_adjustments
            (scenario_id, item_key, target_kind, target_id, target_date, kind, new_date, new_amount, base_date,
             base_amount, note, account_id, category_id, direction, name, counterparty, currency, split_group,
             created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.scenarioId, isAdd ? `new.pending.${randomUUID()}` : f.itemKey, isAdd ? 'new' : f.targetKind,
            isAdd ? '0' : f.targetId, isAdd ? null : f.targetDate ?? null, f.kind, f.newDate ?? null,
            f.newAmount ?? null, isAdd ? null : f.baseDate, isAdd ? null : f.baseAmount, f.note ?? null,
            f.accountId ?? null, f.categoryId ?? null, f.direction ?? null, f.name ?? null, f.counterparty ?? null,
            f.currency ?? null, anchor ? null : f.splitGroup ?? null, f.createdBy]
    );
    const id = ins.insertId;
    if (isAdd) {
        await conn.query('UPDATE scenario_adjustments SET item_key = ?, target_id = ? WHERE id = ?', [buildNewKey(id), String(id), id]);
    }
    if (anchor) await conn.query('UPDATE scenario_adjustments SET split_group = ? WHERE id = ?', [id, id]);
    return id;
}

/**
 * §10.9 step 2 (D39): FOR SHARE on the accounts and the categories of these `add` rows,
 * each ascending by id — §10.1's exception, taken before lockTargets so a reference is
 * never locked after a standing-order target. A row that is not live is simply not
 * locked; loadAddReferences then reads it dead (TARGET_MISSING).
 */
async function shareAddReferences(conn, addRows) {
    const ids = (column) => [...new Set(addRows.map((r) => r[column]).filter((v) => v != null).map(String))].sort(byId);
    for (const accountId of ids('account_id')) {
        await conn.query('SELECT id FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR SHARE', [accountId]);
    }
    for (const categoryId of ids('category_id')) {
        await conn.query('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL FOR SHARE', [categoryId]);
    }
}

/**
 * An `add`'s `stale` (§6.11, D39): its references through loadAddReferences, then the
 * engine's rule — TARGET_MISSING, DATE_PASSED or null. `adj` is the adjustment JSON.
 */
async function addStale(conn, adj, today) {
    const refs = await loadAddReferences(conn, adj);
    return adjustmentStale({ ...adj, targetLive: refs.live }, null, today);
}

/**
 * §10.7b step 5: the descriptive fields a split's parts copy from the target, read under
 * the target's lock (`target` is loadCurrent's): `item.` → the cash_items row's category,
 * direction, name and counterparty; `sched.` → the schedules row's; `ship.` → the category
 * the forecast places the line in (the systemKey 'ship' category, or 'freight' for a
 * forwarder's shipment cost — lib/engine.js shipCategoryOf, §9.3.1), direction out, the
 * forecast's name (lib/lines.js shipName) and the supplier. Account and currency come from
 * the target itself.
 */
async function targetDescription(conn, target) {
    if (target.kind === 'ship') {
        const row = externalItemToJson(await readExternalItem(conn, target.id));
        const categories = new Map((await loadShipCategory(conn)).map((c) => [c.id, c]));
        const category = shipCategoryOf(categories, row);
        return { categoryId: category.id, direction: 'out', name: shipName(row), counterparty: row.supplier ?? null };
    }
    const table = target.kind === 'item' ? 'cash_items' : 'schedules';
    const [[row]] = await conn.query(`SELECT category_id, direction, name, counterparty FROM ${table} WHERE id = ?`, [target.id]);
    return { categoryId: Number(row.category_id), direction: row.direction, name: row.name, counterparty: row.counterparty ?? null };
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
 * A synthetic deadlock: withTransaction (D27) re-runs the whole body once, in a fresh
 * transaction with a fresh snapshot. Thrown when a ship row changed between the plain read
 * that found its id and its row lock (lockTargets) — as routes/schedules.js's split race
 * guard does for its own out-of-order case.
 */
function shipLockRestart(id) {
    const err = new Error(`external_items row ${id} changed while the scenario waited for its lock; restarting.`);
    err.code = 'ER_LOCK_DEADLOCK';
    return err;
}

/**
 * Lock the targets of `parsedKeys` in the standing order (§10.1, §10.9 step 2):
 * `schedules` rows of the `sched.` targets ascending by id, then `cash_items` rows of the
 * `item.` targets ascending by id, then (Phase 2, P11) the `external_items` rows of the
 * `ship.` targets ascending by id, gone or not, then the `schedule_overrides` rows of the
 * `sched.` targets that exist. A row that is not live (or absent) is simply not there;
 * loadTarget then answers null (TARGET_MISSING). A `new.` key (an `add`, D39) has no target
 * and is ignored here.
 *
 * The ship rows are named by (source, ext_id) but ordered by id, so their ids are found
 * first — with a plain read, which is then the transaction's first non-locking read and
 * fixes its REPEATABLE READ snapshot before the ship locks. A change that commits while
 * we wait for one of those locks (a refresh UPDATE, an overlay edit, another apply) would
 * be invisible to loadTarget's plain reads, so each row's row_version is read again under
 * its lock: every writer of external_items bumps it (§2.9, §10.12), and a mismatch
 * restarts the body once (shipLockRestart), whose fresh snapshot sees the change. No
 * network I/O: the check is against the snapshot, never live shipping.
 *
 * The override rows: every writer of an override holds its schedule's lock (taken just
 * above), so the set of overrides for these schedules cannot change now. The plain read
 * that finds them comes after every schedule, item and ship lock, and the rows it finds
 * are then locked by primary key, a record lock with no gap.
 */
async function lockTargets(conn, parsedKeys) {
    const ids = (kind) => [...new Set(parsedKeys.filter((p) => p && p.targetKind === kind).map((p) => p.targetId))];
    for (const id of ids('sched').sort(byId)) {
        await conn.query('SELECT id FROM schedules WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    }
    for (const id of ids('item').sort(byId)) {
        await conn.query('SELECT id FROM cash_items WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    }
    const extIds = ids('ship');
    if (extIds.length) {
        const [ships] = await conn.query(
            `SELECT id, row_version FROM external_items
              WHERE source = 'ship' AND ext_id IN (${extIds.map(() => '?').join(', ')})
              ORDER BY id ASC`,
            extIds
        );
        for (const ship of ships) {
            const [[locked]] = await conn.query('SELECT row_version FROM external_items WHERE id = ? FOR UPDATE', [ship.id]);
            if (Number(locked.row_version) !== Number(ship.row_version)) throw shipLockRestart(ship.id);
        }
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
 * not live, not an occurrence; a `ship.` row absent, gone or undated. A ship line's name
 * is the forecast's (lib/lines.js shipName).
 */
async function loadCurrent(conn, parsed, today) {
    const target = await loadTarget(conn, parsed, today);
    if (!target) return null;
    if (target.kind === 'ship') {
        const [rows] = await conn.query(
            "SELECT ext_id, supplier, po_number, feed_kind FROM external_items WHERE source = 'ship' AND ext_id = ?", [target.id]
        );
        const row = rows.find((r) => r.ext_id === target.id);
        return { ...target, name: row ? shipName({ supplier: row.supplier, poNumber: row.po_number, feedKind: row.feed_kind }) : null };
    }
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
 * comparison). An `add` (D39) resolves against its references — TARGET_MISSING,
 * DATE_PASSED or null — and its `current` is always null.
 */
async function resolveAdjustments(conn, scenario, rows, today) {
    const out = [];
    for (const row of rows) {
        const adj = adjustmentToJson(row);
        if (scenario.status !== 'draft') {
            out.push({ ...adj, stale: null, current: null });
            continue;
        }
        if (adj.kind === 'add') {
            out.push({ ...adj, stale: await addStale(conn, adj, today), current: null });
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
    readAdjustmentRow,
    insertAdjustment,
    shareAddReferences,
    addStale,
    targetDescription,
    targetOf,
    byId,
    lockTargets,
    loadCurrent,
    currentJson,
    resolveAdjustments,
};
