// Copied from workflows/api/test/unit/shape.test.js — changes: trimmed to what lib/shape.js still holds — dropped the entity-shaper coercion, attachment-URL and add-on-family tests; the JSON-column tests and null-row safety now run through auditToJson; kept the envelope and parseCap tests verbatim; added tests for fail/apiError/sendApiError, parseId, parseListParams, normalizeEmail/isValidEmail and the trimmed export list
'use strict';

// lib/shape.js — the envelopes, the parsers and the one row shaper left after
// the trim (auditToJson). Pinned here: what a route test would NOT catch
// cheaply — the refusal envelope's exact keys, the clamps, and JSON columns
// that come back from the driver either parsed or as text.

const shape = require('../../src/lib/shape');

describe('what the trimmed module exports', () => {
    test('exactly the envelopes, parsers and auditToJson (CLAUDE.md copy table)', () => {
        expect(Object.keys(shape).sort()).toEqual([
            'accountToJson', 'adjustmentToJson', 'apiError', 'assertBaseVersion', 'auditToJson', 'balanceToJson',
            'categoryToJson', 'companyToJson', 'fail', 'fxRateToJson', 'isApiError',
            'isValidEmail', 'itemToJson', 'keysetResponse', 'listResponse', 'normalizeEmail',
            'overrideToJson', 'parseBaseVersion', 'parseCap', 'parseId', 'parseListParams', 'parseSortOrder',
            'paymentToJson', 'scenarioToJson', 'scheduleToJson', 'sendApiError', 'serverError',
        ]);
    });
});

describe('scenarioToJson (CONTRACT §6.11)', () => {
    const row = {
        id: 3, name: 'What if', description: null, company_id: 1, status: 'draft', applied_at: null,
        applied_by: null, row_version: 2, created_by: 'a@b.c', created_at: null, updated_at: null, deleted_at: null,
    };

    test('adjustmentCount only when the query selected it (never in an audit snapshot)', () => {
        const snapshot = shape.scenarioToJson(row);
        expect(snapshot).not.toHaveProperty('adjustmentCount');
        expect(snapshot).toMatchObject({ id: 3, companyId: 1, status: 'draft', rowVersion: 2 });
        const full = shape.scenarioToJson({ ...row, adjustment_count: '4' });
        expect(Object.keys(full)).toEqual([
            'id', 'name', 'description', 'companyId', 'status', 'appliedAt', 'appliedBy', 'adjustmentCount',
            'rowVersion', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
        ]);
        expect(full.adjustmentCount).toBe(4);
        expect(shape.scenarioToJson({ ...row, company_id: null }).companyId).toBeNull();
        expect(shape.scenarioToJson(null)).toBeNull();
    });
});

describe('itemToJson / paymentToJson (CONTRACT §6.7, D23)', () => {
    const row = {
        id: 7, account_id: 3, company_id: 1, category_id: 2, direction: 'out', name: 'Rent',
        counterparty: null, amount: '1000.00', currency: 'GBP', due_date: '2026-03-05',
        status: 'part_paid', paid_on: '2026-03-02', paid_amount: '400.50', settle_mode: 'auto',
        notes: null, source_scenario_id: null, row_version: 2, created_by: 'a@b.c',
        created_at: null, updated_at: null, deleted_at: null,
    };
    const payment = {
        id: 9, cash_item_id: 7, override_id: null, paid_on: '2026-03-02', amount: '400.50',
        note: 'first', created_by: 'a@b.c', created_at: null,
    };

    test('key, companyId and remainingAmount are derived; no payments or derivedStatus without extras', () => {
        const out = shape.itemToJson(row);
        expect(out).toMatchObject({
            id: 7, key: 'item.7', companyId: 1, amount: '1000.00', paidAmount: '400.50', remainingAmount: '599.50',
        });
        expect(out).not.toHaveProperty('payments');
        expect(out).not.toHaveProperty('derivedStatus');
        expect(shape.itemToJson({ ...row, paid_amount: null, paid_on: null }).remainingAmount).toBe('1000.00');
        expect(shape.itemToJson(null)).toBeNull();
    });

    test('extras add payments (without the parent ids) and derivedStatus', () => {
        const p = shape.paymentToJson(payment);
        expect(p).toEqual({
            id: 9, cashItemId: 7, overrideId: null, paidOn: '2026-03-02', amount: '400.50',
            note: 'first', createdBy: 'a@b.c', createdAt: null,
        });
        const out = shape.itemToJson(row, { payments: [p], derivedStatus: 'overdue' });
        expect(out.payments).toEqual([{ id: 9, paidOn: '2026-03-02', amount: '400.50', note: 'first', createdBy: 'a@b.c', createdAt: null }]);
        expect(out.derivedStatus).toBe('overdue');
        expect(Object.keys(out)).toEqual([
            'id', 'key', 'accountId', 'companyId', 'categoryId', 'direction', 'name', 'counterparty', 'amount',
            'currency', 'dueDate', 'status', 'paidOn', 'paidAmount', 'remainingAmount', 'payments', 'settleMode',
            'notes', 'sourceScenarioId', 'derivedStatus', 'rowVersion', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
        ]);
    });
});

describe('scheduleToJson / overrideToJson / adjustmentToJson (CONTRACT §6.8, §6.9, §6.11)', () => {
    const schedule = {
        id: 5, account_id: 3, company_id: 1, category_id: 2, direction: 'out', name: 'Rent', counterparty: null,
        amount: '1000.00', currency: 'GBP', frequency: 'monthly', interval_count: 1, start_date: '2026-01-31',
        active_from: '2026-06-30', occurrence_count: null, end_date: null, weekend_rule: 'none', settle_mode: 'auto',
        predecessor_id: 4, status: 'active', notes: null, row_version: 0, created_by: 'a@b.c',
        created_at: null, updated_at: null, deleted_at: null,
    };

    test('the row in its JSON shape; successorId and structureLocked only through extras (not in audit snapshots)', () => {
        const out = shape.scheduleToJson(schedule);
        expect(out).toMatchObject({
            id: 5, accountId: 3, companyId: 1, categoryId: 2, intervalCount: 1, startDate: '2026-01-31',
            activeFrom: '2026-06-30', occurrenceCount: null, weekendRule: 'none', settleMode: 'auto', predecessorId: 4,
        });
        expect(out).not.toHaveProperty('successorId');
        expect(out).not.toHaveProperty('structureLocked');
        const full = shape.scheduleToJson(schedule, { successorId: 9, structureLocked: true });
        expect(Object.keys(full)).toEqual([
            'id', 'accountId', 'companyId', 'categoryId', 'direction', 'name', 'counterparty', 'amount', 'currency',
            'frequency', 'intervalCount', 'startDate', 'activeFrom', 'occurrenceCount', 'endDate', 'weekendRule',
            'settleMode', 'predecessorId', 'successorId', 'status', 'notes', 'structureLocked', 'rowVersion',
            'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
        ]);
        expect(full).toMatchObject({ successorId: 9, structureLocked: true });
        expect(shape.scheduleToJson(null)).toBeNull();
    });

    test('an override row, and an adjustment row', () => {
        expect(shape.overrideToJson({
            id: 40, schedule_id: 5, natural_date: '2026-03-31', amount: '983.00', due_date: null, status: null,
            settle_mode: 'manual', paid_on: null, paid_amount: null, note: 'x', source_scenario_id: null,
            row_version: 1, created_by: 'a@b.c', created_at: null, updated_at: null,
        })).toEqual({
            id: 40, scheduleId: 5, naturalDate: '2026-03-31', amount: '983.00', dueDate: null, status: null,
            settleMode: 'manual', paidOn: null, paidAmount: null, note: 'x', sourceScenarioId: null,
            rowVersion: 1, createdBy: 'a@b.c', createdAt: null, updatedAt: null,
        });
        expect(shape.adjustmentToJson({
            id: 8, scenario_id: 2, item_key: 'sched.5.2026-03-31', target_kind: 'sched', target_id: '5',
            target_date: '2026-03-31', kind: 'adjust', new_date: null, new_amount: '1100.00',
            base_date: '2026-03-31', base_amount: '1000.00', note: null, row_version: 0, created_by: 'a@b.c',
            created_at: null, updated_at: null,
        })).toEqual({
            id: 8, scenarioId: 2, itemKey: 'sched.5.2026-03-31', targetKind: 'sched', targetId: '5',
            targetDate: '2026-03-31', kind: 'adjust', newDate: null, newAmount: '1100.00', baseDate: '2026-03-31',
            baseAmount: '1000.00', note: null, rowVersion: 0, createdBy: 'a@b.c', createdAt: null, updatedAt: null,
        });
        expect(shape.overrideToJson(null)).toBeNull();
        expect(shape.adjustmentToJson(null)).toBeNull();
    });
});

/** A stand-in for Express's res: records status and body. */
function fakeRes() {
    const res = { statusCode: null, body: undefined, headersSent: false };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; res.headersSent = true; return res; };
    return res;
}

describe('refusal envelope', () => {
    test('fail sends {error} alone when there is no code or details', () => {
        const res = fakeRes();
        shape.fail(res, 400, 'Bad input.');
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Bad input.' });
    });

    test('fail carries code and details when given', () => {
        const res = fakeRes();
        shape.fail(res, 409, 'Stale.', 'STALE_WRITE', { currentVersion: 3 });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: 'Stale.', code: 'STALE_WRITE', details: { currentVersion: 3 } });
    });

    test('apiError builds a throwable refusal that sendApiError answers identically', () => {
        const err = shape.apiError(422, 'BALANCE_DATE_IN_FUTURE', 'Too late.', { balanceDate: '2026-10-01' });
        expect(err).toBeInstanceOf(Error);
        expect(shape.isApiError(err)).toBe(true);
        expect(shape.isApiError(new Error('real bug'))).toBe(false);
        expect(shape.isApiError(null)).toBe(false);
        const res = fakeRes();
        shape.sendApiError(res, err);
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({
            error: 'Too late.', code: 'BALANCE_DATE_IN_FUTURE', details: { balanceDate: '2026-10-01' },
        });
    });

    test('sendApiError defaults to 409 when the error carries no status', () => {
        const res = fakeRes();
        shape.sendApiError(res, { message: 'Conflict.', code: 'X' });
        expect(res.statusCode).toBe(409);
    });

    test('serverError answers the generic 500 with the request id', () => {
        const res = fakeRes();
        res.req = { requestId: 'req-1' };
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            shape.serverError(res, 'test', new Error('boom'));
        } finally {
            spy.mockRestore();
        }
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'An internal error occurred.', requestId: 'req-1' });
    });
});

describe('auditToJson', () => {
    test('maps the row to camelCase', () => {
        expect(shape.auditToJson({
            id: 5, entity_type: 'company', entity_id: 2, action: 'update',
            before_json: { name: 'A' }, after_json: { name: 'B' }, reason: null,
            user_email: 'a@b.test', created_at: '2026-09-29T10:00:00.000Z',
        })).toEqual({
            id: 5, entityType: 'company', entityId: 2, action: 'update',
            before: { name: 'A' }, after: { name: 'B' }, reason: null,
            userEmail: 'a@b.test', createdAt: '2026-09-29T10:00:00.000Z',
        });
    });

    test('a JSON column already parsed by the driver passes through', () => {
        expect(shape.auditToJson({ id: 1, after_json: { unit: 'g' } }).after).toEqual({ unit: 'g' });
    });

    test('a JSON column handed back as text is parsed', () => {
        expect(shape.auditToJson({ id: 1, after_json: '{"unit":"g"}' }).after).toEqual({ unit: 'g' });
    });

    test('unparseable JSON degrades to null instead of throwing', () => {
        expect(shape.auditToJson({ id: 1, after_json: 'not json' }).after).toBeNull();
    });

    test('a NULL JSON column stays null', () => {
        expect(shape.auditToJson({ id: 1, before_json: null }).before).toBeNull();
    });
});

describe('null-row safety', () => {
    // Detail routes do `shape(rows[0])` on a possibly-empty result; returning
    // null lets the caller 404 instead of throwing on undefined.
    test.each(['auditToJson'])('%s(undefined) returns null', (fn) => {
        expect(shape[fn](undefined)).toBeNull();
        expect(shape[fn](null)).toBeNull();
    });
});

describe('envelopes', () => {
    test('listResponse carries the paging triple', () => {
        expect(shape.listResponse([{ id: 1 }], { page: 2, limit: 50, total: 120 }))
            .toEqual({ data: [{ id: 1 }], page: 2, limit: 50, total: 120 });
    });

    test('keysetResponse yields the last id when the page is full', () => {
        expect(shape.keysetResponse([{ id: 9 }, { id: 7 }], 2).nextCursor).toBe(7);
    });

    test('keysetResponse yields null when the page came back short', () => {
        expect(shape.keysetResponse([{ id: 9 }], 2).nextCursor).toBeNull();
    });

    test('keysetResponse yields null on an empty page', () => {
        expect(shape.keysetResponse([], 2).nextCursor).toBeNull();
    });
});

describe('parseId', () => {
    test.each([
        ['1', 1], ['42', 42], [7, 7],
        ['0', null], ['-3', null], ['2.5', null], ['abc', null], ['', null], [undefined, null], ['1e3', 1000],
    ])('%p -> %p', (raw, expected) => {
        expect(shape.parseId(raw)).toBe(expected);
    });
});

describe('parseListParams (CONTRACT §2.3)', () => {
    test('defaults: page 1, limit 100', () => {
        expect(shape.parseListParams({})).toEqual({ page: 1, limit: 100, offset: 0 });
        expect(shape.parseListParams()).toEqual({ page: 1, limit: 100, offset: 0 });
    });

    test('limit clamps to 1..500; page to >= 1; offset follows', () => {
        expect(shape.parseListParams({ limit: '0' }).limit).toBe(1);
        expect(shape.parseListParams({ limit: '9999' }).limit).toBe(500);
        expect(shape.parseListParams({ page: '-2' }).page).toBe(1);
        expect(shape.parseListParams({ page: '3', limit: '20' })).toEqual({ page: 3, limit: 20, offset: 40 });
    });
});

describe('parseCap', () => {
    // The bare-array ceiling (WP 2.2). Clamps rather than refuses — consistent
    // with parseListParams — so these pin the surprising-but-accepted cases.
    test.each([
        ['absent', undefined, 500],
        ['empty string', '', 500],
        ['non-numeric', 'abc', 500],
        ['zero clamps up', '0', 1],
        ['negative clamps up', '-5', 1],
        ['over the max clamps down', '501', 500],
        ['scientific notation parses as its mantissa', '1e9', 1],
        ['fractional truncates', '3.9', 3],
        ['in range passes through', '42', 42],
    ])('%s -> %i', (_label, raw, expected) => {
        expect(shape.parseCap(raw)).toBe(expected);
    });

    test('a custom default is honoured when the param is absent', () => {
        expect(shape.parseCap(undefined, 100)).toBe(100);
        expect(shape.parseCap('7', 100)).toBe(7);
    });
});

describe('emails', () => {
    test('normalizeEmail trims and lowercases; null-ish becomes empty', () => {
        expect(shape.normalizeEmail('  Dev@Built-Form.CO.UK ')).toBe('dev@built-form.co.uk');
        expect(shape.normalizeEmail(null)).toBe('');
        expect(shape.normalizeEmail(undefined)).toBe('');
    });

    test('isValidEmail accepts a plain address and refuses the obvious non-addresses', () => {
        expect(shape.isValidEmail('a@b.test')).toBe(true);
        expect(shape.isValidEmail('a@b')).toBe(false);
        expect(shape.isValidEmail('a b@c.test')).toBe(false);
        expect(shape.isValidEmail('')).toBe(false);
        expect(shape.isValidEmail(null)).toBe(false);
    });
});
