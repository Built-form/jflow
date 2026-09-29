'use strict';

// lib/stale.js — the §9.5 stale check on loadTarget's shape (CONTRACT §8, §9.5, §10.7–10.9,
// D11, D38). The comparison is lib/engine.js staleReason, so the engine and the scenario
// routes share one definition; these tests pin the order of the checks, the string compare
// on dates, the minor-unit compare on amounts, and the post-rebase question the adjustment
// write and rebase ask.

const { adjustmentStale, staleAfterRebase, engineTarget } = require('../../src/lib/stale');
const { staleReason } = require('../../src/lib/engine');

const TODAY = '2026-03-10';

const target = (over = {}) => ({
    kind: 'sched', id: 5, naturalDate: '2026-04-20', status: 'expected', effectiveDate: '2026-04-20',
    effectiveAmount: '1000.00', currency: 'GBP', accountId: 1, settleMode: 'auto', hasPaymentState: false,
    overrideId: null, ...over,
});
const adj = (over = {}) => ({
    itemKey: 'sched.5.2026-04-20', kind: 'adjust', newDate: '2026-04-27', newAmount: null,
    baseDate: '2026-04-20', baseAmount: '1000.00', ...over,
});

describe('engineTarget', () => {
    test('maps loadTarget\'s shape onto the engine\'s target record; null stays null', () => {
        expect(engineTarget(target({ effectiveAmount: '983.50' }))).toEqual({
            status: 'expected', hasPaymentState: false, date: '2026-04-20', amountMinor: 98350n,
        });
        expect(engineTarget(null)).toBeNull();
    });
});

describe('adjustmentStale (§9.5, in the engine\'s order)', () => {
    test('a fresh adjustment is not stale', () => {
        expect(adjustmentStale(adj(), target(), TODAY)).toBeNull();
        expect(adjustmentStale(adj({ kind: 'exclude', newDate: null }), target(), TODAY)).toBeNull();
    });

    test('TARGET_MISSING when there is no target (deleted, not an occurrence, ship. — D8)', () => {
        expect(adjustmentStale(adj(), null, TODAY)).toBe('TARGET_MISSING');
    });

    test('TARGET_SETTLED when the status is not expected, or the override carries payment state', () => {
        for (const status of ['paid', 'part_paid', 'skipped']) {
            expect(adjustmentStale(adj(), target({ status }), TODAY)).toBe('TARGET_SETTLED');
        }
        expect(adjustmentStale(adj(), target({ hasPaymentState: true }), TODAY)).toBe('TARGET_SETTLED');
    });

    test('BASE_CHANGED: dates compared as strings, amounts as parsed minor units (D11)', () => {
        expect(adjustmentStale(adj(), target({ effectiveDate: '2026-04-21' }), TODAY)).toBe('BASE_CHANGED');
        expect(adjustmentStale(adj(), target({ effectiveAmount: '983.00' }), TODAY)).toBe('BASE_CHANGED');
        // "1000" and "1000.00" are the same money.
        expect(adjustmentStale(adj({ baseAmount: '1000' }), target(), TODAY)).toBeNull();
        expect(adjustmentStale(adj({ baseAmount: '1000.0' }), target({ effectiveAmount: '1000.00' }), TODAY)).toBeNull();
    });

    test('DATE_PASSED: an adjust whose newDate is before today (D38); today itself is fine', () => {
        expect(adjustmentStale(adj({ newDate: '2026-03-09' }), target(), TODAY)).toBe('DATE_PASSED');
        expect(adjustmentStale(adj({ newDate: TODAY }), target(), TODAY)).toBeNull();
        expect(adjustmentStale(adj({ newDate: null, newAmount: '5.00' }), target(), TODAY)).toBeNull();
        // exclude never carries a date
        expect(adjustmentStale(adj({ kind: 'exclude', newDate: null }), target(), '2027-01-01')).toBeNull();
    });

    test('the first reason wins, in §9.5\'s order', () => {
        const passed = adj({ newDate: '2026-03-01' });
        expect(adjustmentStale(passed, null, TODAY)).toBe('TARGET_MISSING');
        expect(adjustmentStale(passed, target({ status: 'paid', effectiveAmount: '1.00' }), TODAY)).toBe('TARGET_SETTLED');
        expect(adjustmentStale(passed, target({ effectiveAmount: '1.00' }), TODAY)).toBe('BASE_CHANGED');
    });

    test('is the engine\'s staleReason on the mapped target (one definition)', () => {
        const cases = [
            [adj(), target()],
            [adj(), null],
            [adj(), target({ status: 'skipped' })],
            [adj({ baseDate: '2026-01-01' }), target()],
            [adj({ newDate: '2026-01-01' }), target()],
        ];
        for (const [a, t] of cases) expect(adjustmentStale(a, t, TODAY)).toBe(staleReason(a, engineTarget(t), TODAY));
    });
});

describe('staleAfterRebase (§10.7 step 4, §10.8 step 3)', () => {
    test('BASE_CHANGED never survives a rebase', () => {
        expect(staleAfterRebase(adj(), target({ effectiveAmount: '983.00', effectiveDate: '2026-04-22' }), TODAY)).toBeNull();
    });

    test('missing, settled and date-passed do', () => {
        expect(staleAfterRebase(adj(), null, TODAY)).toBe('TARGET_MISSING');
        expect(staleAfterRebase(adj(), target({ status: 'paid' }), TODAY)).toBe('TARGET_SETTLED');
        expect(staleAfterRebase(adj(), target({ hasPaymentState: true }), TODAY)).toBe('TARGET_SETTLED');
        // DATE_PASSED is reported even when the base also changed (§10.8 step 3).
        expect(staleAfterRebase(adj({ newDate: '2026-03-01' }), target({ effectiveAmount: '1.00' }), TODAY)).toBe('DATE_PASSED');
    });

    test('does not mutate the adjustment', () => {
        const a = adj();
        staleAfterRebase(a, target({ effectiveAmount: '1.00' }), TODAY);
        expect(a.baseAmount).toBe('1000.00');
    });
});
