/**
 * The Forecast edit dialog's checks and the one write it turns into.
 *
 * Opened only on a line the server marked `editable` (§6.10). Without a scenario it edits
 * real data — a one-off through `PUT /items/:id`, an instance through
 * `PUT /schedules/:id/instances/:naturalDate` — and the row behind the line is found by
 * parsing its key (`lib/keys.ts`), never by pattern-matching it here. With a scenario open
 * it writes an ADJUSTMENT instead (`PUT /scenarios/:id/adjustments/:itemKey`).
 *
 * The checks say before the click what the server would refuse: an amount must be a
 * DECIMAL above zero (§2.6), a date must be a real date, and an adjustment's new date may
 * not be before today (422 `ADJUSTMENT_DATE_IN_PAST`, whose "today" is `meta.today`).
 */

import type { ForecastItem, LineEdit } from '../../api/forecast';
import type { AdjustmentWrite } from '../../api/scenarios';
import { addDays, isValidDate } from '../../lib/dates';
import { parseKey } from '../../lib/keys';
import { formatMinor, parseMoneyInput, toMinor } from '../../lib/money';

export interface EditForm {
  /** As typed; prefilled with the line's amount in its own currency. */
  amount: string;
  date: string;
  /** Scenario only: leave the line out of the scenario (`kind: 'exclude'`). */
  exclude: boolean;
}

export type EditAction =
  | { kind: 'item'; itemId: string; body: LineEdit }
  | { kind: 'instance'; scheduleId: string; naturalDate: string; body: LineEdit }
  | { kind: 'adjustment'; itemKey: string; body: AdjustmentWrite }
  /** Every value is back to the baseline's: the adjustment itself goes. */
  | { kind: 'unadjust'; itemKey: string };

type Field = 'amount' | 'date' | 'form';

export interface EditCheck {
  action: EditAction | null;
  errors: Partial<Record<Field, string>>;
  /** Valid, but nothing differs from what the line shows now. */
  unchanged: boolean;
}

/** The +7 / +14 / +30 buttons. */
export const QUICK_SHIFTS = [7, 14, 30] as const;

/**
 * Where a +N button lands: N days after the line's date — or after today when the line's
 * date has passed, so "+7" on an overdue line means a week from now, not a date that is
 * already behind us. Pure `lib/dates` epoch-day arithmetic.
 */
export function shiftedDate(lineDate: string, days: number, today: string): string {
  const base = isValidDate(lineDate) && lineDate > today ? lineDate : today;
  return addDays(base, days);
}

/** The form as the dialog opens: the line's own values. */
export function initialForm(item: ForecastItem): EditForm {
  return {
    amount: formatMinor(toMinor(item.amountMinor)),
    date: item.date,
    exclude: item.flags.includes('excluded'),
  };
}

/**
 * What saving would send, or why it cannot. `scenario` is the open scenario (null for
 * real data); `today` is the server's (`meta.today`).
 */
export function checkEdit(
  item: ForecastItem,
  form: EditForm,
  { scenario, today }: { scenario: { id: number } | null; today: string },
): EditCheck {
  const errors: Partial<Record<Field, string>> = {};
  const parsed = parseKey(item.key);
  if (!parsed) {
    errors.form = `This line's key (${item.key}) is not one JFlow can edit.`;
    return { action: null, errors, unchanged: false };
  }

  const wasExcluded = item.flags.includes('excluded');

  // Leaving a line out takes neither a date nor an amount (§6.11).
  if (scenario && form.exclude) {
    if (wasExcluded) return { action: null, errors, unchanged: true };
    return { action: { kind: 'adjustment', itemKey: item.key, body: { kind: 'exclude' } }, errors, unchanged: false };
  }

  const amount = parseMoneyInput(form.amount, { allowNegative: false, allowZero: false });
  if (amount.kind === 'blank') errors.amount = 'Enter an amount.';
  else if (amount.kind === 'error') errors.amount = amount.error;

  const date = form.date.trim();
  if (!isValidDate(date)) errors.date = 'Pick a date.';

  if (Object.keys(errors).length || amount.kind !== 'ok') return { action: null, errors, unchanged: false };

  const lineMinor = toMinor(item.amountMinor);
  const sameAsLine = amount.minor === lineMinor && date === item.date && !wasExcluded;

  if (!scenario) {
    if (parsed.targetKind === 'ship') {
      errors.form = 'Shipping payments are not edited here.';
      return { action: null, errors, unchanged: false };
    }
    if (sameAsLine) return { action: null, errors, unchanged: true };
    const body: LineEdit = {};
    if (amount.minor !== lineMinor) body.amount = amount.decimal;
    if (date !== item.date) body.dueDate = date;
    const action: EditAction =
      parsed.targetKind === 'item'
        ? { kind: 'item', itemId: parsed.targetId, body }
        : { kind: 'instance', scheduleId: parsed.targetId, naturalDate: parsed.targetDate as string, body };
    return { action, errors, unchanged: false };
  }

  // A scenario adjustment describes the line against its BASELINE values, so the whole
  // adjustment is sent each time — never a half that leans on what was stored before.
  const baseDate = item.baseline?.date ?? item.date;
  const baseMinor = item.baseline ? toMinor(item.baseline.amountMinor) : lineMinor;
  const newDate = date !== baseDate ? date : undefined;
  const newAmount = amount.minor !== baseMinor ? amount.decimal : undefined;

  if (newDate !== undefined && newDate < today) {
    errors.date = 'A scenario cannot move a line to before today.';
    return { action: null, errors, unchanged: false };
  }
  if (sameAsLine) return { action: null, errors, unchanged: true };

  if (newDate === undefined && newAmount === undefined) {
    // Back to the baseline: the adjustment has nothing left to say.
    return { action: { kind: 'unadjust', itemKey: item.key }, errors, unchanged: false };
  }
  const body: AdjustmentWrite = { kind: 'adjust' };
  if (newDate !== undefined) body.newDate = newDate;
  if (newAmount !== undefined) body.newAmount = newAmount;
  return { action: { kind: 'adjustment', itemKey: item.key, body }, errors, unchanged: false };
}
