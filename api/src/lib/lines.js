'use strict';

// Classifier input lines (CONTRACT §9.6): an item, instance or (Phase 2, §9.3.1) ship
// row in its JSON / engine-input shape → the `line` that lib/classify.js takes. Shaping only:
// money DECIMAL strings are parsed to bigint minor units, the effective values
// are read off the row, and nothing is decided here. The table itself lives in
// classify.js alone; every caller (GET /items, GET /schedules/:id/instances, the
// D17 deactivation guard, and the engine from step 6) builds its line here and
// makes ONE classify call.
//
// Pure: no DB, no clock.

const { parseMinor } = require('./money');
const { isValidDate, diffDays } = require('./dates');
const { classify, derivedStatus } = require('./classify');

/**
 * A one-off item → its classify line. `item` is the item JSON (lib/shape.js
 * itemToJson): a one-off's effective date is its `dueDate`, its settle mode its
 * own. `payments` are the item's payment rows ({id, paidOn, amount}); omitted
 * or empty when the caller has none to hand (§8 rule 4 leaves out payments
 * before minA — the remainder uses the cached `paidAmount`, so it is unaffected).
 */
function itemLine(item, payments = item.payments) {
    return {
        status: item.status,
        settleMode: item.settleMode,
        effectiveDate: item.dueDate,
        amountMinor: parseMinor(item.amount),
        paidAmountMinor: item.paidAmount == null ? 0n : parseMinor(item.paidAmount),
        payments: (payments || []).map((p) => ({
            paymentId: p.id,
            paidOn: p.paidOn,
            amountMinor: parseMinor(p.amount),
        })),
    };
}

/**
 * §9.6 / D10: an item's `derivedStatus` against its account's anchor `A` (a
 * date, or null for none — D12) and `today`: the projection of one classify call.
 */
function itemDerivedStatus(item, A, today) {
    return derivedStatus(classify(itemLine(item), A, today));
}

/**
 * A schedule instance → its classify line. `instance` is the §6.9 instance JSON
 * (lib/instances.js buildInstance), whose `dueDate`, `amount`, `status` and
 * `settleMode` are already the effective values (§3.4: the override's when set,
 * else the schedule's), so the settle mode is resolved before classify sees it.
 * The paid cache is the override's (`override.paidAmount`); `payments` are the
 * override's payment rows, defaulting to `instance.payments`.
 */
function instanceLine(instance, payments = instance.payments) {
    const paid = instance.override ? instance.override.paidAmount : null;
    return {
        status: instance.status,
        settleMode: instance.settleMode,
        effectiveDate: instance.dueDate,
        amountMinor: parseMinor(instance.amount),
        paidAmountMinor: paid == null ? 0n : parseMinor(paid),
        payments: (payments || []).map((p) => ({
            paymentId: p.id,
            paidOn: p.paidOn,
            amountMinor: parseMinor(p.amount),
        })),
    };
}

/** §9.6 / D10: an instance's `derivedStatus`, as itemDerivedStatus. */
function instanceDerivedStatus(instance, A, today) {
    return derivedStatus(classify(instanceLine(instance), A, today));
}

// ── Phase 2: ship rows (CONTRACT §3.4, §9.3.1, P6, P9) ──────────────────────────────────
// `row` is an external_items row in its camelCase shape (feedStatus, dueDate, paidOn,
// amount, the planned* overlay, goneAt, accountId). Settle mode is always `manual`:
// shipping, not the calendar, says a supplier was paid.

const SHIP_SETTLE_MODE = 'manual';

/**
 * §6.10: a ship line's name, `<supplier> · <poNumber> · deposit|balance`, leaving out what
 * the feed does not know. A row that is not a PO's goods says what it is instead of its
 * kind: `<payee> · Freight` for a forwarder's cost, `<supplier> · PO-9 · Mould cost`,
 * `… · PO charges`, `… · Top-up`, `… · QC units X` (the feed's `label`, since 2026-10-06).
 * The engine's lines and a `ship.` adjustment's `current.name`.
 */
const shipName = (row) => {
    const what = row.label || (row.feedKind === 'qc' ? 'QC units' : row.feedKind);
    return [row.supplier, row.poNumber, what].filter((p) => p != null && p !== '').join(' · ');
};

// The "date moved" mark (handover doc "Dates set by hand", 2026-10-06): how long a row
// says its feed date moved — from a set, a clear, or a derived date that changed.
const DATE_MOVED_DAYS = 14;

/**
 * Whether the row wears the `date_moved` mark for `today` (the request's Europe/London
 * date): the refresh recorded a move (`dueDateMovedAt`, UTC) whose calendar day is at most
 * DATE_MOVED_DAYS before today. A Date or an ISO string; never true without a move.
 */
function shipDateMoved(row, today) {
    const at = row.dueDateMovedAt;
    if (at == null || !isValidDate(today)) return false;
    const day = at instanceof Date ? at.toISOString().slice(0, 10) : String(at).slice(0, 10);
    if (!isValidDate(day)) return false;
    const age = diffDays(today, day);          // days since the move; negative = a clock ahead of the request
    return age >= 0 && age <= DATE_MOVED_DAYS;
}

/** Any overlay column set (the `planned` flag, SHIP_PLAN_ORPHANED). */
function hasShipOverlay(row) {
    return row.plannedDate != null || row.plannedAmount != null || Boolean(Number(row.plannedSkipped || 0))
        || row.plannedNote != null;
}

/**
 * §3.4's effective values of a ship row → {status, effectiveDate, effectiveAmount,
 * planStale}. status: `paid` when the feed says so, `skipped` when planned_skipped,
 * else `expected`. effectiveDate: `plannedDate ?? dueDate` for an open row (null =
 * undated); a paid row is dated on its `paidOn` (the feed row is the payment, and a
 * paid row is never undated). effectiveAmount (DECIMAL string): `plannedAmount` while
 * `plannedBaseAmount` equals the feed `amount` (P6, compared as minor units), else the
 * feed amount; a paid row always carries the feed amount. planStale: planned_amount is
 * set but its base no longer matches the feed amount (P6).
 */
function shipEffectiveValues(row) {
    const paid = row.feedStatus === 'paid';
    const amountMinor = parseMinor(row.amount);
    const planStale = row.plannedAmount != null
        && (row.plannedBaseAmount == null || parseMinor(row.plannedBaseAmount) !== amountMinor);
    const usePlan = !paid && row.plannedAmount != null && !planStale;
    let status = 'expected';
    if (paid) status = 'paid';
    else if (Number(row.plannedSkipped || 0)) status = 'skipped';
    return {
        status,
        effectiveDate: paid ? row.paidOn : (row.plannedDate ?? row.dueDate ?? null),
        effectiveAmount: usePlan ? row.plannedAmount : row.amount,
        planStale,
    };
}

/**
 * §9.3.1: a ship row → its classify line, or null when it makes no line (a gone row;
 * an open row with no effective date, skipped or not). Paid → one payment
 * {paymentId: null, paidOn, amount} with the cache equal to the amount; open → the
 * effective date and amount, no payments.
 */
function shipLine(row) {
    if (row.goneAt != null) return null;
    const ev = shipEffectiveValues(row);
    if (ev.effectiveDate == null) return null;
    const amountMinor = parseMinor(ev.effectiveAmount);
    if (ev.status === 'paid') {
        return {
            status: 'paid',
            settleMode: SHIP_SETTLE_MODE,
            effectiveDate: ev.effectiveDate,
            amountMinor,
            paidAmountMinor: amountMinor,
            payments: [{ paymentId: null, paidOn: row.paidOn, amountMinor }],
        };
    }
    return {
        status: ev.status,
        settleMode: SHIP_SETTLE_MODE,
        effectiveDate: ev.effectiveDate,
        amountMinor,
        paidAmountMinor: 0n,
        payments: [],
    };
}

/**
 * §6.12: a ship row's `derivedStatus` against its resolved account's anchor `A` and
 * `today` — one classify call on shipLine — or null for a row that is classified
 * nowhere: undated and open, gone, or unmapped (`accountId` null).
 */
function shipDerivedStatus(row, A, today) {
    if (row.accountId == null) return null;
    const line = shipLine(row);
    return line === null ? null : derivedStatus(classify(line, A, today));
}

module.exports = {
    itemLine, itemDerivedStatus, instanceLine, instanceDerivedStatus,
    SHIP_SETTLE_MODE, DATE_MOVED_DAYS, shipName, hasShipOverlay, shipDateMoved, shipEffectiveValues, shipLine, shipDerivedStatus,
};
