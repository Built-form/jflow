'use strict';

// services/shipping.js and the parts of services/shippingSource.js that need no database
// (docs/PLAN.md "Phase 2"; CONTRACT §2.1, §10.12). The source against real table shapes
// runs in test/e2e/shipping-source.test.js. Pinned here:
//   · every failure is one `unavailable(reason)` with reason in
//     source_schema | source_error | bad_response;
//   · SHIPPING_DB_SCHEMA is read per call (unset or blank → jfa; ^[a-z0-9_]{1,64}$), and an
//     invalid name fails as source_schema before any connection is made;
//   · fetchPaymentsForecast is the source's body (no HTTP), passed {today, paidSince};
//   · the schema check names what is missing, case-blind, and a connection failure is
//     source_error without the password;
//   · validateFeed counts and rejects bad rows and normalises the good ones.

const mysql = require('mysql2/promise');
const shipping = require('../../src/services/shipping');
const source = require('../../src/services/shippingSource');
const { SOURCE_COLUMNS, OPTIONAL_COLUMNS } = require('../../src/services/shippingReads');
const { stubShippingSource, feedItem, feedBody } = require('../helpers/shippingSourceStub');

const TODAY = '2026-09-29';
const PAID_SINCE = '2026-07-31';

let savedSchema;
let logSpies;
beforeEach(() => {
    savedSchema = process.env.SHIPPING_DB_SCHEMA;
    delete process.env.SHIPPING_DB_SCHEMA;
    logSpies = ['warn', 'error', 'log'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
    if (savedSchema === undefined) delete process.env.SHIPPING_DB_SCHEMA;
    else process.env.SHIPPING_DB_SCHEMA = savedSchema;
    for (const spy of logSpies) spy.mockRestore();
    jest.restoreAllMocks();
});

/** The thrown error of `promise`, or a failure when it resolves. */
async function rejectionOf(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected a rejection');
}

describe('configuration', () => {
    test('the reasons SHIPPING_UNAVAILABLE carries', () => {
        expect(shipping.SHIPPING_REASONS).toEqual(['source_schema', 'source_error', 'bad_response']);
    });

    test('SHIPPING_DB_SCHEMA: unset or blank → jfa; read per call; only ^[a-z0-9_]{1,64}$ is configured', () => {
        expect(source.sourceSchema()).toBe('jfa');
        expect(shipping.isConfigured()).toBe(true);
        process.env.SHIPPING_DB_SCHEMA = '   ';
        expect(source.sourceSchema()).toBe('jfa');
        process.env.SHIPPING_DB_SCHEMA = ' jflow_test_ab12_jfa ';
        expect(source.sourceSchema()).toBe('jflow_test_ab12_jfa');
        expect(shipping.isConfigured()).toBe(true);
        process.env.SHIPPING_DB_SCHEMA = 'x'.repeat(64);
        expect(shipping.isConfigured()).toBe(true);
        for (const bad of ['JFA', 'jfa-test', 'jfa.orders', 'jfa`', 'x'.repeat(65), 'j fa']) {
            process.env.SHIPPING_DB_SCHEMA = bad;
            expect({ bad, schema: source.sourceSchema(), configured: shipping.isConfigured() })
                .toEqual({ bad, schema: null, configured: false });
        }
    });

    test('an invalid schema name → source_schema, and no connection is attempted', async () => {
        const connect = jest.spyOn(mysql, 'createConnection');
        process.env.SHIPPING_DB_SCHEMA = 'jfa; DROP TABLE x';
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: TODAY, paidSince: PAID_SINCE }));
        expect(shipping.isUnavailable(err)).toBe(true);
        expect(err.reason).toBe('source_schema');
        expect(err.message).toMatch(/SHIPPING_DB_SCHEMA is not a valid schema name/);
        expect(connect).not.toHaveBeenCalled();
    });

    test('bad arguments are a TypeError, not an unavailable feed', async () => {
        const connect = jest.spyOn(mysql, 'createConnection');
        for (const args of [{}, { today: '2026-02-30', paidSince: PAID_SINCE }, { today: TODAY, paidSince: 'soon' }]) {
            const err = await rejectionOf(source.readPaymentsForecast(args));
            expect(err).toBeInstanceOf(TypeError);
            expect(shipping.isUnavailable(err)).toBe(false);
        }
        expect(connect).not.toHaveBeenCalled();
    });

    test('a connection failure → source_error, with the code and never the password', async () => {
        const savedPassword = process.env.DB_PASSWORD;
        process.env.DB_PASSWORD = 'unit-secret-password-0123';
        try {
            jest.spyOn(mysql, 'createConnection').mockRejectedValue(Object.assign(
                new Error(`connect ECONNREFUSED (password ${process.env.DB_PASSWORD})`), { code: 'ECONNREFUSED' }
            ));
            const err = await rejectionOf(source.readPaymentsForecast({ today: TODAY, paidSince: PAID_SINCE }));
            expect(shipping.isUnavailable(err)).toBe(true);
            expect(err.reason).toBe('source_error');
            expect(err.message).toMatch(/ECONNREFUSED/);
            expect(err.message).not.toMatch(/unit-secret-password/);
        } finally {
            if (savedPassword === undefined) delete process.env.DB_PASSWORD;
            else process.env.DB_PASSWORD = savedPassword;
        }
    });
});

describe('the schema check', () => {
    const ALL_OPTIONAL = { payment_due_dates: true, shipping_allowed_emails: true, payment_extras: true, shipments: true, shipment_lines: true };
    /** Every column per table, required and optional together (a table may be in both lists). */
    const allColumns = () => {
        const out = {};
        for (const list of [SOURCE_COLUMNS, OPTIONAL_COLUMNS]) {
            for (const [table, columns] of Object.entries(list)) out[table] = [...(out[table] ?? []), ...columns];
        }
        return out;
    };
    /** information_schema rows for every column the reads use (optional tables included unless `without`), minus `drop`. */
    const columnsQuery = ({ drop = [], upper = false, without = [] } = {}) => {
        const calls = [];
        return {
            calls,
            async query(sql, params) {
                calls.push({ sql, params });
                const rows = [];
                for (const [table, columns] of Object.entries(allColumns())) {
                    if (without.includes(table)) continue;
                    for (const column of columns) {
                        if (drop.includes(`${table}.${column}`)) continue;
                        rows.push({ table_name: table, column_name: upper ? column.toUpperCase() : column });
                    }
                }
                return [rows];
            },
        };
    };

    test('a complete schema passes; the query is scoped to the schema and the tables read, optional ones included', async () => {
        const q = columnsQuery();
        await expect(source.checkSchema(q, 'jfa')).resolves.toEqual({ optional: ALL_OPTIONAL });
        expect(q.calls).toHaveLength(1);
        expect(q.calls[0].sql).toMatch(/FROM information_schema\.COLUMNS/);
        expect(q.calls[0].params).toEqual(['jfa', ...Object.keys(SOURCE_COLUMNS), ...Object.keys(OPTIONAL_COLUMNS)]);
    });

    test('column names compare case-blind (information_schema may report another case)', async () => {
        await expect(source.checkSchema(columnsQuery({ upper: true }), 'jfa')).resolves.toEqual({ optional: ALL_OPTIONAL });
    });

    test('an optional table missing, or short of a column, is reported — never source_schema', async () => {
        await expect(source.checkSchema(columnsQuery({ without: ['payment_due_dates'] }), 'jfa'))
            .resolves.toEqual({ optional: { ...ALL_OPTIONAL, payment_due_dates: false } });
        await expect(source.checkSchema(columnsQuery({ drop: ['shipping_allowed_emails.display_name'] }), 'jfa'))
            .resolves.toEqual({ optional: { ...ALL_OPTIONAL, shipping_allowed_emails: false } });
        await expect(source.checkSchema(columnsQuery({ without: ['payment_due_dates', 'shipping_allowed_emails', 'payment_extras', 'shipment_lines'] }), 'jfa'))
            .resolves.toEqual({ optional: { payment_due_dates: false, shipping_allowed_emails: false, payment_extras: false, shipments: true, shipment_lines: false } });
        // shipments is in both lists: its required columns still fail the check, its optional ones (name, etd, eta) only turn the flag off.
        await expect(source.checkSchema(columnsQuery({ drop: ['shipments.etd'] }), 'jfa'))
            .resolves.toEqual({ optional: { ...ALL_OPTIONAL, shipments: false } });
        const err = await rejectionOf(source.checkSchema(columnsQuery({ drop: ['shipments.stage'] }), 'jfa'));
        expect(err.reason).toBe('source_schema');
    });

    test("OPTIONAL_COLUMNS: due dates set by hand and the users table that names the setter; extras; drafts and plans with their lines", () => {
        expect(OPTIONAL_COLUMNS).toEqual({
            payment_due_dates: ['id', 'target_key', 'due_date', 'note', 'set_by_email', 'updated_at'],
            shipping_allowed_emails: ['email', 'display_name'],
            payment_extras: ['id', 'supplier_name', 'supplier_key', 'currency', 'amount', 'kind', 'description', 'rides_with',
                'purchase_order_id', 'shipment_id', 'shipment_reference', 'due_date', 'source_kind', 'source_id', 'status', 'paid_on',
                'settled_by_payment_id', 'note', 'created_by_email', 'created_at', 'updated_by_email', 'updated_at', 'deleted_at'],
            shipments: ['name', 'etd', 'eta'],
            shipment_lines: ['shipment_id', 'order_id', 'quantity'],
        });
    });

    test('a missing (or unreadable) column → source_schema naming it', async () => {
        const err = await rejectionOf(source.checkSchema(columnsQuery({ drop: ['orders.unit_price', 'suppliers.paymentTerms'] }), 'jfa'));
        expect(shipping.isUnavailable(err)).toBe(true);
        expect(err.reason).toBe('source_schema');
        expect(err.message).toMatch(/lacks 2 column\(s\)/);
        expect(err.message).toMatch(/orders\.unit_price, suppliers\.paymentTerms/);
        expect(err.missing).toEqual(['orders.unit_price', 'suppliers.paymentTerms']);
    });

    test('a schema that is not there at all → source_schema, the list cut short', async () => {
        const q = { query: async () => [[]] };
        const err = await rejectionOf(source.checkSchema(q, 'nope'));
        expect(err.reason).toBe('source_schema');
        const total = Object.values(SOURCE_COLUMNS).reduce((a, c) => a + c.length, 0);
        expect(err.message).toMatch(new RegExp(`lacks ${total} column`));
        expect(err.message).toMatch(/, …\.$/);
    });

    test('SOURCE_COLUMNS covers the tables the source reads, suppliers (the view) and companies included', () => {
        expect(Object.keys(SOURCE_COLUMNS).sort()).toEqual([
            'companies', 'containers', 'draft_container_documents', 'order_receipts', 'orders', 'payment_rules',
            'purchase_order_invoice_payments', 'purchase_order_invoices', 'purchase_order_payments',
            'purchase_order_signed_pis', 'purchase_orders', 'quality_assurance_documents', 'shipment_payment_allocations',
            'shipment_payments', 'shipments', 'supplier_payment_lines', 'supplier_payments', 'suppliers',
        ]);
    });
});

describe('fetchPaymentsForecast', () => {
    let stub;
    beforeEach(() => { stub = stubShippingSource(); });
    afterEach(() => stub.restore());

    test('returns the source body for {today, paidSince}; no HTTP involved', async () => {
        const body = feedBody([feedItem('bal-812-s311')]);
        stub.respond(body);
        await expect(shipping.fetchPaymentsForecast({ today: TODAY, paidSince: PAID_SINCE })).resolves.toEqual(body);
        expect(stub.requests).toEqual([{ today: TODAY, paidSince: PAID_SINCE }]);
    });

    test("the source's unavailable passes through unchanged", async () => {
        for (const reason of ['source_schema', 'source_error']) {
            stub.fail(reason, `stub ${reason}`);
            const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: TODAY, paidSince: PAID_SINCE }));
            expect(shipping.isUnavailable(err)).toBe(true);
            expect(err.reason).toBe(reason);
            expect(err.message).toBe(`stub ${reason}`);
        }
    });

    test('a body with no items array → bad_response', async () => {
        for (const body of [null, {}, { items: 'x' }, []]) {
            stub.respondWith(() => body);
            const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: TODAY, paidSince: PAID_SINCE }));
            expect(err.reason).toBe('bad_response');
        }
    });
});

describe('validateFeed', () => {
    test('a clean feed: every row kept, normalised, nothing rejected', () => {
        const out = shipping.validateFeed(feedBody([
            feedItem('bal-812-s311', { amount: '12.5', flags: ['projected', 'estimated'], dateBasis: 'estimated' }),
            feedItem('dep-900', { kind: 'deposit', dueDate: null, dateBasis: 'undated', shipmentId: null, containerRef: null }),
            feedItem('pay-17-bal812', {
                status: 'paid', dueDate: null, paidOn: '2026-09-20', settles: 'bal-812-s311', amount: '100.00',
            }),
        ]));
        expect(out.rejected).toBe(0);
        expect(out.items).toHaveLength(3);
        expect(out.items[0]).toEqual({
            id: 'bal-812-s311', kind: 'balance', status: 'open', supplier: 'Acme Textiles', companyId: 1,
            poId: 812, poNumber: 'PO-812', shipmentId: 311, containerRef: 'MSKU1234567', currency: 'USD',
            amount: '12.50', dueDate: '2026-10-15', paidOn: null, settles: null, dateBasis: 'estimated',
            amountBasis: 'stated', blocked: null, flags: ['estimated', 'projected'], dueSet: null, label: null,
        });
        expect(out.items[1]).toMatchObject({ id: 'dep-900', dueDate: null, dateBasis: 'undated', flags: [] });
        expect(out.items[2]).toMatchObject({ status: 'paid', paidOn: '2026-09-20', settles: 'bal-812-s311' });
        expect(out.companies).toEqual([{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }]);
    });

    test('bad rows are counted and rejected; the good ones survive', () => {
        const bad = [
            'not an object',
            null,
            feedItem('derived:dep:812'),                        // id grammar: ':' (finding 3)
            feedItem('x'.repeat(65)),                           // id grammar: too long
            feedItem(''),                                       // id grammar: empty
            feedItem(812),                                      // id not a string
            feedItem('a1', { amount: 12.5 }),                   // amount must be a DECIMAL string
            feedItem('a2', { amount: '1.234' }),                // parseMinor: 3 decimals
            feedItem('a3', { amount: '0.00' }),                 // must be > 0
            feedItem('a4', { amount: '-5.00' }),
            feedItem('d1', { dueDate: '2026-02-30' }),          // not a real date
            feedItem('d2', { dueDate: '29/09/2026' }),
            feedItem('d3', { dueDate: null, dateBasis: 'firm' }),            // undated needs dateBasis undated
            feedItem('d4', { dateBasis: 'undated' }),                        // …and dated must not say undated
            feedItem('p1', { status: 'paid', paidOn: null, dueDate: null }), // a paid row needs paidOn
            feedItem('p2', { paidOn: '2026-09-01' }),                        // an open row has no paidOn
            feedItem('c1', { currency: 'usd' }),
            feedItem('c2', { currency: 'US' }),
            feedItem('k1', { kind: 'refund' }),
            feedItem('s1', { status: 'closed' }),
            feedItem('b1', { dateBasis: 'guess' }),
            feedItem('b2', { amountBasis: 'quoted' }),
            feedItem('b3', { blocked: 'customs' }),
            feedItem('f1', { flags: 'estimated' }),
            feedItem('f2', { flags: [1] }),
            feedItem('i1', { companyId: 0 }),
            feedItem('i2', { poId: -3 }),
            feedItem('i3', { shipmentId: 1.5 }),
            feedItem('t1', { supplier: 'x'.repeat(256) }),
            feedItem('t2', { poNumber: 'x'.repeat(65) }),
            feedItem('t3', { containerRef: 'x'.repeat(101) }),
            feedItem('t4', { settles: 'derived:bal:1' }),
        ];
        const good = [feedItem('ok-1'), feedItem('ok-2', { companyId: null, blocked: 'pi_signed' })];
        const out = shipping.validateFeed(feedBody([...good.slice(0, 1), ...bad, ...good.slice(1)]));
        expect(out.rejected).toBe(bad.length);
        expect(out.items.map((i) => i.id)).toEqual(['ok-1', 'ok-2']);
        expect(out.problems.length).toBeGreaterThan(0);
        expect(out.problems[0]).toEqual(expect.objectContaining({ index: 1, reason: expect.any(String) }));
    });

    test('a repeated id is rejected after its first appearance (ids compare as the DB compares them)', () => {
        const out = shipping.validateFeed(feedBody([
            feedItem('bal-1-n', { amount: '10.00' }),
            feedItem('bal-1-n', { amount: '20.00' }),
            feedItem('BAL-1-N', { amount: '30.00' }),
        ]));
        expect(out.rejected).toBe(2);
        expect(out.items).toHaveLength(1);
        expect(out.items[0].amount).toBe('10.00');
    });

    test('numeric ids may arrive as canonical decimal strings; optional fields may be absent', () => {
        const item = feedItem('bal-9-n', { companyId: '2', poId: '9', shipmentId: undefined });
        delete item.supplier;
        delete item.flags;
        delete item.settles;
        const out = shipping.validateFeed(feedBody([item]));
        expect(out.rejected).toBe(0);
        expect(out.items[0]).toMatchObject({ companyId: 2, poId: 9, shipmentId: null, supplier: null, flags: [], settles: null });
    });

    test('companies: bad entries are dropped (not counted as rejected rows); absent → []', () => {
        const out = shipping.validateFeed(feedBody([], {
            companies: [{ id: 1, name: 'JFA Medical Ltd' }, { id: 'x', name: 'Bad' }, { id: 3 }, null],
        }));
        expect(out.companies).toEqual([{ id: 1, name: 'JFA Medical Ltd' }]);
        expect(out.rejected).toBe(0);
        const bare = shipping.validateFeed({ items: [] });
        expect(bare.companies).toEqual([]);
    });

    test('a body with no items array is a bad_response, not an empty feed', () => {
        for (const body of [null, [], {}, { items: 'x' }]) {
            let err;
            try { shipping.validateFeed(body); } catch (e) { err = e; }
            expect(shipping.isUnavailable(err)).toBe(true);
            expect(err.reason).toBe('bad_response');
        }
    });

    test('every row rejected is a bad_response (it would mark the whole snapshot gone); an empty feed is fine', () => {
        let err;
        try {
            shipping.validateFeed(feedBody([feedItem('derived:dep:1'), feedItem('a1', { amount: '0.00' })]));
        } catch (e) { err = e; }
        expect(shipping.isUnavailable(err)).toBe(true);
        expect(err.reason).toBe('bad_response');
        expect(err.message).toMatch(/Every row of the shipping feed was rejected \(2: id, amount\)/);
        expect(shipping.validateFeed(feedBody([])).items).toEqual([]);
    });
});

describe('validateFeed: dueSet (a date set by hand in ShipLine — external_items.due_set_json)', () => {
    const dueSet = (over = {}) => ({
        by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-11-01',
        scope: 'item', note: 'agreed with the supplier', ...over,
    });
    const only = (over) => shipping.validateFeed(feedBody([feedItem('bal-812-s311', over)]));
    // Beside a good row: a feed whose every row is rejected throws bad_response instead.
    const beside = (over) => shipping.validateFeed(feedBody([
        feedItem('dep-900', { kind: 'deposit', shipmentId: null, containerRef: null }),
        feedItem('bal-812-s311', over),
    ]));

    test('absent or null → null; a good one is kept whole, with a blank note read as none', () => {
        expect(only({}).items[0].dueSet).toBeNull();
        expect(only({ dueSet: null }).items[0].dueSet).toBeNull();
        expect(only({ dueSet: dueSet() }).items[0].dueSet).toEqual(dueSet());
        expect(only({ dueSet: dueSet({ note: '', derivedDate: null }) }).items[0].dueSet).toEqual(dueSet({ note: null, derivedDate: null }));
        expect(only({ dueSet: dueSet({ scope: 'payment', at: '2026-10-06T09:30:00Z' }) }).items[0].dueSet)
            .toMatchObject({ scope: 'payment', at: '2026-10-06T09:30:00Z' });
    });

    test.each([
        ['not an object', 'set by hand'],
        ['an array', [dueSet()]],
        ['no setter', dueSet({ by: '' })],
        ['a setter over 255 characters', dueSet({ by: 'x'.repeat(256) })],
        ['no email', dueSet({ email: null })],
        ['an instant that is not ISO UTC', dueSet({ at: '2026-10-06 09:30:00' })],
        ['an instant that is not real', dueSet({ at: '2026-13-06T09:30:00.000Z' })],
        ['a derived date that is not a date', dueSet({ derivedDate: '2026-02-30' })],
        ['an unknown scope', dueSet({ scope: 'row' })],
        ['a note over 500 characters', dueSet({ note: 'x'.repeat(501) })],
        ['a note that is not text', dueSet({ note: 7 })],
    ])('rejects the row when dueSet is %s', (_label, bad) => {
        const out = beside({ dueSet: bad });
        expect(out.rejected).toBe(1);
        expect(out.items.map((r) => r.id)).toEqual(['dep-900']);
        expect(out.problems).toEqual([{ index: 1, id: 'bal-812-s311', reason: 'dueSet' }]);
    });

    test('a set date is a date: refused on an undated open row and on a paid row', () => {
        expect(beside({ dueSet: dueSet(), dueDate: null, dateBasis: 'undated' }).problems).toEqual([{ index: 1, id: 'bal-812-s311', reason: 'dueSet' }]);
        expect(beside({ dueSet: dueSet(), status: 'paid', dueDate: null, paidOn: '2026-09-20' }).problems).toEqual([{ index: 1, id: 'bal-812-s311', reason: 'dueSet' }]);
    });
});
