import { describe, expect, it } from 'vitest';
import { changedOnly, validateAccount, validateCategory, validateCompany, validateFxRate } from './validation';

describe('company form', () => {
  it('trims and upper-cases the code, as the server stores it', () => {
    const checked = validateCompany({ code: ' jfa ', name: ' JFA ', sortOrder: '' });
    expect(checked).toEqual({ ok: true, body: { code: 'JFA', name: 'JFA' }, errors: {} });
    expect(validateCompany({ code: 'hw', name: 'Hangerworld', sortOrder: '2' }).body).toEqual({
      code: 'HW',
      name: 'Hangerworld',
      sortOrder: 2,
    });
  });

  it('refuses a code outside [A-Z0-9_]{1,16}, a blank name and a non-integer order', () => {
    const checked = validateCompany({ code: 'J-FA', name: '  ', sortOrder: '1.5' });
    expect(checked.ok).toBe(false);
    expect(checked.body).toBeNull();
    expect(Object.keys(checked.errors).sort()).toEqual(['code', 'name', 'sortOrder']);
    expect(validateCompany({ code: 'A'.repeat(17), name: 'x', sortOrder: '' }).errors.code).toBeTruthy();
    expect(validateCompany({ code: '', name: 'x', sortOrder: '' }).errors.code).toBeTruthy();
  });
});

describe('account form', () => {
  const base = { companyId: '1', name: 'Barclays current', currency: 'gbp', sortOrder: '', isActive: true, isDefault: false };

  it('sends an upper-case currency and the flags', () => {
    expect(validateAccount(base)).toEqual({
      ok: true,
      body: { companyId: 1, name: 'Barclays current', currency: 'GBP', isActive: true, isDefault: false },
      errors: {},
    });
  });

  it('needs a company and a three-letter currency', () => {
    const checked = validateAccount({ ...base, companyId: '', currency: 'EURO' });
    expect(checked.ok).toBe(false);
    expect(checked.errors.companyId).toBe('Pick a company.');
    expect(checked.errors.currency).toMatch(/three-letter/);
    expect(validateAccount({ ...base, currency: 'E1R' }).errors.currency).toBeTruthy();
  });
});

describe('category form', () => {
  it('needs a direction, in or out', () => {
    expect(validateCategory({ name: 'Payroll', direction: '', sortOrder: '' }).errors.direction).toBeTruthy();
    expect(validateCategory({ name: 'Payroll', direction: 'out', sortOrder: '3' })).toEqual({
      ok: true,
      body: { name: 'Payroll', direction: 'out', sortOrder: 3 },
      errors: {},
    });
  });
});

describe('FX rate form', () => {
  const base = { currency: 'eur', rateToGbp: '0.85321', effectiveFrom: '2026-09-01', note: '' };

  it('sends the rate at six decimals, as the column holds it', () => {
    expect(validateFxRate(base)).toEqual({
      ok: true,
      body: { currency: 'EUR', rateToGbp: '0.853210', effectiveFrom: '2026-09-01' },
      errors: {},
    });
  });

  it('never takes GBP — the base currency is always 1 (D3)', () => {
    const checked = validateFxRate({ ...base, currency: 'gbp' });
    expect(checked.ok).toBe(false);
    expect(checked.errors.currency).toMatch(/base currency/);
  });

  it('refuses a zero, negative or over-precise rate and a non-date', () => {
    expect(validateFxRate({ ...base, rateToGbp: '0' }).errors.rateToGbp).toBe('Must be more than zero.');
    expect(validateFxRate({ ...base, rateToGbp: '-1' }).errors.rateToGbp).toBeTruthy();
    expect(validateFxRate({ ...base, rateToGbp: '1.1234567' }).errors.rateToGbp).toBeTruthy();
    expect(validateFxRate({ ...base, effectiveFrom: '2026-02-30' }).errors.effectiveFrom).toBeTruthy();
    expect(validateFxRate({ ...base, note: 'n'.repeat(501) }).errors.note).toBeTruthy();
  });
});

describe('changedOnly — the PUT body for an edit', () => {
  it('keeps only what changed, and never an immutable field', () => {
    const before = { companyId: 1, name: 'Old', currency: 'GBP', isActive: true };
    expect(changedOnly(before, { companyId: 2, name: 'New', currency: 'GBP', isActive: true }, ['companyId'])).toEqual({
      name: 'New',
    });
  });

  it('treats a cleared note and a missing one alike', () => {
    expect(changedOnly({ note: null }, { note: '' })).toEqual({});
    expect(changedOnly({ note: 'x' }, { note: null })).toEqual({ note: null });
  });
});
