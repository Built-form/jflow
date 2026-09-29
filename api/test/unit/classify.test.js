'use strict';

// Classification (CONTRACT §9.6, D9, D10, D12, D23; BUILD_PLAN step 4). Pinned here:
//
//  - the matrix {auto, manual} × {< A, A..today−1, == today, > today} × {A < today, A == today}
//    (A..today−1 is empty when A == today: row 6 is empty and row 5 takes every auto item
//    before today);
//  - paid and part_paid with payment rows straddling A (each row classified on its own
//    paid_on, D23), skipped, and A = null (D12: minus infinity);
//  - the 45-day boundary: today−44 and today−45 overdue, today−46 unresolved (D9);
//  - a part_paid remainder is forced manual: never assumed / assumedSettled;
//  - the invariant, asserted on every call: one paid band per payment row; owed is null
//    iff status = 'paid', else exactly one owed band;
//  - the derivedStatus projection (D10).

const fs = require('fs');

const { classify, derivedStatus, OVERDUE_WINDOW_DAYS, DERIVED_STATUSES } = require('../../src/lib/classify');

const TODAY = '2026-09-29';
const A_BEFORE = '2026-09-01'; // an anchor before today
const PAID_BANDS = ['settledBeforeAnchor', 'paid'];
const OWED_BANDS = ['skipped', 'assumedSettled', 'assumed', 'future', 'overdue', 'unresolved'];

/** A classifier input line (§9.6 `line`); money in bigint minor units. */
function line(overrides = {}) {
    return {
        status: 'expected',
        settleMode: 'auto',
        effectiveDate: TODAY,
        amountMinor: 100000n,
        paidAmountMinor: 0n,
        payments: [],
        ...overrides,
    };
}

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

/** The §9.6 invariant, checked on every classification in this file. */
function expectInvariant(input, result) {
    expect(Object.keys(result).sort()).toEqual(['owed', 'payments']);
    const rows = input.payments || [];
    expect(result.payments).toHaveLength(rows.length);
    result.payments.forEach((paid, i) => {
        expect(PAID_BANDS).toContain(paid.band);
        expect(paid).toEqual({
            paymentId: rows[i].paymentId,
            band: paid.band,
            date: rows[i].paidOn,
            amountMinor: rows[i].amountMinor,
            partial: input.status === 'part_paid',
        });
    });
    if (input.status === 'paid') {
        expect(result.owed).toBeNull();
    } else {
        expect(result.owed).not.toBeNull();
        expect(Object.keys(result.owed).sort()).toEqual(['amountMinor', 'band', 'date', 'remainder']);
        expect(OWED_BANDS).toContain(result.owed.band);
        expect(typeof result.owed.amountMinor).toBe('bigint');
    }
}

/** classify with a frozen input (it must not mutate) and the invariant asserted. */
function run(input, A, today = TODAY) {
    deepFreeze(input);
    const result = classify(input, A, today);
    expectInvariant(input, result);
    return result;
}

describe('constants', () => {
    test('OVERDUE_WINDOW_DAYS is 45 (D9)', () => {
        expect(OVERDUE_WINDOW_DAYS).toBe(45);
    });

    test('DERIVED_STATUSES is D10\'s vocabulary', () => {
        expect([...DERIVED_STATUSES].sort()).toEqual(
            ['assumed', 'assumedSettled', 'expected', 'overdue', 'paid', 'skipped', 'unresolved'],
        );
    });
});

describe('the matrix: {auto, manual} × effective date × {A < today, A == today}', () => {
    // [anchor case, A, effective-date bucket, effectiveDate, band when auto, band when manual]
    const CELLS = [
        ['A < today', A_BEFORE, '< A', '2025-06-01', 'assumedSettled', 'unresolved'],
        ['A < today', A_BEFORE, '< A', '2026-08-31', 'assumedSettled', 'overdue'],
        ['A < today', A_BEFORE, 'A..today−1', '2026-09-01', 'assumed', 'overdue'],
        ['A < today', A_BEFORE, 'A..today−1', '2026-09-28', 'assumed', 'overdue'],
        ['A < today', A_BEFORE, '== today', '2026-09-29', 'future', 'future'],
        ['A < today', A_BEFORE, '> today', '2026-09-30', 'future', 'future'],
        ['A < today', A_BEFORE, '> today', '2027-01-15', 'future', 'future'],
        ['A == today', TODAY, '< A', '2025-06-01', 'assumedSettled', 'unresolved'],
        ['A == today', TODAY, '< A', '2026-09-28', 'assumedSettled', 'overdue'],
        // 'A..today−1' has no dates when A == today: row 6 is empty.
        ['A == today', TODAY, '== today', '2026-09-29', 'future', 'future'],
        ['A == today', TODAY, '> today', '2026-09-30', 'future', 'future'],
        ['A == today', TODAY, '> today', '2027-01-15', 'future', 'future'],
    ];
    const CASES = CELLS.flatMap(([anchorCase, A, bucket, date, autoBand, manualBand]) => [
        [anchorCase, 'auto', bucket, date, A, autoBand],
        [anchorCase, 'manual', bucket, date, A, manualBand],
    ]);

    test('every cell of the matrix is enumerated', () => {
        const cells = new Set(CASES.map(([anchorCase, mode, bucket]) => `${anchorCase} | ${mode} | ${bucket}`));
        for (const mode of ['auto', 'manual']) {
            for (const bucket of ['< A', 'A..today−1', '== today', '> today']) {
                expect(cells.has(`A < today | ${mode} | ${bucket}`)).toBe(true);
                expect(cells.has(`A == today | ${mode} | ${bucket}`)).toBe(bucket !== 'A..today−1');
            }
        }
    });

    test.each(CASES)('%s, %s, effective %s (%s, A = %s) → %s', (_anchorCase, settleMode, _bucket, effectiveDate, A, band) => {
        const r = run(line({ settleMode, effectiveDate }), A);
        expect(r.payments).toEqual([]);
        expect(r.owed).toEqual({
            band,
            // Overdue is placed at today; every other band keeps its effective date.
            date: band === 'overdue' ? TODAY : effectiveDate,
            amountMinor: 100000n,
            remainder: false,
        });
    });
});

describe('paid: each payment row on its own paid_on (rows 1–2, D23)', () => {
    test('payments straddling A: the one before is settledBeforeAnchor, the one after is paid; owed is null', () => {
        const r = run(line({
            status: 'paid', effectiveDate: '2026-08-20', paidAmountMinor: 100000n,
            payments: [
                { paymentId: 11, paidOn: '2026-08-27', amountMinor: 40000n }, // A − 5
                { paymentId: 12, paidOn: '2026-09-03', amountMinor: 60000n }, // A + 2
            ],
        }), A_BEFORE);
        expect(r).toEqual({
            payments: [
                { paymentId: 11, band: 'settledBeforeAnchor', date: '2026-08-27', amountMinor: 40000n, partial: false },
                { paymentId: 12, band: 'paid', date: '2026-09-03', amountMinor: 60000n, partial: false },
            ],
            owed: null,
        });
    });

    test('paid_on = A is paid; A − 1 is settledBeforeAnchor; today is paid at today', () => {
        const r = run(line({
            status: 'paid', paidAmountMinor: 100000n,
            payments: [
                { paymentId: 1, paidOn: '2026-08-31', amountMinor: 30000n },
                { paymentId: 2, paidOn: '2026-09-01', amountMinor: 30000n },
                { paymentId: 3, paidOn: TODAY, amountMinor: 40000n },
            ],
        }), A_BEFORE);
        expect(r.payments.map((p) => [p.paymentId, p.band, p.date]))
            .toEqual([[1, 'settledBeforeAnchor', '2026-08-31'], [2, 'paid', '2026-09-01'], [3, 'paid', TODAY]]);
    });

    test('A == today: a payment yesterday is inside the anchor, one today is paid', () => {
        const r = run(line({
            status: 'paid', paidAmountMinor: 100000n,
            payments: [
                { paymentId: 1, paidOn: '2026-09-28', amountMinor: 50000n },
                { paymentId: 2, paidOn: TODAY, amountMinor: 50000n },
            ],
        }), TODAY);
        expect(r.payments.map((p) => p.band)).toEqual(['settledBeforeAnchor', 'paid']);
    });

    test('settle mode and effective date do not matter once paid', () => {
        for (const settleMode of ['auto', 'manual']) {
            for (const effectiveDate of ['2025-01-01', TODAY, '2027-01-01']) {
                const r = run(line({
                    status: 'paid', settleMode, effectiveDate, paidAmountMinor: 100000n,
                    payments: [{ paymentId: 1, paidOn: '2026-09-10', amountMinor: 100000n }],
                }), A_BEFORE);
                expect(r.owed).toBeNull();
                expect(r.payments[0].band).toBe('paid');
            }
        }
    });

    test('a paid parent whose payments were all before the anchor still owes nothing', () => {
        const r = run(line({
            status: 'paid', paidAmountMinor: 100000n,
            payments: [{ paymentId: 1, paidOn: '2026-08-01', amountMinor: 100000n }],
        }), A_BEFORE);
        expect(r.payments[0].band).toBe('settledBeforeAnchor');
        expect(r.owed).toBeNull();
    });
});

describe('part_paid: payments per row, the remainder forced manual (row 3)', () => {
    // D23's example: 1,000 item, 400 paid at A − 5, 300 at A + 2.
    const STRADDLING = [
        { paymentId: 21, paidOn: '2026-08-27', amountMinor: 40000n },
        { paymentId: 22, paidOn: '2026-09-03', amountMinor: 30000n },
    ];
    const partPaid = (overrides) => line({
        status: 'part_paid', paidAmountMinor: 70000n, payments: STRADDLING, ...overrides,
    });

    test('payments straddling A split across the two paid bands, flagged partial; the remainder is owed', () => {
        const r = run(partPaid({ effectiveDate: '2026-10-15' }), A_BEFORE);
        expect(r).toEqual({
            payments: [
                { paymentId: 21, band: 'settledBeforeAnchor', date: '2026-08-27', amountMinor: 40000n, partial: true },
                { paymentId: 22, band: 'paid', date: '2026-09-03', amountMinor: 30000n, partial: true },
            ],
            owed: { band: 'future', date: '2026-10-15', amountMinor: 30000n, remainder: true },
        });
    });

    test('the remainder uses the parent cache, not the sum of the payment rows handed in', () => {
        // Payments before minA are not loaded (§8 rule 4); paidAmountMinor still counts them.
        const r = run(partPaid({ effectiveDate: '2026-10-15', payments: [STRADDLING[1]] }), A_BEFORE);
        expect(r.owed.amountMinor).toBe(30000n);
    });

    test.each([
        // [settle mode, remainder date, band]
        ['auto', '2026-09-10', 'overdue'], // in [A, today): an auto expected item would be 'assumed'
        ['auto', '2026-08-20', 'overdue'], // < A, within 45 days: never 'assumedSettled'
        ['auto', '2026-08-14', 'unresolved'], // today − 46
        ['auto', TODAY, 'future'],
        ['auto', '2026-12-01', 'future'],
        ['manual', '2026-09-10', 'overdue'],
        ['manual', '2026-08-14', 'unresolved'],
        ['manual', '2026-12-01', 'future'],
    ])('%s part_paid, remainder dated %s → %s', (settleMode, effectiveDate, band) => {
        const r = run(partPaid({ settleMode, effectiveDate }), A_BEFORE);
        expect(r.owed).toEqual({
            band,
            date: band === 'overdue' ? TODAY : effectiveDate,
            amountMinor: 30000n,
            remainder: true,
        });
    });

    test('with A == today the remainder is still forced manual', () => {
        const r = run(partPaid({ effectiveDate: '2026-09-28', payments: [] }), TODAY);
        expect(r.owed.band).toBe('overdue');
    });
});

describe('skipped (row 4)', () => {
    test.each([
        ['auto', '2025-06-01', A_BEFORE],
        ['auto', '2026-09-10', A_BEFORE],
        ['auto', '2026-12-01', A_BEFORE],
        ['manual', '2025-06-01', A_BEFORE],
        ['manual', '2026-09-10', TODAY],
        ['manual', '2026-12-01', null],
        ['auto', '2026-09-10', null],
    ])('%s, dated %s, A = %s → skipped at its effective date', (settleMode, effectiveDate, A) => {
        const r = run(line({ status: 'skipped', settleMode, effectiveDate }), A);
        expect(r.owed).toEqual({ band: 'skipped', date: effectiveDate, amountMinor: 100000n, remainder: false });
    });
});

describe('A = null: no anchor is minus infinity (D12)', () => {
    test.each([
        ['auto', '2020-01-01', 'assumed'],
        ['auto', '2026-09-28', 'assumed'],
        ['auto', TODAY, 'future'],
        ['auto', '2026-10-01', 'future'],
        ['manual', '2026-09-19', 'overdue'],
        ['manual', '2026-08-14', 'unresolved'],
        ['manual', '2026-10-01', 'future'],
    ])('expected, %s, dated %s → %s', (settleMode, effectiveDate, band) => {
        const r = run(line({ settleMode, effectiveDate }), null);
        expect(r.owed.band).toBe(band);
    });

    test('nothing is assumedSettled and every payment row is paid', () => {
        const r = run(line({
            status: 'part_paid', effectiveDate: '2026-10-01', paidAmountMinor: 40000n,
            payments: [{ paymentId: 1, paidOn: '2000-01-01', amountMinor: 40000n }],
        }), null);
        expect(r.payments[0].band).toBe('paid');
        expect(r.owed.band).toBe('future');
    });

    test('an undefined anchor is treated as null', () => {
        expect(run(line({ effectiveDate: '2020-01-01' }), undefined).owed.band).toBe('assumed');
    });
});

describe('the 45-day boundary (D9)', () => {
    test.each([
        ['2026-09-28', 1, 'overdue'],
        ['2026-08-16', 44, 'overdue'],
        ['2026-08-15', 45, 'overdue'],
        ['2026-08-14', 46, 'unresolved'],
        ['2025-01-01', 636, 'unresolved'],
    ])('manual expected dated %s (today − %i) → %s', (effectiveDate, _days, band) => {
        for (const A of [A_BEFORE, TODAY, null]) {
            const r = run(line({ settleMode: 'manual', effectiveDate }), A);
            expect(r.owed.band).toBe(band);
        }
    });

    test.each([
        ['2026-08-16', 'overdue'],
        ['2026-08-15', 'overdue'],
        ['2026-08-14', 'unresolved'],
    ])('an auto part_paid remainder dated %s → %s (forced manual)', (effectiveDate, band) => {
        const r = run(line({ status: 'part_paid', effectiveDate, paidAmountMinor: 1n }), A_BEFORE);
        expect(r.owed).toEqual({
            band, date: band === 'overdue' ? TODAY : effectiveDate, amountMinor: 99999n, remainder: true,
        });
    });

    test('the window crosses a year end on epoch days', () => {
        expect(run(line({ settleMode: 'manual', effectiveDate: '2025-11-18' }), null, '2026-01-02').owed.band)
            .toBe('overdue'); // 45 days
        expect(run(line({ settleMode: 'manual', effectiveDate: '2025-11-17' }), null, '2026-01-02').owed.band)
            .toBe('unresolved'); // 46 days
    });
});

describe('derivedStatus: the projection of the same classify call (§9.6, D10)', () => {
    test.each([
        ['future', line({ effectiveDate: '2026-10-01' }), A_BEFORE, 'expected'],
        ['due today', line({ effectiveDate: TODAY, settleMode: 'manual' }), A_BEFORE, 'expected'],
        ['assumed', line({ effectiveDate: '2026-09-10' }), A_BEFORE, 'assumed'],
        ['assumedSettled', line({ effectiveDate: '2026-08-10' }), A_BEFORE, 'assumedSettled'],
        ['overdue', line({ settleMode: 'manual', effectiveDate: '2026-09-10' }), A_BEFORE, 'overdue'],
        ['unresolved', line({ settleMode: 'manual', effectiveDate: '2026-08-14' }), A_BEFORE, 'unresolved'],
        ['skipped', line({ status: 'skipped', effectiveDate: '2026-08-10' }), A_BEFORE, 'skipped'],
        ['paid', line({
            status: 'paid', paidAmountMinor: 100000n,
            payments: [{ paymentId: 1, paidOn: '2026-08-10', amountMinor: 100000n }],
        }), A_BEFORE, 'paid'],
        ['part_paid, remainder future', line({ status: 'part_paid', effectiveDate: '2026-10-01', paidAmountMinor: 500n }), A_BEFORE, 'expected'],
        ['part_paid auto, remainder in [A, today)', line({ status: 'part_paid', effectiveDate: '2026-09-10', paidAmountMinor: 500n }), A_BEFORE, 'overdue'],
        ['part_paid auto, remainder < A', line({ status: 'part_paid', effectiveDate: '2026-08-20', paidAmountMinor: 500n }), A_BEFORE, 'overdue'],
        ['part_paid, remainder today − 46', line({ status: 'part_paid', effectiveDate: '2026-08-14', paidAmountMinor: 500n }), A_BEFORE, 'unresolved'],
        ['no anchor, auto before today', line({ effectiveDate: '2026-01-01' }), null, 'assumed'],
    ])('%s → %s', (_label, input, A, expected) => {
        const status = derivedStatus(run(input, A));
        expect(status).toBe(expected);
        expect(DERIVED_STATUSES).toContain(status);
    });

    test('a part_paid row never reports assumed or assumedSettled', () => {
        for (const effectiveDate of ['2025-01-01', '2026-08-20', '2026-09-01', '2026-09-28', TODAY, '2027-01-01']) {
            for (const A of [A_BEFORE, TODAY, null]) {
                const status = derivedStatus(run(line({ status: 'part_paid', effectiveDate, paidAmountMinor: 500n }), A));
                expect(['expected', 'overdue', 'unresolved']).toContain(status);
            }
        }
    });
});

describe('inputs outside the contract throw', () => {
    test('an unknown status', () => {
        expect(() => classify(line({ status: 'pending' }), A_BEFORE, TODAY)).toThrow();
    });

    test('an unknown settle mode on an owed line', () => {
        expect(() => classify(line({ settleMode: 'sometimes' }), A_BEFORE, TODAY)).toThrow();
    });

    test('an anchor after today (A <= today always holds, §9.6)', () => {
        expect(() => classify(line(), '2026-09-30', TODAY)).toThrow();
    });

    test('a malformed date', () => {
        expect(() => classify(line({ effectiveDate: '2026-02-30' }), A_BEFORE, TODAY)).toThrow();
        expect(() => classify(line(), A_BEFORE, '29/09/2026')).toThrow();
        expect(() => classify(line(), '2026-9-1', TODAY)).toThrow();
    });
});

describe('module boundary', () => {
    test('classify.js imports nothing from db/ and reads no clock', () => {
        const src = fs.readFileSync(require.resolve('../../src/lib/classify'), 'utf8');
        expect(src).not.toMatch(/require\([^)]*db/);
        expect(src).not.toMatch(/new Date|Date\.now/);
    });
});
