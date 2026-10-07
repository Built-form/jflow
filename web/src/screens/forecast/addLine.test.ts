import { describe, expect, it } from 'vitest';
import { account, category } from '../items/testFixtures';
import { TODAY } from './fixtures';
import { blankAddLineForm, checkAddLine } from './addLine';
import type { AddLineForm } from './addLine';

const categories = [category(1, 'Sales', 'in'), category(2, 'Fees and fines', 'out'), category(3, 'Interest', 'out')];
const ctx = { categories, today: TODAY };
const barclays = account(1, 'Barclays');

/** A form that passes: a £250.00 fine on 13 Oct. */
function filled(over: Partial<AddLineForm> = {}): AddLineForm {
  return {
    ...blankAddLineForm(TODAY, barclays),
    categoryId: '2',
    name: '  Late payment fine ',
    amount: '£250',
    date: '2026-10-13',
    ...over,
  };
}

describe('a new one-off in a scenario (D39)', () => {
  it('opens on the first account, its currency, money out and today', () => {
    expect(blankAddLineForm(TODAY, barclays)).toEqual({
      accountId: '1',
      direction: 'out',
      categoryId: '',
      name: '',
      counterparty: '',
      amount: '',
      currency: 'GBP',
      date: TODAY,
      note: '',
    });
    expect(blankAddLineForm(TODAY, null).accountId).toBe('');
  });

  it('sends the add: its own fields, trimmed, the amount as a DECIMAL string', () => {
    const check = checkAddLine(filled(), ctx);
    expect(check.errors).toEqual({});
    expect(check.body).toEqual({
      kind: 'add',
      accountId: 1,
      categoryId: 2,
      direction: 'out',
      name: 'Late payment fine',
      newDate: '2026-10-13',
      newAmount: '250.00',
      currency: 'GBP',
    });
  });

  it('sends a counterparty and a note only when there is one', () => {
    const body = checkAddLine(filled({ counterparty: ' HMRC ', note: ' If the VAT return is late ', currency: 'eur' }), ctx).body;
    expect(body).toMatchObject({ counterparty: 'HMRC', note: 'If the VAT return is late', currency: 'EUR' });
  });

  it.each<[keyof AddLineForm, string, string]>([
    ['accountId', '', 'Pick an account.'],
    ['categoryId', '', 'Pick a category.'],
    ['categoryId', '1', 'Sales is money in. Pick a money-out category.'],
    ['name', '   ', 'Give it a name.'],
    ['name', 'x'.repeat(256), 'At most 255 characters.'],
    ['counterparty', 'x'.repeat(256), 'At most 255 characters.'],
    ['amount', '', 'Enter the amount.'],
    ['amount', '0', 'Must be more than zero.'],
    ['amount', '-3', 'Must not be negative.'],
    ['amount', '2.505', 'At most two decimal places.'],
    ['currency', 'pounds', 'A three-letter code, like GBP or EUR.'],
    ['date', '', 'Pick a date.'],
    ['date', '2026-02-30', 'Pick a date.'],
    ['note', 'x'.repeat(501), 'At most 500 characters.'],
  ])('refuses %s = %j', (field, value, message) => {
    const check = checkAddLine(filled({ [field]: value }), ctx);
    expect(check.body).toBeNull();
    expect(check.errors[field]).toBe(message);
  });

  it("refuses a date before the server's today, and takes today itself", () => {
    const past = checkAddLine(filled({ date: '2026-09-28' }), ctx);
    expect(past.body).toBeNull();
    expect(past.errors.date).toBe('Today or later: a scenario cannot add a one-off in the past.');
    expect(checkAddLine(filled({ date: TODAY }), ctx).body?.newDate).toBe(TODAY);
  });

  it('takes a note of exactly 500 characters', () => {
    expect(checkAddLine(filled({ note: 'x'.repeat(500) }), ctx).body?.note).toHaveLength(500);
  });
});
