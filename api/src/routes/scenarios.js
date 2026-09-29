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
//     keeps the adjustments (D18). Rework an applied scenario by duplicating it.
//
// Locks (§10.1): scenario row → schedules (asc id) → cash_items (asc id) → external_items
// (asc id, Phase 2 P11) → overrides, through services/scenarios.js lockScenario /
// lockTargets. Every read that the re-check depends on happens after those locks (see that
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
const { loadTarget } = require('../services/forecastLoad');
const { lockExternalItem, auditOverlay } = require('../services/externalItems');
const {
    SCENARIO_SELECT, readScenario, readScenarioRow, lockScenario, requireDraft, readAdjustments,
    targetOf, lockTargets, loadCurrent, currentJson, resolveAdjustments,
} = require('../services/scenarios');

const MAX_NAME = 255;          // scenarios.name VARCHAR(255)
const MAX_TEXT = 16000;        // scenarios.description TEXT (16,000 four-byte characters fit)
const MAX_NOTE = 500;          // scenario_adjustments.note VARCHAR(500)
const COPY_SUFFIX = ' (copy)';
const PUT_FIELDS = ['name', 'description', 'companyId', 'status'];

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
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'cash_item', entityId: target.id };
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
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'schedule_override', entityId: Number(overrideId) };
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
    return { itemKey: adj.itemKey, kind: adj.kind, wrote: 'external_item', entityId: Number(before.id) };
}

const APPLY_TO = { item: applyToItem, sched: applyToInstance, ship: applyToShip };

module.exports = ({ schemaReady, fail, serverError, todayFor, enums }) => {
    const router = express.Router();
    const STATUSES = enums.scenarioStatuses;
    const KINDS = enums.adjustmentKinds;

    // Adjustment routes parse the key first (§4, §6.11): it arrives un-encoded, as one
    // path segment, and a key lib/keys.js rejects is 422 before anything else is read.
    function keyOf(req) {
        const key = req.params.itemKey;
        const parsed = parseKey(key);
        if (!parsed) {
            throw apiError(422, 'ITEM_KEY_INVALID',
                'That is not a forecast key: expected item.<id>, sched.<id>.<YYYY-MM-DD> or ship.<id>.', { key });
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
                for (const a of await readAdjustments(conn, id)) {
                    const [copy] = await conn.query(
                        `INSERT INTO scenario_adjustments
                            (scenario_id, item_key, target_kind, target_id, target_date, kind, new_date, new_amount,
                             base_date, base_amount, note, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [copyId, a.item_key, a.target_kind, a.target_id, a.target_date, a.kind, a.new_date, a.new_amount,
                            a.base_date, a.base_amount, a.note, req.userEmail]
                    );
                    const [[row]] = await conn.query('SELECT * FROM scenario_adjustments WHERE id = ?', [copy.insertId]);
                    await recordAudit(conn, {
                        entityType: 'scenario_adjustment', entityId: copy.insertId, action: 'create',
                        before: null, after: adjustmentToJson(row), userEmail: req.userEmail,
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

    // §10.7: create or replace the adjustment for one key. A full replace — an omitted
    // newDate, newAmount or note is cleared. The bases are the target's current effective
    // values from the loader, read under the target's locks; the body cannot set them.
    router.put('/scenarios/:id/adjustments/:itemKey', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Scenario not found.');
            const { key, parsed } = keyOf(req);
            const body = req.body || {};
            const kind = body.kind;
            if (!KINDS.includes(kind)) return fail(res, 400, `kind is required: one of ${KINDS.join(', ')}.`);
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
                // D33: the stale reasons as refusals. A fresh base cannot be BASE_CHANGED,
                // and a past newDate was refused above.
                const reason = staleAfterRebase({ kind, newDate }, target, today);
                if (reason === 'TARGET_MISSING') {
                    throw apiError(404, 'TARGET_MISSING', 'There is no live forecast line with that key.', { key });
                }
                if (reason === 'TARGET_SETTLED') {
                    throw apiError(409, 'TARGET_SETTLED',
                        `That line is ${target.status.replace('_', ' ')}: only an expected line can be adjusted.`,
                        { key, status: target.status });
                }
                if (reason) throw new Error(`scenarios: unexpected stale reason ${reason} on write`);

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
                await conn.query('DELETE FROM scenario_adjustments WHERE id = ?', [row.id]);
                await recordAudit(conn, {
                    entityType: 'scenario_adjustment', entityId: Number(row.id), action: 'delete',
                    before: adjustmentToJson(row), after: null, userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'scenarios-adjustment-delete', err);
        }
    });

    // §10.8: refresh every base that changed; TARGET_SETTLED / TARGET_MISSING / DATE_PASSED
    // cannot be fixed by a rebase and are reported, or removed with dropStale (D38).
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
                await lockTargets(conn, rows.map(targetOf));
                const adjustments = [];
                const counts = { rebased: 0, dropped: 0, stale: 0 };
                for (const row of rows) {
                    const adj = adjustmentToJson(row);
                    const target = await loadCurrent(conn, targetOf(row), today);
                    const current = currentJson(target);
                    const stale = staleAfterRebase(adj, target, today);
                    if (stale) {
                        counts.stale += 1;
                        if (dropStale) {
                            await conn.query('DELETE FROM scenario_adjustments WHERE id = ?', [row.id]);
                            await recordAudit(conn, {
                                entityType: 'scenario_adjustment', entityId: Number(row.id), action: 'delete',
                                before: adj, after: null, userEmail: req.userEmail,
                            });
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
                await lockTargets(conn, rows.map(targetOf));

                const checked = [];
                const stale = [];
                for (const row of rows) {
                    const adj = adjustmentToJson(row);
                    const target = await loadTarget(conn, targetOf(row), today);
                    const reason = adjustmentStale(adj, target, today);
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
                    applied.push(await APPLY_TO[adj.targetKind](conn, adj, target, id, req.userEmail));
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

    return router;
};
