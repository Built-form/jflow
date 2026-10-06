'use strict';

// lib/lines.js — item and instance JSON → the classify line (CONTRACT §9.6), and
// derivedStatus as the projection of that one call. The table itself is pinned by
// classify.test.js; this file pins only the shaping.

const fs = require('fs');

const {
    itemLine, itemDerivedStatus, instanceLine, instanceDerivedStatus,
    shipEffectiveValues, shipLine, shipDerivedStatus, hasShipOverlay,
} = require('../../src/lib/lines');

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

// An instance in its §6.9 JSON shape (lib/instances.js buildInstance): the effective
// values are already resolved on it, so the line reads them off the object.
const instance = (over = {}) => ({
    key: 'sched.7.2026-03-05', scheduleId: 7, naturalDate: '2026-03-05', predictedDueDate: '2026-03-05',
    dueDate: '2026-03-05', amount: '1000.00', remainingAmount: '1000.00', currency: 'GBP', direction: 'out',
    status: 'expected', settleMode: 'auto', tuned: false, override: null, payments: [], ...over,
});

describe('instanceLine', () => {
    test('effective date and amount off the instance; the paid cache off its override', () => {
        const inst = instance({
            dueDate: '2026-03-20', status: 'part_paid', settleMode: 'auto', tuned: true,
            override: { id: 40, amount: null, dueDate: '2026-03-20', status: 'part_paid', paidAmount: '700.00' },
            payments: [
                { id: 1, paidOn: '2026-02-24', amount: '400.00', note: null },
                { id: 2, paidOn: '2026-03-03', amount: '300.00', note: null },
            ],
        });
        expect(instanceLine(inst)).toEqual({
            status: 'part_paid',
            settleMode: 'auto',
            effectiveDate: '2026-03-20',
            amountMinor: 100000n,
            paidAmountMinor: 70000n,
            payments: [
                { paymentId: 1, paidOn: '2026-02-24', amountMinor: 40000n },
                { paymentId: 2, paidOn: '2026-03-03', amountMinor: 30000n },
            ],
        });
    });

    test('no override → 0n paid; an explicit payment list wins over instance.payments', () => {
        expect(instanceLine(instance()).paidAmountMinor).toBe(0n);
        expect(instanceLine(instance({ payments: undefined })).payments).toEqual([]);
        expect(instanceLine(instance(), [{ id: 3, paidOn: A, amount: '2.50' }]).payments)
            .toEqual([{ paymentId: 3, paidOn: A, amountMinor: 250n }]);
    });
});

describe('instanceDerivedStatus', () => {
    test.each([
        ['auto, due after today', 'expected', instance({ dueDate: '2026-04-05' }), A],
        ['auto, due in [A, today)', 'assumed', instance({ dueDate: '2026-03-05' }), A],
        ['auto, due before A', 'assumedSettled', instance({ dueDate: '2026-02-05' }), A],
        ['auto, before today, no anchor (D12)', 'assumed', instance({ dueDate: '2026-02-05' }), null],
        ['override settle mode manual ("Didn\'t happen")', 'overdue', instance({ dueDate: '2026-02-05', settleMode: 'manual' }), A],
        ['manual, today − 64', 'unresolved', instance({ dueDate: '2026-01-05', settleMode: 'manual' }), A],
        ['skipped', 'skipped', instance({ status: 'skipped' }), A],
        ['paid', 'paid', instance({ status: 'paid', override: { paidAmount: '1000.00' } }), A],
        ['part_paid remainder dated before today', 'overdue',
            instance({ status: 'part_paid', dueDate: '2026-03-05', override: { paidAmount: '1.00' } }), A],
    ])('%s → %s', (_label, expected, input, anchor) => {
        expect(instanceDerivedStatus(input, anchor, TODAY)).toBe(expected);
    });
});

// ── Phase 2: ship rows (CONTRACT §3.4, §9.3.1, §6.12) ────────────────────────────────────
// An external_items row in its camelCase shape, open and dated unless `over` says otherwise.
const ship = (over = {}) => ({
    extId: 'bal-812-s311', feedKind: 'balance', feedStatus: 'open', supplier: 'Acme Textiles', poNumber: 'PO-812',
    currency: 'USD', amount: '1000.00', dueDate: '2026-03-20', paidOn: null, dateBasis: 'firm', amountBasis: 'stated',
    blocked: null, flags: [], goneAt: null, plannedDate: null, plannedAmount: null, plannedSkipped: false,
    plannedBaseAmount: null, plannedNote: null, sourceScenarioId: null, accountId: 3, ...over,
});

describe('shipEffectiveValues (§3.4, P6)', () => {
    test('open: the feed values; the overlay date wins; skipped → skipped', () => {
        expect(shipEffectiveValues(ship())).toEqual({
            status: 'expected', effectiveDate: '2026-03-20', effectiveAmount: '1000.00', planStale: false,
        });
        expect(shipEffectiveValues(ship({ plannedDate: '2026-04-02' })).effectiveDate).toBe('2026-04-02');
        expect(shipEffectiveValues(ship({ plannedSkipped: true })).status).toBe('skipped');
        expect(shipEffectiveValues(ship({ plannedSkipped: 1 })).status).toBe('skipped');
        expect(shipEffectiveValues(ship({ dueDate: null })).effectiveDate).toBeNull();
    });

    test('planned_amount applies only while planned_base_amount equals the feed amount', () => {
        expect(shipEffectiveValues(ship({ plannedAmount: '900.00', plannedBaseAmount: '1000.00' })))
            .toMatchObject({ effectiveAmount: '900.00', planStale: false });
        // the same money spelled differently is not a change
        expect(shipEffectiveValues(ship({ amount: '1000', plannedAmount: '900.00', plannedBaseAmount: '1000.00' })))
            .toMatchObject({ effectiveAmount: '900.00', planStale: false });
        expect(shipEffectiveValues(ship({ amount: '1100.00', plannedAmount: '900.00', plannedBaseAmount: '1000.00' })))
            .toMatchObject({ effectiveAmount: '1100.00', planStale: true });
        expect(shipEffectiveValues(ship({ plannedAmount: '900.00', plannedBaseAmount: null })))
            .toMatchObject({ effectiveAmount: '1000.00', planStale: true });
    });

    test('paid: status paid, dated on paidOn, the feed amount (the row is the payment)', () => {
        expect(shipEffectiveValues(ship({ feedStatus: 'paid', dueDate: null, paidOn: '2026-03-02', plannedSkipped: true })))
            .toEqual({ status: 'paid', effectiveDate: '2026-03-02', effectiveAmount: '1000.00', planStale: false });
    });
});

describe('shipLine (§9.3.1)', () => {
    test('open, dated: expected, always manual, overlay values', () => {
        expect(shipLine(ship({ plannedDate: '2026-04-02', plannedAmount: '250.50', plannedBaseAmount: '1000.00' }))).toEqual({
            status: 'expected', settleMode: 'manual', effectiveDate: '2026-04-02',
            amountMinor: 25050n, paidAmountMinor: 0n, payments: [],
        });
    });

    test('paid: one payment {paidOn, amount} with no payment id; paidAmount = amount', () => {
        expect(shipLine(ship({ feedStatus: 'paid', dueDate: null, paidOn: '2026-03-02', amount: '12.34' }))).toEqual({
            status: 'paid', settleMode: 'manual', effectiveDate: '2026-03-02', amountMinor: 1234n, paidAmountMinor: 1234n,
            payments: [{ paymentId: null, paidOn: '2026-03-02', amountMinor: 1234n }],
        });
    });

    test('skipped keeps its date; undated open rows and gone rows make no line', () => {
        expect(shipLine(ship({ plannedSkipped: true }))).toMatchObject({ status: 'skipped', effectiveDate: '2026-03-20' });
        expect(shipLine(ship({ dueDate: null }))).toBeNull();
        expect(shipLine(ship({ dueDate: null, plannedSkipped: true }))).toBeNull();
        expect(shipLine(ship({ goneAt: '2026-03-01T10:00:00.000Z' }))).toBeNull();
        expect(shipLine(ship({ dueDate: null, plannedDate: '2026-04-01' }))).toMatchObject({ effectiveDate: '2026-04-01' });
    });
});

describe('shipDerivedStatus (§6.12)', () => {
    test.each([
        ['open, future', 'expected', ship({ dueDate: '2026-03-20' })],
        ['open, today − 45 (manual, never assumed)', 'overdue', ship({ dueDate: '2026-01-24' })],
        ['open, today − 46', 'unresolved', ship({ dueDate: '2026-01-23' })],
        ['open, before the anchor: still owed', 'overdue', ship({ dueDate: '2026-02-20' })],
        ['skipped', 'skipped', ship({ plannedSkipped: true })],
        ['paid before the anchor', 'paid', ship({ feedStatus: 'paid', dueDate: null, paidOn: '2026-02-20' })],
        ['paid today', 'paid', ship({ feedStatus: 'paid', dueDate: null, paidOn: TODAY })],
        ['undated open', null, ship({ dueDate: null })],
        ['gone', null, ship({ goneAt: '2026-03-01T10:00:00.000Z' })],
        ['unmapped', null, ship({ accountId: null })],
    ])('%s → %s', (_label, expected, row) => {
        expect(shipDerivedStatus(row, A, TODAY)).toBe(expected);
    });
});

describe('hasShipOverlay', () => {
    test('any planned_* column set, or skipped', () => {
        expect(hasShipOverlay(ship())).toBe(false);
        expect(hasShipOverlay(ship({ plannedSkipped: 0 }))).toBe(false);
        for (const over of [{ plannedDate: '2026-04-01' }, { plannedAmount: '1.00' }, { plannedSkipped: true },
            { plannedSkipped: 1 }, { plannedNote: 'held' }]) {
            expect(hasShipOverlay(ship(over))).toBe(true);
        }
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

describe('shipDateMoved (the `date_moved` mark; handover doc "Dates set by hand")', () => {
    const { shipDateMoved, DATE_MOVED_DAYS } = require('../../src/lib/lines');
    const TODAY = '2026-10-20';

    test('14 days, inclusive, counted on the move\'s UTC calendar day; nothing without a move', () => {
        expect(DATE_MOVED_DAYS).toBe(14);
        expect(shipDateMoved({ dueDateMovedAt: '2026-10-20T08:00:00.000Z' }, TODAY)).toBe(true);
        expect(shipDateMoved({ dueDateMovedAt: '2026-10-06T23:59:59.000Z' }, TODAY)).toBe(true);
        expect(shipDateMoved({ dueDateMovedAt: '2026-10-05T23:59:59.000Z' }, TODAY)).toBe(false);
        expect(shipDateMoved({ dueDateMovedAt: new Date('2026-10-10T10:00:00Z') }, TODAY)).toBe(true);
        expect(shipDateMoved({ dueDateMovedAt: null }, TODAY)).toBe(false);
        expect(shipDateMoved({}, TODAY)).toBe(false);
    });

    test('a move dated after today (a clock ahead of the request) and a bad value are not a mark', () => {
        expect(shipDateMoved({ dueDateMovedAt: '2026-10-21T00:00:00.000Z' }, TODAY)).toBe(false);
        expect(shipDateMoved({ dueDateMovedAt: 'yesterday' }, TODAY)).toBe(false);
        expect(shipDateMoved({ dueDateMovedAt: '2026-10-20T08:00:00.000Z' }, 'not a day')).toBe(false);
    });
});
