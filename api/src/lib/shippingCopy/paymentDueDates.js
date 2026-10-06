// Copied from shipping/src/lib/payment-due-dates.js (rowToJson) and src/services/payment-due-date-routes.js (the SELECT's LEFT JOIN on shipping_allowed_emails.display_name) @ 2cd5900 — changes: the route's SELECT is in services/shippingReads.js (schema-qualified, read-only); rowToJson verbatim in behaviour; `setter_name` is null when the users table could not be read
'use strict';

// Due dates set by hand (ShipLine 2026-10-06): one row of shipping's
// `payment_due_dates` → what GET /api/v1/payment-due-dates sends, which is what
// ShipLine's Payments page hands buildPaymentsFlow as `dueOverrides` and what
// lib/payments-flow/overrides.js reads. Pure.

const iso = v => (v == null ? null : v.toISOString ? v.toISOString() : String(v));
const ymd = v => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** @returns {import('../payments-flow/types').PaymentDueDate} */
function rowToJson(r) {
    return {
        id: r.id,
        key: r.target_key,
        scope: r.target_key.startsWith('item:') ? 'item' : 'payment',
        dueDate: ymd(r.due_date),
        note: r.note || null,
        setByEmail: r.set_by_email,
        setByName: r.setter_name || null,
        setAt: iso(r.updated_at),
    };
}

module.exports = { rowToJson };
