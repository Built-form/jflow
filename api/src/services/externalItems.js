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

const { externalItemToJson } = require('../lib/shape');
const { shipDerivedStatus } = require('../lib/lines');
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

module.exports = { EFFECTIVE_DATE_SQL, decorateExternalItems, listExternalItems, readExternalItem };
