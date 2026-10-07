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
 *
 * A `new` line (2026-10-07, D39) is a scenario's own hypothetical one-off — an `add`
 * adjustment, keyed `new.<id>`. It has no baseline, so an edit of it is the add written again
 * IN FULL (`PUT …/adjustments/new.<id>` is a full replace, §10.7a): its own account,
 * category, direction, name, counterparty and currency from the line, the edited date and
 * amount, and the note it already carries — read from the scenario, because the forecast
 * line does not carry it and an omitted note would be cleared.
 *
 * Which line is a split's anchor or part (D40) is the server's `splitGroup` and `split`
 * flag; this file only names the buttons for it.
 */

import type { ForecastItem, LineDirection, LineEdit } from '../../api/forecast';
import type { AddAdjustmentWrite, AdjustmentWrite } from '../../api/scenarios';
import { addDays, isValidDate } from '../../lib/dates';
import { isNewKey, parseKey } from '../../lib/keys';
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
  | { kind: 'adjustment'; itemKey: string; body: AdjustmentWrite | AddAdjustmentWrite }
  /**
   * Every value is back to the baseline's: the adjustment itself goes. Also the undo
   * button's DELETE — which removes an add, and on a split's anchor, the whole split (D40).
   */
  | { kind: 'unadjust'; itemKey: string };

/**
 * What a `new` line's edit needs beyond the line: the row it sits in (its category and
 * direction, §6.10 `rows[]`) and the add's own note, read from `GET /scenarios/:id`.
 */
export interface NewLineContext {
  categoryId: number;
  direction: LineDirection;
  note: string | null;
}

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
 * real data); `today` is the server's (`meta.today`). `newLine` is needed only for a `new`
 * line, and only once its note has been read; until then nothing is sent for it.
 */
export function checkEdit(
  item: ForecastItem,
  form: EditForm,
  {
    scenario,
    today,
    newLine = null,
  }: { scenario: { id: number } | null; today: string; newLine?: NewLineContext | null },
): EditCheck {
  const errors: Partial<Record<Field, string>> = {};
  const parsed = parseKey(item.key);
  if (!parsed) {
    errors.form = `This line's key (${item.key}) is not one JFlow can edit.`;
    return { action: null, errors, unchanged: false };
  }

  const isNew = parsed.targetKind === 'new';
  if (isNew && !scenario) {
    errors.form = 'This one-off exists only inside its scenario. Open the scenario to change it.';
    return { action: null, errors, unchanged: false };
  }

  const wasExcluded = item.flags.includes('excluded');

  // Leaving a line out takes neither a date nor an amount (§6.11). A scenario's own
  // one-off has no real line to leave out: it is removed instead.
  if (scenario && form.exclude && !isNew) {
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

  if (isNew) {
    // An add's date is always sent (it is the one-off's own), so it is always checked.
    if (date < today) {
      errors.date = 'A scenario cannot move a line to before today.';
      return { action: null, errors, unchanged: false };
    }
    if (sameAsLine) return { action: null, errors, unchanged: true };
    if (!newLine) {
      errors.form = "This one-off's note has not been read from the scenario yet, so nothing can be saved.";
      return { action: null, errors, unchanged: false };
    }
    const body: AddAdjustmentWrite = {
      kind: 'add',
      accountId: item.accountId,
      categoryId: newLine.categoryId,
      direction: newLine.direction,
      name: item.name,
      currency: item.currency,
      newDate: date,
      newAmount: amount.decimal,
    };
    if (item.counterparty) body.counterparty = item.counterparty;
    if (newLine.note) body.note = newLine.note;
    return { action: { kind: 'adjustment', itemKey: item.key, body }, errors, unchanged: false };
  }

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

/* ---------- splits and the undo button (D40) ---------- */

/**
 * A split line's part in its group, from the server's `splitGroup`: the ANCHOR is the line
 * the split was made on (its key names a real line), a PART is a `new` line in the group.
 */
export function splitRole(item: ForecastItem): 'anchor' | 'part' | null {
  if (item.splitGroup == null) return null;
  return isNewKey(item.key) ? 'part' : 'anchor';
}

export interface UndoChoice {
  label: string;
  /** What else the click takes with it, when anything. */
  detail: string | null;
  action: EditAction;
}

/**
 * The dialog's undo button — always a DELETE of the line's adjustment, which the server
 * widens on a split's anchor to the whole group (§10.7b). Null when the line carries no
 * adjustment, or no scenario is open.
 */
export function undoChoice(item: ForecastItem, scenarioOpen: boolean): UndoChoice | null {
  if (!scenarioOpen) return null;
  const action: EditAction = { kind: 'unadjust', itemKey: item.key };
  const role = splitRole(item);
  if (role === 'part') return { label: 'Remove this part', detail: 'The line and the other parts stay as they are.', action };
  if (isNewKey(item.key)) return { label: 'Remove it from the scenario', detail: null, action };
  if (role === 'anchor') return { label: 'Undo the split', detail: 'Removes its parts too.', action };
  if (item.flags.includes('adjusted') || item.flags.includes('excluded')) return { label: 'Undo this adjustment', detail: null, action };
  return null;
}

/**
 * Whether the dialog offers "Split into parts…": a line the server marked `editable`, with
 * a scenario open, that names a real line (an add cannot be split, D43) and is not left out.
 */
export function canSplit(item: ForecastItem, scenarioOpen: boolean): boolean {
  return scenarioOpen && item.editable && !isNewKey(item.key) && !item.flags.includes('excluded');
}
