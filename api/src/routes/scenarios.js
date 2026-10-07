'use strict';

// Scenario routes (CONTRACT §6.11, §10.7–10.10; D4, D11, D18, D20, D33, D36, D38; Phase 2
// P6, P7, P11 for `ship.` targets — D8 is retired).
//
// A scenario is a named sandbox of adjustments, one per forecast key (§4): `adjust`
// (new date and/or amount) or `exclude`. Rules:
//   - Adjustments are written, deleted, rebased and applied only while the scenario is a
//     `draft` (409 SCENARIO_NOT_DRAFT otherwise); once applied they are the audit trail.
//   - An adjustment's base_date / base_amount come from the loader (loadTarget: the
//     target's current, override-adjusted effective values — D11), never from the body.
//   - Stale checks use lib/stale.js, which is the engine's own §9.5 comparison.
//   - Apply is all or nothing: every adjustment is re-checked under the locks and any
//     stale one refuses the whole apply (409 SCENARIO_STALE), nothing written.
//   - `archived` is terminal and set only by PUT from draft or applied (D36); soft delete
//     keeps the adjustments (D18). Rework an applied scenario by duplicating it, or
//     un-apply it (below).
//   - Adds, splits and un-apply (Dev, 2026-10-07; D39–D44, §10.7a, §10.7b, §10.13): an `add`
//     is a hypothetical one-off keyed new.<its own id>, created only by POST …/adjustments
//     and replaced by PUT on its key; a split writes one `adjust` on the line (the anchor)
//     plus one `add` per further part, all in one split_group, and deleting the anchor
//     deletes the group; apply inserts an add's one-off and records on every adjustment, in
//     applied_state, the before image of what it wrote; un-apply puts that back, all or
//     nothing, and makes the scenario a draft again.
//
// Locks (§10.1): scenario row → schedules (asc id) → cash_items (asc id) → external_items
// (asc id, Phase 2 P11) → overrides, through services/scenarios.js lockScenario /
// lockTargets. An add's account and category are shared (FOR SHARE) first in the add write
// (§10.1's exception, before the scenario lock) and, in apply, before lockTargets. Every read that the re-check depends on happens after those locks (see that
// file's header). No network I/O in any transaction: a `ship.` target is checked against the
// snapshot in external_items, never live shipping, and its apply writes only the overlay
// (§10.9 step 5, P6, P7) — nothing goes back to shipping.

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const { isValidDate } = require('../lib/dates');
const { parseKey } = require('../lib/keys');
const { parseMinor, formatMinor } = require('../lib/money');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, scenarioToJson, adjustmentToJson, itemToJson, overrideToJson,
} = require('../lib/shape');
const { adjustmentStale, staleAfterRebase } = require('../lib/stale');
const { readItem } = require('../services/items');
const { loadTarget, loadAddReferences } = require('../services/forecastLoad');
const { lockExternalItem, auditOverlay, overlaySnapshot } = require('../services/externalItems');
const { shareReferences, requireAccount, requireCategory, assertDirection } = require('../services/references');
const {
    SCENARIO_SELECT, readScenario, readScenarioRow, lockScenario, requireDraft, readAdjustments,
    readAdjustmentRow, insertAdjustment, shareAddReferences, addStale, targetDescription,
    targetOf, lockTargets, loadCurrent, currentJson, resolveAdjustments,
} = require('../services/scenarios');

const MAX_NAME = 255;          // scenarios.name VARCHAR(255)
const MAX_TEXT = 16000;        // scenarios.description TEXT (16,000 four-byte characters fit)
const MAX_NOTE = 500;          // scenario_adjustments.note VARCHAR(500)
const COPY_SUFFIX = ' (copy)';
const PUT_FIELDS = ['name', 'description', 'companyId', 'status'];
const CURRENCY_RE = /^[A-Z]{3}$/;

function parseName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= MAX_NAME ? name : null;
}

/** Optional text: undefined = absent, null = clear (null or blank), else trimmed. NaN = invalid (400). */
function parseText(value, max) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > max) return NaN;
    return value.trim() || null;
}

/** A body id: a positive integer as a JSON number or numeric string, else null. */
function bodyId(value) {
    return typeof value === 'number' || typeof value === 'string' ? parseId(value) : null;
}

/** A DECIMAL money string (D1) → bigint minor units, or null (a JSON number is refused). */
function parseMoney(value) {
    try {
        return parseMinor(value);
    } catch {
        return null;
    }
}

/** DECIMAL strings equal as money ("80" = "80.00"); null only equals null. */
const sameMoney = (a, b) => (a == null || b == null ? a == null && b == null : parseMinor(a) === parseMinor(b));

/** The live company, read before any standing-order lock (reference rows come first, §10.1). */
async function requireCompany(conn, companyId) {
    if (companyId == null) return;
    const [rows] = await conn.query('SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL', [companyId]);
    if (!rows.length) throw apiError(400, undefined, 'companyId is not a live company.');
}

/** `<source name> (copy)`, the source part shortened so the whole fits VARCHAR(255). */
function copyName(name) {
    return `${name.slice(0, MAX_NAME - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

const scenarioOut = async (conn, id) => scenarioToJson(await readScenario(conn, id, { includeDeleted: true }));

const bad = (message) => apiError(400, undefined, message);

/**
 * §10.7a step 1 (D39): an add's body → its fields, mirroring POST /items' grammar; a 400 on
 * a malformed field and 422 ADJUSTMENT_DATE_IN_PAST on a newDate before today — all before
 * the transaction. `kind` is the caller's check. `direction` / `currency` stay undefined
 * when omitted (the category's and the account's, resolved under the reference locks).
 */
function parseAddBody(body, today, directions) {
    const accountId = bodyId(body.accountId);
    if (!accountId) throw bad('accountId is required (a positive integer).');
    const categoryId = bodyId(body.categoryId);
    if (!categoryId) throw bad('categoryId is required (a positive integer).');
    const name = parseName(body.name);
    if (!name) throw bad(`name is required (at most ${MAX_NAME} characters).`);
    const amount = parseMoney(body.newAmount);
    if (amount === null || amount <= 0n) {
        throw bad('newAmount is required: a decimal string greater than zero, e.g. "1024.00".');
    }
    if (!isValidDate(body.newDate)) throw bad('newDate is required: a real date, YYYY-MM-DD.');
    if (body.direction !== undefined && !directions.includes(body.direction)) {
        throw bad(`direction must be one of: ${directions.join(', ')}.`);
    }
    if (body.currency !== undefined && !(typeof body.currency === 'string' && CURRENCY_RE.test(body.currency))) {
        throw bad('currency must be three capital letters, e.g. GBP.');
    }
    const counterparty = parseText(body.counterparty, MAX_NAME);
    if (Number.isNaN(counterparty)) throw bad(`counterparty must be text of at most ${MAX_NAME} characters.`);
    const note = parseText(body.note, MAX_NOTE);
    if (Number.isNaN(note)) throw bad(`note must be text of at most ${MAX_NOTE} characters.`);
    if (body.newDate < today) {
        throw apiError(422, 'ADJUSTMENT_DATE_IN_PAST', 'An added line cannot be dated before today.', { newDate: body.newDate, today });
    }
    return {
        accountId, categoryId, name, newDate: body.newDate, newAmount: formatMinor(amount),
        direction: body.direction, currency: body.currency, counterparty: counterparty ?? null, note: note ?? null,
    };
}

/**
 * §10.7a step 2: §10.1's exception, before any standing-order lock — FOR SHARE on the add's
 * account and category, re-checked live (and the account active) with POST /items' 400s;
 * D14 on a sent direction. → the add's direction (the category's) and currency (the
 * body's, else the account's).
 */
async function shareAddRefs(conn, add) {
    const refs = await shareReferences(conn, { accountId: add.accountId, categoryId: add.categoryId });
    const account = requireAccount(refs.account);
    const category = requireCategory(refs.category);
    assertDirection(add.direction, category);
    return { direction: category.direction, currency: add.currency ?? account.currency };
}

/**
 * §10.7 step 4, D33: the stale reasons a write cannot stand on, as refusals — 404
 * TARGET_MISSING, 409 TARGET_SETTLED. A fresh base cannot be BASE_CHANGED, and a past
 * newDate was refused before the transaction.
 */
function requireLiveTarget(target, key, adj, today) {
    const reason = staleAfterRebase(adj, target, today);
    if (reason === 'TARGET_MISSING') {
        throw apiError(404, 'TARGET_MISSING', 'There is no live forecast line with that key.', { key });
    }
    if (reason === 'TARGET_SETTLED') {
        throw apiError(409, 'TARGET_SETTLED',
            `That line is ${target.status.replace('_', ' ')}: only an expected line can be adjusted.`,
            { key, status: target.status });
    }
    if (reason) throw new Error(`scenarios: unexpected stale reason ${reason} on write`);
}

/**
 * §10.7b step 1: `parts` → [{newDate, newAmount (canonical DECIMAL), amountMinor}], at least
 * two, each a real date and an amount > 0 (400 otherwise). The dates' "today or later" is
 * the caller's 422.
 */
function parseParts(value) {
    if (!Array.isArray(value) || value.length < 2) {
        throw bad('parts must be a list of at least two {newDate, newAmount}.');
    }
    return value.map((p, i) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad(`parts[${i}] must be {newDate, newAmount}.`);
        if (!isValidDate(p.newDate)) throw bad(`parts[${i}].newDate must be a real date, YYYY-MM-DD.`);
        const amountMinor = parseMoney(p.newAmount);
        if (amountMinor === null || amountMinor <= 0n) {
            throw bad(`parts[${i}].newAmount must be a decimal string greater than zero, e.g. "80.00".`);
        }
        return { newDate: p.newDate, newAmount: formatMinor(amountMinor), amountMinor };
    });
}

/** Hard-delete one adjustment row with its audit row (§2.7: only while the scenario is draft). */
async function deleteAdjustment(conn, row, userEmail) {
    await conn.query('DELETE FROM scenario_adjustments WHERE id = ?', [row.id]);
    await recordAudit(conn, {
        entityType: 'scenario_adjustment', entityId: Number(row.id), action: 'delete',
        before: adjustmentToJson(row), after: null, userEmail,
    });
}

/** D40: the row anchors a split group (its split_group is its own id). */
const isAnchor = (row) => row.split_group != null && Number(row.split_group) === Number(row.id);

/** The other rows of the group `anchor` anchors, ascending id, locked. */
async function groupParts(conn, scenarioId, anchor) {
    const [rows] = await conn.query(
        `SELECT * FROM scenario_adjustments WHERE scenario_id = ? AND split_group = ? AND id <> ?
          ORDER BY id ASC FOR UPDATE`,
        [scenarioId, anchor.id, anchor.id]
    );
    return rows;
}

// ── applied_state (D41, §10.9 step 5): the before image apply records, un-apply restores ──

const sourceOf = (r) => (r.source_scenario_id == null ? null : Number(r.source_scenario_id));
/** A cash_items or schedule_overrides row's date, amount and status, verbatim (nothing derived). */
const lineImage = (r) => ({ dueDate: r.due_date ?? null, amount: r.amount ?? null, status: r.status ?? null });
/** An external_items row's overlay as apply recorded it (plannedAt as an ISO instant). */
function shipBeforeImage(r) {
    const o = overlaySnapshot(r);
    return {
        plannedDate: o.plannedDate, plannedAmount: o.plannedAmount, plannedBaseAmount: o.plannedBaseAmount,
        plannedSkipped: o.plannedSkipped, sourceScenarioId: o.sourceScenarioId, plannedBy: o.plannedBy, plannedAt: o.plannedAt,
    };
}
const shipAfterImage = (r) => ({
    plannedDate: r.planned_date ?? null, plannedAmount: r.planned_amount ?? null, plannedSkipped: Number(r.planned_skipped) === 1,
});

/** A row's applied_state (mysql2 parses a JSON column; a string is parsed here), or null. */
function appliedStateOf(row) {
    const v = row.applied_state;
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
}

/** §3.4's "payment state" on a cash_items or schedule_overrides row's cache columns. */
const hasPaymentState = (r) => r.status === 'paid' || r.status === 'part_paid'
    || (r.paid_amount != null && parseMinor(r.paid_amount) > 0n) || r.paid_on != null;

/**
 * §10.9 step 5 for an `item.` target: `adjust` moves due_date / amount, `exclude` skips;
 * both stamp source_scenario_id. The item row is already locked (lockTargets).
 */
async function applyToItem(conn, adj, target, scenarioId, userEmail) {
    const before = await readItem(conn, target.id);
    if (adj.kind === 'exclude') {
        await conn.query(
            `UPDATE cash_items SET status = 'skipped', source_scenario_id = ?, row_version = row_version + 1 WHERE id = ?`,
            [scenarioId, target.id]
        );
    } else {
        await conn.query(
            `UPDATE cash_items SET due_date = ?, amount = ?, source_scenario_id = ?, row_version = row_version + 1 WHERE id = ?`,
            [adj.newDate ?? before.due_date, adj.newAmount ?? before.amount, scenarioId, target.id]
        );
    }
    const after = await readItem(conn, target.id);
    await recordAudit(conn, {
        entityType: 'cash_item', entityId: target.id, action: 'apply',
        before: itemToJson(before), after: itemToJson(after), userEmail,
    });
    return {
        applied: { itemKey: adj.itemKey, kind: adj.kind, wrote: 'cash_item', entityId: target.id },
        state: { kind: 'item', id: target.id, before: { ...lineImage(before), sourceScenarioId: sourceOf(before) }, after: lineImage(after) },
    };
}

/**
 * §10.9 step 5 for a `sched.` target: upsert the instance's override — `adjust` sets
 * due_date (when new_date is set) and amount (when new_amount is set), `exclude` sets
 * status = 'skipped' — stamped with source_scenario_id. The schedule row and the existing
 * override row are already locked (lockTargets); other override columns are kept.
 */
async function applyToInstance(conn, adj, target, scenarioId, userEmail) {
    let before = null;
    let overrideId = target.overrideId;
    if (overrideId) {
        [[before]] = await conn.query('SELECT * FROM schedule_overrides WHERE id = ?', [overrideId]);
        if (adj.kind === 'exclude') {
            await conn.query(
                `UPDATE schedule_overrides SET status = 'skipped', source_scenario_id = ?, row_version = row_version + 1 WHERE id = ?`,
                [scenarioId, overrideId]
            );
        } else {
            await conn.query(
                `UPDATE schedule_overrides
                    SET due_date = COALESCE(?, due_date), amount = COALESCE(?, amount),
                        source_scenario_id = ?, row_version = row_version + 1
                  WHERE id = ?`,
                [adj.newDate, adj.newAmount, scenarioId, overrideId]
            );
        }
    } else {
        const [ins] = await conn.query(
            `INSERT INTO schedule_overrides (schedule_id, natural_date, amount, due_date, status, source_scenario_id, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [target.id, target.naturalDate,
                adj.kind === 'adjust' ? adj.newAmount : null,
                adj.kind === 'adjust' ? adj.newDate : null,
                adj.kind === 'exclude' ? 'skipped' : null,
                scenarioId, userEmail]
        );
        overrideId = ins.insertId;
    }
    const [[after]] = await conn.query('SELECT * FROM schedule_overrides WHERE id = ?', [overrideId]);
    await recordAudit(conn, {
        entityType: 'schedule_override', entityId: overrideId, action: 'apply',
        before: overrideToJson(before), after: overrideToJson(after), userEmail,
    });
    return {
        applied: { itemKey: adj.itemKey, kind: adj.kind, wrote: 'schedule_override', entityId: Number(overrideId) },
        state: {
            kind: 'sched', overrideId: Number(overrideId), created: before === null,
            before: before ? { ...lineImage(before), sourceScenarioId: sourceOf(before) } : null,
            after: lineImage(after),
        },
    };
}

/**
 * §10.9 step 5 for a `ship.` target (Phase 2): the overlay only, never a feed column.
 * `adjust` → planned_date = new_date ?? planned_date, planned_amount = new_amount ??
 * planned_amount and, when new_amount is set, planned_base_amount = the feed amount under
 * the lock (P6); `exclude` → planned_skipped = 1 (P7). Both stamp source_scenario_id,
 * planned_by and planned_at and bump row_version; audit `external_item`/`apply`. The row is
 * already locked (lockTargets); lockExternalItem re-reads it as it is now.
 */
async function applyToShip(conn, adj, target, scenarioId, userEmail) {
    const before = await lockExternalItem(conn, target.id);
    if (adj.kind === 'exclude') {
        await conn.query(
            `UPDATE external_items
                SET planned_skipped = 1, source_scenario_id = ?, planned_by = ?, planned_at = UTC_TIMESTAMP(),
                    row_version = row_version + 1
              WHERE id = ?`,
            [scenarioId, userEmail, before.id]
        );
    } else {
        await conn.query(
            `UPDATE external_items
                SET planned_date = COALESCE(?, planned_date), planned_amount = COALESCE(?, planned_amount),
                    planned_base_amount = IF(? IS NULL, planned_base_amount, amount),
                    source_scenario_id = ?, planned_by = ?, planned_at = UTC_TIMESTAMP(), row_version = row_version + 1
              WHERE id = ?`,
            [adj.newDate, adj.newAmount, adj.newAmount, scenarioId, userEmail, before.id]
        );
    }
    const after = await lockExternalItem(conn, target.id);
    await auditOverlay(conn, { action: 'apply', before, after, userEmail });
    return {
        applied: { itemKey: adj.itemKey, kind: adj.kind, wrote: 'external_item', entityId: Number(before.id) },
        state: { kind: 'ship', id: Number(before.id), before: shipBeforeImage(before), after: shipAfterImage(after) },
    };
}

/**
 * §10.9 step 5 for an `add` (D39): insert its one-off — status expected, settle mode auto
 * (D13), notes = the adjustment's note — stamped source_scenario_id; audit
 * `cash_item`/`apply` with `before: null`. Its references were shared (FOR SHARE) and
 * re-checked live before the targets were locked.
 */
async function applyAdd(conn, adj, _target, scenarioId, userEmail) {
    const [ins] = await conn.query(
        `INSERT INTO cash_items
            (account_id, category_id, direction, name, counterparty, amount, currency, due_date, status,
             settle_mode, notes, source_scenario_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expected', 'auto', ?, ?, ?)`,
        [adj.accountId, adj.categoryId, adj.direction, adj.name, adj.counterparty, adj.newAmount, adj.currency,
            adj.newDate, adj.note, scenarioId, userEmail]
    );
    const id = Number(ins.insertId);
    await recordAudit(conn, {
        entityType: 'cash_item', entityId: id, action: 'apply',
        before: null, after: itemToJson(await readItem(conn, id)), userEmail,
    });
    return {
        applied: { itemKey: adj.itemKey, kind: adj.kind, wrote: 'cash_item', entityId: id },
        state: { kind: 'add', createdItemId: id },
    };
}

// §10.9 step 5 by target kind → {applied: the applied[] entry, state: the row's applied_state (D41)}.
const APPLY_TO = { item: applyToItem, sched: applyToInstance, ship: applyToShip, new: applyAdd };

// ── Un-apply (§10.13, D41) ──────────────────────────────────────────────────────────────

/**
 * The target an un-apply locks for one adjustment (§10.13 step 2): an `adjust`/`exclude`'s key;
 * an `add`'s created one-off as an `item.` target; none without a record (NO_RECORD).
 */
function unapplyTargetOf({ row, state }) {
    if (!state) return null;
    if (state.kind === 'add') return { targetKind: 'item', targetId: String(state.createdItemId), targetDate: null };
    return targetOf(row);
}

/**
 * §10.13 step 3, under the locks: why this row cannot be put back, in the contract's order —
 * NO_RECORD (no applied_state), TARGET_MISSING (the row apply wrote is gone), TARGET_SETTLED
 * (payment state; a ship row paid), CHANGED (not this scenario's any more, or its date,
 * amount or status — a ship row's planned date, amount or skipped — is not what apply
 * wrote) — or null. Dates compare as strings, money as minor units.
 */
async function unapplyReason(conn, { adj, state }, scenarioId) {
    if (!state) return 'NO_RECORD';
    const ours = (r) => sourceOf(r) === scenarioId;
    if (state.kind === 'item' || state.kind === 'add') {
        const [[r]] = await conn.query('SELECT * FROM cash_items WHERE id = ?', [state.kind === 'add' ? state.createdItemId : state.id]);
        if (!r || r.deleted_at != null) return 'TARGET_MISSING';
        if (hasPaymentState(r)) return 'TARGET_SETTLED';
        const after = state.kind === 'add' ? { dueDate: adj.newDate, amount: adj.newAmount, status: 'expected' } : state.after;
        if (!ours(r) || r.due_date !== after.dueDate || !sameMoney(r.amount, after.amount) || r.status !== after.status) return 'CHANGED';
        return null;
    }
    if (state.kind === 'sched') {
        const [[r]] = await conn.query('SELECT * FROM schedule_overrides WHERE id = ?', [state.overrideId]);
        if (!r) return 'TARGET_MISSING';
        if (hasPaymentState(r)) return 'TARGET_SETTLED';
        const a = state.after;
        if (!ours(r) || (r.due_date ?? null) !== (a.dueDate ?? null) || !sameMoney(r.amount, a.amount)
            || (r.status ?? null) !== (a.status ?? null)) return 'CHANGED';
        return null;
    }
    if (state.kind === 'ship') {
        const [[r]] = await conn.query('SELECT * FROM external_items WHERE id = ?', [state.id]);
        if (!r || r.gone_at != null) return 'TARGET_MISSING';
        if (r.feed_status === 'paid') return 'TARGET_SETTLED';
        const a = state.after;
        if (!ours(r) || (r.planned_date ?? null) !== (a.plannedDate ?? null) || !sameMoney(r.planned_amount, a.plannedAmount)
            || (Number(r.planned_skipped) === 1) !== Boolean(a.plannedSkipped)) return 'CHANGED';
        return null;
    }
    return 'NO_RECORD';                 // a record this version cannot read: nothing to restore from
}

/** §10.13 step 5, `item.`: due_date, amount, status and source_scenario_id from the before image. */
async function unapplyItem(conn, { adj, state }, userEmail) {
    const id = Number(state.id);
    const before = await readItem(conn, id);
    const b = state.before;
    await conn.query(
        'UPDATE cash_items SET due_date = ?, amount = ?, status = ?, source_scenario_id = ?, row_version = row_version + 1 WHERE id = ?',
        [b.dueDate, b.amount, b.status, b.sourceScenarioId ?? null, id]
    );
    await recordAudit(conn, {
        entityType: 'cash_item', entityId: id, action: 'unapply',
        before: itemToJson(before), after: itemToJson(await readItem(conn, id)), userEmail,
    });
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'cash_item', entityId: id };
}

/**
 * §10.13 step 5, `sched.`: an override apply created is deleted (audit `delete`, before = the
 * full row); one apply updated gets due_date, amount, status and source_scenario_id back.
 */
async function unapplyInstance(conn, { adj, state }, userEmail) {
    const id = Number(state.overrideId);
    const [[before]] = await conn.query('SELECT * FROM schedule_overrides WHERE id = ?', [id]);
    if (state.created) {
        await conn.query('DELETE FROM schedule_overrides WHERE id = ?', [id]);
        await recordAudit(conn, {
            entityType: 'schedule_override', entityId: id, action: 'delete', before: overrideToJson(before), after: null, userEmail,
        });
    } else {
        const b = state.before;
        await conn.query(
            `UPDATE schedule_overrides SET due_date = ?, amount = ?, status = ?, source_scenario_id = ?, row_version = row_version + 1
              WHERE id = ?`,
            [b.dueDate ?? null, b.amount ?? null, b.status ?? null, b.sourceScenarioId ?? null, id]
        );
        const [[after]] = await conn.query('SELECT * FROM schedule_overrides WHERE id = ?', [id]);
        await recordAudit(conn, {
            entityType: 'schedule_override', entityId: id, action: 'unapply',
            before: overrideToJson(before), after: overrideToJson(after), userEmail,
        });
    }
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'schedule_override', entityId: id };
}

/**
 * §10.13 step 5, `ship.`: the overlay columns apply touched, from the before image
 * (planned_at back from its ISO instant); feed columns untouched; audit
 * `external_item`/`unapply` through auditOverlay.
 */
async function unapplyShip(conn, { adj, state }, userEmail) {
    const id = Number(state.id);
    const [[before]] = await conn.query('SELECT * FROM external_items WHERE id = ?', [id]);
    const b = state.before;
    await conn.query(
        `UPDATE external_items
            SET planned_date = ?, planned_amount = ?, planned_base_amount = ?, planned_skipped = ?, source_scenario_id = ?,
                planned_by = ?, planned_at = ?, row_version = row_version + 1
          WHERE id = ?`,
        [b.plannedDate ?? null, b.plannedAmount ?? null, b.plannedBaseAmount ?? null, b.plannedSkipped ? 1 : 0,
            b.sourceScenarioId ?? null, b.plannedBy ?? null, b.plannedAt ? new Date(b.plannedAt) : null, id]
    );
    const [[after]] = await conn.query('SELECT * FROM external_items WHERE id = ?', [id]);
    await auditOverlay(conn, { action: 'unapply', before, after, userEmail });
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'external_item', entityId: id };
}

/** §10.13 step 5, `add`: the one-off apply created is soft-deleted (§2.7: it stays for the audit trail). */
async function unapplyAdd(conn, { adj, state }, userEmail) {
    const id = Number(state.createdItemId);
    const before = await readItem(conn, id);
    await conn.query('UPDATE cash_items SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?', [id]);
    await recordAudit(conn, {
        entityType: 'cash_item', entityId: id, action: 'unapply',
        before: itemToJson(before), after: itemToJson(await readItem(conn, id, { includeDeleted: true })), userEmail,
    });
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'cash_item', entityId: id };
}

// §10.13 step 5 by applied_state.kind → the unapplied[] entry (applied[]'s shape, D42).
const UNAPPLY = { item: unapplyItem, sched: unapplyInstance, ship: unapplyShip, add: unapplyAdd };

module.exports = ({ schemaReady, fail, serverError, todayFor, enums }) => {
    const router = express.Router();
    const STATUSES = enums.scenarioStatuses;
    const KINDS = enums.adjustmentKinds;
    const DIRECTIONS = enums.directions;

    // Adjustment routes parse the key first (§4, §6.11): it arrives un-encoded, as one
    // path segment, and a key lib/keys.js rejects is 422 before anything else is read.
    function keyOf(req) {
        const key = req.params.itemKey;
        const parsed = parseKey(key);
        if (!parsed) {
            throw apiError(422, 'ITEM_KEY_INVALID',
                'That is not a forecast key: expected item.<id>, sched.<id>.<YYYY-MM-DD>, ship.<id> or new.<id>.', { key });
        }
        return { key, parsed };
    }

    router.get('/scenarios', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            if (req.query.includeDeleted !== '1') where.push('s.deleted_at IS NULL');
            if (req.query.status !== undefined) {
                const statuses = String(req.query.status).split(',').map((v) => v.trim());
                if (statuses.some((v) => !STATUSES.includes(v))) {
                    return fail(res, 400, `status must be a comma list of: ${STATUSES.join(', ')}.`);
                }
                where.push(`s.status IN (${statuses.map(() => '?').join(', ')})`);
                params.push(...statuses);
            }
            if (req.query.companyId !== undefined) {
                const companyId = parseId(req.query.companyId);
                if (!companyId) return fail(res, 400, 'companyId must be a positive integer.');
                where.push('s.company_id = ?');
                params.push(companyId);
            }
            if (req.query.q) {
                where.push('(s.name LIKE ? OR s.description LIKE ?)');
                const like = `%${String(req.query.q)}%`;
                params.push(like, like);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(`SELECT COUNT(*) AS total FROM scenarios s ${whereSql}`, params);
                const [rows] = await c.query(
                    `${SCENARIO_SELECT} ${whereSql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, rows };
            });
            res.json(listResponse(out.rows.map(scenarioToJson), { page, limit, total: Number(out.total) }));
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-list', err);
        }
    });

    router.post('/scenarios', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            const name = parseName(body.name);
            if (!name) return fail(res, 400, `name is required (at most ${MAX_NAME} characters).`);
            const description = parseText(body.description, MAX_TEXT);
            if (Number.isNaN(description)) return fail(res, 400, `description must be text of at most ${MAX_TEXT} characters.`);
            const companyId = body.companyId == null ? null : bodyId(body.companyId);
            if (body.companyId != null && !companyId) return fail(res, 400, 'companyId must be a positive integer or null.');

            const created = await withTransaction(async (conn) => {
                await requireCompany(conn, companyId);
                const [ins] = await conn.query(
                    'INSERT INTO scenarios (name, description, company_id, created_by) VALUES (?, ?, ?, ?)',
                    [name, description ?? null, companyId, req.userEmail]
                );
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: ins.insertId, action: 'create',
                    before: null, after: scenarioToJson(await readScenarioRow(conn, ins.insertId)), userEmail: req.userEmail,
                });
                return scenarioOut(conn, ins.insertId);
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-create', err);
        }
    });

    router.get('/scenarios/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const today = todayFor(req);
            const out = await withConnection(async (c) => {
                const row = await readScenario(c, id, { includeDeleted: req.query.includeDeleted === '1' });
                if (!row) return null;
                const adjustments = await resolveAdjustments(c, row, await readAdjustments(c, id), today);
                return { ...scenarioToJson(row), adjustments };
            });
            if (!out) return fail(res, 404, 'Scenario not found.');
            res.json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-get', err);
        }
    });

    router.put('/scenarios/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const body = req.body || {};
            const has = (k) => body[k] !== undefined;
            if (!PUT_FIELDS.some(has)) return fail(res, 400, `Nothing to update: send any of ${PUT_FIELDS.join(', ')}.`);
            const name = has('name') ? parseName(body.name) : null;
            if (has('name') && !name) return fail(res, 400, `name cannot be blank (at most ${MAX_NAME} characters).`);
            const description = parseText(body.description, MAX_TEXT);
            if (Number.isNaN(description)) return fail(res, 400, `description must be text of at most ${MAX_TEXT} characters.`);
            const companyId = body.companyId == null ? null : bodyId(body.companyId);
            if (body.companyId != null && !companyId) return fail(res, 400, 'companyId must be a positive integer or null.');
            if (has('status') && !STATUSES.includes(body.status)) {
                return fail(res, 400, `status must be one of: ${STATUSES.join(', ')}.`);
            }
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            const updated = await withTransaction(async (conn) => {
                if (has('companyId')) await requireCompany(conn, companyId);
                const row = await lockScenario(conn, id);
                assertBaseVersion(row, baseVersion);
                // D36: the only status a PUT writes is archived, from draft or applied. The
                // stored value sent back is no change.
                if (has('status') && body.status !== row.status
                    && !(body.status === 'archived' && (row.status === 'draft' || row.status === 'applied'))) {
                    throw apiError(400, undefined,
                        `status can only change to archived, from draft or applied (this scenario is ${row.status}); apply has its own route.`,
                        { status: row.status });
                }
                const next = {
                    name: name ?? row.name,
                    description: description === undefined ? row.description : description,
                    companyId: has('companyId') ? companyId : (row.company_id == null ? null : Number(row.company_id)),
                    status: has('status') ? body.status : row.status,
                };
                const changed = next.name !== row.name || next.description !== row.description
                    || next.companyId !== (row.company_id == null ? null : Number(row.company_id)) || next.status !== row.status;
                if (!changed) return scenarioOut(conn, id);
                await conn.query(
                    `UPDATE scenarios SET name = ?, description = ?, company_id = ?, status = ?, row_version = row_version + 1
                      WHERE id = ?`,
                    [next.name, next.description, next.companyId, next.status, id]
                );
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: id, action: 'update',
                    before: scenarioToJson(row), after: scenarioToJson(await readScenarioRow(conn, id)), userEmail: req.userEmail,
                });
                return scenarioOut(conn, id);
            });
            res.json(updated);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-update', err);
        }
    });

    // Soft delete, any status; the adjustments stay (D18, §2.7).
    router.delete('/scenarios/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            await withTransaction(async (conn) => {
                const row = await lockScenario(conn, id);
                assertBaseVersion(row, baseVersion);
                await conn.query(
                    'UPDATE scenarios SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?', [id]
                );
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: id, action: 'delete',
                    before: scenarioToJson(row), after: scenarioToJson(await readScenarioRow(conn, id)), userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-delete', err);
        }
    });

    // §10.10: a new draft with every adjustment copied as-is. The bases are not refreshed,
    // so the first read shows what is stale. The source is only read (any status, live).
    // An `add` gets a fresh key (new.<its new id>), a split group is re-pointed at the copied
    // anchor (ascending id: an anchor is always older than its parts), and applied_state is
    // never copied (D39–D41).
    router.post('/scenarios/:id/duplicate', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const body = req.body || {};
            const name = body.name == null ? null : parseName(body.name);
            if (body.name != null && !name) return fail(res, 400, `name cannot be blank (at most ${MAX_NAME} characters).`);

            const created = await withTransaction(async (conn) => {
                const [[source]] = await conn.query('SELECT * FROM scenarios WHERE id = ? AND deleted_at IS NULL', [id]);
                if (!source) throw apiError(404, undefined, 'Scenario not found.');
                const [ins] = await conn.query(
                    'INSERT INTO scenarios (name, description, company_id, created_by) VALUES (?, ?, ?, ?)',
                    [name ?? copyName(source.name), source.description, source.company_id, req.userEmail]
                );
                const copyId = ins.insertId;
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: copyId, action: 'duplicate', before: null,
                    after: { ...scenarioToJson(await readScenarioRow(conn, copyId)), copiedFrom: id }, userEmail: req.userEmail,
                });
                const copies = new Map();      // source adjustment id → its copy's id
                for (const a of await readAdjustments(conn, id)) {
                    const adjCopyId = await insertAdjustment(conn, {
                        scenarioId: copyId, itemKey: a.item_key, targetKind: a.target_kind, targetId: a.target_id,
                        targetDate: a.target_date, kind: a.kind, newDate: a.new_date, newAmount: a.new_amount,
                        baseDate: a.base_date, baseAmount: a.base_amount, note: a.note,
                        accountId: a.account_id, categoryId: a.category_id, direction: a.direction, name: a.name,
                        counterparty: a.counterparty, currency: a.currency,
                        splitGroup: a.split_group == null ? null : copies.get(Number(a.split_group)) ?? null,
                        createdBy: req.userEmail,
                    }, { anchor: isAnchor(a) });
                    copies.set(Number(a.id), adjCopyId);
                    await recordAudit(conn, {
                        entityType: 'scenario_adjustment', entityId: adjCopyId, action: 'create',
                        before: null, after: adjustmentToJson(await readAdjustmentRow(conn, adjCopyId)), userEmail: req.userEmail,
                    });
                }
                return scenarioOut(conn, copyId);
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-duplicate', err);
        }
    });

    // §10.7a (D39, D43): the only way to create an `add` — a hypothetical one-off inside a
    // draft scenario, keyed new.<its own id>. The references come first (§10.1's exception),
    // then the scenario row. 201 with stale null (both references were just checked live and
    // the date is today or later) and current null (there is no target).
    router.post('/scenarios/:id/adjustments', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const body = req.body || {};
            if (body.kind !== 'add') {
                return fail(res, 400, 'kind must be add: this route adds a hypothetical one-off (adjust and exclude are a PUT on the line\'s key).');
            }
            const add = parseAddBody(body, todayFor(req), DIRECTIONS);

            const out = await withTransaction(async (conn) => {
                const refs = await shareAddRefs(conn, add);
                requireDraft(await lockScenario(conn, id));
                const adjId = await insertAdjustment(conn, {
                    scenarioId: id, kind: 'add', newDate: add.newDate, newAmount: add.newAmount, note: add.note,
                    accountId: add.accountId, categoryId: add.categoryId, direction: refs.direction, name: add.name,
                    counterparty: add.counterparty, currency: refs.currency, createdBy: req.userEmail,
                });
                const row = adjustmentToJson(await readAdjustmentRow(conn, adjId));
                await recordAudit(conn, {
                    entityType: 'scenario_adjustment', entityId: adjId, action: 'create', before: null, after: row, userEmail: req.userEmail,
                });
                return { ...row, stale: null, current: null };
            });
            res.status(201).json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-add-create', err);
        }
    });

    /**
     * §10.7a step 4, PUT on a new.<id> key (D43): a full replace of an existing add of this
     * scenario — every field again; an omitted counterparty or note is cleared; split_group is
     * kept. References first, then the scenario, then the row (404 when this scenario has no
     * such add). Audit `update` when anything changed. 200.
     */
    async function putAdd(req, res, { id, key }) {
        const body = req.body || {};
        const add = parseAddBody(body, todayFor(req), DIRECTIONS);
        const baseVersion = parseBaseVersion(body);
        if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
        const out = await withTransaction(async (conn) => {
            const refs = await shareAddRefs(conn, add);
            requireDraft(await lockScenario(conn, id));
            const [[existing]] = await conn.query(
                'SELECT * FROM scenario_adjustments WHERE scenario_id = ? AND item_key = ? FOR UPDATE', [id, key]
            );
            if (!existing || existing.kind !== 'add') {
                throw apiError(404, undefined, 'This scenario has no added line with that key; POST /scenarios/:id/adjustments adds one.');
            }
            assertBaseVersion(existing, baseVersion);
            const next = [
                ['account_id', add.accountId], ['category_id', add.categoryId], ['direction', refs.direction],
                ['name', add.name], ['counterparty', add.counterparty], ['currency', refs.currency],
                ['new_date', add.newDate], ['new_amount', add.newAmount], ['note', add.note],
            ];
            const changed = next.some(([column, value]) => (column === 'new_amount' ? !sameMoney(existing[column], value)
                : column.endsWith('_id') ? Number(existing[column]) !== value : (existing[column] ?? null) !== value));
            if (changed) {
                await conn.query(
                    `UPDATE scenario_adjustments SET ${next.map(([column]) => `${column} = ?`).join(', ')}, row_version = row_version + 1
                      WHERE id = ?`,
                    [...next.map(([, value]) => value), existing.id]
                );
                await recordAudit(conn, {
                    entityType: 'scenario_adjustment', entityId: Number(existing.id), action: 'update',
                    before: adjustmentToJson(existing), after: adjustmentToJson(await readAdjustmentRow(conn, existing.id)),
                    userEmail: req.userEmail,
                });
            }
            return { ...adjustmentToJson(await readAdjustmentRow(conn, existing.id)), stale: null, current: null };
        });
        return res.json(out);
    }

    // §10.7: create or replace the adjustment for one key. A full replace — an omitted
    // newDate, newAmount or note is cleared. The bases are the target's current effective
    // values from the loader, read under the target's locks; the body cannot set them.
    // A new.<id> key takes only kind add, the add's whole body (D43, putAdd above); kind add
    // on any other key is 400. A PUT on a split's anchor keeps its split_group (D40).
    router.put('/scenarios/:id/adjustments/:itemKey', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const { key, parsed } = keyOf(req);
            const body = req.body || {};
            const kind = body.kind;
            if (!KINDS.includes(kind)) return fail(res, 400, `kind is required: one of ${KINDS.join(', ')}.`);
            if (parsed.targetKind === 'new') {
                if (kind !== 'add') {
                    return fail(res, 400, 'A new.<id> key is an added line: send kind add with the whole line (accountId, categoryId, name, newDate, newAmount).');
                }
                return await putAdd(req, res, { id, key });
            }
            if (kind === 'add') {
                return fail(res, 400, 'kind add is only for a new.<id> key: POST /scenarios/:id/adjustments adds a line.');
            }
            const newDate = body.newDate ?? null;
            if (newDate !== null && !isValidDate(newDate)) return fail(res, 400, 'newDate must be a real date, YYYY-MM-DD.');
            const newAmountMinor = body.newAmount == null ? null : parseMoney(body.newAmount);
            if (body.newAmount != null && (newAmountMinor === null || newAmountMinor <= 0n)) {
                return fail(res, 400, 'newAmount must be a decimal string greater than zero, e.g. "1024.00".');
            }
            const newAmount = newAmountMinor === null ? null : formatMinor(newAmountMinor);
            if (kind === 'adjust' && newDate === null && newAmount === null) {
                return fail(res, 400, 'An adjust needs newDate or newAmount (or both).');
            }
            if (kind === 'exclude' && (newDate !== null || newAmount !== null)) {
                return fail(res, 400, 'An exclude takes neither newDate nor newAmount.');
            }
            const note = parseText(body.note, MAX_NOTE);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);
            if (newDate !== null && newDate < today) {
                throw apiError(422, 'ADJUSTMENT_DATE_IN_PAST', 'An adjustment cannot move a line before today.', { newDate, today });
            }

            const out = await withTransaction(async (conn) => {
                requireDraft(await lockScenario(conn, id));
                await lockTargets(conn, [parsed]);
                const target = await loadCurrent(conn, parsed, today);
                requireLiveTarget(target, key, { kind, newDate }, today);      // D33

                const next = {
                    kind, newDate, newAmount, note: note ?? null,
                    baseDate: target.effectiveDate, baseAmount: target.effectiveAmount,
                };
                const [[existing]] = await conn.query(
                    'SELECT * FROM scenario_adjustments WHERE scenario_id = ? AND item_key = ?', [id, key]
                );
                let adjId;
                let created = false;
                if (existing) {
                    assertBaseVersion(existing, baseVersion);
                    adjId = existing.id;
                    const changed = existing.kind !== next.kind || existing.new_date !== next.newDate
                        || !sameMoney(existing.new_amount, next.newAmount) || existing.note !== next.note
                        || existing.base_date !== next.baseDate || !sameMoney(existing.base_amount, next.baseAmount);
                    if (changed) {
                        await conn.query(
                            `UPDATE scenario_adjustments
                                SET kind = ?, new_date = ?, new_amount = ?, base_date = ?, base_amount = ?, note = ?,
                                    row_version = row_version + 1
                              WHERE id = ?`,
                            [next.kind, next.newDate, next.newAmount, next.baseDate, next.baseAmount, next.note, adjId]
                        );
                        const [[after]] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [adjId]);
                        await recordAudit(conn, {
                            entityType: 'scenario_adjustment', entityId: adjId, action: 'update',
                            before: adjustmentToJson(existing), after: adjustmentToJson(after), userEmail: req.userEmail,
                        });
                    }
                } else {
                    const [ins] = await conn.query(
                        `INSERT INTO scenario_adjustments
                            (scenario_id, item_key, target_kind, target_id, target_date, kind, new_date, new_amount,
                             base_date, base_amount, note, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [id, key, parsed.targetKind, parsed.targetId, parsed.targetDate, next.kind, next.newDate,
                            next.newAmount, next.baseDate, next.baseAmount, next.note, req.userEmail]
                    );
                    adjId = ins.insertId;
                    created = true;
                    const [[row]] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [adjId]);
                    await recordAudit(conn, {
                        entityType: 'scenario_adjustment', entityId: adjId, action: 'create',
                        before: null, after: adjustmentToJson(row), userEmail: req.userEmail,
                    });
                }
                const [[row]] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [adjId]);
                const adj = adjustmentToJson(row);
                return { created, body: { ...adj, stale: adjustmentStale(adj, target, today), current: currentJson(target) } };
            });
            res.status(out.created ? 201 : 200).json(out.body);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-adjustment-put', err);
        }
    });

    // §10.7 delete: hard, draft only; nothing about the target is read, so no target lock.
    // Deleting a split's anchor deletes its whole group, the anchor last ("revert the split",
    // D40); deleting a part removes that part alone.
    router.delete('/scenarios/:id/adjustments/:itemKey', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const { key } = keyOf(req);
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            await withTransaction(async (conn) => {
                requireDraft(await lockScenario(conn, id));
                const [[row]] = await conn.query(
                    'SELECT * FROM scenario_adjustments WHERE scenario_id = ? AND item_key = ? FOR UPDATE', [id, key]
                );
                if (!row) throw apiError(404, undefined, 'This scenario has no adjustment for that key.');
                assertBaseVersion(row, baseVersion);
                const parts = isAnchor(row) ? await groupParts(conn, id, row) : [];
                for (const victim of [...parts, row]) await deleteAdjustment(conn, victim, req.userEmail);
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-adjustment-delete', err);
        }
    });

    // §10.7b (D40): split one line into dated parts — an `adjust` on the line (part 1: the line
    // itself, resized and maybe moved) plus one `add` per further part copying the line's
    // account, category, direction, name, counterparty and currency, all in one split_group
    // (the anchor's id). The parts must sum to the line's current effective amount. A split
    // replaces whatever adjustment the key had, and the parts of the group it anchored. No
    // reference lock: the parts copy the target's references, which apply re-checks.
    router.post('/scenarios/:id/adjustments/:itemKey/split', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const { key, parsed } = keyOf(req);
            if (parsed.targetKind === 'new') {
                return fail(res, 400, 'An added line cannot be split (D43): delete it and add the parts instead.');
            }
            const body = req.body || {};
            const parts = parseParts(body.parts);
            const note = parseText(body.note, MAX_NOTE);
            if (Number.isNaN(note)) return fail(res, 400, `note must be text of at most ${MAX_NOTE} characters.`);
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);
            const early = parts.find((p) => p.newDate < today);
            if (early) {
                throw apiError(422, 'ADJUSTMENT_DATE_IN_PAST', 'A part cannot be dated before today.', { newDate: early.newDate, today });
            }

            const out = await withTransaction(async (conn) => {
                requireDraft(await lockScenario(conn, id));
                await lockTargets(conn, [parsed]);
                const target = await loadCurrent(conn, parsed, today);
                requireLiveTarget(target, key, { kind: 'adjust', newDate: parts[0].newDate }, today);
                if (target.accountId == null) {
                    throw apiError(400, undefined,
                        'That line has no account to sit on (its company maps to no account), so its parts would have none: it cannot be split.',
                        { key });
                }
                const expected = parseMinor(target.effectiveAmount);
                const total = parts.reduce((acc, p) => acc + p.amountMinor, 0n);
                if (total !== expected) {
                    throw apiError(422, 'SPLIT_AMOUNTS_MISMATCH',
                        `The parts add up to ${formatMinor(total)} but the line is ${formatMinor(expected)}: a split must add up to the line.`,
                        { total: formatMinor(total), expected: formatMinor(expected) });
                }
                const described = await targetDescription(conn, target);

                // 6. The key's existing adjustment, if any, becomes the anchor; a group it
                //    anchored loses its old parts first.
                const [[existing]] = await conn.query(
                    'SELECT * FROM scenario_adjustments WHERE scenario_id = ? AND item_key = ? FOR UPDATE', [id, key]
                );
                if (existing) {
                    assertBaseVersion(existing, baseVersion);
                    if (isAnchor(existing)) {
                        for (const old of await groupParts(conn, id, existing)) await deleteAdjustment(conn, old, req.userEmail);
                    }
                }
                const first = parts[0];
                const anchor = {
                    kind: 'adjust', newDate: first.newDate === target.effectiveDate ? null : first.newDate,
                    newAmount: first.newAmount, note: note ?? null,
                    baseDate: target.effectiveDate, baseAmount: target.effectiveAmount,
                };
                let anchorId;
                if (existing) {
                    anchorId = Number(existing.id);
                    await conn.query(
                        `UPDATE scenario_adjustments
                            SET kind = ?, new_date = ?, new_amount = ?, base_date = ?, base_amount = ?, note = ?, split_group = ?,
                                row_version = row_version + 1
                          WHERE id = ?`,
                        [anchor.kind, anchor.newDate, anchor.newAmount, anchor.baseDate, anchor.baseAmount, anchor.note,
                            anchorId, anchorId]
                    );
                    await recordAudit(conn, {
                        entityType: 'scenario_adjustment', entityId: anchorId, action: 'update',
                        before: adjustmentToJson(existing), after: adjustmentToJson(await readAdjustmentRow(conn, anchorId)),
                        userEmail: req.userEmail,
                    });
                } else {
                    anchorId = await insertAdjustment(conn, {
                        scenarioId: id, itemKey: key, targetKind: parsed.targetKind, targetId: parsed.targetId,
                        targetDate: parsed.targetDate, ...anchor, createdBy: req.userEmail,
                    }, { anchor: true });
                    await recordAudit(conn, {
                        entityType: 'scenario_adjustment', entityId: anchorId, action: 'create',
                        before: null, after: adjustmentToJson(await readAdjustmentRow(conn, anchorId)), userEmail: req.userEmail,
                    });
                }

                // 7. One add per further part, in the anchor's group.
                const added = [];
                for (const part of parts.slice(1)) {
                    const partId = await insertAdjustment(conn, {
                        scenarioId: id, kind: 'add', newDate: part.newDate, newAmount: part.newAmount, note: note ?? null,
                        accountId: target.accountId, categoryId: described.categoryId, direction: described.direction,
                        name: described.name, counterparty: described.counterparty, currency: target.currency,
                        splitGroup: anchorId, createdBy: req.userEmail,
                    });
                    const row = adjustmentToJson(await readAdjustmentRow(conn, partId));
                    await recordAudit(conn, {
                        entityType: 'scenario_adjustment', entityId: partId, action: 'create', before: null, after: row,
                        userEmail: req.userEmail,
                    });
                    added.push({ ...row, stale: null, current: null });
                }
                const anchorAdj = adjustmentToJson(await readAdjustmentRow(conn, anchorId));
                return {
                    splitGroup: anchorId,
                    adjustments: [
                        { ...anchorAdj, stale: adjustmentStale(anchorAdj, target, today), current: currentJson(target) },
                        ...added,
                    ],
                };
            });
            res.status(201).json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-adjustment-split', err);
        }
    });

    // §10.8: refresh every base that changed; TARGET_SETTLED / TARGET_MISSING / DATE_PASSED
    // cannot be fixed by a rebase and are reported, or removed with dropStale (D38). An `add`
    // has no base and is never rebased; dropStale removes a stale one (D39).
    router.post('/scenarios/:id/rebase', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const body = req.body || {};
            if (body.dropStale !== undefined && typeof body.dropStale !== 'boolean') {
                return fail(res, 400, 'dropStale must be true or false.');
            }
            const dropStale = body.dropStale === true;
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);

            const out = await withTransaction(async (conn) => {
                const scenario = await lockScenario(conn, id);
                requireDraft(scenario);
                assertBaseVersion(scenario, baseVersion);
                const rows = await readAdjustments(conn, id, { lock: true });
                await lockTargets(conn, rows.filter((r) => r.kind !== 'add').map(targetOf));
                const adjustments = [];
                const counts = { rebased: 0, dropped: 0, stale: 0 };
                // D40: a stale anchor dropped here takes its parts with it (wherever the server
                // deletes an anchor, its group goes). A part's own id is higher than its anchor's,
                // so it is met later in this loop and reported then as dropped, not stale.
                const gone = new Set();
                for (const row of rows) {
                    const adj = adjustmentToJson(row);
                    if (gone.has(Number(row.id))) {
                        adjustments.push({ ...adj, stale: null, current: null, rebased: false, dropped: true });
                        continue;
                    }
                    const isAdd = adj.kind === 'add';
                    const target = isAdd ? null : await loadCurrent(conn, targetOf(row), today);
                    const current = currentJson(target);
                    const stale = isAdd ? await addStale(conn, adj, today) : staleAfterRebase(adj, target, today);
                    if (stale) {
                        counts.stale += 1;
                        if (dropStale) {
                            if (isAnchor(row)) {
                                for (const part of await groupParts(conn, id, row)) {
                                    await deleteAdjustment(conn, part, req.userEmail);
                                    gone.add(Number(part.id));
                                    counts.dropped += 1;
                                }
                            }
                            await deleteAdjustment(conn, row, req.userEmail);
                            counts.dropped += 1;
                        }
                        adjustments.push({ ...adj, stale, current, rebased: false, dropped: dropStale });
                    } else if (adjustmentStale(adj, target, today) === 'BASE_CHANGED') {
                        await conn.query(
                            `UPDATE scenario_adjustments SET base_date = ?, base_amount = ?, row_version = row_version + 1
                              WHERE id = ?`,
                            [target.effectiveDate, target.effectiveAmount, row.id]
                        );
                        const [[after]] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [row.id]);
                        const rebased = adjustmentToJson(after);
                        await recordAudit(conn, {
                            entityType: 'scenario_adjustment', entityId: Number(row.id), action: 'update',
                            before: adj, after: rebased, userEmail: req.userEmail,
                        });
                        counts.rebased += 1;
                        adjustments.push({ ...rebased, stale: null, current, rebased: true, dropped: false });
                    } else {
                        adjustments.push({ ...adj, stale: null, current, rebased: false, dropped: false });
                    }
                }
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: id, action: 'rebase',
                    before: null, after: { ...counts, dropStale }, userEmail: req.userEmail,
                });
                return { scenario: await scenarioOut(conn, id), adjustments };
            });
            res.json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-rebase', err);
        }
    });

    // §10.9: all or nothing. Every adjustment is re-checked under the locks with the
    // engine's §9.5 definitions; any stale one refuses the whole apply, nothing written.
    // An `add` (D39): its account and category are shared first, before the targets; it is
    // TARGET_MISSING or DATE_PASSED, never settled or base-changed; it inserts its one-off.
    // Every row records its applied_state (D41) for un-apply; row_version stays as it is.
    router.post('/scenarios/:id/apply', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');
            const today = todayFor(req);

            const out = await withTransaction(async (conn) => {
                const scenario = await lockScenario(conn, id);
                requireDraft(scenario);
                assertBaseVersion(scenario, baseVersion);
                const rows = await readAdjustments(conn, id, { lock: true });
                await shareAddReferences(conn, rows.filter((r) => r.kind === 'add'));
                await lockTargets(conn, rows.filter((r) => r.kind !== 'add').map(targetOf));

                const checked = [];
                const stale = [];
                for (const row of rows) {
                    const adj = adjustmentToJson(row);
                    let target = null;
                    let reason;
                    if (adj.kind === 'add') {
                        const refs = await loadAddReferences(conn, adj);
                        reason = adjustmentStale({ ...adj, targetLive: refs.live }, null, today);
                    } else {
                        target = await loadTarget(conn, targetOf(row), today);
                        reason = adjustmentStale(adj, target, today);
                    }
                    if (reason) stale.push({ itemKey: adj.itemKey, reason });
                    checked.push({ adj, target });
                }
                if (stale.length) {
                    throw apiError(409, 'SCENARIO_STALE',
                        `${stale.length} adjustment${stale.length === 1 ? ' no longer matches' : 's no longer match'} the real data; nothing was applied. Rebase, or drop the stale ones, and try again.`,
                        { stale });
                }

                const applied = [];
                for (const { adj, target } of checked) {
                    const wrote = await APPLY_TO[adj.targetKind](conn, adj, target, id, req.userEmail);
                    await conn.query('UPDATE scenario_adjustments SET applied_state = ? WHERE id = ?', [JSON.stringify(wrote.state), adj.id]);
                    applied.push(wrote.applied);
                }
                await conn.query(
                    `UPDATE scenarios SET status = 'applied', applied_at = UTC_TIMESTAMP(), applied_by = ?,
                            row_version = row_version + 1
                      WHERE id = ?`,
                    [req.userEmail, id]
                );
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: id, action: 'apply',
                    before: scenarioToJson(scenario), after: scenarioToJson(await readScenarioRow(conn, id)), userEmail: req.userEmail,
                });
                return { scenario: await scenarioOut(conn, id), applied };
            });
            res.json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-apply', err);
        }
    });

    // §10.13 (D41): all or nothing. Every adjustment is re-checked under the standing-order
    // locks against what apply recorded (applied_state); any row that cannot be put back
    // refuses the whole un-apply (409 SCENARIO_UNAPPLY_BLOCKED), nothing written. Otherwise
    // each target gets its before image back (an override apply created is deleted, a
    // one-off an add created is soft-deleted), applied_state is cleared, and the scenario is
    // a draft again whose bases equal the real data.
    router.post('/scenarios/:id/unapply', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            const out = await withTransaction(async (conn) => {
                const scenario = await lockScenario(conn, id);
                if (scenario.status !== 'applied') {
                    throw apiError(409, 'SCENARIO_NOT_APPLIED',
                        `This scenario is ${scenario.status}: only an applied scenario can be un-applied.`, { status: scenario.status });
                }
                assertBaseVersion(scenario, baseVersion);
                const records = (await readAdjustments(conn, id, { lock: true }))
                    .map((row) => ({ row, adj: adjustmentToJson(row), state: appliedStateOf(row) }));
                await lockTargets(conn, records.map(unapplyTargetOf).filter(Boolean));

                const blocked = [];
                for (const rec of records) {
                    const reason = await unapplyReason(conn, rec, id);
                    if (reason) blocked.push({ itemKey: rec.adj.itemKey, reason });
                }
                if (blocked.length) {
                    throw apiError(409, 'SCENARIO_UNAPPLY_BLOCKED',
                        `${blocked.length} line${blocked.length === 1 ? ' has' : 's have'} changed since this scenario was applied; nothing was put back. Revert ${blocked.length === 1 ? 'it' : 'them'} by hand, or leave the scenario applied.`,
                        { blocked });
                }

                const unapplied = [];
                for (const rec of records) {
                    unapplied.push(await UNAPPLY[rec.state.kind](conn, rec, req.userEmail));
                    await conn.query('UPDATE scenario_adjustments SET applied_state = NULL WHERE id = ?', [rec.row.id]);
                }
                await conn.query(
                    `UPDATE scenarios SET status = 'draft', applied_at = NULL, applied_by = NULL, row_version = row_version + 1
                      WHERE id = ?`,
                    [id]
                );
                await recordAudit(conn, {
                    entityType: 'scenario', entityId: id, action: 'unapply',
                    before: scenarioToJson(scenario), after: scenarioToJson(await readScenarioRow(conn, id)), userEmail: req.userEmail,
                });
                return { scenario: await scenarioOut(conn, id), unapplied };
            });
            res.json(out);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-unapply', err);
        }
    });

    return router;
};
