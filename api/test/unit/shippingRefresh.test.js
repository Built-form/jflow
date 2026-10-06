'use strict';

// services/shippingRefresh.js — the parts that need no database (docs/PHASE2.md §4.3):
// the feed columns, the row they map to, and feed_hash. The refresh itself runs
// end to end in test/e2e/shipping-refresh.test.js.
//
// Also pinned here, as a source check: the refresh never names an overlay column,
// never deletes, and writes no audit (P8) — the step-19 grep gate, kept in the suite.

const fs = require('fs');
const path = require('path');
const { FEED_COLUMNS, feedRow, feedHash, dueDateMoved, MOVED_FLAG_EXEMPT } = require('../../src/services/shippingRefresh');
const shipping = require('../../src/services/shipping');
const { feedItem, feedBody } = require('../helpers/shippingSourceStub');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'shippingRefresh.js'), 'utf8');

const normalised = (over) => shipping.validateFeed(feedBody([feedItem('bal-812-s311', over)])).items[0];
const DUE_SET = { by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-11-01', scope: 'item', note: null };

describe('feed columns', () => {
    test('exactly the §4.2 feed columns, in one fixed order', () => {
        expect(FEED_COLUMNS).toEqual([
            'feed_kind', 'feed_status', 'supplier', 'shipping_company_id', 'po_id', 'po_number', 'shipment_id',
            'container_ref', 'currency', 'amount', 'due_date', 'paid_on', 'settles', 'date_basis', 'amount_basis',
            'blocked', 'flags_json', 'due_set_json',
        ]);
    });

    test('feedRow maps a validated item onto them, and onto nothing else', () => {
        const row = feedRow(normalised({ flags: ['estimated'] }));
        expect(Object.keys(row)).toEqual(FEED_COLUMNS);
        expect(row).toEqual({
            feed_kind: 'balance', feed_status: 'open', supplier: 'Acme Textiles', shipping_company_id: 1,
            po_id: 812, po_number: 'PO-812', shipment_id: 311, container_ref: 'MSKU1234567', currency: 'USD',
            amount: '12345.67', due_date: '2026-10-15', paid_on: null, settles: null, date_basis: 'firm',
            amount_basis: 'stated', blocked: null, flags_json: '["estimated"]', due_set_json: null,
        });
    });

    test("due_set_json is the row's dueSet as JSON, in one fixed key order", () => {
        const row = feedRow(normalised({ dueSet: DUE_SET }));
        expect(JSON.parse(row.due_set_json)).toEqual(DUE_SET);
        expect(Object.keys(JSON.parse(row.due_set_json))).toEqual(['by', 'email', 'at', 'derivedDate', 'scope', 'note']);
    });
});

describe('feedHash', () => {
    test('64 hex characters, stable for the same row', () => {
        const a = feedHash(feedRow(normalised()));
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(feedHash(feedRow(normalised()))).toBe(a);
    });

    test('the same money and the same flag set hash the same however they were spelled', () => {
        expect(feedHash(feedRow(normalised({ amount: '12.5' })))).toBe(feedHash(feedRow(normalised({ amount: '12.50' }))));
        expect(feedHash(feedRow(normalised({ flags: ['projected', 'estimated'] }))))
            .toBe(feedHash(feedRow(normalised({ flags: ['estimated', 'projected'] }))));
    });

    test.each([
        ['kind', { kind: 'deposit' }],
        ['status', { status: 'paid', paidOn: '2026-09-20', dueDate: null }],
        ['supplier', { supplier: 'Other' }],
        ['supplier null', { supplier: null }],
        ['company', { companyId: 2 }],
        ['po id', { poId: 813 }],
        ['po number', { poNumber: 'PO-813' }],
        ['shipment', { shipmentId: 312 }],
        ['container', { containerRef: 'MSKU7654321' }],
        ['currency', { currency: 'CNY' }],
        ['amount', { amount: '12345.68' }],
        ['due date', { dueDate: '2026-10-16' }],
        ['settles', { settles: 'dep-812' }],
        ['date basis', { dateBasis: 'estimated' }],
        ['amount basis', { amountBasis: 'derived' }],
        ['blocked', { blocked: 'artwork' }],
        ['flags', { flags: ['estimated'] }],
        ['due set', { dueSet: DUE_SET }],
        ['due set note', { dueSet: { ...DUE_SET, note: 'later' } }],
    ])('changes when the %s changes', (_label, over) => {
        expect(feedHash(feedRow(normalised(over)))).not.toBe(feedHash(feedRow(normalised())));
    });

    test('null and the empty string do not collide', () => {
        expect(feedHash(feedRow(normalised({ supplier: '' })))).not.toBe(feedHash(feedRow(normalised({ supplier: null }))));
    });
});

describe('what the refresh may write (source check)', () => {
    test('no overlay column is named anywhere in the file (the step-19 grep gate)', () => {
        expect(SOURCE).not.toMatch(/planned_/);
        expect(SOURCE).not.toMatch(/source_scenario_id/);
    });

    test('it never deletes, and writes no audit row (P8)', () => {
        expect(SOURCE).not.toMatch(/\bDELETE\b/);
        expect(SOURCE).not.toMatch(/recordAudit|audit_log/);
    });
});

describe('dueDateMoved (the "date moved" bookkeeping: due_date_prev, due_date_moved_at)', () => {
    const prior = (over = {}) => ({ due_date: '2026-10-15', flags_json: '[]', ...over });

    test('a different due_date — a set, a clear, a derived date that changed — is a move; the same date is not', () => {
        expect(dueDateMoved(prior(), normalised({ dueDate: '2026-11-20' }))).toBe(true);
        expect(dueDateMoved(prior(), normalised({ dueDate: null, dateBasis: 'undated' }))).toBe(true);
        expect(dueDateMoved(prior({ due_date: null }), normalised())).toBe(true);
        expect(dueDateMoved(prior(), normalised())).toBe(false);
        expect(dueDateMoved(prior({ due_date: null }), normalised({ dueDate: null, dateBasis: 'undated' }))).toBe(false);
    });

    test('a from_today row sliding by the days elapsed is not a move (both sides carry the flag)', () => {
        expect(MOVED_FLAG_EXEMPT).toBe('from_today');
        const slid = normalised({ dueDate: '2026-10-16', flags: ['from_today'] });
        expect(dueDateMoved(prior({ flags_json: '["from_today"]' }), slid)).toBe(false);
        expect(dueDateMoved(prior({ flags_json: '[]' }), slid)).toBe(true);
        expect(dueDateMoved(prior({ flags_json: '["from_today"]' }), normalised({ dueDate: '2026-10-16' }))).toBe(true);
    });

    test('a prior row read back as a Date, or with unreadable flags, still compares by the calendar day', () => {
        expect(dueDateMoved(prior({ due_date: new Date('2026-10-15T00:00:00Z') }), normalised())).toBe(false);
        expect(dueDateMoved(prior({ flags_json: 'not json' }), normalised({ dueDate: '2026-10-16' }))).toBe(true);
        expect(dueDateMoved(prior({ flags_json: null }), normalised())).toBe(false);
    });
});
