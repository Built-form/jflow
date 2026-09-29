import { describe, expect, it } from 'vitest';
import { blankItemForm, itemChanges, itemToForm, validateItem } from './itemForm';
import type { ItemForm } from './itemForm';
import { account, category, item } from './testFixtures';

const categories = [category(1, 'Sales', 'in'), category(2, 'Suppliers', 'out')];

function form(over: Partial<ItemForm> = {}): ItemForm {
  return {
    ...blankItemForm('2026-09-29', account(1, 'Barclays')),
    categoryId: '2',
    name: 'Courier',
    amount: '100',
    ...over,
  };
}

describe('validateItem', () => {
  it('sends the amount as the DECIMAL string it parses to, never through a float', () => {
    // Each of these is off by a hair as a float: 0.29×100 = 28.999…, 1.15×100 = 114.999…,
    // 4.35×100 = 434.999…, and 999,999,999,999.99 has no exact double at all.
    for (const [typed, sent] of [
      ['0.29', '0.29'],
      ['1.15', '1.15'],
      ['4.35', '4.35'],
      ['£1,024.1', '1024.10'],
      ['999999999999.99', '999999999999.99'],
    ]) {
      const checked = validateItem(form({ amount: typed }), { categories });
      expect(checked.ok, typed).toBe(true);
      expect(checked.body?.amount).toBe(sent);
      expect(typeof checked.body?.amount).toBe('string');
    }
  });

  it('refuses amounts the API would: zero, negative, three decimals, thirteen digits', () => {
    for (const typed of ['0', '-10', '1.005', '1000000000000', 'ten']) {
      expect(validateItem(form({ amount: typed }), { categories }).ok, typed).toBe(false);
    }
  });

  it('requires the category to go the same way as the item (D14)', () => {
    const checked = validateItem(form({ direction: 'out', categoryId: '1' }), { categories });
    expect(checked.ok).toBe(false);
    expect(checked.errors.categoryId).toMatch(/Sales is money in/);
    expect(validateItem(form({ direction: 'in', categoryId: '1' }), { categories }).body?.direction).toBe('in');
  });

  it("defaults the currency to the account's, and upper-cases a typed one", () => {
    expect(form().currency).toBe('GBP');
    expect(validateItem(form({ currency: 'eur' }), { categories }).body?.currency).toBe('EUR');
    expect(validateItem(form({ currency: 'EURO' }), { categories }).errors.currency).toBeTruthy();
  });

  it('omits blank optional fields on create', () => {
    expect(validateItem(form(), { categories }).body).toEqual({
      accountId: 1,
      categoryId: 2,
      direction: 'out',
      name: 'Courier',
      amount: '100.00',
      currency: 'GBP',
      dueDate: '2026-09-29',
      settleMode: 'auto',
    });
  });
});

describe('itemChanges', () => {
  it('sends only what changed — "100" is the same amount as "100.00"', () => {
    const row = item(7, { amount: '100.00', name: 'Courier', counterparty: 'DPD' });
    const checked = validateItem({ ...itemToForm(row), amount: '100', counterparty: '' }, { categories });
    expect(checked.ok).toBe(true);
    expect(itemChanges(row, checked.body!)).toEqual({ counterparty: null });
  });
});
