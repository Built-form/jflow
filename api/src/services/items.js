'use strict';

// Item reads shared by the item routes and the D17 deactivation guard
// (routes/accounts.js): `cash_items` rows → the item JSON of CONTRACT §6.7,
// carrying `payments[]` and `derivedStatus`.
//
// The payment rows and the anchors come through the loader
// (services/forecastLoad.js), and `derivedStatus` is ONE classify call per row
// through lib/lines.js, against the account's anchor (D12: none → null) and
// the request's `today` — the same call /forecast makes, so a list and the
// forecast cannot disagree (§9.6, §10.2).

const { itemToJson } = require('../lib/shape');
const { itemDerivedStatus } = require('../lib/lines');
const { ITEM_SELECT, loadAnchors, loadItemPayments } = require('./forecastLoad');

/**
 * Rows selected through ITEM_SELECT (so they carry `company_id`) → item JSON
 * with `payments[]` (ascending by paidOn, id) and `derivedStatus`, in the rows'
 * order.
 */
async function decorateItems(conn, rows, today) {
    if (!rows.length) return [];
    const payments = await loadItemPayments(conn, rows.map((r) => r.id));
    const byItem = new Map();
    for (const p of payments) {
        if (!byItem.has(p.cashItemId)) byItem.set(p.cashItemId, []);
        byItem.get(p.cashItemId).push(p);
    }
    const anchors = await loadAnchors(conn, rows.map((r) => r.account_id), today);
    return rows.map((r) => {
        const item = itemToJson(r, { payments: byItem.get(Number(r.id)) || [], derivedStatus: null });
        const anchor = anchors.get(item.accountId);
        item.derivedStatus = itemDerivedStatus(item, anchor ? anchor.anchorDate : null, today);
        return item;
    });
}

/** One item row (with `company_id`), or null. Live only unless `includeDeleted`. */
async function readItem(conn, id, { includeDeleted = false } = {}) {
    const [rows] = await conn.query(
        `${ITEM_SELECT} WHERE i.id = ?${includeDeleted ? '' : ' AND i.deleted_at IS NULL'}`, [id]
    );
    return rows.length ? rows[0] : null;
}

module.exports = { decorateItems, readItem };
