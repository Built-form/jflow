/**
 * The split dialog's model (2026-10-07, D40): one forecast line shared out over dated parts.
 *
 * Part 1 is the line itself, resized (and perhaps moved); every further part becomes a new
 * one-off in the scenario with the line's account and category. The server refuses parts
 * that do not add up to the line's real amount (422 `SPLIT_AMOUNTS_MISMATCH`), fewer than
 * two, an amount that is not above zero, and a date before today — so this says each of
 * those before the click.
 *
 * Money is bigint minor units throughout (`lib/money.ts`); dates are `YYYY-MM-DD` strings
 * with epoch-day arithmetic (`lib/dates.ts`). The amount to share out is the server's: the
 * line's BASELINE amount when it already carries an adjustment, else its own.
 */

import type { ForecastItem } from '../../api/forecast';
import type { SplitWrite } from '../../api/scenarios';
import { addDays, isValidDate } from '../../lib/dates';
import { formatMinor, formatMoney, parseMoneyInput, toMinor } from '../../lib/money';

export interface SplitPartForm {
  /** As picked: `YYYY-MM-DD`. */
  date: string;
  /** As typed; a DECIMAL string once valid. */
  amount: string;
}

export interface SplitForm {
  parts: SplitPartForm[];
}

/** The server's floor (§10.7b). */
export const MIN_PARTS = 2;
/** How far apart a new part starts from the one before it. */
export const PART_STEP_DAYS = 30;

/**
 * What the parts must add up to, in the line's own currency (minor units): the line's
 * amount in the real plan (`baseline`, the server's, sent with every scenario read). On a
 * line with no adjustment that IS its amount; on an adjusted line — a split's anchor
 * included — it is what the server sums the parts against (§10.7b), not the scenario's value.
 */
export function splitBase(item: ForecastItem): bigint {
  return toMinor(item.baseline ? item.baseline.amountMinor : item.amountMinor);
}

/** Whether the line's scenario value differs from the real plan's, so the dialog says which figure it shares out. */
export function splitsRealAmount(item: ForecastItem): boolean {
  return !!item.baseline && toMinor(item.baseline.amountMinor) !== toMinor(item.amountMinor);
}

/**
 * Two parts: part 1 on the line's real date (never before today), part 2 thirty days on;
 * the amount halved in minor units, the odd penny on part 1.
 */
export function initialSplit(item: ForecastItem, today: string): SplitForm {
  const base = splitBase(item);
  const second = base / 2n;
  const first = base - second;
  const real = item.baseline?.date ?? item.date;
  const start = isValidDate(real) && real >= today ? real : today;
  return {
    parts: [
      { date: start, amount: formatMinor(first) },
      { date: addDays(start, PART_STEP_DAYS), amount: formatMinor(second) },
    ],
  };
}

/** Change one part's date or amount. */
export function setPart(form: SplitForm, index: number, change: Partial<SplitPartForm>): SplitForm {
  return { parts: form.parts.map((p, i) => (i === index ? { ...p, ...change } : p)) };
}

/** "Add a part": thirty days after the last part (or after today, when the last date is not a date yet), at zero. */
export function addPart(form: SplitForm, today: string): SplitForm {
  const last = form.parts[form.parts.length - 1]?.date;
  const from = last && isValidDate(last) ? last : today;
  return { parts: [...form.parts, { date: addDays(from, PART_STEP_DAYS), amount: formatMinor(0n) }] };
}

/** Remove a part — never below two (the same form back, untouched). */
export function removePart(form: SplitForm, index: number): SplitForm {
  if (form.parts.length <= MIN_PARTS) return form;
  return { parts: form.parts.filter((_, i) => i !== index) };
}

/** A part's amount as minor units, or 0n while it is not a valid amount yet. */
function partMinor(part: SplitPartForm): bigint {
  const parsed = parseMoneyInput(part.amount, { allowNegative: true });
  return parsed.kind === 'ok' ? parsed.minor : 0n;
}

/** The base less every part — what is still to be shared out (negative when over). */
export function leftToAllocate(form: SplitForm, base: bigint): bigint {
  let total = 0n;
  for (const part of form.parts) total += partMinor(part);
  return base - total;
}

export interface PartErrors {
  date?: string;
  amount?: string;
}

export interface SplitCheck {
  /** What to send, or null while anything is wrong. */
  body: SplitWrite | null;
  errors: { parts: PartErrors[]; form?: string };
  /** Base − Σ parts, in minor units. */
  left: bigint;
}

/** What "Split it" would send, or why it cannot yet. `today` is the server's (`meta.today`). */
export function checkSplit(
  form: SplitForm,
  { base, currency, today }: { base: bigint; currency: string; today: string },
): SplitCheck {
  const parts: PartErrors[] = [];
  const out: SplitWrite['parts'] = [];
  for (const part of form.parts) {
    const errors: PartErrors = {};
    const date = part.date.trim();
    if (!isValidDate(date)) errors.date = 'Pick a date.';
    else if (date < today) errors.date = 'Today or later.';
    const amount = parseMoneyInput(part.amount, { allowNegative: false, allowZero: false });
    if (amount.kind === 'blank') errors.amount = 'Enter an amount.';
    else if (amount.kind === 'error') errors.amount = amount.error;
    parts.push(errors);
    if (amount.kind === 'ok') out.push({ newDate: date, newAmount: amount.decimal });
  }

  const left = leftToAllocate(form, base);
  const errors: SplitCheck['errors'] = { parts };
  if (form.parts.length < MIN_PARTS) errors.form = 'A split needs at least two parts.';
  else if (left !== 0n) errors.form = `The parts must add up to ${formatMoney(base, currency)}.`;

  const ok = !errors.form && parts.every((p) => !p.date && !p.amount);
  return { body: ok ? { parts: out } : null, errors, left };
}
