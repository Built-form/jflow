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
// Step 5 adds loadTarget's `sched.` branch.
//
// Step 6 completes §8 for GET /forecast:
//   loadScopeAccounts     the account set — live, active, of one company or all
//   loadSchedules         rules 1 (weekend-widened), 2, 5, and schedules an override needs
//   loadScheduleTargets   rule 6 (sched. keys) — schedules by id, whatever their bounds or scope
//   loadScheduleOverrides rule 3 — every override row of every loaded schedule (D31)
//   loadOverridePayments  rule 4 for instances
//   loadCategories, loadRates (rule 8), loadScenario, loadAdjustments (rule 10)
//   loadEngineInput       the assembly: minA, NO_ANCHOR, de-duplication, `engineInput`

const { itemToJson, paymentToJson, scheduleToJson, overrideToJson, adjustmentToJson } = require('../lib/shape');
const { isOccurrence, effectiveValues } = require('../lib/recurrence');
const { addDays } = require('../lib/dates');
const { clampWindow, currenciesInScope, MANUAL_LOOKBACK_DAYS } = require('../lib/engine');

// §8 rule 1: `previous` / `next` move a natural date by at most two days (§5.3), so a
// schedule whose natural dates stop two days short of the window can still land in it.
const WEEKEND_REACH_DAYS = 2;
const GBP = 'GBP';                  // D3: no fx_rates row, rate 1.000000 in the engine

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

// ── Step 6: the rest of §8 and the assembled engineInput ─────────────────────

/**
 * The account set of §6.10: live, active accounts of one company, or of every live
 * company for `'all'` — company scope resolved through bank_accounts (items and
 * schedules carry no company_id, §3.4). In the /accounts order. →
 * [{id, companyId, name, currency}]
 */
async function loadScopeAccounts(conn, companyId) {
    const one = companyId !== 'all';
    const [rows] = await conn.query(
        `SELECT a.id, a.company_id, a.name, a.currency
           FROM bank_accounts a
           JOIN companies c ON c.id = a.company_id AND c.deleted_at IS NULL
          WHERE a.deleted_at IS NULL AND a.is_active = 1${one ? ' AND a.company_id = ?' : ''}
          ORDER BY c.sort_order ASC, c.name ASC, a.company_id ASC, a.sort_order ASC, a.name ASC, a.id ASC`,
        one ? [companyId] : []
    );
    return rows.map((r) => ({ id: Number(r.id), companyId: Number(r.company_id), name: r.name, currency: r.currency }));
}

/** A `schedules` row with its company, derived through the account (§3.4). Callers append `WHERE …`. */
const SCHEDULE_SELECT = `SELECT s.*, a.company_id
       FROM schedules s
       LEFT JOIN bank_accounts a ON a.id = s.account_id`;

/**
 * Rules 1, 2 and 5 for schedules (`active` and `ended` alike), over the in-scope
 * anchored accounts. The rows only: the engine expands their occurrences itself.
 *   1  natural dates that can land in [minA, to] after the weekend rule:
 *      `start_date <= to + 2` and (`end_date IS NULL OR end_date >= minA − 2`);
 *   5  `manual` schedules scanned back to today − 730: `start_date <= to + 2` and
 *      (`end_date IS NULL OR end_date >= today − 730`);
 *   2, 3, 5, 7 — a schedule one of whose override rows needs it, whatever the
 *      schedule's own dates: paid late (`paid_on >= minA`), moved into [minA, to]
 *      (`due_date`, verbatim), or still owed with no floor (`part_paid`; or `manual`
 *      and still expected). Without this, an override of a schedule that has ended
 *      before minA − 2 would never be loaded, since rule 3 loads the overrides of
 *      loaded schedules only.
 * One query, so a schedule several rules select comes back once. Ascending by id;
 * each row carries `inScope: true`.
 */
async function loadSchedules(conn, { accountIds, minA, to, today }) {
    const ids = uniqueIds(accountIds);
    if (!ids.length) return [];
    const hi = addDays(to, WEEKEND_REACH_DAYS);
    const [rows] = await conn.query(
        `${SCHEDULE_SELECT}
          WHERE s.account_id IN (${marks(ids)}) AND s.deleted_at IS NULL
            AND ((s.start_date <= ? AND (s.end_date IS NULL OR s.end_date >= ?))
                 OR (s.settle_mode = 'manual' AND s.start_date <= ? AND (s.end_date IS NULL OR s.end_date >= ?))
                 OR s.id IN (SELECT o.schedule_id FROM schedule_overrides o
                              WHERE o.paid_on >= ?
                                 OR o.due_date BETWEEN ? AND ?
                                 OR o.status = 'part_paid'
                                 OR (o.settle_mode = 'manual' AND (o.status IS NULL OR o.status = 'expected'))))
          ORDER BY s.id ASC`,
        [...ids, hi, addDays(minA, -WEEKEND_REACH_DAYS), hi, addDays(today, -MANUAL_LOOKBACK_DAYS), minA, minA, to]
    );
    return rows.map((r) => ({ ...scheduleToJson(r), inScope: true }));
}

/**
 * Rule 6 for `sched.` keys: the live schedules with these ids, whatever their dates
 * or account; `inScope` says whether the schedule's account is in `accountIds` (D20).
 * A deleted or absent id is not returned (→ TARGET_MISSING downstream). The target
 * instance itself is expanded by the engine from the adjustment's natural date.
 */
async function loadScheduleTargets(conn, scheduleIds, accountIds) {
    const ids = uniqueIds(scheduleIds);
    if (!ids.length) return [];
    const scope = new Set(uniqueIds(accountIds));
    const [rows] = await conn.query(
        `${SCHEDULE_SELECT} WHERE s.id IN (${marks(ids)}) AND s.deleted_at IS NULL ORDER BY s.id ASC`,
        ids
    );
    return rows.map((r) => ({ ...scheduleToJson(r), inScope: scope.has(Number(r.account_id)) }));
}

/**
 * Rule 3 (D31): EVERY override row of these schedules, whatever its dates or columns
 * — amount-only tunes, moved dates, part-paid remainders behind minA, settle-mode-only
 * "Didn't happen" rows, and orphans (the engine warns ORPHAN_OVERRIDE). Ascending by
 * schedule and natural date.
 */
async function loadScheduleOverrides(conn, scheduleIds) {
    const ids = uniqueIds(scheduleIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `SELECT * FROM schedule_overrides WHERE schedule_id IN (${marks(ids)})
          ORDER BY schedule_id ASC, natural_date ASC`,
        ids
    );
    return rows.map(overrideToJson);
}

/**
 * Rule 4 for instances: the `payments` rows of these overrides, ascending by
 * `paid_on, id`; with `since` (minA) only `paid_on >= since`, as loadItemPayments.
 */
async function loadOverridePayments(conn, overrideIds, { since } = {}) {
    const ids = uniqueIds(overrideIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `SELECT * FROM payments
          WHERE override_id IN (${marks(ids)})${since ? ' AND paid_on >= ?' : ''}
          ORDER BY paid_on ASC, id ASC`,
        since ? [...ids, since] : ids
    );
    return rows.map(paymentToJson);
}

/** The live categories with these ids → [{id, name, direction, sortOrder}], ascending by id. */
async function loadCategories(conn, categoryIds) {
    const ids = uniqueIds(categoryIds);
    if (!ids.length) return [];
    const [rows] = await conn.query(
        `SELECT id, name, direction, sort_order FROM categories
          WHERE id IN (${marks(ids)}) AND deleted_at IS NULL ORDER BY id ASC`,
        ids
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name, direction: r.direction, sortOrder: r.sort_order }));
}

/**
 * Rule 8 (§9.7): per currency, the `fx_rates` row with the latest `effective_from <=
 * today` → {CUR: {rateToGbp, effectiveFrom}}. GBP has no row (D3). A currency with no
 * such row is simply absent: the route answers FX_RATE_MISSING before the engine runs.
 */
async function loadRates(conn, currencies, today) {
    const wanted = [...new Set(currencies || [])].filter((c) => c !== GBP).sort();
    if (!wanted.length) return {};
    const [rows] = await conn.query(
        `SELECT f.currency, f.rate_to_gbp, f.effective_from
           FROM fx_rates f
           JOIN (SELECT currency, MAX(effective_from) AS effective_from
                   FROM fx_rates
                  WHERE currency IN (${marks(wanted)}) AND effective_from <= ?
                  GROUP BY currency) latest
             ON latest.currency = f.currency AND latest.effective_from = f.effective_from
          ORDER BY f.currency ASC`,
        [...wanted, today]
    );
    return Object.fromEntries(rows.map((r) => [r.currency, { rateToGbp: r.rate_to_gbp, effectiveFrom: r.effective_from }]));
}

/** The live scenario → {id, name, status} (the engine's EngineScenario), or null. */
async function loadScenario(conn, scenarioId) {
    const [rows] = await conn.query(
        'SELECT id, name, status FROM scenarios WHERE id = ? AND deleted_at IS NULL', [scenarioId]
    );
    return rows.length ? { id: Number(rows[0].id), name: rows[0].name, status: rows[0].status } : null;
}

/** Rule 10: every adjustment of the scenario, ascending id, in the adjustment JSON (§6.11). */
async function loadAdjustments(conn, scenarioId) {
    const [rows] = await conn.query(
        'SELECT * FROM scenario_adjustments WHERE scenario_id = ? ORDER BY id ASC', [scenarioId]
    );
    return rows.map(adjustmentToJson);
}

/** First occurrence wins, by `keyOf(row)`: §8's de-duplication across overlapping rules. */
function uniqueBy(rows, keyOf) {
    const seen = new Map();
    for (const row of rows) {
        const k = keyOf(row);
        if (!seen.has(k)) seen.set(k, row);
    }
    return [...seen.values()];
}

/**
 * §8 end to end: one /forecast request's rows → lib/engine.js's EngineInput (the
 * JSDoc typedef at the top of that file), with no logic of its own.
 *
 * `from`, `to`, `bucket`, `include` and `companyId` are echoed as requested (the
 * engine defaults and clamps them); the loader's own bound is
 * clampWindow(today, from, to).to. `scenario` is loadScenario's row or null. Every
 * in-scope account is listed, `anchorDate: null` when it has no balance on or before
 * today (NO_ANCHOR, and none of its rows are loaded). With no anchor anywhere there is
 * no minA and nothing dated is loaded; a draft scenario's targets still are (rule 6), so
 * its warnings stay truthful. A scenario that is not `draft` brings no adjustments and
 * no targets. No instance lists: the engine expands the schedules.
 */
async function loadEngineInput(conn, { today, from, to, bucket, include, companyId, scenario = null }) {
    const bound = clampWindow(today, from, to).to;
    const scope = await loadScopeAccounts(conn, companyId);
    const scopeIds = scope.map((a) => a.id);
    const anchors = await loadAnchors(conn, scopeIds, today);                          // rule 9
    const accounts = scope.map((a) => {
        const anchor = anchors.get(a.id);
        return { ...a, anchorDate: anchor ? anchor.anchorDate : null, anchorBalance: anchor ? anchor.anchorBalance : null };
    });
    const anchored = accounts.filter((a) => a.anchorDate !== null);
    const warnings = accounts.filter((a) => a.anchorDate === null).map((a) => ({ code: 'NO_ANCHOR', accountId: a.id }));
    const minA = anchored.reduce((m, a) => (m === null || a.anchorDate < m ? a.anchorDate : m), null);
    const dated = minA === null ? null : { accountIds: anchored.map((a) => a.id), minA, to: bound, today };

    // Rules 10 and 6 for a `draft` scenario only (coordinator decision, step 6): an
    // applied or archived scenario is history, not a live what-if — after an apply every
    // adjustment would read BASE_CHANGED — as GET /scenarios/:id resolves stale / current
    // only while draft. Its row still rides along, so meta.scenarioId and `scenario`
    // render, and the engine keeps every line non-editable.
    const live = scenario !== null && scenario.status === 'draft';
    const adjustments = live ? await loadAdjustments(conn, scenario.id) : [];           // rule 10
    const targetIds = (kind) => adjustments.filter((a) => a.targetKind === kind).map((a) => a.targetId);

    const items = uniqueBy([                                                            // rules 1, 2, 5, 6
        ...(dated ? await loadItems(conn, dated) : []),
        ...await loadItemTargets(conn, targetIds('item'), scopeIds),
    ], (i) => i.id);
    const schedules = uniqueBy([                                                        // rules 1, 2, 5, 6, 7
        ...(dated ? await loadSchedules(conn, dated) : []),
        ...await loadScheduleTargets(conn, targetIds('sched'), scopeIds),
    ], (s) => s.id);
    const overrides = uniqueBy(                                                         // rule 3, late joiners included
        await loadScheduleOverrides(conn, schedules.map((s) => s.id)),
        (o) => `${o.scheduleId}|${o.naturalDate}`,
    );
    const payments = minA === null ? [] : [                                             // rule 4
        ...await loadItemPayments(conn, items.map((i) => i.id), { since: minA }),
        ...await loadOverridePayments(conn, overrides.map((o) => o.id), { since: minA }),
    ];
    const categories = await loadCategories(conn, [...items, ...schedules].map((r) => r.categoryId));

    const input = {
        today, from, to, bucket, include, companyId,
        accounts, rates: {}, categories, items, schedules, overrides, payments, adjustments,
        externalItems: [], scenario, warnings,
    };
    input.rates = await loadRates(conn, currenciesInScope(input), today);               // rule 8
    return input;
}

/**
 * §8's single-target read for the adjustment write, rebase and apply, called
 * AFTER the caller has locked the target's rows in the standing order (§10.1).
 * `parsedKey` is lib/keys.js parseKey's result. Returns
 * {kind, id, naturalDate, status, effectiveDate, effectiveAmount, currency,
 *  accountId, settleMode, hasPaymentState, overrideId} or null when the row is
 * not live, when a `sched.` date is not an occurrence of its schedule (wrong
 * date, past the end, or before active_from), or for a `ship.` key (D8). A
 * one-off's effective values are its own; an instance's are recurrence.js
 * effectiveValues over the schedule and its override row (§3.4, D11). "Payment
 * state" is §3.4's predicate on the cache columns.
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
    if (parsedKey.targetKind === 'sched') {
        const [rows] = await conn.query(
            `SELECT s.*, a.company_id
               FROM schedules s
               LEFT JOIN bank_accounts a ON a.id = s.account_id
              WHERE s.id = ? AND s.deleted_at IS NULL`,
            [parsedKey.targetId]
        );
        if (!rows.length) return null;
        const schedule = scheduleToJson(rows[0]);
        const naturalDate = parsedKey.targetDate;
        if (!isOccurrence(schedule, naturalDate)) return null;           // wrong date, past the end, or the predecessor's
        const [overrides] = await conn.query(
            `SELECT o.*,
                    (o.status IN ('paid', 'part_paid') OR o.paid_amount > 0 OR o.paid_on IS NOT NULL) AS has_payment_state
               FROM schedule_overrides o
              WHERE o.schedule_id = ? AND o.natural_date = ?`,
            [schedule.id, naturalDate]
        );
        const override = overrides.length ? overrideToJson(overrides[0]) : null;
        const values = effectiveValues(schedule, naturalDate, override);   // §3.4, the one definition
        return {
            kind: 'sched',
            id: schedule.id,
            naturalDate,
            status: values.status,
            effectiveDate: values.effectiveDate,
            effectiveAmount: values.amount,
            currency: schedule.currency,
            accountId: schedule.accountId,
            settleMode: values.settleMode,
            hasPaymentState: overrides.length ? Boolean(Number(overrides[0].has_payment_state)) : false,
            overrideId: override ? override.id : null,
        };
    }
    throw new Error(`loadTarget: unknown target kind ${parsedKey.targetKind}`);
}

module.exports = {
    ITEM_SELECT,
    loadAnchors,
    loadItems,
    loadItemTargets,
    loadItemPayments,
    loadScopeAccounts,
    loadSchedules,
    loadScheduleTargets,
    loadScheduleOverrides,
    loadOverridePayments,
    loadCategories,
    loadRates,
    loadScenario,
    loadAdjustments,
    loadEngineInput,
    loadTarget,
};
