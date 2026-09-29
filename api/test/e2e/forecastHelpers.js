'use strict';

// SQL fixtures for the /forecast suites (forecast.test.js, forecast-input.test.js).
//
// Rows that step 5's and step 7's routes write — schedules, overrides, override
// payments, scenarios, adjustments — are inserted straight into the per-run
// jflow_test_<runid> schema, exactly as those writers leave them (the payment cache on
// the override equals its payment rows, D23; an adjustment carries the parsed key,
// §4). Everything with a route already (companies, accounts, categories, balances,
// fx-rates, items and item pay) goes through the route in the suites themselves.

const { parseKey } = require('../../src/lib/keys');

const E2E_USER = 'local@dev';

/** A schedules row; returns its id. Defaults: monthly, 100.00 out, GBP, auto, weekend none. */
async function insertSchedule(h, s) {
    const res = await h.sql(
        `INSERT INTO schedules
            (account_id, category_id, direction, name, counterparty, amount, currency, frequency, interval_count,
             start_date, active_from, occurrence_count, end_date, weekend_rule, settle_mode, status, created_by,
             deleted_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${s.deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
        [s.accountId, s.categoryId, s.direction || 'out', s.name || 'schedule', s.amount || '100.00',
            s.currency || 'GBP', s.frequency || 'monthly', s.intervalCount || 1, s.startDate, s.activeFrom || null,
            s.occurrenceCount || null, s.endDate || null, s.weekendRule || 'none', s.settleMode || 'auto',
            s.status || (s.endDate ? 'ended' : 'active'), E2E_USER]
    );
    return res.insertId;
}

/** A schedule_overrides row; returns its id. Unset columns are NULL (= the schedule's). */
async function insertOverride(h, o) {
    const res = await h.sql(
        `INSERT INTO schedule_overrides
            (schedule_id, natural_date, amount, due_date, status, settle_mode, paid_on, paid_amount, note,
             source_scenario_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.scheduleId, o.naturalDate, o.amount ?? null, o.dueDate ?? null, o.status ?? null, o.settleMode ?? null,
            o.paidOn ?? null, o.paidAmount ?? null, o.note ?? null, o.sourceScenarioId ?? null, E2E_USER]
    );
    return res.insertId;
}

/** One payments row under an override (the caller keeps the override's cache in step). */
async function insertOverridePayment(h, { overrideId, paidOn, amount }) {
    const res = await h.sql(
        'INSERT INTO payments (override_id, paid_on, amount, created_by) VALUES (?, ?, ?, ?)',
        [overrideId, paidOn, amount, E2E_USER]
    );
    return res.insertId;
}

/** A scenarios row; returns its id. */
async function insertScenario(h, { name = 'What if', status = 'draft', companyId = null, deleted = false } = {}) {
    const res = await h.sql(
        `INSERT INTO scenarios (name, company_id, status, created_by, deleted_at)
         VALUES (?, ?, ?, ?, ${deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
        [name, companyId, status, E2E_USER]
    );
    return res.insertId;
}

/** A scenario_adjustments row with its parsed key (§4); returns its id. */
async function insertAdjustment(h, { scenarioId, itemKey, kind = 'adjust', newDate = null, newAmount = null, baseDate, baseAmount }) {
    const p = parseKey(itemKey);
    if (!p) throw new Error(`[e2e] not a key: ${itemKey}`);
    const res = await h.sql(
        `INSERT INTO scenario_adjustments
            (scenario_id, item_key, target_kind, target_id, target_date, kind, new_date, new_amount, base_date,
             base_amount, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [scenarioId, itemKey, p.targetKind, p.targetId, p.targetDate, kind, newDate, newAmount, baseDate, baseAmount,
            E2E_USER]
    );
    return res.insertId;
}

module.exports = { insertSchedule, insertOverride, insertOverridePayment, insertScenario, insertAdjustment };
