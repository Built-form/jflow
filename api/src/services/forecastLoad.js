'use strict';

// Load rules (CONTRACT §8): rows in, engine input out. NO LOGIC — no
// classification, no FX, no arithmetic beyond the date bounds. Live rows only;
// every row leaves in its camelCase JSON shape (lib/shape.js) with money still
// DECIMAL strings. Every function takes the caller's connection (inside its
// transaction when there is one) and `today` as an argument; nothing here
// reads a clock.
//
// Step 4 builds the item side:
//   loadAnchors        rule 9  — per account, the latest balance
//   loadItems          rules 1, 2, 5 — one-off items of the in-scope accounts
//   loadItemTargets    rule 6 (item. keys) — items by id, whatever their bounds or scope
//   loadItemPayments   rule 4  — payment rows of loaded items
//   loadTarget         the single-target read, `item.` and `ship.` keys
//
// TODO(step 5): schedules and overrides (rules 1, 2, 3, 5 and 7) and
//   loadTarget's `sched.` branch.
// TODO(step 6): rates (rule 8), the accounts list, minA and NO_ANCHOR, the
//   de-duplication across rules, and the assembled `engineInput`.
// TODO(step 7): adjustments (rule 10) and the scenario row.

const { itemToJson, paymentToJson } = require('../lib/shape');

/**
 * A `cash_items` row with its company, derived through the account (§3.4,
 * §6.7). Callers append `WHERE …`. A locking read through it names the item
 * alone (`FOR SHARE OF i`): locking the joined account row after an item row
 * would break §10.1's order.
 */
const ITEM_SELECT = `SELECT i.*, a.company_id
       FROM cash_items i
       LEFT JOIN bank_accounts a ON a.id = i.account_id`;

const marks = (list) => list.map(() => '?').join(', ');

/** Distinct positive integer ids, ascending. */
function uniqueIds(ids) {
    return [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/**
 * Rule 9 (§9.2): per account, the `bank_balances` row with the latest
 * `balance_date` → Map<accountId, {anchorDate, anchorBalance}>. An account with
 * no balance is absent from the map (D12, NO_ANCHOR).
 *
 * Balances dated after `today` are not anchors. None can exist when deployed
 * (BALANCE_DATE_IN_FUTURE, and `?today=` is ignored there — D24), but a pinned
 * `?today=` earlier than a recorded balance (local/test) must not see an anchor
 * from its own future: classify requires A <= today.
 */
async function loadAnchors(conn, accountIds, today) {
    const ids = uniqueIds(accountIds);
    if (!ids.length) return new Map();
    const [rows] = await conn.query(
        `SELECT b.account_id, b.balance_date, b.balance
           FROM bank_balances b
           JOIN (SELECT account_id, MAX(balance_date) AS latest
                   FROM bank_balances
                  WHERE account_id IN (${marks(ids)}) AND balance_date <= ?
                  GROUP BY account_id) m
             ON m.account_id = b.account_id AND m.latest = b.balance_date`,
        [...ids, today]
    );
    return new Map(rows.map((r) => [Number(r.account_id), { anchorDate: r.balance_date, anchorBalance: r.balance }]));
}

/**
 * Rules 1, 2 and 5 for one-off items, over the in-scope accounts:
 *   1  dated [minA, to]: `due_date BETWEEN minA AND to`, any status;
 *   2  paid late: the `paid_on` cache `>= minA`, whatever `due_date`;
 *   5  still owed with no 45-day floor: every `part_paid` (the remainder is
 *      forced manual), and every `manual` + `expected` dated before today.
 * One query, so an item several rules select comes back once. Ascending by
 * `due_date, id`; each row carries `inScope: true`.
 */
async function loadItems(conn, { accountIds, minA, to, today }) {
    const ids = uniqueIds(accountIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `${ITEM_SELECT}
          WHERE i.account_id IN (${marks(ids)}) AND i.deleted_at IS NULL
            AND (i.due_date BETWEEN ? AND ?
                 OR i.paid_on >= ?
                 OR i.status = 'part_paid'
                 OR (i.settle_mode = 'manual' AND i.status = 'expected' AND i.due_date < ?))
          ORDER BY i.due_date ASC, i.id ASC`,
        [...ids, minA, to, minA, today]
    );
    return rows.map((r) => ({ ...itemToJson(r), inScope: true }));
}

/**
 * Rule 6 for `item.` keys: the live items with these ids, whatever their dates
 * or account. `inScope` says whether the item's account is in `accountIds`
 * (D20: an out-of-scope target is loaded so its stale check is truthful). A
 * deleted or absent id is simply not returned (→ TARGET_MISSING downstream).
 */
async function loadItemTargets(conn, itemIds, accountIds) {
    const ids = uniqueIds(itemIds);
    if (!ids.length) return [];
    const scope = new Set(uniqueIds(accountIds));
    const [rows] = await conn.query(
        `${ITEM_SELECT} WHERE i.id IN (${marks(ids)}) AND i.deleted_at IS NULL ORDER BY i.id ASC`,
        ids
    );
    return rows.map((r) => ({ ...itemToJson(r), inScope: scope.has(Number(r.account_id)) }));
}

/**
 * Rule 4: the `payments` rows of these items, ascending by `paid_on, id`. With
 * `since` (the loader passes minA) only rows with `paid_on >= since`: earlier
 * ones are inside every anchor, and the remainder uses the parent's cached
 * `paid_amount`. Without it, every row (the item JSON's `payments[]`).
 */
async function loadItemPayments(conn, itemIds, { since } = {}) {
    const ids = uniqueIds(itemIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `SELECT * FROM payments
          WHERE cash_item_id IN (${marks(ids)})${since ? ' AND paid_on >= ?' : ''}
          ORDER BY paid_on ASC, id ASC`,
        since ? [...ids, since] : ids
    );
    return rows.map(paymentToJson);
}

/**
 * §8's single-target read for the adjustment write, rebase and apply, called
 * AFTER the caller has locked the target's rows in the standing order (§10.1).
 * `parsedKey` is lib/keys.js parseKey's result. Returns
 * {kind, id, naturalDate, status, effectiveDate, effectiveAmount, currency,
 *  accountId, settleMode, hasPaymentState, overrideId} or null when the row is
 * not live, or for a `ship.` key (D8). A one-off's effective values are its own
 * (§3.4); "payment state" is §3.4's predicate on the cache columns.
 */
async function loadTarget(conn, parsedKey, _today) {
    if (!parsedKey) return null;
    if (parsedKey.targetKind === 'ship') return null;
    if (parsedKey.targetKind === 'item') {
        const [rows] = await conn.query(
            `SELECT i.*, a.company_id,
                    (i.status IN ('paid', 'part_paid') OR i.paid_amount > 0 OR i.paid_on IS NOT NULL) AS has_payment_state
               FROM cash_items i
               LEFT JOIN bank_accounts a ON a.id = i.account_id
              WHERE i.id = ? AND i.deleted_at IS NULL`,
            [parsedKey.targetId]
        );
        if (!rows.length) return null;
        const item = itemToJson(rows[0]);
        return {
            kind: 'item',
            id: item.id,
            naturalDate: null,
            status: item.status,
            effectiveDate: item.dueDate,
            effectiveAmount: item.amount,
            currency: item.currency,
            accountId: item.accountId,
            settleMode: item.settleMode,
            hasPaymentState: Boolean(Number(rows[0].has_payment_state)),
            overrideId: null,
        };
    }
    // TODO(step 5): `sched.` — lock-free read of the schedule and override,
    // isOccurrence, and §3.4's effective values.
    throw new Error(`loadTarget: ${parsedKey.targetKind}. targets are not loaded before step 5`);
}

module.exports = {
    ITEM_SELECT,
    loadAnchors,
    loadItems,
    loadItemTargets,
    loadItemPayments,
    loadTarget,
};
