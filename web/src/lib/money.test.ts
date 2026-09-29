import { describe, expect, it } from 'vitest';
import {
  formatDecimal,
  formatMinor,
  formatMoney,
  formatRateMicro,
  parseMinor,
  parseMoneyInput,
  parseRateMicro,
  sumMinor,
  toMinor,
} from './money';

describe('parseMinor — DECIMAL strings to integer minor units', () => {
  it('reads the wire forms the API sends', () => {
    expect(parseMinor('1024.00')).toBe(102400n);
    expect(parseMinor('1024')).toBe(102400n);
    expect(parseMinor('1024.5')).toBe(102450n);
    expect(parseMinor('-250.50')).toBe(-25050n);
    expect(parseMinor('0.01')).toBe(1n);
    expect(parseMinor('999999999999.99')).toBe(99999999999999n);
  });

  it('refuses anything that is not DECIMAL(14,2)', () => {
    for (const bad of ['', '1.234', '1,024.00', '£10', 'abc', '1e3', '.5', '1.', '1234567890123', '--1']) {
      expect(parseMinor(bad)).toBeNull();
    }
    expect(parseMinor(null)).toBeNull();
    expect(parseMinor(undefined)).toBeNull();
  });

  it('sums exactly where floats would not', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004.
    const total = sumMinor([parseMinor('0.10')!, parseMinor('0.20')!]);
    expect(total).toBe(30n);
    expect(formatMinor(total)).toBe('0.30');
    const many = sumMinor(Array.from({ length: 1000 }, () => parseMinor('0.01')!));
    expect(formatMinor(many)).toBe('10.00');
  });
});

describe('formatMinor — back to the wire', () => {
  it('always writes two decimals and keeps the sign', () => {
    expect(formatMinor(102450n)).toBe('1024.50');
    expect(formatMinor(0n)).toBe('0.00');
    expect(formatMinor(-5n)).toBe('-0.05');
    expect(formatMinor(-25050n)).toBe('-250.50');
  });
});

describe('formatMoney — for reading', () => {
  it('groups thousands and puts the symbol in front for GBP, EUR and USD', () => {
    expect(formatMoney(123456789n, 'GBP')).toBe('£1,234,567.89');
    expect(formatMoney(100n, 'EUR')).toBe('€1.00');
    expect(formatMoney(99n, 'USD')).toBe('$0.99');
  });

  it('puts any other currency code after the figure', () => {
    expect(formatMoney(102450n, 'SEK')).toBe('1,024.50 SEK');
    expect(formatMoney(102450n, 'chf')).toBe('1,024.50 CHF');
  });

  it('shows an overdraft with a leading minus', () => {
    expect(formatMoney(-25050n, 'GBP')).toBe('-£250.50');
    expect(formatMoney(-100000n, 'SEK')).toBe('-1,000.00 SEK');
  });

  it("takes /forecast's integer minor units, and refuses a float", () => {
    expect(formatMoney(102450, 'GBP')).toBe('£1,024.50');
    expect(() => formatMoney(10.5, 'GBP')).toThrow(RangeError);
    expect(toMinor(7n)).toBe(7n);
  });

  it('formatDecimal reads a DECIMAL string and dashes a missing one', () => {
    expect(formatDecimal('1024.00', 'GBP')).toBe('£1,024.00');
    expect(formatDecimal('-3.5', 'EUR')).toBe('-€3.50');
    expect(formatDecimal(null, 'GBP')).toBe('—');
    expect(formatDecimal('nonsense', 'GBP')).toBe('—');
  });
});

describe('parseMoneyInput — what someone typed', () => {
  it('forgives presentation: spaces, commas, a symbol, a typographic minus', () => {
    expect(parseMoneyInput(' £1,024.5 ', { allowNegative: true })).toEqual({ kind: 'ok', minor: 102450n, decimal: '1024.50' });
    expect(parseMoneyInput('−250', { allowNegative: true })).toEqual({ kind: 'ok', minor: -25000n, decimal: '-250.00' });
    expect(parseMoneyInput('-€3.10', { allowNegative: true })).toEqual({ kind: 'ok', minor: -310n, decimal: '-3.10' });
  });

  it('blank is blank, not zero', () => {
    expect(parseMoneyInput('')).toEqual({ kind: 'blank' });
    expect(parseMoneyInput('   ')).toEqual({ kind: 'blank' });
  });

  it('is strict about the value', () => {
    expect(parseMoneyInput('1.234')).toEqual({ kind: 'error', error: 'At most two decimal places.' });
    expect(parseMoneyInput('12abc').kind).toBe('error');
    expect(parseMoneyInput('1.').kind).toBe('error');
    expect(parseMoneyInput('-5')).toEqual({ kind: 'error', error: 'Must not be negative.' });
    expect(parseMoneyInput('0', { allowZero: false })).toEqual({ kind: 'error', error: 'Must be more than zero.' });
    expect(parseMoneyInput('0')).toEqual({ kind: 'ok', minor: 0n, decimal: '0.00' });
  });
});

describe('rates as micro-units', () => {
  it('reads DECIMAL(12,6) and writes six decimals', () => {
    expect(parseRateMicro('1.234567')).toBe(1234567n);
    expect(parseRateMicro('0.005234')).toBe(5234n);
    expect(parseRateMicro('1.17')).toBe(1170000n);
    expect(formatRateMicro(1170000n)).toBe('1.170000');
    expect(formatRateMicro(5234n)).toBe('0.005234');
  });

  it('refuses a sign, seven decimals or seven whole digits', () => {
    expect(parseRateMicro('-1')).toBeNull();
    expect(parseRateMicro('1.1234567')).toBeNull();
    expect(parseRateMicro('1234567')).toBeNull();
    expect(parseRateMicro('')).toBeNull();
  });
});
