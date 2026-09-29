'use strict';

// lib/lines.js — item JSON → the classify line (CONTRACT §9.6), and derivedStatus
// as the projection of that one call. The table itself is pinned by
// classify.test.js; this file pins only the shaping.

const fs = require('fs');

const { itemLine, itemDerivedStatus } = require('../../src/lib/lines');

const TODAY = '2026-03-10';
const A = '2026-03-01';

const item = (over = {}) => ({
    status: 'expected', settleMode: 'auto', dueDate: '2026-03-15', amount: '1000.00', paidAmount: null,
    payments: [], ...over,
});

describe('itemLine', () => {
    test('money parsed to bigint minor units; a one-off is effective on its dueDate', () => {
        expect(itemLine(item({
            status: 'part_paid', paidAmount: '700.00',
            payments: [
                { id: 1, paidOn: '2026-02-24', amount: '400.00', note: null },
                { id: 2, paidOn: '2026-03-03', amount: '300.00', note: 'x' },
            ],
        }))).toEqual({
            status: 'part_paid',
            settleMode: 'auto',
            effectiveDate: '2026-03-15',
            amountMinor: 100000n,
            paidAmountMinor: 70000n,
            payments: [
                { paymentId: 1, paidOn: '2026-02-24', amountMinor: 40000n },
                { paymentId: 2, paidOn: '2026-03-03', amountMinor: 30000n },
            ],
        });
    });

    test('no cache → 0n; no payments → []; an explicit payment list wins over item.payments', () => {
        const line = itemLine(item({ payments: undefined }));
        expect(line.paidAmountMinor).toBe(0n);
        expect(line.payments).toEqual([]);
        const only = itemLine(item(), [{ id: 9, paidOn: A, amount: '1.00' }]);
        expect(only.payments).toEqual([{ paymentId: 9, paidOn: A, amountMinor: 100n }]);
    });

    test('a JSON-number amount is refused (D1)', () => {
        expect(() => itemLine(item({ amount: 1000 }))).toThrow();
    });
});

describe('itemDerivedStatus', () => {
    test.each([
        ['auto, due after today', 'expected', item({ dueDate: '2026-03-15' }), A],
        ['auto, due in [A, today)', 'assumed', item({ dueDate: '2026-03-05' }), A],
        ['auto, due before A', 'assumedSettled', item({ dueDate: '2026-02-20' }), A],
        ['auto, due before today, no anchor (D12)', 'assumed', item({ dueDate: '2026-02-20' }), null],
        ['manual, due today − 5', 'overdue', item({ dueDate: '2026-03-05', settleMode: 'manual' }), A],
        ['manual, due today − 49', 'unresolved', item({ dueDate: '2026-01-20', settleMode: 'manual' }), A],
        ['skipped', 'skipped', item({ status: 'skipped', dueDate: '2026-02-20' }), A],
        ['paid', 'paid', item({ status: 'paid', paidAmount: '1000.00', payments: [{ id: 1, paidOn: '2026-02-01', amount: '1000.00' }] }), A],
        ['part_paid auto, remainder in [A, today)', 'overdue', item({ status: 'part_paid', dueDate: '2026-03-05', paidAmount: '1.00' }), A],
    ])('%s → %s', (_label, expected, input, anchor) => {
        expect(itemDerivedStatus(input, anchor, TODAY)).toBe(expected);
    });
});

describe('module boundary', () => {
    test('lines.js imports nothing from db/, reads no clock, and holds no band table', () => {
        const src = fs.readFileSync(require.resolve('../../src/lib/lines'), 'utf8');
        expect(src).not.toMatch(/require\([^)]*db/);
        expect(src).not.toMatch(/new Date|Date\.now/);
        expect(src).not.toMatch(/assumedSettled|settledBeforeAnchor|unresolved|overdue/);
    });
});
