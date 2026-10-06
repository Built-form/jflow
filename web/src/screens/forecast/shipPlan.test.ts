import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { TODAY, depositRow, externalRow } from './fixtures';
import {
  checkPlan,
  followFeedDate,
  hasOverlay,
  initialPlanForm,
  isStaleWrite,
  pickDate,
  refusalNeedsReload,
  revertAction,
  shipRefusalLines,
  shipRowName,
  targetFromRow,
} from './shipPlan';

/** The balance: shipping says $1,500.00 on 13 Oct; nothing planned; row version 4. */
const plain = targetFromRow(externalRow());
/** The deposit: shipping says $5,000.00 on 2 Oct; JFlow pinned 6 Oct with a note; row version 7. */
const planned = targetFromRow(depositRow());

describe('the target, from the /external-items row', () => {
  it('knows the feed figures, the overlay as stored, the note and the version', () => {
    expect(planned).toMatchObject({
      key: 'ship.dep-812',
      name: 'Acme Textiles · PO-812 · deposit',
      currency: 'USD',
      feedDate: '2026-10-02',
      feedAmountMinor: 500000n,
      date: '2026-10-06',
      amountMinor: 500000n,
      plannedDate: '2026-10-06',
      plannedAmountMinor: null,
      note: 'Factory holiday',
      planned: true,
      skipped: false,
      gone: false,
      paid: false,
      rowVersion: 7,
    });
    expect(planned.flags).toEqual(['estimated', 'planned']);
    expect(plain.flags).toEqual(['blocked']);
    expect(plain).toMatchObject({ planned: false, note: null, plannedDate: null, rowVersion: 4 });
  });

  it("carries the feed's set-by-hand story and a recent move as flags and fields; a derived, unmoved date carries neither", () => {
    const dueSet = { by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-11-01', scope: 'item', note: null };
    const set = targetFromRow(externalRow({ dueSet, flags: ['due_set'] }));
    expect(set.flags).toEqual(['blocked', 'due_set']);
    expect(set).toMatchObject({ dueSet, dateMovedFrom: null, dateMovedAt: null });
    const moved = targetFromRow(externalRow({ dueDatePrev: '2026-10-05', dueDateMovedAt: '2026-10-06T07:00:00.000Z', dateMoved: true }));
    expect(moved.flags).toEqual(['blocked', 'date_moved']);
    expect(moved).toMatchObject({ dueSet: null, dateMovedFrom: '2026-10-05', dateMovedAt: '2026-10-06T07:00:00.000Z' });
    // the server decides the 14 days: an old move the server did not mark is not a flag here
    const old = targetFromRow(externalRow({ dueDatePrev: '2026-10-05', dueDateMovedAt: '2026-09-01T07:00:00.000Z', dateMoved: false }));
    expect(old.flags).toEqual(['blocked']);
    expect(old).toMatchObject({ dateMovedFrom: null, dateMovedAt: null });
    expect(plain).toMatchObject({ dueSet: null, dateMovedFrom: null, dateMovedAt: null });
  });

  it('names the row as /forecast does, leaving out what shipping does not know', () => {
    expect(shipRowName({ supplier: null, poNumber: 'PO-9', feedKind: 'deposit', extId: 'dep-9' })).toBe('PO-9 · deposit');
    expect(shipRowName({ supplier: null, poNumber: null, feedKind: '', extId: 'dep-9' })).toBe('dep-9');
  });

  it('counts any overlay column as a plan', () => {
    const none = { plannedDate: null, plannedAmount: null, plannedSkipped: false, plannedNote: null };
    expect(hasOverlay(none)).toBe(false);
    expect(hasOverlay({ ...none, plannedNote: 'x' })).toBe(true);
    expect(hasOverlay({ ...none, plannedSkipped: true })).toBe(true);
    expect(hasOverlay({ ...none, plannedAmount: '10.00' })).toBe(true);
  });

  it('opens the form on what is stored: the date follows shipping unless one is pinned', () => {
    expect(initialPlanForm(plain)).toEqual({ date: '2026-10-13', dateFollowsFeed: true, amount: '1500.00', skipped: false, note: '' });
    expect(initialPlanForm(planned)).toEqual({ date: '2026-10-06', dateFollowsFeed: false, amount: '5000.00', skipped: false, note: 'Factory holiday' });
  });
});

describe('checkPlan — the date', () => {
  it('pins a picked date, which must be today or later, and always sends the row version', () => {
    const past = checkPlan(plain, pickDate(initialPlanForm(plain), '2026-09-28'), TODAY);
    expect(past.action).toBeNull();
    expect(past.errors.date).toBe('A planned date must be today or later.');
    expect(checkPlan(plain, pickDate(initialPlanForm(plain), TODAY), TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.bal-812-s311',
      body: { plannedDate: TODAY },
      baseVersion: 4,
    });
  });

  it('must be a real date', () => {
    expect(checkPlan(plain, pickDate(initialPlanForm(plain), '2026-02-30'), TODAY).errors.date).toBe('Pick a date.');
    expect(checkPlan(plain, pickDate(initialPlanForm(plain), ''), TODAY).errors.date).toBe("Pick a date, or use shipping's.");
  });

  it("\"Use shipping's\" clears a pinned date (null): the line follows the feed again", () => {
    expect(checkPlan(planned, followFeedDate(initialPlanForm(planned), planned), TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.dep-812',
      body: { plannedDate: null },
      baseVersion: 7,
    });
  });

  it("pins a date EQUAL to shipping's when the row already has a plan", () => {
    // Pinned 6 Oct → pinned 2 Oct, the date shipping gives: stored, not cleared.
    expect(checkPlan(planned, pickDate(initialPlanForm(planned), '2026-10-02'), TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.dep-812',
      body: { plannedDate: '2026-10-02' },
      baseVersion: 7,
    });
    // A plan with no date yet (a note only): "Pin 13 Oct" pins shipping's own date.
    const noted = targetFromRow(externalRow({ plannedNote: 'Check with QC' }));
    const form = initialPlanForm(noted);
    expect(form.dateFollowsFeed).toBe(true);
    expect(checkPlan(noted, pickDate(form, form.date), TODAY).action).toMatchObject({ body: { plannedDate: '2026-10-13' } });
  });

  it("on a row with no plan, shipping's own date is simply the date it has — nothing to send", () => {
    expect(checkPlan(plain, pickDate(initialPlanForm(plain), '2026-10-13'), TODAY)).toMatchObject({ action: null, unchanged: true });
  });

  it('leaves a pinned date that has since passed alone when only the amount changes', () => {
    const passed = targetFromRow(depositRow({ plannedDate: '2026-09-20', effectiveDate: '2026-09-20' }));
    expect(checkPlan(passed, { ...initialPlanForm(passed), amount: '4800' }, TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.dep-812',
      body: { plannedAmount: '4800.00' },
      baseVersion: 7,
    });
  });

  it('gives an undated row its first date', () => {
    const undated = targetFromRow(externalRow({ dueDate: null, effectiveDate: null, derivedStatus: null }));
    expect(checkPlan(undated, initialPlanForm(undated), TODAY)).toMatchObject({ action: null, unchanged: true });
    expect(checkPlan(undated, pickDate(initialPlanForm(undated), '2026-11-02'), TODAY).action).toMatchObject({
      body: { plannedDate: '2026-11-02' },
      baseVersion: 4,
    });
  });
});

describe('checkPlan — the amount', () => {
  it.each([
    ['', 'Enter an amount.'],
    ['0', 'Must be more than zero.'],
    ['0.00', 'Must be more than zero.'],
    ['-5', 'Must not be negative.'],
    ['10.999', 'At most two decimal places.'],
    ['ten', 'Enter an amount like 1024.50.'],
  ])('refuses %j', (amount, message) => {
    const check = checkPlan(plain, { ...initialPlanForm(plain), amount }, TODAY);
    expect(check.action).toBeNull();
    expect(check.errors.amount).toBe(message);
  });

  it('is sent as a DECIMAL string', () => {
    expect(checkPlan(plain, { ...initialPlanForm(plain), amount: '$1,650.5' }, TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.bal-812-s311',
      body: { plannedAmount: '1650.50' },
      baseVersion: 4,
    });
  });

  it("set back to shipping's clears a planned amount (null)", () => {
    const more = targetFromRow(depositRow({ plannedAmount: '5200.00', plannedBaseAmount: '5000.00', effectiveAmount: '5200.00' }));
    expect(checkPlan(more, { ...initialPlanForm(more), amount: '5000' }, TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.dep-812',
      body: { plannedAmount: null },
      baseVersion: 7,
    });
  });
});

describe('checkPlan — skip, note, nothing', () => {
  it('holds the save back while nothing has changed', () => {
    expect(checkPlan(planned, initialPlanForm(planned), TODAY)).toEqual({ action: null, errors: {}, unchanged: true });
  });

  it('skips with neither a date nor an amount — even a wrong one in the hidden fields', () => {
    const check = checkPlan(plain, { ...pickDate(initialPlanForm(plain), '2026-01-01'), skipped: true, amount: 'ten' }, TODAY);
    expect(check.action).toEqual({ kind: 'plan', key: 'ship.bal-812-s311', body: { skipped: true }, baseVersion: 4 });
  });

  it('unskips a skipped row', () => {
    const skipped = targetFromRow(externalRow({ plannedSkipped: true, derivedStatus: 'skipped' }));
    expect(checkPlan(skipped, { ...initialPlanForm(skipped), skipped: false }, TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.bal-812-s311',
      body: { skipped: false },
      baseVersion: 4,
    });
  });

  it('edits the existing note, trimmed, and clears it with null', () => {
    expect(checkPlan(planned, { ...initialPlanForm(planned), note: ' Factory holiday, week 41 ' }, TODAY).action).toMatchObject({
      body: { note: 'Factory holiday, week 41' },
    });
    expect(checkPlan(planned, { ...initialPlanForm(planned), note: '' }, TODAY).action).toEqual({
      kind: 'plan',
      key: 'ship.dep-812',
      body: { note: null },
      baseVersion: 7,
    });
    expect(checkPlan(planned, { ...initialPlanForm(planned), note: 'Factory holiday  ' }, TODAY).unchanged).toBe(true);
  });

  it('refuses a note over 500 characters', () => {
    expect(checkPlan(plain, { ...initialPlanForm(plain), note: 'x'.repeat(501) }, TODAY).errors.note).toBe('At most 500 characters.');
  });

  it('refuses a key that is not a stock payment, before anything is sent', () => {
    const bad = { ...plain, key: 'item.10' };
    const check = checkPlan(bad, { ...initialPlanForm(bad), amount: '5' }, TODAY);
    expect(check.action).toBeNull();
    expect(check.errors.form).toMatch(/not a stock payment/);
  });

  it('plans nothing on a row shipping no longer lists, or has paid', () => {
    const gone = targetFromRow(depositRow({ goneAt: '2026-09-28T10:00:00Z' }));
    expect(checkPlan(gone, { ...initialPlanForm(gone), note: 'x' }, TODAY).errors.form).toMatch(/no longer lists/);
    const paid = targetFromRow(externalRow({ feedStatus: 'paid', paidOn: '2026-09-25' }));
    expect(checkPlan(paid, initialPlanForm(paid), TODAY).errors.form).toMatch(/has been made/);
    // A plan left on a gone row can still be reverted.
    expect(revertAction(gone)).toEqual({ kind: 'unplan', key: 'ship.dep-812', baseVersion: 7 });
  });
});

describe('Revert to feed', () => {
  it('is offered while anything of JFlow is on the row, with its version', () => {
    expect(revertAction(plain)).toBeNull();
    expect(revertAction(planned)).toEqual({ kind: 'unplan', key: 'ship.dep-812', baseVersion: 7 });
    expect(revertAction(targetFromRow(externalRow({ plannedSkipped: true })))).toEqual({
      kind: 'unplan',
      key: 'ship.bal-812-s311',
      baseVersion: 4,
    });
  });
});

describe('the overlay refusals (§6.12, §7)', () => {
  it('404 TARGET_MISSING: shipping no longer lists it', () => {
    const e = new ApiError(404, { error: 'Target missing.', code: 'TARGET_MISSING', details: { key: 'ship.dep-812' } });
    expect(shipRefusalLines(e, TODAY)[0].message).toMatch(/no longer lists this payment/);
    expect(refusalNeedsReload(e)).toBe(true);
  });

  it('404 with no code: no such row', () => {
    const e = new ApiError(404, { error: 'Not found.' });
    expect(shipRefusalLines(e, TODAY)[0].message).toMatch(/no stock payment with this key/);
    expect(refusalNeedsReload(e)).toBe(true);
  });

  it('409 TARGET_SETTLED: shipping says it is paid', () => {
    const e = new ApiError(409, { error: 'Settled.', code: 'TARGET_SETTLED', details: { key: 'ship.dep-812', status: 'paid' } });
    expect(shipRefusalLines(e, TODAY)[0].message).toMatch(/has been made/);
    expect(refusalNeedsReload(e)).toBe(true);
  });

  it('422 PLANNED_DATE_IN_PAST: names both dates', () => {
    const e = new ApiError(422, {
      error: 'Planned date in the past.',
      code: 'PLANNED_DATE_IN_PAST',
      details: { plannedDate: '2026-09-28', today: '2026-09-29' },
    });
    expect(shipRefusalLines(e, TODAY)[0].message).toBe('Mon 28 Sep 2026 is before today (Tue 29 Sep 2026). Pick today or later.');
    expect(refusalNeedsReload(e)).toBe(false);
  });

  it('409 STALE_WRITE is a re-read, not a reload of the screen; a 400 adds nothing', () => {
    const stale = new ApiError(409, { error: 'Stale.', code: 'STALE_WRITE', details: { currentVersion: 8 } });
    expect(isStaleWrite(stale)).toBe(true);
    expect(refusalNeedsReload(stale)).toBe(false);
    expect(shipRefusalLines(stale, TODAY)).toEqual([]);
    expect(shipRefusalLines(new ApiError(400, { error: 'Nothing to plan; DELETE reverts.' }), TODAY)).toEqual([]);
  });
});
