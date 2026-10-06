'use strict';

// External item reads (Phase 2, CONTRACT §6.12): `external_items` rows → the row JSON of
// §6.12, carrying `companyId` / `accountId` (resolved in SQL at read time, P5 — the same
// query as the forecast loader's, services/forecastLoad.js shipResolvedSelect) and
// `derivedStatus`: ONE classify call per row through lib/lines.js shipDerivedStatus,
// against the resolved account's anchor and the request's `today` — the call /forecast
// makes on the same row, so the list and the forecast cannot disagree. `derivedStatus` is
// null for an undated open row, a gone row and an unmapped row (nothing is classified).
//
// Shared by GET /external-items (step 20) and the overlay writes (step 21), which answer
// with the same row JSON.
//
// Step 21 adds the overlay side (§10.9 step 5, §10.11): the row lock, the "overlay set"
// predicate, and the one audit shape of `plan`, `unplan` and `apply`. The overlay columns
// are written only by a user edit (PUT/DELETE /external-items/:key) or a scenario apply,
// never by the refresh; neither writer ever touches a feed column.

const { recordAudit } = require('../lib/audit');
const { buildShipKey } = require('../lib/keys');
const { externalItemToJson } = require('../lib/shape');
const { shipDerivedStatus, shipDateMoved } = require('../lib/lines');
const { shipResolvedSelect, loadAnchors } = require('./forecastLoad');

// §3.4's effective date in SQL, over the resolved row `x`: a paid row is dated on its
// paid_on; an open row on planned_date ?? due_date (NULL = undated). lib/lines.js
// shipEffectiveValues is the same rule in JS.
const EFFECTIVE_DATE_SQL = "(CASE WHEN x.feed_status = 'paid' THEN x.paid_on ELSE COALESCE(x.planned_date, x.due_date) END)";

/** Rows of shipResolvedSelect → the §6.12 row JSON with `derivedStatus`, in the rows' order. */
async function decorateExternalItems(conn, rows, today) {
    if (!rows.length) return [];
    const anchors = await loadAnchors(conn, rows.map((r) => r.resolved_account_id).filter((v) => v != null), today);
    return rows.map((r) => {
        const row = externalItemToJson(r, { derivedStatus: null });
        const anchor = row.accountId === null ? null : anchors.get(row.accountId);
        row.derivedStatus = shipDerivedStatus(row, anchor ? anchor.anchorDate : null, today);
        // The same rule the engine's `date_moved` flag follows (lib/lines.js), for `today`.
        row.dateMoved = shipDateMoved(row, today);
        return row;
    });
}

/**
 * GET /external-items (§6.12). Filters, all optional and already validated:
 *   statuses     ['open', 'paid'] subset (default both)
 *   companyId    a live company id (rows resolving to it), or 'all'
 *   from, to     bound the effective date (an undated row has none, so a bound drops it)
 *   includeGone  true adds rows with gone_at set
 *   q            LIKE %q% over supplier, po_number, container_ref
 * Sorted by effective date ascending, undated last, then id. → {total, data}.
 */
async function listExternalItems(conn, { today, statuses, companyId = 'all', from, to, includeGone = false, q, limit, offset }) {
    const inner = [];
    const innerParams = [];
    if (statuses && statuses.length) {
        inner.push(`e.feed_status IN (${statuses.map(() => '?').join(', ')})`);
        innerParams.push(...statuses);
    }
    if (!includeGone) inner.push('e.gone_at IS NULL');
    if (q) {
        inner.push('(e.supplier LIKE ? OR e.po_number LIKE ? OR e.container_ref LIKE ?)');
        innerParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const outer = [];
    const outerParams = [];
    if (companyId !== 'all') {
        outer.push('x.resolved_company_id = ?');
        outerParams.push(companyId);
    }
    if (from) {
        outer.push(`${EFFECTIVE_DATE_SQL} >= ?`);
        outerParams.push(from);
    }
    if (to) {
        outer.push(`${EFFECTIVE_DATE_SQL} <= ?`);
        outerParams.push(to);
    }
    const base = `(${shipResolvedSelect(inner.length ? inner.join(' AND ') : '1 = 1')}) x`;
    const outerSql = outer.length ? `WHERE ${outer.join(' AND ')}` : '';
    const params = [...innerParams, ...outerParams];

    const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM ${base} ${outerSql}`, params);
    const [rows] = await conn.query(
        `SELECT x.* FROM ${base} ${outerSql}
          ORDER BY ${EFFECTIVE_DATE_SQL} IS NULL ASC, ${EFFECTIVE_DATE_SQL} ASC, x.id ASC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    return { total: Number(total), data: await decorateExternalItems(conn, rows, today) };
}

/** One row by its ext_id (exact match), resolved, gone or not → the raw row, or null. */
async function readExternalItem(conn, extId) {
    const [rows] = await conn.query(`${shipResolvedSelect('e.ext_id = ?')} ORDER BY r.id ASC`, [extId]);
    const row = rows.find((r) => r.ext_id === extId);
    return row || null;
}

/** One row as the §6.12 JSON with `derivedStatus` (gone or not), or null. */
async function externalItemJson(conn, extId, today) {
    const row = await readExternalItem(conn, extId);
    return row ? (await decorateExternalItems(conn, [row], today))[0] : null;
}

// ── The overlay (step 21: CONTRACT §3.5, §10.9 step 5, §10.11) ────────────────────────

/**
 * `SELECT … FOR UPDATE` on the ship row with this ext_id, gone or not (§10.11 step 1) → the
 * raw row as it is now (a locking read never reads an older snapshot), or null. The unique
 * key compares ext_id case-insensitively (the schema's collation), so the row must also match
 * exactly, as loadTarget requires; a row of another case is locked but is not this key's.
 */
async function lockExternalItem(conn, extId) {
    const [rows] = await conn.query("SELECT * FROM external_items WHERE source = 'ship' AND ext_id = ? FOR UPDATE", [extId]);
    return rows.find((r) => r.ext_id === extId) || null;
}

/** Any overlay column set on a raw row, stamps included — DELETE's "nothing to revert" is its negation. */
function hasOverlay(r) {
    return r.planned_date != null || r.planned_amount != null || Number(r.planned_skipped) === 1
        || r.planned_base_amount != null || r.planned_note != null || r.source_scenario_id != null
        || r.planned_by != null || r.planned_at != null;
}

const isoOrNull = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** A raw row's overlay columns in their §6.12 names (`plannedAt` as ISO: audit.js's diff sees any two Dates as equal). */
function overlaySnapshot(r) {
    return {
        plannedDate: r.planned_date,
        plannedAmount: r.planned_amount,
        plannedSkipped: Number(r.planned_skipped) === 1,
        plannedBaseAmount: r.planned_base_amount,
        plannedNote: r.planned_note,
        sourceScenarioId: r.source_scenario_id == null ? null : Number(r.source_scenario_id),
        plannedBy: r.planned_by,
        plannedAt: isoOrNull(r.planned_at),
    };
}

/**
 * The audit row of an overlay write (§2.8: `external_item`, entity_id = external_items.id;
 * §10.11: before/after = the overlay columns plus `key`), inside the caller's transaction.
 * `action` is `plan`, `unplan` or `apply`; `before` / `after` are the raw rows. `key` rides
 * on `after` only: audit.js keeps just the keys that differ, so a key on both sides would be
 * dropped from both.
 */
function auditOverlay(conn, { action, before, after, userEmail }) {
    return recordAudit(conn, {
        entityType: 'external_item',
        entityId: Number(after.id),
        action,
        before: overlaySnapshot(before),
        after: { key: buildShipKey(after.ext_id), ...overlaySnapshot(after) },
        userEmail,
    });
}

module.exports = {
    EFFECTIVE_DATE_SQL,
    decorateExternalItems,
    listExternalItems,
    readExternalItem,
    externalItemJson,
    lockExternalItem,
    hasOverlay,
    overlaySnapshot,
    auditOverlay,
};
