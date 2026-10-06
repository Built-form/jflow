'use strict';

// Forecast engine (CONTRACT §9): engineInput (§8) → the /forecast body (§6.10), minus
// `meta.generatedAt`, which the route adds. Pure: no DB, no clock, no I/O. `today` comes in.
// Money is bigint minor units inside and JSON integers at the edge; dates are 'YYYY-MM-DD'
// strings with epoch-day arithmetic (lib/dates.js).
//
// The steps, in §9's order:
//   1 today            given (input.today), never derived here
//   2 anchors          per account; no anchor → NO_ANCHOR, account excluded
//   3 load             done by services/forecastLoad.js; this file expands each loaded
//                      schedule's instances itself (see "Instances" below)
//   4 effective values lib/recurrence.js effectiveValues; an override that is not an
//                      occurrence → ORPHAN_OVERRIDE, never projected
//   5 adjustments      before classifying; baseline and scenario are two line sets from here
//   6 classify         lib/classify.js, one call per line per set. THE TABLE LIVES THERE:
//                      this file only routes the bands it returns (absorbed, placed in the
//                      series, unresolved, or nowhere) and never compares a date with an
//                      anchor or counts overdue days itself
//   7 FX               one rate set per run; GBP is 1.000000 (D3)
//   8 rounding         GBP fixed once per line; every total is an integer sum of those
//   9 roll             each account from its own anchor to today (absorbed[]); the combined
//                      GBP series from today
//  10 window           [today, to]; an earlier `from` is clamped (fromClamped)
//  11 cap              to − today <= 730 days (toClamped)
//
// Instances. The loader hands over schedule rows, not instances; the engine expands them
// (recurrence is pure logic, and §8 keeps the loader logic-free). Per schedule of an
// in-scope, anchored account: natural dates in [minA − 2, to + 2] (§8 rule 1, widened by
// the weekend rule's reach, which can move a date two days across either edge); for a
// manual schedule also back to max(start_date, today − 730) (§8 rule 5); plus, for every
// schedule, the natural date of each of its overrides (rule 3) and of each adjustment
// target (rule 6).
//
// Ship lines (Phase 2, §9.3.1). Each `externalItems` row that makes a line (lib/lines.js
// shipLine: not gone, and paid or dated) becomes one line of the systemKey 'ship'
// category, direction 'out', settle mode 'manual', and then flows through steps 5–12
// exactly as items and instances do. Undated open rows are only counted (the `shipping`
// block); a gone row with an overlay only warns (SHIP_PLAN_ORPHANED).

const { addDays, addMonthsClamped, dayOfWeek, diffDays, isValidDate } = require('./dates');
const { parseMinor, parseRate, toGbp, fromGbp } = require('./money');
const { buildItemKey, buildSchedKey, buildShipKey } = require('./keys');
const { occurrences, isOccurrence, effectiveValues } = require('./recurrence');
const { classify } = require('./classify');
const { itemLine, shipLine, shipName, shipEffectiveValues, hasShipOverlay, shipDateMoved } = require('./lines');

/**
 * CONTRACT §8's `engineInput`, field for field. Rows are the camelCase JSON of lib/shape.js
 * (§2.4); only the fields named here are read. Money is DECIMAL strings, dates 'YYYY-MM-DD',
 * ids JSON numbers (an adjustment's `targetId` is the string of D32).
 *
 * @typedef {object} EngineInput
 * @property {string} today                  Europe/London date from the route (§2.5)
 * @property {string} [from]                 as requested; default today; earlier → clamped (D7, §9.10)
 * @property {string} [to]                   as requested; default today + 90; beyond today + 730 → clamped (D25)
 * @property {'day'|'week'|'month'} [bucket] default 'week' (D7)
 * @property {'grid'|'summary'} [include]    default 'grid' (D7)
 * @property {number|'all'|null} [companyId] echoed in meta
 * @property {EngineAccount[]} accounts      every live, active account in scope; anchorDate null → NO_ANCHOR
 * @property {Object<string, {rateToGbp: string, effectiveFrom: string}>} rates
 *           per non-GBP currency in scope (§3.4): the latest row with effectiveFrom <= today
 * @property {EngineCategory[]} categories   at least every category of a loaded item or schedule
 * @property {EngineItem[]} items            §8 rules 1, 2, 5, 6
 * @property {EngineSchedule[]} schedules    §8 rules 1, 2, 5, 6, 7
 * @property {EngineOverride[]} overrides    every override row of every loaded schedule (D31)
 * @property {EnginePayment[]} payments      rows of loaded items / overrides with paidOn >= minA (rule 4)
 * @property {EngineAdjustment[]} adjustments the scenario's adjustments (any order; applied by ascending id)
 * @property {EngineExternalItem[]} externalItems  §8 rule 11 plus rule-6 `ship.` targets (Phase 2)
 * @property {EngineShipping|null} [shipping]  external_sync; null until the feed has succeeded once
 * @property {EngineScenario|null} scenario
 * @property {Array<{code: 'NO_ANCHOR', accountId: number}|{code: 'SHIPPING_UNAVAILABLE', reason: string,
 *           lastSuccessAt: string|null}>} warnings  the loader's and the route's; merged, not duplicated
 *
 * @typedef {object} EngineExternalItem  an external_items row (§3.5) in camelCase plus its resolution
 * @property {string} extId                  key = ship.<extId> (§4)
 * @property {'deposit'|'balance'} feedKind
 * @property {'open'|'paid'} feedStatus
 * @property {string|null} supplier
 * @property {string|null} poNumber
 * @property {string|null} containerRef
 * @property {string} currency
 * @property {string} amount                 open: still owed; paid: this payment
 * @property {string|null} dueDate           open rows (null = undated)
 * @property {string|null} paidOn            paid rows
 * @property {'firm'|'estimated'|'undated'} dateBasis
 * @property {'stated'|'derived'} amountBasis
 * @property {string|null} blocked
 * @property {string|null} goneAt            set → never projected (a rule-6 target, or an orphaned overlay)
 * @property {string|null} plannedDate       overlay (§3.5)
 * @property {string|null} plannedAmount
 * @property {boolean|number} plannedSkipped
 * @property {string|null} plannedBaseAmount
 * @property {string|null} plannedNote
 * @property {number|null} sourceScenarioId
 * @property {number|null} accountId         resolved at load (§3.4, P5); null = unmapped
 * @property {number|null} companyId
 * @property {boolean} [inScope]             false for an out-of-scope or unmapped rule-6 target
 *
 * @typedef {object} EngineShipping
 * @property {string|null} lastSuccessAt     ISO 8601
 * @property {string|null} feedToday
 * @property {Array<{shippingCompanyId: number|null, count: number, reason: 'company'|'account',
 *            companyId?: number, currencies?: string[]}>} unmappedCounts  rows omitted (SHIP_UNMAPPED): 'company' =
 *            no JFlow company has that shipping company; 'account' = `companyId` has no active account
 *            in `currencies` and no active default
 *
 * @typedef {object} EngineAccount
 * @property {number} id
 * @property {number} companyId
 * @property {string} name
 * @property {string} currency
 * @property {string|null} anchorDate        latest bank_balances.balance_date <= today
 * @property {string|null} anchorBalance     that row's balance (start of day), DECIMAL
 *
 * @typedef {object} EngineCategory
 * @property {number} id
 * @property {string} name
 * @property {'in'|'out'} direction
 * @property {number} sortOrder
 * @property {string|null} [systemKey]       'ship' on "Stock payments" (P10), the category of every ship line
 *
 * @typedef {object} EngineItem  itemToJson (§6.7) plus inScope
 * @property {number} id
 * @property {number} accountId
 * @property {number} categoryId
 * @property {'in'|'out'} direction
 * @property {string} name
 * @property {string|null} counterparty
 * @property {string} amount
 * @property {string} currency
 * @property {string} dueDate
 * @property {'expected'|'part_paid'|'paid'|'skipped'} status
 * @property {string|null} paidOn            cache (D23)
 * @property {string|null} paidAmount        cache (D23)
 * @property {'auto'|'manual'} settleMode
 * @property {number|null} sourceScenarioId
 * @property {boolean} [inScope]             false only for an out-of-scope adjustment target (D20); default true
 *
 * @typedef {object} EngineSchedule  the schedule JSON (§6.8) plus inScope
 * @property {number} id
 * @property {number} accountId
 * @property {number} categoryId
 * @property {'in'|'out'} direction
 * @property {string} name
 * @property {string|null} counterparty
 * @property {string} amount
 * @property {string} currency
 * @property {string} frequency
 * @property {number} intervalCount
 * @property {string} startDate
 * @property {string|null} activeFrom
 * @property {number|null} occurrenceCount
 * @property {string|null} endDate
 * @property {'none'|'previous'|'next'} weekendRule
 * @property {'auto'|'manual'} settleMode
 * @property {boolean} [inScope]             as items
 *
 * @typedef {object} EngineOverride  the override JSON (§6.9) plus its parent and identity
 * @property {number} id
 * @property {number} scheduleId
 * @property {string} naturalDate
 * @property {string|null} amount
 * @property {string|null} dueDate
 * @property {'expected'|'part_paid'|'paid'|'skipped'|null} status
 * @property {'auto'|'manual'|null} settleMode
 * @property {string|null} paidOn
 * @property {string|null} paidAmount
 * @property {number|null} sourceScenarioId
 *
 * @typedef {object} EnginePayment  paymentToJson
 * @property {number} id
 * @property {number|null} cashItemId
 * @property {number|null} overrideId
 * @property {string} paidOn
 * @property {string} amount
 *
 * @typedef {object} EngineAdjustment  the adjustment JSON (§6.11)
 * @property {number} id
 * @property {string} itemKey
 * @property {'adjust'|'exclude'} kind
 * @property {string|null} newDate
 * @property {string|null} newAmount
 * @property {string} baseDate
 * @property {string} baseAmount
 *
 * @typedef {object} EngineScenario
 * @property {number} id
 * @property {string} name
 * @property {'draft'|'applied'|'archived'} status
 */

const MAX_WINDOW_DAYS = 730;          // §9.11, D25
const DEFAULT_WINDOW_DAYS = 90;       // D7
const MANUAL_LOOKBACK_DAYS = 730;     // §8 rule 5
const WEEKEND_SLACK_DAYS = 2;         // §5.3: a weekend rule moves a date by at most two days
const BUCKETS = ['day', 'week', 'month'];
const INCLUDES = ['summary', 'grid'];
const GBP = 'GBP';
const GBP_RATE = '1.000000';          // D3

// ── Small helpers ───────────────────────────────────────────────────────────────────────

function requireDate(value, name) {
    if (!isValidDate(value)) throw new TypeError(`engine: ${name} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
    return value;
}

function requireDirection(row) {
    if (row.direction !== 'in' && row.direction !== 'out') {
        throw new TypeError(`engine: direction must be 'in' or 'out', got ${JSON.stringify(row.direction)}`);
    }
    return row.direction;
}

/** bigint minor units → JSON integer; refuses anything a double cannot hold exactly. */
function num(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new RangeError(`engine: ${value} is outside the safe integer range`);
    return n;
}

const sign = (direction) => (direction === 'in' ? 1n : -1n);

function groupBy(rows, field) {
    const out = new Map();
    for (const row of rows || []) {
        const k = row[field];
        if (k == null) continue;
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(row);
    }
    return out;
}

/** §7: the refusal the route answers as-is (the shape of lib/shape.js apiError). */
function fxRateMissing(currencies) {
    const err = new Error(`No FX rate with effective_from on or before today for ${currencies.join(', ')}.`);
    err.status = 422;
    err.code = 'FX_RATE_MISSING';
    err.details = { currencies };
    err.isApiError = true;
    return err;
}

// ── Window (§9.10, §9.11, D7, D25) ─────────────────────────────────────────────────────

/**
 * The output window: `from` defaults to today and is raised to today when earlier
 * (fromClamped); `to` defaults to today + 90 and is lowered to today + 730 when later
 * (toClamped). Throws RangeError when the window ends before today or starts after its
 * end (the route answers those 400 before calling). The loader takes its `to` from here.
 */
function clampWindow(today, from, to) {
    requireDate(today, 'today');
    const wantFrom = requireDate(from ?? today, 'from');
    const wantTo = requireDate(to ?? addDays(today, DEFAULT_WINDOW_DAYS), 'to');
    const cap = addDays(today, MAX_WINDOW_DAYS);
    const fromClamped = wantFrom < today;
    const toClamped = wantTo > cap;
    const window = { from: fromClamped ? today : wantFrom, to: toClamped ? cap : wantTo, fromClamped, toClamped };
    if (window.to < today) throw new RangeError(`engine: to ${window.to} is before today ${today}`);
    if (window.from > window.to) throw new RangeError(`engine: from ${window.from} is after to ${window.to}`);
    return window;
}

// ── FX (§9.7, §3.4) ─────────────────────────────────────────────────────────────────────

/**
 * §3.4's currencies in scope: the in-scope accounts' currencies ∪ the currencies of every
 * loaded item, schedule and ship row (undated rows included), adjustment targets
 * included. A gone ship row makes no line and is converted nowhere, so it needs no rate.
 * Sorted.
 */
function currenciesInScope(input) {
    const set = new Set();
    for (const a of input.accounts || []) set.add(a.currency);
    for (const i of input.items || []) set.add(i.currency);
    for (const s of input.schedules || []) set.add(s.currency);
    for (const e of input.externalItems || []) if (e.goneAt == null) set.add(e.currency);
    return [...set].sort();
}

/** One rate set per run: Map currency → micro-units, plus meta.ratesUsed. Throws FX_RATE_MISSING. */
function buildRates(input) {
    const currencies = currenciesInScope(input);
    const given = input.rates || {};
    const missing = currencies.filter((c) => c !== GBP && !given[c]);
    if (missing.length) throw fxRateMissing(missing);
    const micro = new Map([[GBP, parseRate(GBP_RATE)]]);
    const used = {};
    for (const c of currencies) {
        if (c === GBP) {
            used[c] = { rateToGbp: GBP_RATE, effectiveFrom: null };
        } else {
            micro.set(c, parseRate(given[c].rateToGbp));
            used[c] = { rateToGbp: given[c].rateToGbp, effectiveFrom: given[c].effectiveFrom ?? null };
        }
    }
    const rateOf = (c) => {
        if (!micro.has(c)) throw fxRateMissing([c]);
        return micro.get(c);
    };
    return { rateOf, used };
}

// ── Lines: items and instances with their effective values (§9.4, §3.4) ─────────────────

/** §3.4's "payment state", on a row's cache columns. */
function hasPaymentState(row) {
    return row.status === 'paid' || row.status === 'part_paid'
        || (row.paidAmount != null && parseMinor(row.paidAmount) > 0n)
        || row.paidOn != null;
}

const byPaidOn = (a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : a.id - b.id);

const paymentLine = (p) => ({ paymentId: p.id, paidOn: p.paidOn, amountMinor: parseMinor(p.amount) });

function describe(row) {
    return {
        name: row.name,
        counterparty: row.counterparty ?? null,
        categoryId: row.categoryId,
        direction: requireDirection(row),
        accountId: row.accountId,
        currency: row.currency,
        inScope: row.inScope !== false,
    };
}

function itemRecord(item, payments) {
    const line = itemLine(item, [...payments].sort(byPaidOn));
    return {
        key: buildItemKey(item.id), kind: 'item', id: item.id, scheduleId: null, naturalDate: null,
        ...describe(item),
        status: line.status, settleMode: line.settleMode, date: line.effectiveDate,
        amountMinor: line.amountMinor, paidAmountMinor: line.paidAmountMinor, payments: line.payments,
        tuned: false, sourceScenarioId: item.sourceScenarioId ?? null, hasPaymentState: hasPaymentState(item),
    };
}

// The instance counterpart of lib/lines.js itemLine, on §3.4's effective values.
function instanceRecord(schedule, naturalDate, override, payments) {
    const ev = effectiveValues(schedule, naturalDate, override);
    return {
        key: buildSchedKey(schedule.id, naturalDate), kind: 'sched', id: schedule.id,
        scheduleId: schedule.id, naturalDate,
        ...describe(schedule),
        status: ev.status, settleMode: ev.settleMode, date: ev.effectiveDate,
        amountMinor: parseMinor(ev.amount),
        paidAmountMinor: override && override.paidAmount != null ? parseMinor(override.paidAmount) : 0n,
        payments: [...payments].sort(byPaidOn).map(paymentLine),
        tuned: override !== null,
        sourceScenarioId: override ? override.sourceScenarioId ?? null : null,
        hasPaymentState: override ? hasPaymentState(override) : false,
    };
}

const FEED_STATUSES = ['open', 'paid'];
// Why a ship row was left out (SHIP_UNMAPPED.reason, §6.10), in the warnings' order.
const SHIP_UNMAPPED_REASONS = ['company', 'account'];

function requireFeedStatus(row) {
    if (!FEED_STATUSES.includes(row.feedStatus)) {
        throw new TypeError(`engine: ship row ${JSON.stringify(row.extId)} feedStatus must be 'open' or 'paid', got ${JSON.stringify(row.feedStatus)}`);
    }
    return row.feedStatus;
}

/**
 * §6.10's ship flags, carried on the line; none of them changes a band. `due_set`: the
 * feed's date was set by hand in ShipLine (row.dueSet says by whom); `date_moved`: the
 * refresh moved the feed's due date within the last DATE_MOVED_DAYS (lib/lines.js).
 */
function shipFlags(row, today) {
    const flags = [];
    if (row.dateBasis === 'estimated') flags.push('estimated');
    // `projected` (amountBasis = 'derived') retired 2026-10-06: it read as "no invoice" to
    // users, while it only meant "worked out from the terms"; amountBasis stays on the row.
    if (row.blocked != null) flags.push('blocked');
    if (hasShipOverlay(row)) flags.push('planned');
    if (row.dueSet) flags.push('due_set');
    if (shipDateMoved(row, today)) flags.push('date_moved');
    return flags;
}

/**
 * §9.3.1: a ship row that makes a line (lib/lines.js shipLine) → its record: kind 'ship',
 * the systemKey 'ship' category, direction 'out', settle mode 'manual', the resolved
 * account. `hasPaymentState` is true for a paid row (the feed row is the payment).
 */
function shipRecord(row, line, category, today) {
    return {
        key: buildShipKey(row.extId), kind: 'ship', id: row.extId, scheduleId: null, naturalDate: null,
        name: shipName(row),
        counterparty: row.supplier ?? null,
        categoryId: category.id,
        direction: 'out',
        accountId: row.accountId,
        currency: row.currency,
        inScope: row.inScope !== false && row.accountId != null,
        status: line.status, settleMode: line.settleMode, date: line.effectiveDate,
        amountMinor: line.amountMinor, paidAmountMinor: line.paidAmountMinor, payments: line.payments,
        tuned: false, sourceScenarioId: row.sourceScenarioId ?? null, hasPaymentState: line.status === 'paid',
        shipFlags: shipFlags(row, today),
        ship: {
            kind: row.feedKind, poNumber: row.poNumber ?? null, containerRef: row.containerRef ?? null,
            dateBasis: row.dateBasis, amountBasis: row.amountBasis, blocked: row.blocked ?? null,
            feedDate: row.dueDate ?? null, feedAmountMinor: parseMinor(row.amount),
            // The story of a date set by hand in ShipLine, and the feed's last date move
            // (handover doc "Dates set by hand"); null when there is none.
            dueSet: row.dueSet ?? null,
            dateMovedFrom: shipDateMoved(row, today) ? (row.dueDatePrev ?? null) : null,
            dateMovedAt: shipDateMoved(row, today) ? isoInstant(row.dueDateMovedAt) : null,
        },
    };
}

/** A DATETIME as the row carries it (a Date from the pool, or an ISO string) → ISO string | null. */
function isoInstant(v) {
    if (v == null) return null;
    return v instanceof Date ? v.toISOString() : String(v);
}

/** A forwarder's cost of the shipment itself: paid to its own payee, not the supplier. */
const isFreightRow = (row) => row.feedKind === 'extra' && Array.isArray(row.flags) && row.flags.includes('shipment_cost');

/**
 * The category a ship row's line sits in: the systemKey 'ship' category (P10) for every row
 * but a forwarder's shipment cost, which sits in the systemKey 'freight' category
 * ("Freight and forwarders", Dev 2026-10-06) when one is seeded, else with the rest.
 */
function shipCategoryOf(categories, row) {
    let ship = null;
    let freight = null;
    for (const c of categories.values()) {
        if (c.systemKey === 'ship') ship = ship ?? c;
        if (c.systemKey === 'freight') freight = freight ?? c;
    }
    if (!ship) throw new TypeError("engine: ship lines need the systemKey 'ship' category in input.categories");
    return row && freight && isFreightRow(row) ? freight : ship;
}

/**
 * Every loaded line, keyed by its item key: the in-scope lines of the forecast and the
 * out-of-scope adjustment targets (kept for their stale check only). Emits ORPHAN_OVERRIDE
 * for an in-scope schedule's override whose natural date is not an occurrence (§5.5).
 */
function buildRecords(input, { today, window, anchors, minA, categories }) {
    const records = new Map();
    const orphans = [];
    const paymentsOfItem = groupBy(input.payments, 'cashItemId');
    const paymentsOfOverride = groupBy(input.payments, 'overrideId');

    for (const item of input.items || []) {
        const rec = itemRecord(item, paymentsOfItem.get(item.id) || []);
        records.set(rec.key, rec);
    }

    const overridesOf = groupBy(input.overrides, 'scheduleId');
    const targetDatesOf = new Map();
    for (const adj of input.adjustments || []) {
        if (adj.targetKind !== 'sched' || !adj.targetDate) continue;
        const id = String(adj.targetId);
        if (!targetDatesOf.has(id)) targetDatesOf.set(id, []);
        targetDatesOf.get(id).push(adj.targetDate);
    }

    for (const schedule of input.schedules || []) {
        const inScope = schedule.inScope !== false;
        const byNatural = new Map((overridesOf.get(schedule.id) || []).map((o) => [o.naturalDate, o]));
        const dates = new Set();
        if (inScope && anchors.has(schedule.accountId)) {
            const hi = addDays(window.to, WEEKEND_SLACK_DAYS);
            occurrences(schedule, addDays(minA, -WEEKEND_SLACK_DAYS), hi).forEach((d) => dates.add(d));
            if (schedule.settleMode === 'manual') {
                occurrences(schedule, addDays(today, -MANUAL_LOOKBACK_DAYS), hi).forEach((d) => dates.add(d));
            }
        }
        for (const [naturalDate, o] of byNatural) {
            if (isOccurrence(schedule, naturalDate)) dates.add(naturalDate);
            else if (inScope) orphans.push({ code: 'ORPHAN_OVERRIDE', scheduleId: schedule.id, naturalDate, overrideId: o.id });
        }
        for (const naturalDate of targetDatesOf.get(String(schedule.id)) || []) {
            if (isOccurrence(schedule, naturalDate)) dates.add(naturalDate);
        }
        for (const naturalDate of dates) {
            const o = byNatural.get(naturalDate) || null;
            const rec = instanceRecord(schedule, naturalDate, o, o ? paymentsOfOverride.get(o.id) || [] : []);
            records.set(rec.key, rec);
        }
    }

    // §9.3.1: a gone row, or an open row with no effective date, makes no line (and so,
    // as an adjustment target, reads TARGET_MISSING).
    for (const row of input.externalItems || []) {
        requireFeedStatus(row);
        const line = shipLine(row);
        if (line === null) continue;
        const rec = shipRecord(row, line, shipCategoryOf(categories, row), today);
        records.set(rec.key, rec);
    }

    orphans.sort((a, b) => a.scheduleId - b.scheduleId || (a.naturalDate < b.naturalDate ? -1 : 1));
    return { records, orphans };
}

// ── Scenario adjustments, before classifying (§9.5) ─────────────────────────────────────

/** The first stale reason of §9.5's table, on the target's native pre-adjustment values; null when none. */
function staleReason(adj, target, today) {
    if (!target) return 'TARGET_MISSING';
    if (target.status !== 'expected' || target.hasPaymentState) return 'TARGET_SETTLED';
    if (adj.baseDate !== target.date || parseMinor(adj.baseAmount) !== target.amountMinor) return 'BASE_CHANGED';
    if (adj.kind === 'adjust' && adj.newDate != null && adj.newDate < today) return 'DATE_PASSED';
    return null;
}

/** The scenario set: a copy of the baseline with each adjustment applied or flagged. */
function applyAdjustments(baseline, records, adjustments, today) {
    const lines = baseline.map((l) => ({ ...l }));
    const byKey = new Map(lines.map((l) => [l.key, l]));
    const warnings = [];
    for (const adj of [...(adjustments || [])].sort((a, b) => a.id - b.id)) {
        if (adj.kind !== 'adjust' && adj.kind !== 'exclude') {
            throw new TypeError(`engine: adjustment kind must be 'adjust' or 'exclude', got ${JSON.stringify(adj.kind)}`);
        }
        const key = adj.itemKey;
        const target = records.get(key);
        const line = byKey.get(key);
        const reason = staleReason(adj, target, today);
        if (reason) {
            warnings.push({ code: 'STALE', key, reason });
            if (line) line.stale = true;
            continue;
        }
        if (!target.inScope) {                       // D20: loaded for the check, applied to nothing
            warnings.push({ code: 'ADJUSTMENT_OUT_OF_SCOPE', key });
            continue;
        }
        if (!line) continue;                          // its account has no anchor: NO_ANCHOR says why
        if (adj.kind === 'exclude') {
            line.excluded = true;
        } else {
            if (adj.newDate != null) line.date = requireDate(adj.newDate, 'adjustment newDate');
            if (adj.newAmount != null) line.amountMinor = parseMinor(adj.newAmount);
            line.adjusted = true;
        }
    }
    return { lines, warnings };
}

// ── Classify each set (§9.6) and route what classify returns (§9.9) ─────────────────────

// Where each of classify's owed bands goes. Nothing here decides a band.
const OWED_SECTION = {
    skipped: null,
    assumedSettled: null,
    assumed: 'absorbed',
    future: 'placed',
    overdue: 'placed',
    unresolved: 'unresolved',
};

/** A classified piece → 'absorbed' | 'placed' | 'unresolved' | null (in nothing). */
function sectionOf(piece, today) {
    if (piece.isPayment) {
        if (piece.band !== 'paid') return null;                  // settledBeforeAnchor: in the balance
        return piece.date < today ? 'absorbed' : 'placed';       // row 2: before today absorbed, else its day
    }
    const section = OWED_SECTION[piece.band];
    if (section === undefined) throw new Error(`engine: unknown band ${JSON.stringify(piece.band)} from classify`);
    return section;
}

/** §6.10's item flags, in a fixed order (a ship line's feed flags first). */
function rowFlags(line, piece) {
    const flags = line.shipFlags ? [...line.shipFlags] : [];
    if (line.tuned) flags.push('tuned');
    if (line.sourceScenarioId != null) flags.push('fromScenario');
    if (piece.isPayment) {
        flags.push('paid');
        if (piece.partial) flags.push('partial');
    }
    if (piece.remainder) flags.push('remainder');
    if (piece.band === 'overdue') flags.push('overdue');
    if (line.adjusted) flags.push('adjusted');
    if (line.excluded) flags.push('excluded');
    if (line.stale) flags.push('stale');
    return flags;
}

const identityOf = (line, piece) => `${line.key}|${piece.isPayment ? piece.paymentId : '-'}`;

const classifyLine = (l) => ({
    status: l.status,
    settleMode: l.settleMode,
    effectiveDate: l.date,
    amountMinor: l.amountMinor,
    paidAmountMinor: l.paidAmountMinor,
    payments: l.payments,
});

/**
 * One set through classify, FX and placement: per account its absorbed parts and openings
 * (§9.9), the parts placed in the series, the unresolved parts, and every part by identity
 * (the baseline values a scenario row shows).
 */
function evaluate(lines, { today, anchors, rateOf }) {
    const absorbed = new Map([...anchors.keys()].map((id) => [id, []]));
    const placed = [];
    const unresolved = [];
    const byIdentity = new Map();

    for (const line of lines) {
        const account = anchors.get(line.accountId);
        const result = classify(classifyLine(line), account.anchorDate, today);
        const pieces = result.payments.map((p) => ({
            isPayment: true, paymentId: p.paymentId, band: p.band, date: p.date,
            amountMinor: p.amountMinor, partial: p.partial, remainder: false,
        }));
        if (result.owed) {
            const o = result.owed;
            pieces.push({
                isPayment: false, paymentId: null, band: o.band, date: o.date,
                amountMinor: o.amountMinor, partial: false, remainder: o.remainder,
            });
        }
        for (const piece of pieces) {
            // §9.8: GBP once per line; a foreign line reaches the account through GBP.
            const gbpMinor = toGbp(piece.amountMinor, rateOf(line.currency));
            const accountMinor = line.currency === account.currency
                ? piece.amountMinor
                : fromGbp(gbpMinor, rateOf(account.currency));
            const section = sectionOf(piece, today);
            const flags = rowFlags(line, piece);
            const part = { ...piece, line, gbpMinor, accountMinor, flags, identity: identityOf(line, piece), counts: !line.excluded };
            byIdentity.set(part.identity, {
                date: piece.date, amountMinor: piece.amountMinor, gbpMinor,
                flags: section === 'placed' || piece.isPayment ? flags : [...flags, piece.band],
            });
            if (section === null) continue;
            if (line.excluded && section !== 'placed') continue;   // D30: counts nothing, shown only in rows
            if (section === 'absorbed') absorbed.get(line.accountId).push(part);
            else if (section === 'placed') placed.push(part);
            else unresolved.push(part);
        }
    }

    const accounts = [...anchors.values()].map((a) => {
        const parts = absorbed.get(a.id).sort(byPlacement);
        let openingNative = a.anchorNative;
        let openingGbp = a.anchorGbp;
        for (const p of parts) {
            openingNative += sign(p.line.direction) * p.accountMinor;
            openingGbp += sign(p.line.direction) * p.gbpMinor;
        }
        return { account: a, absorbed: parts, openingNative, openingGbp };
    });
    return { accounts, placed: placed.sort(byPlacement), unresolved: unresolved.sort(byPlacement), byIdentity };
}

/** Date, then key, then payment lines (by id) before the owed line. */
function byPlacement(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.line.key !== b.line.key) return a.line.key < b.line.key ? -1 : 1;
    if (a.isPayment !== b.isPayment) return a.isPayment ? -1 : 1;
    return a.isPayment ? a.paymentId - b.paymentId : 0;
}

// ── Series, buckets, summary (§9.9, §9.12) ──────────────────────────────────────────────

/**
 * The combined GBP line, rolled from today (Σ openingGbp) to `to`; the days in [from, to]
 * are returned. A line counts on its placed date; excluded lines count nothing.
 */
function dailySeries(set, { today, window }) {
    const flows = new Map();
    for (const p of set.placed) {
        if (!p.counts || p.date > window.to) continue;
        const f = flows.get(p.date) || { inflow: 0n, outflow: 0n };
        if (p.line.direction === 'in') f.inflow += p.gbpMinor; else f.outflow += p.gbpMinor;
        flows.set(p.date, f);
    }
    let balance = set.accounts.reduce((acc, a) => acc + a.openingGbp, 0n);
    const days = [];
    for (let date = today; date <= window.to; date = addDays(date, 1)) {
        const f = flows.get(date) || { inflow: 0n, outflow: 0n };
        const net = f.inflow - f.outflow;
        const day = { date, opening: balance, inflow: f.inflow, outflow: f.outflow, net, closing: balance + net };
        balance = day.closing;
        if (date >= window.from) days.push(day);
    }
    return days;
}

/** D6: calendar-aligned day / week (Monday–Sunday) / month buckets, first and last clipped. */
function bucketRanges(from, to, bucket) {
    const ranges = [];
    for (let start = from; start <= to;) {
        let end = start;
        if (bucket === 'week') end = addDays(start, 7 - dayOfWeek(start));
        else if (bucket === 'month') end = addDays(addMonthsClamped(`${start.slice(0, 8)}01`, 1), -1);
        if (end > to) end = to;
        ranges.push({ start, end });
        start = addDays(end, 1);
    }
    return ranges;
}

/** The lowest daily closing and its (first) date. */
function lowest(days) {
    let low = days[0];
    for (const d of days) if (d.closing < low.closing) low = d;
    return { minClosing: low.closing, minDate: low.date };
}

const total = (items, field) => items.reduce((acc, x) => acc + x[field], 0n);

function bucketFigures(days, ranges) {
    let i = 0;
    return ranges.map(({ start, end }) => {
        const inBucket = [];
        while (i < days.length && days[i].date <= end) inBucket.push(days[i++]);
        return {
            start, end,
            opening: inBucket[0].opening,
            inflow: total(inBucket, 'inflow'),
            outflow: total(inBucket, 'outflow'),
            net: total(inBucket, 'net'),
            closing: inBucket[inBucket.length - 1].closing,
            ...lowest(inBucket),
        };
    });
}

function summarise(set, days) {
    return {
        opening: days[0].opening,
        inflow: total(days, 'inflow'),
        outflow: total(days, 'outflow'),
        net: total(days, 'net'),
        closing: days[days.length - 1].closing,
        ...lowest(days),
        unresolvedCount: BigInt(set.unresolved.length),
        unresolvedTotal: total(set.unresolved, 'gbpMinor'),
        absorbedCount: BigInt(set.accounts.reduce((acc, a) => acc + a.absorbed.length, 0)),
    };
}

// ── JSON at the edge ────────────────────────────────────────────────────────────────────

const moneyJson = (o, fields) => Object.fromEntries(fields.map((f) => [f, typeof o[f] === 'bigint' ? num(o[f]) : o[f]]));
const DAY_FIELDS = ['date', 'opening', 'inflow', 'outflow', 'net', 'closing'];
const BUCKET_FIELDS = ['start', 'end', 'opening', 'inflow', 'outflow', 'net', 'closing', 'minClosing', 'minDate'];
const SUMMARY_FIELDS = ['opening', 'inflow', 'outflow', 'net', 'closing', 'minClosing', 'minDate',
    'unresolvedCount', 'unresolvedTotal', 'absorbedCount'];

function absorbedJson(p) {
    const l = p.line;
    const out = {
        key: l.key, name: l.name, categoryId: l.categoryId, date: p.date, currency: l.currency,
        amountMinor: num(p.amountMinor), accountMinor: num(p.accountMinor), gbpMinor: num(p.gbpMinor),
        direction: l.direction,
    };
    if (p.isPayment && p.paymentId != null) out.paymentId = p.paymentId;   // a ship payment has no payments row
    out.flags = p.isPayment ? (p.partial ? ['paid', 'partial'] : ['paid']) : ['assumed'];
    return out;
}

/** §6.10 rows[].items[].ship: the feed's view of a ship line. */
function shipJson(ship) {
    return { ...ship, feedAmountMinor: num(ship.feedAmountMinor) };
}

function accountJson(a, today, used) {
    const acct = a.account;
    return {
        accountId: acct.id, name: acct.name, companyId: acct.companyId, currency: acct.currency,
        rateToGbp: used[acct.currency].rateToGbp,
        anchorDate: acct.anchorDate, anchorAgeDays: diffDays(today, acct.anchorDate),
        anchorNative: num(acct.anchorNative), anchorGbp: num(acct.anchorGbp),
        openingNative: num(a.openingNative), openingGbp: num(a.openingGbp),
        absorbed: a.absorbed.map(absorbedJson),
    };
}

function unresolvedJson(p, today) {
    const l = p.line;
    return {
        key: l.key, kind: l.kind, name: l.name, categoryId: l.categoryId, accountId: l.accountId,
        currency: l.currency, amountMinor: num(p.amountMinor), gbpMinor: num(p.gbpMinor),
        direction: l.direction, date: p.date, ageDays: diffDays(today, p.date), settleMode: l.settleMode,
    };
}

/** §6.10 rows[]: category → the lines placed in [from, to], with per-bucket GBP totals. */
function buildRows(set, baseline, ranges, { window, categories, scenario }) {
    const bucketOf = new Map();
    ranges.forEach((r, i) => {
        for (let d = r.start; d <= r.end; d = addDays(d, 1)) bucketOf.set(d, i);
    });
    const editableSet = scenario === null || scenario.status === 'draft';
    const rows = new Map();
    for (const p of set.placed) {
        if (p.date < window.from || p.date > window.to) continue;
        const l = p.line;
        if (!rows.has(l.categoryId)) {
            const c = categories.get(l.categoryId);
            rows.set(l.categoryId, {
                categoryId: l.categoryId,
                categoryName: c ? c.name : null,
                direction: c ? c.direction : l.direction,
                sortOrder: c ? c.sortOrder : 0,
                totals: ranges.map(() => 0n),
                items: [],
            });
        }
        const row = rows.get(l.categoryId);
        const bucketIndex = bucketOf.get(p.date);
        if (p.counts) row.totals[bucketIndex] += p.gbpMinor;

        const out = { key: l.key, kind: l.kind, id: l.id };
        if (l.kind === 'sched') {
            out.scheduleId = l.scheduleId;
            out.naturalDate = l.naturalDate;
        }
        Object.assign(out, {
            name: l.name, counterparty: l.counterparty, accountId: l.accountId, currency: l.currency,
            amountMinor: num(p.amountMinor), accountMinor: num(p.accountMinor), gbpMinor: num(p.gbpMinor),
            date: p.date, dueDate: l.date, bucketIndex, status: l.status, settleMode: l.settleMode,
            flags: p.flags,
            editable: l.status === 'expected' && !p.remainder && editableSet,
        });
        if (p.isPayment && p.paymentId != null) out.paymentId = p.paymentId;
        if (l.kind === 'ship') out.ship = shipJson(l.ship);
        if (scenario !== null) {
            const b = baseline.byIdentity.get(p.identity);
            out.baseline = b ? { date: b.date, amountMinor: num(b.amountMinor), gbpMinor: num(b.gbpMinor), flags: b.flags } : null;
        }
        row.items.push(out);
    }
    return [...rows.values()]
        .sort((a, b) => (a.direction !== b.direction ? (a.direction === 'in' ? -1 : 1)
            : a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder
                : a.categoryName !== b.categoryName ? ((a.categoryName ?? '') < (b.categoryName ?? '') ? -1 : 1)
                    : a.categoryId - b.categoryId))
        .map((row) => ({
            ...row,
            totals: row.totals.map(num),
            total: num(row.totals.reduce((acc, t) => acc + t, 0n)),
        }));
}

// ── The shipping block and the ship warnings (§6.10, Phase 2) ───────────────────────────

/**
 * One loader count → SHIP_UNMAPPED {shippingCompanyId, count, reason}, plus {companyId,
 * currencies} for reason 'account' (the JFlow company that matched, and the currencies it
 * has no active account for, with no active default to fall back on).
 */
function unmappedWarning(u) {
    if (!SHIP_UNMAPPED_REASONS.includes(u.reason)) {
        throw new TypeError(`engine: unmappedCounts reason must be 'company' or 'account', got ${JSON.stringify(u.reason)}`);
    }
    const warning = { code: 'SHIP_UNMAPPED', shippingCompanyId: u.shippingCompanyId ?? null, count: Number(u.count), reason: u.reason };
    if (u.reason === 'account') {
        warning.companyId = Number(u.companyId);
        warning.currencies = [...(u.currencies || [])];
    }
    return warning;
}

/**
 * Over the ship rows of in-scope, anchored accounts (rule 11's rows; out-of-scope and
 * unmapped rule-6 targets count nowhere): the `shipping` block — openCount (open rows,
 * skipped included), undatedCount / undatedGbp (open, not skipped, no effective date;
 * GBP at §9.7's rates, once per row), unmappedCount (Σ of the loader's SHIP_UNMAPPED
 * counts) — or null when the feed has never succeeded (`input.shipping` null); and the
 * warnings SHIP_UNMAPPED (one per shipping company and reason, as the loader counted them),
 * SHIP_PLAN_ORPHANED (an overlay on a gone row) and SHIP_PLAN_STALE (P6: a planned
 * amount ignored because the feed amount moved), each sorted by key.
 */
function shipFeed(input, { anchors, rateOf }) {
    let openCount = 0n;
    let undatedCount = 0n;
    let undatedGbp = 0n;
    const orphaned = new Set();
    const stale = new Set();
    for (const row of input.externalItems || []) {
        if (row.inScope === false || row.accountId == null || !anchors.has(row.accountId)) continue;
        const key = buildShipKey(row.extId);
        if (row.goneAt != null) {
            if (hasShipOverlay(row)) orphaned.add(key);
            continue;
        }
        if (requireFeedStatus(row) !== 'open') continue;
        openCount += 1n;
        const ev = shipEffectiveValues(row);
        if (ev.status === 'skipped') continue;
        if (ev.planStale) stale.add(key);
        if (ev.effectiveDate == null) {
            undatedCount += 1n;
            undatedGbp += toGbp(parseMinor(ev.effectiveAmount), rateOf(row.currency));
        }
    }
    const sync = input.shipping ?? null;
    const unmapped = sync ? sync.unmappedCounts || [] : [];
    const block = sync === null ? null : {
        lastSuccessAt: sync.lastSuccessAt ?? null,
        feedToday: sync.feedToday ?? null,
        openCount: num(openCount),
        undatedCount: num(undatedCount),
        undatedGbp: num(undatedGbp),
        unmappedCount: unmapped.reduce((acc, u) => acc + Number(u.count), 0),
    };
    const warnings = [
        ...unmapped.map(unmappedWarning),
        ...[...orphaned].sort().map((key) => ({ code: 'SHIP_PLAN_ORPHANED', key })),
        ...[...stale].sort().map((key) => ({ code: 'SHIP_PLAN_STALE', key })),
    ];
    return { block, warnings };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────

/**
 * engineInput (§8, typedef above) → the §6.10 response body without meta.generatedAt.
 * Throws FX_RATE_MISSING (an apiError-shaped 422) for a currency in scope with no rate,
 * TypeError / RangeError on malformed input. Never mutates its input.
 */
function run(input) {
    const today = requireDate(input.today, 'today');
    const window = clampWindow(today, input.from, input.to);
    const bucket = input.bucket ?? 'week';
    const include = input.include ?? 'grid';
    if (!BUCKETS.includes(bucket)) throw new TypeError(`engine: bucket must be one of ${BUCKETS.join(', ')}, got ${JSON.stringify(bucket)}`);
    if (!INCLUDES.includes(include)) throw new TypeError(`engine: include must be one of ${INCLUDES.join(', ')}, got ${JSON.stringify(include)}`);
    const scenario = input.scenario ?? null;

    const { rateOf, used } = buildRates(input);

    // §9.2: anchors. An account with none is excluded and warned about once.
    const anchors = new Map();
    const noAnchor = new Set((input.warnings || []).filter((w) => w.code === 'NO_ANCHOR').map((w) => w.accountId));
    for (const a of input.accounts || []) {
        if (a.anchorDate == null) {
            noAnchor.add(a.id);
            continue;
        }
        requireDate(a.anchorDate, 'anchorDate');
        if (a.anchorDate > today) throw new RangeError(`engine: account ${a.id} anchor ${a.anchorDate} is after today ${today}`);
        const anchorNative = parseMinor(a.anchorBalance);
        anchors.set(a.id, { ...a, anchorNative, anchorGbp: toGbp(anchorNative, rateOf(a.currency)) });
    }
    const minA = [...anchors.values()].reduce((m, a) => (m === null || a.anchorDate < m ? a.anchorDate : m), null);

    const ctx = {
        today, window, anchors, minA, rateOf, scenario,
        categories: new Map((input.categories || []).map((c) => [c.id, c])),
    };

    // §9.4–9.5: lines with effective values; the scenario set is the baseline adjusted.
    const { records, orphans } = buildRecords(input, ctx);
    const baselineLines = [...records.values()].filter((r) => r.inScope && anchors.has(r.accountId));
    const adjusted = scenario ? applyAdjustments(baselineLines, records, input.adjustments, today) : null;

    // §9.6–9.9 per set; the response is built from the scenario set when there is one.
    const baseline = evaluate(baselineLines, ctx);
    const main = adjusted ? evaluate(adjusted.lines, ctx) : baseline;
    const baselineDays = dailySeries(baseline, ctx);
    const days = adjusted ? dailySeries(main, ctx) : baselineDays;
    const ranges = bucketRanges(window.from, window.to, bucket);
    const buckets = bucketFigures(days, ranges);
    const summary = summarise(main, days);

    const body = {
        meta: {
            today, from: window.from, to: window.to, bucket,
            fromClamped: window.fromClamped, toClamped: window.toClamped,
            companyId: input.companyId ?? null, scenarioId: scenario ? scenario.id : null, include,
            ratesUsed: used,
        },
        accounts: main.accounts.map((a) => accountJson(a, today, used)),
        days: days.map((d, i) => {
            const out = moneyJson(d, DAY_FIELDS);
            if (adjusted) out.baselineClosing = num(baselineDays[i].closing);
            return out;
        }),
        buckets: buckets.map((b) => moneyJson(b, BUCKET_FIELDS)),
    };
    if (include === 'grid') body.rows = buildRows(main, baseline, ranges, ctx);
    body.summary = moneyJson(summary, SUMMARY_FIELDS);
    if (adjusted) {
        const baselineBuckets = bucketFigures(baselineDays, ranges);
        body.scenario = {
            id: scenario.id, name: scenario.name, status: scenario.status,
            baselineSummary: moneyJson(summarise(baseline, baselineDays), SUMMARY_FIELDS),
            deltaByBucket: buckets.map((b, i) => ({
                start: b.start, end: b.end,
                inflow: num(b.inflow - baselineBuckets[i].inflow),
                outflow: num(b.outflow - baselineBuckets[i].outflow),
                net: num(b.net - baselineBuckets[i].net),
                closing: num(b.closing - baselineBuckets[i].closing),
            })),
            warnings: adjusted.warnings,
        };
    } else {
        body.scenario = null;
    }
    body.unresolved = main.unresolved.map((p) => unresolvedJson(p, today));
    const feed = shipFeed(input, ctx);
    body.shipping = feed.block;
    body.warnings = [
        ...[...noAnchor].sort((a, b) => a - b).map((accountId) => ({ code: 'NO_ANCHOR', accountId })),
        ...(input.warnings || []).filter((w) => w.code !== 'NO_ANCHOR'),
        ...orphans,
        ...feed.warnings,
    ];
    return body;
}

module.exports = {
    MAX_WINDOW_DAYS,
    DEFAULT_WINDOW_DAYS,
    MANUAL_LOOKBACK_DAYS,
    BUCKETS,
    INCLUDES,
    SHIP_UNMAPPED_REASONS,
    run,
    clampWindow,
    currenciesInScope,
    // §9.5's stale table, shared with the adjustment write, rebase and apply
    // (services/scenarios.js through lib/stale.js) so both sides use one definition.
    staleReason,
};
