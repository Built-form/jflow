import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { category, instance, schedule } from '../items/testFixtures';
import {
  conflictConfirmLabel,
  instanceRemaining,
  resendFlags,
  scheduleChanges,
  scheduleToForm,
  splitConflictOf,
  structureLockMessage,
  structureLockOf,
  validateSchedule,
} from './scheduleForm';

const categories = [category(1, 'Sales', 'in'), category(2, 'Suppliers', 'out')];

describe('the structure-lock message', () => {
  it("names the fields and the server's reason, and points at a split", () => {
    const started = structureLockMessage([], { fields: ['amount', 'frequency'], reason: 'started', split: '/schedules/7/split' });
    expect(started).toBe(
      'The amount and frequency cannot change in place: this schedule has already started. Split it from a date instead — the schedule ends before that date and a new one carries the change from it on, leaving the past as it was.',
    );
    expect(structureLockMessage([], { fields: ['settleMode'], reason: 'has_overrides' })).toMatch(
      /^The settle mode cannot change in place: some of its instances have been tuned or paid\. Split it/,
    );
  });

  it("says the general reason when only the schedule's structureLocked flag is known", () => {
    expect(structureLockMessage(['accountId', 'amount', 'endDate'])).toMatch(
      /^The account, amount and end date cannot change in place: this schedule is already in use/,
    );
  });

  it('reads SCHEDULE_STRUCTURE_LOCKED off a refusal, and nothing else', () => {
    const locked = new ApiError(409, {
      error: 'Structure is locked.',
      code: 'SCHEDULE_STRUCTURE_LOCKED',
      details: { fields: ['amount'], reason: 'started', split: '/schedules/7/split' },
    });
    expect(structureLockOf(locked)).toEqual({ fields: ['amount'], reason: 'started', split: '/schedules/7/split' });
    expect(structureLockOf(new ApiError(409, { error: 'x', code: 'STALE_WRITE' }))).toBeNull();
    expect(structureLockOf(new Error('x'))).toBeNull();
  });
});

describe('scheduleChanges', () => {
  it('splits an edit into descriptive and structural, and an unchanged value is not a change', () => {
    const s = schedule(7, { amount: '1000.00' });
    const checked = validateSchedule({ ...scheduleToForm(s), name: 'Office rent', amount: '1000' }, { categories });
    expect(checked.ok).toBe(true);
    expect(scheduleChanges(s, checked.values!)).toEqual({ descriptive: { name: 'Office rent' }, structural: {} });

    const moved = validateSchedule({ ...scheduleToForm(s), amount: '1050', endKind: 'count', occurrenceCount: '12' }, { categories });
    expect(scheduleChanges(s, moved.values!).structural).toEqual({ amount: '1050.00', occurrenceCount: 12 });
  });

  it('can never send both ends (D22)', () => {
    const s = schedule(7, { endDate: '2027-01-31' });
    const checked = validateSchedule({ ...scheduleToForm(s), endKind: 'count', occurrenceCount: '3' }, { categories });
    expect(checked.values?.occurrenceCount).toBe(3);
    expect(checked.values?.endDate).toBeNull();
  });
});

describe('split and end conflicts', () => {
  const refusal = (code: string, details: Record<string, unknown>) => new ApiError(409, { error: code, code, details });

  it('turns each 409 into what the person is asked', () => {
    expect(splitConflictOf(refusal('SCHEDULE_HAS_PAYMENTS', { naturalDates: ['2026-10-31'] }))).toEqual({
      kind: 'payments',
      naturalDates: ['2026-10-31'],
    });
    expect(splitConflictOf(refusal('SCHEDULE_HAS_OVERRIDES', { naturalDates: ['2026-11-30'] }))).toEqual({
      kind: 'overrides',
      naturalDates: ['2026-11-30'],
    });
    const adjustments = [{ scenarioId: 3, scenarioName: 'Hire in Nov', itemKey: 'sched.7.2026-11-30', naturalDate: '2026-11-30' }];
    expect(splitConflictOf(refusal('SCHEDULE_HAS_ADJUSTMENTS', { adjustments }))).toEqual({ kind: 'adjustments', adjustments });
    expect(splitConflictOf(refusal('STALE_WRITE', {}))).toBeNull();
  });

  it('answers overrides and adjustments with their flag, keeping earlier answers; payments with nothing', () => {
    expect(resendFlags({ kind: 'overrides', naturalDates: [] }, {})).toEqual({ dropOverrides: true });
    expect(resendFlags({ kind: 'adjustments', adjustments: [] }, { dropOverrides: true })).toEqual({
      dropOverrides: true,
      dropAdjustments: true,
    });
    expect(resendFlags({ kind: 'payments', naturalDates: ['2026-10-31'] }, { dropOverrides: true })).toBeNull();
  });

  it('labels the confirm with what it drops', () => {
    expect(conflictConfirmLabel({ kind: 'overrides', naturalDates: ['a', 'b'] }, 'split')).toBe('Drop 2 tuned instances and split');
    expect(conflictConfirmLabel({ kind: 'adjustments', adjustments: [] as never[] }, 'end')).toBe('Drop 0 scenario adjustments and end');
  });
});

describe('instanceRemaining', () => {
  it('is the effective amount less the paid cache, in minor units', () => {
    expect(instanceRemaining(instance(7, '2026-10-31', { amount: '0.30' }))).toBe('0.30');
    const partPaid = instance(7, '2026-10-31', {
      amount: '0.30',
      status: 'part_paid',
      override: {
        id: 1, amount: null, dueDate: null, status: 'part_paid', settleMode: null, paidOn: '2026-09-01',
        paidAmount: '0.10', note: null, sourceScenarioId: null, rowVersion: 1, createdBy: null, createdAt: '', updatedAt: '',
      },
    });
    // 0.30 − 0.10 is 0.19999999999999998 as floats.
    expect(instanceRemaining(partPaid)).toBe('0.20');
  });
});
