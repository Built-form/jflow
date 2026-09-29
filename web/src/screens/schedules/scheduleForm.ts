/**
 * The schedule form's checks, and the two rules the client needs to SAY (never enforce)
 * about a schedule: which fields are structural (D37), and what a split's three 409s ask
 * of the person (§6.8, §7, §10.5). Whether a schedule is locked is the server's
 * `structureLocked`; whether a split may go ahead is the server's answer.
 */

import { isApiError } from '../../api/client';
import type { Instance, Schedule, ScheduleCreate, ScheduleDescriptive, ScheduleStructure, StructureLockDetails } from '../../api/schedules';
import type { BlockingAdjustment, Frequency, StructuralField, WeekendRule } from '../../api/schedules';
import { STRUCTURAL_FIELDS } from '../../api/schedules';
import type { Category } from '../../api/types';
import { formatDay, isValidDate } from '../../lib/dates';
import { formatMinor, parseMinor } from '../../lib/money';
import type { FieldErrors } from '../../lib/validation';
import { checkCommon, sameDecimal } from '../items/itemForm';
import type { CommonField, CommonForm } from '../items/itemForm';

/* ---------- vocabulary ---------- */

const FREQUENCY_UNIT: Record<Frequency, [string, string]> = {
  weekly: ['week', 'weeks'],
  fortnightly: ['fortnight', 'fortnights'],
  four_weekly: ['4 weeks', '× 4 weeks'],
  monthly: ['month', 'months'],
  quarterly: ['quarter', 'quarters'],
  annually: ['year', 'years'],
};

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  four_weekly: 'Every four weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};

export const WEEKEND_RULE_LABEL: Record<WeekendRule, string> = {
  none: 'Keep weekend dates',
  previous: 'Move to the Friday before',
  next: 'Move to the Monday after',
};

export const FIELD_LABEL: Record<StructuralField, string> = {
  amount: 'amount',
  currency: 'currency',
  accountId: 'account',
  frequency: 'frequency',
  intervalCount: 'interval',
  startDate: 'start date',
  occurrenceCount: 'number of occurrences',
  endDate: 'end date',
  weekendRule: 'weekend rule',
  settleMode: 'settle mode',
};

/** `Every month`, `Every 2 weeks`, `Every 3 × 4 weeks`. */
export function cadenceLabel(frequency: Frequency, intervalCount: number): string {
  const [one, many] = FREQUENCY_UNIT[frequency] ?? [frequency, frequency];
  return intervalCount <= 1 ? `Every ${one}` : `Every ${intervalCount} ${many}`;
}

/** `No end`, `After 12 occurrences`, `Last on or before Tue 29 Sep 2026`. */
export function endLabel(s: Pick<Schedule, 'occurrenceCount' | 'endDate'>): string {
  if (s.occurrenceCount != null) return `After ${s.occurrenceCount} ${s.occurrenceCount === 1 ? 'occurrence' : 'occurrences'}`;
  if (s.endDate) return `Last on or before ${formatDay(s.endDate)}`;
  return 'No end';
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/* ---------- the form ---------- */

export type EndKind = 'none' | 'count' | 'date';

export interface ScheduleForm extends CommonForm {
  frequency: Frequency;
  intervalCount: string;
  startDate: string;
  endKind: EndKind;
  occurrenceCount: string;
  endDate: string;
  weekendRule: WeekendRule;
}

export type ScheduleField = keyof ScheduleForm;

/** Every field the API holds, ends as nulls — the shape the diff compares. */
export type ScheduleValues = ScheduleDescriptive & ScheduleStructure & { direction: 'in' | 'out' };

export type ScheduleCheck =
  | { ok: true; values: ScheduleValues; errors: FieldErrors<ScheduleField> }
  | { ok: false; values: null; errors: FieldErrors<ScheduleField> };

function wholeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  return Number(text);
}

export function validateSchedule(form: ScheduleForm, ctx: { categories: Category[] }): ScheduleCheck {
  const errors: FieldErrors<ScheduleField> = {};
  const common = checkCommon(form, ctx, errors as FieldErrors<CommonField>);

  const intervalCount = wholeNumber(form.intervalCount);
  if (intervalCount === null || intervalCount < 1) errors.intervalCount = 'A whole number, 1 or more.';

  const startDate = form.startDate.trim();
  if (!isValidDate(startDate)) errors.startDate = 'Pick the first date.';

  // One end or none, never both (D22) — the choice makes both impossible to send.
  let occurrenceCount: number | null = null;
  let endDate: string | null = null;
  if (form.endKind === 'count') {
    occurrenceCount = wholeNumber(form.occurrenceCount);
    if (occurrenceCount === null || occurrenceCount < 1) errors.occurrenceCount = 'How many times? 1 or more.';
  } else if (form.endKind === 'date') {
    endDate = form.endDate.trim();
    if (!isValidDate(endDate)) errors.endDate = 'Pick the last date.';
    else if (isValidDate(startDate) && endDate < startDate) errors.endDate = 'On or after the start date.';
  }

  if (Object.keys(errors).length) return { ok: false, values: null, errors };
  return {
    ok: true,
    errors,
    values: {
      name: common.name,
      counterparty: common.counterparty,
      categoryId: common.categoryId,
      notes: common.notes,
      direction: common.direction,
      amount: common.amount,
      currency: common.currency,
      accountId: common.accountId,
      frequency: form.frequency,
      intervalCount: intervalCount ?? 1,
      startDate,
      occurrenceCount,
      endDate,
      weekendRule: form.weekendRule,
      settleMode: common.settleMode,
    },
  };
}

/** The POST body: nulls and blanks left out. */
export function createBody(v: ScheduleValues): ScheduleCreate {
  const body: ScheduleCreate = {
    accountId: v.accountId,
    categoryId: v.categoryId,
    direction: v.direction,
    name: v.name,
    amount: v.amount,
    currency: v.currency,
    frequency: v.frequency,
    intervalCount: v.intervalCount,
    startDate: v.startDate,
    weekendRule: v.weekendRule,
    settleMode: v.settleMode,
  };
  if (v.occurrenceCount != null) body.occurrenceCount = v.occurrenceCount;
  if (v.endDate) body.endDate = v.endDate;
  if (v.counterparty) body.counterparty = v.counterparty;
  if (v.notes) body.notes = v.notes;
  return body;
}

export function blankScheduleForm(today: string, account: { id: number; currency: string } | null): ScheduleForm {
  return {
    accountId: account ? String(account.id) : '',
    direction: 'out',
    categoryId: '',
    name: '',
    counterparty: '',
    amount: '',
    currency: account?.currency ?? '',
    settleMode: 'auto',
    notes: '',
    frequency: 'monthly',
    intervalCount: '1',
    startDate: today,
    endKind: 'none',
    occurrenceCount: '',
    endDate: '',
    weekendRule: 'none',
  };
}

export function scheduleToForm(s: Schedule): ScheduleForm {
  return {
    accountId: String(s.accountId),
    direction: s.direction,
    categoryId: String(s.categoryId),
    name: s.name,
    counterparty: s.counterparty ?? '',
    amount: s.amount,
    currency: s.currency,
    settleMode: s.settleMode,
    notes: s.notes ?? '',
    frequency: s.frequency,
    intervalCount: String(s.intervalCount),
    startDate: s.startDate,
    endKind: s.occurrenceCount != null ? 'count' : s.endDate ? 'date' : 'none',
    occurrenceCount: s.occurrenceCount != null ? String(s.occurrenceCount) : '',
    endDate: s.endDate ?? '',
    weekendRule: s.weekendRule,
  };
}

function sameValue(field: StructuralField, a: unknown, b: unknown): boolean {
  if (field === 'amount') return sameDecimal(a as string, b as string);
  return (a ?? null) === (b ?? null);
}

/**
 * What an edit changes, split the way the API splits it (D37): descriptive fields edit in
 * place always; structural ones only while the schedule is unlocked. An unchanged value is
 * not a change, so it is never sent.
 */
export function scheduleChanges(
  s: Schedule,
  v: ScheduleValues,
): { descriptive: Partial<ScheduleDescriptive>; structural: Partial<ScheduleStructure> } {
  const descriptive: Partial<ScheduleDescriptive> = {};
  if (v.name !== s.name) descriptive.name = v.name;
  if ((v.counterparty ?? null) !== (s.counterparty || null)) descriptive.counterparty = v.counterparty;
  if (v.categoryId !== s.categoryId) descriptive.categoryId = v.categoryId;
  if ((v.notes ?? null) !== (s.notes || null)) descriptive.notes = v.notes;
  const structural: Partial<ScheduleStructure> = {};
  for (const field of STRUCTURAL_FIELDS) {
    if (!sameValue(field, v[field], s[field])) (structural as Record<string, unknown>)[field] = v[field];
  }
  return { descriptive, structural };
}

/* ---------- structure lock ---------- */

/**
 * The sentence for `SCHEDULE_STRUCTURE_LOCKED` (or for a locked schedule before the click):
 * which fields, why, and what to do instead. `details` is the server's; without it (the
 * `structureLocked` flag said so first) the reason is the general one.
 */
export function structureLockMessage(fields: string[], details?: Partial<StructureLockDetails> | null): string {
  const names = (details?.fields?.length ? details.fields : fields).map(
    (f) => FIELD_LABEL[f as StructuralField] ?? f,
  );
  const what = names.length ? `The ${listWords(names)}` : 'Its structure';
  const why =
    details?.reason === 'started'
      ? 'this schedule has already started'
      : details?.reason === 'has_overrides'
        ? 'some of its instances have been tuned or paid'
        : 'this schedule is already in use (it has started, or has tuned instances)';
  return `${capitalise(what)} cannot change in place: ${why}. Split it from a date instead — the schedule ends before that date and a new one carries the change from it on, leaving the past as it was.`;
}

/** The structure-lock details off a refusal, or null when it is some other refusal. */
export function structureLockOf(e: unknown): StructureLockDetails | null {
  if (!isApiError(e) || e.code !== 'SCHEDULE_STRUCTURE_LOCKED') return null;
  const d = e.details ?? {};
  return {
    fields: Array.isArray(d.fields) ? (d.fields as string[]) : [],
    reason: typeof d.reason === 'string' ? d.reason : '',
    split: typeof d.split === 'string' ? d.split : '',
  };
}

/* ---------- split / end conflicts ---------- */

/**
 * The three 409s a split or an end can answer (§6.8, §10.5 steps 3–5), as what the person
 * is asked:
 *  - `payments`: a refusal. Paid instances from the split date cannot be moved; unpay them
 *    or pick a later date. Nothing to resend.
 *  - `overrides`: a confirmation. Resend with `dropOverrides: true` to drop those tunes.
 *  - `adjustments`: a confirmation. Resend with `dropAdjustments: true` to drop those draft
 *    scenario adjustments.
 */
export type SplitConflict =
  | { kind: 'payments'; naturalDates: string[] }
  | { kind: 'overrides'; naturalDates: string[] }
  | { kind: 'adjustments'; adjustments: BlockingAdjustment[] };

export interface DropFlags {
  dropOverrides?: boolean;
  dropAdjustments?: boolean;
}

function dates(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : [];
}

export function splitConflictOf(e: unknown): SplitConflict | null {
  if (!isApiError(e) || e.status !== 409) return null;
  const d = e.details ?? {};
  if (e.code === 'SCHEDULE_HAS_PAYMENTS') return { kind: 'payments', naturalDates: dates(d.naturalDates) };
  if (e.code === 'SCHEDULE_HAS_OVERRIDES') return { kind: 'overrides', naturalDates: dates(d.naturalDates) };
  if (e.code === 'SCHEDULE_HAS_ADJUSTMENTS') {
    const list = Array.isArray(d.adjustments) ? (d.adjustments as BlockingAdjustment[]) : [];
    return { kind: 'adjustments', adjustments: list };
  }
  return null;
}

/**
 * The flags to resend with once the person confirms `conflict` — the ones already
 * confirmed are kept, so a second 409 after the first is answered never loses the first
 * answer. `null` for a refusal, which no flag answers.
 */
export function resendFlags(conflict: SplitConflict, flags: DropFlags): DropFlags | null {
  if (conflict.kind === 'overrides') return { ...flags, dropOverrides: true };
  if (conflict.kind === 'adjustments') return { ...flags, dropAdjustments: true };
  return null;
}

/** The confirm button's words for a conflict. */
export function conflictConfirmLabel(conflict: SplitConflict, action: 'split' | 'end'): string {
  if (conflict.kind === 'overrides') {
    const n = conflict.naturalDates.length;
    return `Drop ${n === 1 ? 'the tuned instance' : `${n} tuned instances`} and ${action}`;
  }
  if (conflict.kind === 'adjustments') {
    const n = conflict.adjustments.length;
    return `Drop ${n === 1 ? 'the scenario adjustment' : `${n} scenario adjustments`} and ${action}`;
  }
  return action === 'split' ? 'Split' : 'End it';
}

/* ---------- instances ---------- */

/**
 * What is left to pay on an instance: its effective amount less the override's paid cache
 * (§3.4). Instances carry no `remainingAmount` of their own, so it is the one subtraction
 * made here — in bigint minor units.
 */
export function instanceRemaining(i: Instance): string {
  const amount = parseMinor(i.amount) ?? 0n;
  const paid = parseMinor(i.override?.paidAmount ?? null) ?? 0n;
  const left = amount - paid;
  return formatMinor(left < 0n ? 0n : left);
}

/** Payment state as the server sent it: payment rows, or a paid / part-paid status. */
export function hasPaymentState(i: Instance): boolean {
  return i.payments.length > 0 || i.status === 'paid' || i.status === 'part_paid';
}
