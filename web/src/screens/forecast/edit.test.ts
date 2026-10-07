import { describe, expect, it } from 'vitest';
import { SPLIT_GROUP, TODAY, line } from './fixtures';
import { canSplit, checkEdit, initialForm, shiftedDate, splitRole, undoChoice } from './edit';

const invoice = line({ key: 'item.10', id: 10, name: 'Invoice', amountMinor: 102450, date: '2026-10-06', bucketIndex: 1 });
const rent = line({ key: 'sched.45.2026-10-01', id: 45, name: 'Rent', amountMinor: 120000, date: '2026-10-02' });
const real = { scenario: null, today: TODAY };
const inScenario = { scenario: { id: 9 }, today: TODAY };

describe('the +7 / +14 / +30 buttons', () => {
  it('count on from the line date with lib/dates epoch-day arithmetic', () => {
    expect(shiftedDate('2026-10-06', 7, TODAY)).toBe('2026-10-13');
    expect(shiftedDate('2026-10-06', 14, TODAY)).toBe('2026-10-20');
    expect(shiftedDate('2026-10-06', 30, TODAY)).toBe('2026-11-05');
    expect(shiftedDate('2026-12-15', 30, TODAY)).toBe('2027-01-14');
    expect(shiftedDate('2028-02-22', 7, TODAY)).toBe('2028-02-29');
  });

  it('count on from today for a line whose date has passed (an overdue line)', () => {
    expect(shiftedDate('2026-09-10', 7, TODAY)).toBe('2026-10-06');
    expect(shiftedDate(TODAY, 7, TODAY)).toBe('2026-10-06');
  });
});

describe('the amount', () => {
  it('opens on the line amount as a DECIMAL string', () => {
    expect(initialForm(invoice)).toEqual({ amount: '1024.50', date: '2026-10-06', exclude: false });
  });

  it.each([
    ['', 'Enter an amount.'],
    ['0', 'Must be more than zero.'],
    ['0.00', 'Must be more than zero.'],
    ['-5', 'Must not be negative.'],
    ['10.999', 'At most two decimal places.'],
    ['ten', 'Enter an amount like 1024.50.'],
  ])('refuses %j', (amount, message) => {
    const check = checkEdit(invoice, { ...initialForm(invoice), amount }, real);
    expect(check.action).toBeNull();
    expect(check.errors.amount).toBe(message);
  });

  it('sends only what changed, as a DECIMAL string', () => {
    const check = checkEdit(invoice, { ...initialForm(invoice), amount: '£1,100' }, real);
    expect(check.action).toEqual({ kind: 'item', itemId: '10', body: { amount: '1100.00' } });
  });

  it('holds the save back while nothing has changed', () => {
    const check = checkEdit(invoice, initialForm(invoice), real);
    expect(check.action).toBeNull();
    expect(check.unchanged).toBe(true);
  });
});

describe('the date', () => {
  it('must be a real date', () => {
    expect(checkEdit(invoice, { ...initialForm(invoice), date: '2026-02-30' }, real).errors.date).toBe('Pick a date.');
  });

  it('on real data, edits the one-off by id, or tunes the instance by its NATURAL date', () => {
    expect(checkEdit(invoice, { ...initialForm(invoice), date: '2026-10-13' }, real).action).toEqual({
      kind: 'item',
      itemId: '10',
      body: { dueDate: '2026-10-13' },
    });
    expect(checkEdit(rent, { ...initialForm(rent), date: '2026-10-09', amount: '1250' }, real).action).toEqual({
      kind: 'instance',
      scheduleId: '45',
      naturalDate: '2026-10-01',
      body: { amount: '1250.00', dueDate: '2026-10-09' },
    });
  });

  it('in a scenario, may not be before today', () => {
    const check = checkEdit(invoice, { ...initialForm(invoice), date: '2026-09-28' }, inScenario);
    expect(check.action).toBeNull();
    expect(check.errors.date).toBe('A scenario cannot move a line to before today.');
    expect(checkEdit(invoice, { ...initialForm(invoice), date: TODAY }, inScenario).action).toEqual({
      kind: 'adjustment',
      itemKey: 'item.10',
      body: { kind: 'adjust', newDate: TODAY },
    });
  });

  it('in a scenario, an overdue line keeps its passed date when only the amount changes', () => {
    const overdue = line({ key: 'item.88', id: 88, name: 'Late', amountMinor: 5000, date: '2026-09-10', flags: ['overdue'] });
    expect(checkEdit(overdue, { ...initialForm(overdue), amount: '60' }, inScenario).action).toEqual({
      kind: 'adjustment',
      itemKey: 'item.88',
      body: { kind: 'adjust', newAmount: '60.00' },
    });
  });
});

describe('adjustments', () => {
  const moved = {
    ...rent,
    flags: ['adjusted'],
    date: '2026-10-09',
    baseline: { date: '2026-10-02', amountMinor: 120000, gbpMinor: 120000, flags: [] },
  };

  it('describe the whole change against the baseline, not against the last adjustment', () => {
    const check = checkEdit(moved, { ...initialForm(moved), amount: '1300' }, inScenario);
    expect(check.action).toEqual({
      kind: 'adjustment',
      itemKey: 'sched.45.2026-10-01',
      body: { kind: 'adjust', newDate: '2026-10-09', newAmount: '1300.00' },
    });
  });

  it('become a removal when every value is back to the baseline', () => {
    const check = checkEdit(moved, { ...initialForm(moved), date: '2026-10-02' }, inScenario);
    expect(check.action).toEqual({ kind: 'unadjust', itemKey: 'sched.45.2026-10-01' });
  });

  it('leave a line out with neither a date nor an amount', () => {
    const check = checkEdit(invoice, { ...initialForm(invoice), exclude: true, amount: '' }, inScenario);
    expect(check.action).toEqual({ kind: 'adjustment', itemKey: 'item.10', body: { kind: 'exclude' } });
  });

  it('refuse a key the contract grammar rejects, before anything is sent', () => {
    const bad = line({ key: 'item.012', name: 'Bad' });
    const check = checkEdit(bad, { ...initialForm(bad), amount: '5' }, inScenario);
    expect(check.action).toBeNull();
    expect(check.errors.form).toMatch(/not one JFlow can edit/);
  });
});

describe("a scenario's own one-off (a `new` line, D39)", () => {
  const penalty = line({
    key: 'new.23',
    id: 23,
    name: 'Late filing penalty',
    counterparty: 'HMRC',
    amountMinor: 7500,
    date: '2026-10-13',
    flags: ['added'],
    baseline: null,
    splitGroup: null,
  });
  const newLine = { categoryId: 3, direction: 'out' as const, note: 'If the return is late' };
  const withAdd = { ...inScenario, newLine };

  it('sends the whole add again: its own fields, the amount and date as edited, and the note it carries', () => {
    const check = checkEdit(penalty, { ...initialForm(penalty), amount: '100', date: '2026-10-20' }, withAdd);
    expect(check.action).toEqual({
      kind: 'adjustment',
      itemKey: 'new.23',
      body: {
        kind: 'add',
        accountId: 1,
        categoryId: 3,
        direction: 'out',
        name: 'Late filing penalty',
        counterparty: 'HMRC',
        currency: 'GBP',
        newDate: '2026-10-20',
        newAmount: '100.00',
        note: 'If the return is late',
      },
    });
  });

  it('sends the amount on a date-only change too — a PUT on an add is a full replace', () => {
    const check = checkEdit(penalty, { ...initialForm(penalty), date: '2026-10-20' }, withAdd);
    expect(check.action?.kind === 'adjustment' && check.action.body).toMatchObject({ newDate: '2026-10-20', newAmount: '75.00' });
  });

  it('leaves out a counterparty and a note it does not have', () => {
    const bare = { ...penalty, counterparty: null };
    const check = checkEdit(bare, { ...initialForm(bare), amount: '80' }, { ...inScenario, newLine: { ...newLine, note: null } });
    const body = check.action?.kind === 'adjustment' ? check.action.body : null;
    expect(body).not.toBeNull();
    expect(body && 'counterparty' in body).toBe(false);
    expect(body && 'note' in body).toBe(false);
  });

  it('holds the save back while nothing has changed, and never leaves the line out', () => {
    expect(checkEdit(penalty, initialForm(penalty), withAdd)).toMatchObject({ action: null, unchanged: true });
    expect(checkEdit(penalty, { ...initialForm(penalty), exclude: true }, withAdd)).toMatchObject({ action: null, unchanged: true });
  });

  it('is never sent back to a baseline — it has none — and may not be dated before today', () => {
    const back = checkEdit(penalty, { ...initialForm(penalty), amount: '50' }, withAdd);
    expect(back.action?.kind).toBe('adjustment');
    const past = checkEdit(penalty, { ...initialForm(penalty), date: '2026-09-28' }, withAdd);
    expect(past.action).toBeNull();
    expect(past.errors.date).toBe('A scenario cannot move a line to before today.');
  });

  it('sends nothing until the note has been read from the scenario', () => {
    const check = checkEdit(penalty, { ...initialForm(penalty), amount: '100' }, inScenario);
    expect(check.action).toBeNull();
    expect(check.errors.form).toMatch(/not been read/);
  });

  it('is a form error with no scenario open (the server makes no such line)', () => {
    const check = checkEdit(penalty, { ...initialForm(penalty), amount: '100' }, real);
    expect(check.action).toBeNull();
    expect(check.errors.form).toMatch(/only inside its scenario/);
  });
});

describe('the undo button, and which lines offer a split (D40)', () => {
  const anchor = line({ key: 'item.10', id: 10, name: 'Invoice 1041', flags: ['adjusted', 'split'], splitGroup: SPLIT_GROUP });
  const part = line({ key: 'new.22', id: 22, name: 'Invoice 1041', flags: ['added', 'split'], baseline: null, splitGroup: SPLIT_GROUP });
  const added = line({ key: 'new.23', id: 23, name: 'Late filing penalty', flags: ['added'], baseline: null, splitGroup: null });
  const moved = line({ key: 'item.11', id: 11, name: 'Moved', flags: ['adjusted'], splitGroup: null });
  const plain = line({ key: 'item.12', id: 12, name: 'Plain', splitGroup: null });
  const leftOut = line({ key: 'item.13', id: 13, name: 'Left out', flags: ['excluded'], splitGroup: null });

  it('says what a split line is', () => {
    expect(splitRole(anchor)).toBe('anchor');
    expect(splitRole(part)).toBe('part');
    expect(splitRole(added)).toBeNull();
    expect(splitRole(moved)).toBeNull();
  });

  it('removes an add, undoes a split from its anchor, removes one part, or undoes an adjustment — always a DELETE', () => {
    expect(undoChoice(added, true)).toEqual({ label: 'Remove it from the scenario', detail: null, action: { kind: 'unadjust', itemKey: 'new.23' } });
    expect(undoChoice(anchor, true)).toEqual({ label: 'Undo the split', detail: 'Removes its parts too.', action: { kind: 'unadjust', itemKey: 'item.10' } });
    expect(undoChoice(part, true)).toMatchObject({ label: 'Remove this part', action: { kind: 'unadjust', itemKey: 'new.22' } });
    expect(undoChoice(moved, true)).toMatchObject({ label: 'Undo this adjustment', action: { kind: 'unadjust', itemKey: 'item.11' } });
    expect(undoChoice(leftOut, true)?.label).toBe('Undo this adjustment');
    expect(undoChoice(plain, true)).toBeNull();
    expect(undoChoice(moved, false)).toBeNull();
  });

  it('offers a split on an editable line in a scenario — not on a one-off of its own, a line left out, or real data', () => {
    expect(canSplit(plain, true)).toBe(true);
    expect(canSplit(anchor, true)).toBe(true);
    expect(canSplit(moved, true)).toBe(true);
    expect(canSplit(added, true)).toBe(false);
    expect(canSplit(part, true)).toBe(false);
    expect(canSplit(leftOut, true)).toBe(false);
    expect(canSplit({ ...plain, editable: false }, true)).toBe(false);
    expect(canSplit(plain, false)).toBe(false);
  });
});
