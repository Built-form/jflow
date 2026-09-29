'use strict';

// lib/money.js (CONTRACT §2.6, §9.8): money is integer minor units (bigint)
// parsed from DECIMAL strings, never through a float. Pinned here:
//
//  - parseMinor: the exact grammar ^-?\d{1,12}(\.\d{1,2})?$, both ends of
//    DECIMAL(14,2), and every lookalike a float or a sloppy client would send;
//  - formatMinor: minor → "1024.00", negatives and sub-unit values included;
//  - parseRate: DECIMAL(12,6) → micro-units, strictly positive;
//  - roundHalfUp: half away from zero on the magnitude, sign restored;
//  - toGbp / fromGbp at the rates CONTRACT §9.8 names (1.234567 and 0.005234),
//    against values computed by hand (shown in the comments), plus exact halves
//    and values near the DECIMAL(14,2) maximum.
//
// Every expected value is a bigint literal: no float appears in this file.

const fs = require('fs');
const path = require('path');

const money = require('../../src/lib/money');
const { parseMinor, formatMinor, parseRate, roundHalfUp, toGbp, fromGbp } = money;

describe('parseMinor (DECIMAL(14,2) string → bigint minor units)', () => {
    test.each([
        ['1024.00', 102400n],
        ['1024', 102400n],
        ['1024.5', 102450n],
        ['-250.50', -25050n],
        ['0.01', 1n],
        ['-0.01', -1n],
        ['0.1', 10n],
        ['0', 0n],
        ['0.00', 0n],
        ['-0', 0n],
        ['-0.00', 0n],
        ['007.50', 750n],               // leading zeros: inside CONTRACT's grammar
        ['999999999999.99', 99999999999999n],    // DECIMAL(14,2) maximum
        ['-999999999999.99', -99999999999999n],  // and minimum
        ['999999999999', 99999999999900n],
    ])('%s → %s', (s, want) => {
        expect(parseMinor(s)).toBe(want);
    });

    test('returns a bigint, never a number', () => {
        expect(typeof parseMinor('1.00')).toBe('bigint');
    });

    test.each([
        ['exponent notation', '1e3'],
        ['a third decimal', '1.234'],
        ['no integer part', '.5'],
        ['a bare trailing point', '5.'],
        ['a plus sign', '+5'],
        ['a double minus', '--5'],
        ['a lone minus', '-'],
        ['13 integer digits', '1000000000000.00'],
        ['13 integer digits, negative', '-1000000000000'],
        ['a thousands separator', '1,000.00'],
        ['a decimal comma', '10,50'],
        ['a leading space', ' 5.00'],
        ['a trailing space', '5.00 '],
        ['a trailing newline', '5.00\n'],
        ['an internal space', '5 000'],
        ['a currency symbol', '£5.00'],
        ['hex', '0x10'],
        ['Infinity', 'Infinity'],
        ['NaN', 'NaN'],
        ['full-width digits', '５.００'],
        ['the empty string', ''],
    ])('rejects %s (%j)', (_label, s) => {
        expect(() => parseMinor(s)).toThrow();
    });

    test.each([
        ['a JSON number', 1024],
        ['a float', 10.5],
        ['a bigint', 1024n],
        ['null', null],
        ['undefined', undefined],
        ['an object', {}],
        ['an array', ['1.00']],
        ['a boolean', true],
    ])('rejects %s (not a string — CONTRACT D1)', (_label, v) => {
        expect(() => parseMinor(v)).toThrow(TypeError);
    });
});

describe('formatMinor (bigint minor units → DECIMAL string)', () => {
    test.each([
        [102400n, '1024.00'],
        [102450n, '1024.50'],
        [-25050n, '-250.50'],
        [0n, '0.00'],
        [1n, '0.01'],
        [-1n, '-0.01'],
        [-5n, '-0.05'],
        [10n, '0.10'],
        [-100n, '-1.00'],
        [99999999999999n, '999999999999.99'],
        [-99999999999999n, '-999999999999.99'],
        [123456699999999n, '1234566999999.99'],   // sums may exceed DECIMAL(14,2); formatting does not care
    ])('%s → %s', (n, want) => {
        expect(formatMinor(n)).toBe(want);
    });

    test('accepts a safe-integer number (a /forecast figure) as well as a bigint', () => {
        expect(formatMinor(102450)).toBe('1024.50');
        expect(formatMinor(-1)).toBe('-0.01');
    });

    test.each([
        ['a float', 10.5], ['NaN', NaN], ['an unsafe integer', 2 ** 53], ['a string', '100'],
        ['null', null], ['undefined', undefined],
    ])('rejects %s', (_label, v) => {
        expect(() => formatMinor(v)).toThrow(TypeError);
    });

    test('round-trips with parseMinor on canonical strings', () => {
        for (const s of ['0.00', '0.01', '-0.01', '1024.00', '-250.50', '999999999999.99', '-999999999999.99']) {
            expect(formatMinor(parseMinor(s))).toBe(s);
        }
        // and canonicalises the short forms
        expect(formatMinor(parseMinor('1024'))).toBe('1024.00');
        expect(formatMinor(parseMinor('1024.5'))).toBe('1024.50');
        expect(formatMinor(parseMinor('-0'))).toBe('0.00');
    });
});

describe('parseRate (DECIMAL(12,6) string → bigint micro-units)', () => {
    test.each([
        ['1.234567', 1234567n],
        ['0.005234', 5234n],
        ['1', 1000000n],
        ['1.000000', 1000000n],
        ['1.5', 1500000n],
        ['0.000001', 1n],
        ['0.1', 100000n],
        ['999999.999999', 999999999999n],     // DECIMAL(12,6) maximum
    ])('%s → %s', (s, want) => {
        expect(parseRate(s)).toBe(want);
    });

    test.each([
        ['zero', '0'],
        ['zero with decimals', '0.000000'],
        ['a negative rate', '-1.0'],
        ['a plus sign', '+1.0'],
        ['seven integer digits', '1234567'],
        ['seven decimals', '1.2345678'],
        ['no integer part', '.5'],
        ['a bare trailing point', '1.'],
        ['exponent notation', '1e-3'],
        ['a space', ' 1.0'],
        ['the empty string', ''],
    ])('rejects %s (%j)', (_label, s) => {
        expect(() => parseRate(s)).toThrow();
    });

    test.each([
        ['a JSON number', 1.234567], ['a bigint', 1234567n], ['null', null], ['undefined', undefined],
    ])('rejects %s (not a string)', (_label, v) => {
        expect(() => parseRate(v)).toThrow(TypeError);
    });
});

describe('roundHalfUp(numerator, denominator) — half away from zero', () => {
    test.each([
        [5n, 10n, 1n],      //  0.5 →  1
        [-5n, 10n, -1n],    // -0.5 → -1
        [15n, 10n, 2n],     //  1.5 →  2
        [-15n, 10n, -2n],   // -1.5 → -2
        [25n, 10n, 3n],     //  2.5 →  3 (not banker's 2)
        [-25n, 10n, -3n],   // -2.5 → -3
        [4n, 10n, 0n],      //  0.4 →  0
        [-4n, 10n, 0n],     // -0.4 →  0
        [14n, 10n, 1n],
        [-14n, 10n, -1n],
        [16n, 10n, 2n],
        [-16n, 10n, -2n],
        [20n, 10n, 2n],     // exact
        [-20n, 10n, -2n],
        [0n, 7n, 0n],
        [1n, 3n, 0n],       // 0.333…
        [2n, 3n, 1n],       // 0.666…
        [-2n, 3n, -1n],
        [7n, -2n, -4n],     // a negative denominator carries the sign: -3.5 → -4
        [-7n, -2n, 4n],
    ])('roundHalfUp(%s, %s) = %s', (n, d, want) => {
        expect(roundHalfUp(n, d)).toBe(want);
    });

    test('is symmetric: roundHalfUp(−n, d) = −roundHalfUp(n, d)', () => {
        for (let n = 0n; n <= 40n; n += 1n) {
            for (const d of [1n, 2n, 3n, 7n, 10n]) {
                expect(roundHalfUp(-n, d)).toBe(-roundHalfUp(n, d));
            }
        }
    });

    test('throws on a zero denominator', () => {
        expect(() => roundHalfUp(1n, 0n)).toThrow(RangeError);
    });

    test('throws on non-bigint arguments (no float can sneak in)', () => {
        expect(() => roundHalfUp(5, 10n)).toThrow(TypeError);
        expect(() => roundHalfUp(5n, 10)).toThrow(TypeError);
        expect(() => roundHalfUp('5', 10n)).toThrow(TypeError);
    });
});

describe('toGbp(nativeMinor, rateMicro) = roundHalfUp(native × rate, 1_000_000)', () => {
    const R1 = 1234567n;   // 1.234567
    const R2 = 5234n;      // 0.005234

    test.each([
        // rate 1.234567
        [1n, R1, 1n],                  // 1 × 1.234567 = 1.234567 → 1
        [100000n, R1, 123457n],        // 1000.00: 123456.7 → 123457
        [-100000n, R1, -123457n],
        [123456n, R1, 152415n],        // 1234.56: 152414.703552 → 152415
        [50n, R1, 62n],                // 61.72835 → 62
        [500000n, R1, 617284n],        // 5000.00: 617283.5 exactly → 617284 (half up)
        [-500000n, R1, -617284n],      // -617283.5 → -617284 (half away from zero)
        // rate 0.005234
        [1n, R2, 0n],                  // 0.005234 → 0
        [95n, R2, 0n],                 // 0.49723 → 0
        [96n, R2, 1n],                 // 0.502464 → 1
        [-96n, R2, -1n],
        [100000n, R2, 523n],           // 1000.00: 523.4 → 523
        [250000n, R2, 1309n],          // 2500.00: 1308.5 exactly → 1309 (half up)
        [-250000n, R2, -1309n],        // -1308.5 → -1309
        // GBP itself (CONTRACT D3): rate 1.000000 is the identity
        [102450n, 1000000n, 102450n],
        [-25050n, 1000000n, -25050n],
        [0n, R1, 0n],
    ])('toGbp(%s, %s) = %s', (native, rate, want) => {
        expect(toGbp(native, rate)).toBe(want);
    });

    test('near the DECIMAL(14,2) maximum, with no loss of precision', () => {
        const max = parseMinor('999999999999.99');                 // 99999999999999n
        // (10^14 − 1) × 1234567 = 123456700000000000000 − 1234567
        //                       = 123456699999998765433  → /10^6 = 123456699999998.765433 → …999
        expect(toGbp(max, R1)).toBe(123456699999999n);
        expect(toGbp(-max, R1)).toBe(-123456699999999n);
        // (10^14 − 1) × (10^12 − 1) = 10^26 − 10^14 − 10^12 + 1
        //                           = 99999999999899000000000001 → /10^6 → …899000000.000001 → down
        expect(toGbp(max, parseRate('999999.999999'))).toBe(99999999999899000000n);
        // (10^14 − 1) × 5234 = 523400000000000000 − 5234 = 523399999999994766 → 523399999999.994766 → up
        expect(toGbp(max, R2)).toBe(523400000000n);
    });

    test('rejects non-bigint arguments', () => {
        expect(() => toGbp(100, R1)).toThrow(TypeError);
        expect(() => toGbp(100n, 1.234567)).toThrow(TypeError);
    });
});

describe('fromGbp(gbpMinor, rateMicro) = roundHalfUp(gbp × 1_000_000, rate)', () => {
    test.each([
        // 152415 × 10^6 / 1234567: 1234567 × 123456 = 152414703552, remainder 296448 (< half) → 123456
        [152415n, 1234567n, 123456n],
        [-152415n, 1234567n, -123456n],
        // 523 × 10^6 / 5234: 5234 × 99923 = 522996982, remainder 3018 (≥ 2617 = half) → 99924
        [523n, 5234n, 99924n],
        [-523n, 5234n, -99924n],
        // exact halves at rate 2.000000
        [1n, 2000000n, 1n],            //  0.5 →  1
        [-1n, 2000000n, -1n],          // -0.5 → -1
        [3n, 2000000n, 2n],            //  1.5 →  2
        [4n, 2000000n, 2n],            //  exact
        // GBP identity
        [102450n, 1000000n, 102450n],
        [0n, 5234n, 0n],
    ])('fromGbp(%s, %s) = %s', (gbp, rate, want) => {
        expect(fromGbp(gbp, rate)).toBe(want);
    });

    test('item → GBP → account currency rounds once per step (CONTRACT §9.8)', () => {
        // 1234.56 at 1.234567 into GBP, then into an account at 0.005234.
        const gbp = toGbp(123456n, 1234567n);           // 152415
        expect(gbp).toBe(152415n);
        // 152415 × 10^6 / 5234 = 29120175.773… (5234 × 29120175 = 152414995950, rem 4050 ≥ 2617) → 29120176
        expect(fromGbp(gbp, 5234n)).toBe(29120176n);
    });

    test('throws on a zero rate and on non-bigint arguments', () => {
        expect(() => fromGbp(100n, 0n)).toThrow(RangeError);
        expect(() => fromGbp(100, 5234n)).toThrow(TypeError);
    });
});

describe('the module', () => {
    test('exports the §2.6 surface', () => {
        expect(Object.keys(money).sort()).toEqual([
            'formatMinor', 'fromGbp', 'parseMinor', 'parseRate', 'roundHalfUp', 'toGbp',
        ]);
    });

    test('imports nothing from src/db and never calls Number/parseFloat on money', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/lib/money.js'), 'utf8');
        expect(src).not.toMatch(/require\(\s*['"][^'"]*\bdb\b/);
        expect(src).not.toMatch(/parseFloat|toFixed|Math\.round/);
    });
});
