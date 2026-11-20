/**
 * Moving every payment of one container inside the open scenario (Dev, 2026-11-20): the
 * dialog's checks and the writes it turns into.
 *
 * There is no bulk route, and none is added: a move is ONE ordinary adjustment per payment
 * (`PUT /scenarios/:id/adjustments/:itemKey`), exactly what the line's own edit dialog would
 * send for that date. So each payment goes through `checkEdit` (`edit.ts`) — the amount the
 * scenario already gave it is kept, and a payment that lands back on the real plan's date
 * loses its adjustment instead.
 *
 * Two ways to move (Dev chose both): SHIFT each payment by a number of days, so they keep
 * their gaps (a minus number moves them earlier; an overdue payment counts from today, as
 * the +7 button does), or put them all on the SAME DATE.
 *
 * Which payments can move is the server's say: its `editable`, and its `excluded` flag (a
 * payment the scenario leaves out stays out — moving it would put it back in). The writes go
 * one after another and are not one transaction: `runMoves` reports what moved, what was
 * refused and what was never sent.
 */

import { ApiError } from '../../api/client';
import type { ForecastItem } from '../../api/forecast';
import { isValidDate } from '../../lib/dates';
import { formatMinor, toMinor } from '../../lib/money';
import type { EditAction } from './edit';
import { checkEdit, shiftedDate } from './edit';

export type MoveMode = 'shift' | 'date';

export interface MoveForm {
  mode: MoveMode;
  /** Shift: as typed — a whole number of days, minus for earlier. */
  days: string;
  /** Same date: as picked, `YYYY-MM-DD`. */
  date: string;
  /** The keys of the payments unticked: left where they are. */
  skip: string[];
}

/** Two years either way: further than any window shows, and short of a typing slip. */
export const MAX_SHIFT_DAYS = 730;

export function initialMove(): MoveForm {
  return { mode: 'shift', days: '7', date: '', skip: [] };
}

/** One payment of the container, and why it cannot be moved at all (null when it can). */
export interface MovePayment {
  key: string;
  item: ForecastItem;
  fixed: string | null;
}

function fixedReason(item: ForecastItem): string | null {
  if (item.flags.includes('excluded')) return 'Left out of this scenario';
  if (!item.editable) return item.flags.includes('paid') ? 'Paid' : 'Cannot be changed';
  return null;
}

/**
 * A container's payments, one per key, in date order (the grid's order within a date). When
 * one key owns several lines, the one the server lets through an edit stands for it.
 */
export function movePayments(lines: readonly ForecastItem[]): MovePayment[] {
  const byKey = new Map<string, ForecastItem>();
  for (const item of lines) {
    const held = byKey.get(item.key);
    if (!held || (!held.editable && item.editable)) byKey.set(item.key, item);
  }
  return [...byKey.values()]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : a.i - b.i))
    .map(({ item }) => ({ key: item.key, item, fixed: fixedReason(item) }));
}

/** The writes a move is made of: an adjustment, or its removal. */
export type MoveAction = Extract<EditAction, { itemKey: string }>;

export interface MoveStep {
  key: string;
  name: string;
  action: MoveAction;
}

export interface MoveRow extends MovePayment {
  /** In the move: it can move and has not been unticked. */
  ticked: boolean;
  /** Where the move would put it; null while the form does not say, or it cannot move. */
  to: string | null;
  /** Ticked and already on that date: nothing is sent for it. */
  same: boolean;
  /** Ticked, and this move cannot be made for it: why. */
  error: string | null;
}

export interface MoveCheck {
  rows: MoveRow[];
  /** What to send, in order; null while anything is wrong or nothing would move. */
  steps: MoveStep[] | null;
  errors: { days?: string; date?: string; form?: string };
}

function parseDays(raw: string): { days: number } | { error: string } {
  const text = raw.trim().replace('−', '-');
  if (text === '') return { error: 'Enter a number of days.' };
  if (!/^[+-]?\d+$/.test(text)) return { error: 'Enter a whole number of days, like 14 or -7.' };
  const days = Number(text);
  if (days === 0) return { error: 'Enter a number of days other than 0.' };
  if (Math.abs(days) > MAX_SHIFT_DAYS) return { error: `At most ${MAX_SHIFT_DAYS} days either way.` };
  return { days };
}

/**
 * What "Move" would send, or why it cannot yet. `today` is the server's (`meta.today`).
 * A payment's new date is worked out for every one that can move, ticked or not, so the
 * dialog can show it; only the ticked ones are checked and sent.
 */
export function checkMove(
  payments: readonly MovePayment[],
  form: MoveForm,
  { scenario, today }: { scenario: { id: number }; today: string },
): MoveCheck {
  const errors: MoveCheck['errors'] = {};
  let target: ((item: ForecastItem) => string) | null = null;
  if (form.mode === 'shift') {
    const parsed = parseDays(form.days);
    if ('error' in parsed) errors.days = parsed.error;
    else target = (item) => shiftedDate(item.date, parsed.days, today);
  } else {
    const date = form.date.trim();
    if (!isValidDate(date)) errors.date = 'Pick a date.';
    else if (date < today) errors.date = 'Today or later.';
    else target = () => date;
  }

  const steps: MoveStep[] = [];
  const rows: MoveRow[] = payments.map((payment) => {
    const row: MoveRow = { ...payment, ticked: payment.fixed === null && !form.skip.includes(payment.key), to: null, same: false, error: null };
    if (payment.fixed !== null || target === null) return row;
    row.to = target(payment.item);
    if (!row.ticked) return row;
    // The line's own edit, with only its date changed.
    const { item } = payment;
    const check = checkEdit(item, { amount: formatMinor(toMinor(item.amountMinor)), date: row.to, exclude: false }, { scenario, today });
    const action = check.action;
    if (action && (action.kind === 'adjustment' || action.kind === 'unadjust')) steps.push({ key: item.key, name: item.name, action });
    else if (check.unchanged) row.same = true;
    else row.error = check.errors.date ?? check.errors.amount ?? check.errors.form ?? 'This payment cannot be moved.';
    return row;
  });

  if (target !== null) {
    const ticked = rows.filter((r) => r.ticked);
    if (rows.every((r) => r.fixed !== null)) errors.form = 'None of these payments can be moved.';
    else if (ticked.length === 0) errors.form = 'Tick at least one payment.';
    else if (ticked.some((r) => r.error !== null)) errors.form = 'A ticked payment cannot make this move. Untick it, or change the move.';
    else if (steps.length === 0) errors.form = 'Every ticked payment is already on that date.';
  }
  return { rows, steps: Object.keys(errors).length === 0 ? steps : null, errors };
}

/* ---------- sending ---------- */

export interface MoveOutcome {
  moved: MoveStep[];
  failed: { step: MoveStep; error: ApiError }[];
  /** Never sent: the run stopped at a refusal that was not about one payment. */
  unsent: MoveStep[];
}

/**
 * The adjustment write's refusals of ONE target (§10.7): it has been paid or skipped, it is
 * gone, or its new date has passed. The other payments can still move. Anything else — the
 * scenario is no longer a draft, the server cannot be reached — would refuse them all.
 */
const ABOUT_ONE_PAYMENT = new Set(['TARGET_SETTLED', 'TARGET_MISSING', 'ADJUSTMENT_DATE_IN_PAST']);

/**
 * Send the steps one after another, in order — never side by side: each write locks the
 * scenario's row. Not all or nothing: what went through stays, and the outcome says the rest.
 */
export async function runMoves(
  steps: readonly MoveStep[],
  send: (action: MoveAction) => Promise<void>,
  onProgress?: (sent: number) => void,
): Promise<MoveOutcome> {
  const out: MoveOutcome = { moved: [], failed: [], unsent: [] };
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    try {
      await send(step.action);
      out.moved.push(step);
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(0, { error: String(e) });
      out.failed.push({ step, error });
      if (!ABOUT_ONE_PAYMENT.has(error.code ?? '')) {
        out.unsent.push(...steps.slice(i + 1));
        return out;
      }
    }
    onProgress?.(i + 1);
  }
  return out;
}
