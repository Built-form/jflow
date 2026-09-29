'use strict';

// Payment rows (CONTRACT D23, §10.3, §10.4), shared by the item and instance pay /
// unpay routes. A payment belongs to exactly one parent: a `cash_items` row
// ({cashItemId}) or a `schedule_overrides` row ({overrideId}). Every function runs
// inside the caller's transaction, AFTER the caller holds the parent's lock (the item
// row; for an instance, the schedule row and then the override row — §10.1), so the
// rows are never locked on their own and the cache rewrite is exact.

const { recordAudit } = require('../lib/audit');
const { formatMinor } = require('../lib/money');
const { paymentToJson } = require('../lib/shape');

/** The `payment` audit snapshot (§2.8): `{cashItemId, overrideId, paidOn, amount, note}`. */
const paymentSnapshot = (p) => ({
    cashItemId: p.cashItemId, overrideId: p.overrideId, paidOn: p.paidOn, amount: p.amount, note: p.note,
});

/** `[column, id]` of the one parent a payment hangs off. */
function parentOf({ cashItemId = null, overrideId = null }) {
    if (cashItemId != null && overrideId == null) return ['cash_item_id', cashItemId];
    if (overrideId != null && cashItemId == null) return ['override_id', overrideId];
    throw new TypeError('A payment belongs to exactly one of cashItemId / overrideId');
}

/**
 * Insert one payment row under `parent` and audit `payment`/`create`. `amountMinor` is
 * bigint minor units, already checked against the remaining amount. Returns the row JSON.
 */
async function insertPayment(conn, parent, { paidOn, amountMinor, note, userEmail }) {
    const [column, parentId] = parentOf(parent);
    const [ins] = await conn.query(
        `INSERT INTO payments (${column}, paid_on, amount, note, created_by) VALUES (?, ?, ?, ?, ?)`,
        [parentId, paidOn, formatMinor(amountMinor), note ?? null, userEmail]
    );
    const [[row]] = await conn.query('SELECT * FROM payments WHERE id = ?', [ins.insertId]);
    const payment = paymentToJson(row);
    await recordAudit(conn, {
        entityType: 'payment', entityId: payment.id, action: 'create',
        before: null, after: paymentSnapshot(payment), userEmail,
    });
    return payment;
}

/**
 * The parent's cache, recomputed from its rows (D23): `{paidAmount: SUM(amount),
 * paidOn: MAX(paid_on)}` as DECIMAL / date strings, both null when there are none.
 */
async function paymentCache(conn, parent) {
    const [column, parentId] = parentOf(parent);
    const [[cache]] = await conn.query(
        `SELECT CAST(SUM(amount) AS CHAR) AS paid_amount, DATE_FORMAT(MAX(paid_on), '%Y-%m-%d') AS paid_on
           FROM payments WHERE ${column} = ?`,
        [parentId]
    );
    return { paidAmount: cache.paid_amount ?? null, paidOn: cache.paid_on ?? null };
}

/**
 * Unpay: delete every payment row of `parent`, one `payment`/`delete` audit row each
 * with the before-snapshot. Returns how many were deleted.
 */
async function deletePayments(conn, parent, userEmail) {
    const [column, parentId] = parentOf(parent);
    const [rows] = await conn.query(
        `SELECT * FROM payments WHERE ${column} = ? ORDER BY paid_on ASC, id ASC FOR UPDATE`, [parentId]
    );
    for (const r of rows) {
        await conn.query('DELETE FROM payments WHERE id = ?', [r.id]);
        await recordAudit(conn, {
            entityType: 'payment', entityId: Number(r.id), action: 'delete',
            before: paymentSnapshot(paymentToJson(r)), after: null, userEmail,
        });
    }
    return rows.length;
}

module.exports = { paymentSnapshot, insertPayment, paymentCache, deletePayments };
