/**
 * The "Add a one-off to this scenario" form's checks (2026-10-07, D39, D43): a hypothetical
 * one-off that exists only in the open draft until it is applied.
 *
 * The fields an item has (account, direction, category, name, counterparty, amount,
 * currency) are checked by the items form's own `checkCommon`, so the two say the same
 * thing; the date must be today or later (422 `ADJUSTMENT_DATE_IN_PAST`, whose "today" is
 * the server's `meta.today`) and the note at most 500 characters (§10.7a). The server
 * still decides — an inactive account or a deleted category is its 400.
 */

import type { AddAdjustmentWrite } from '../../api/scenarios';
import type { Account, Category, Direction } from '../../api/types';
import { isValidDate } from '../../lib/dates';
import type { FieldErrors } from '../../lib/validation';
import { checkCommon } from '../items/itemForm';
import type { CommonField } from '../items/itemForm';

const NOTE_MAX = 500;

export interface AddLineForm {
  accountId: string;
  direction: Direction | '';
  categoryId: string;
  name: string;
  counterparty: string;
  /** As typed; parsed to minor units by `parseMoneyInput`. */
  amount: string;
  /** Follows the account until someone types their own. */
  currency: string;
  date: string;
  note: string;
}

export type AddLineField = keyof AddLineForm;

export type AddLineCheck =
  | { ok: true; body: AddAdjustmentWrite; errors: FieldErrors<AddLineField> }
  | { ok: false; body: null; errors: FieldErrors<AddLineField> };

/** The form as it opens: the first account and its currency, money out, today. */
export function blankAddLineForm(today: string, account: Account | null): AddLineForm {
  return {
    accountId: account ? String(account.id) : '',
    direction: 'out',
    categoryId: '',
    name: '',
    counterparty: '',
    amount: '',
    currency: account?.currency ?? '',
    date: today,
    note: '',
  };
}

const SHARED: CommonField[] = ['accountId', 'direction', 'categoryId', 'name', 'counterparty', 'amount', 'currency'];

/** The body for `POST /scenarios/:id/adjustments`, or the problem with each field. */
export function checkAddLine(form: AddLineForm, ctx: { categories: Category[]; today: string }): AddLineCheck {
  const common: FieldErrors<CommonField> = {};
  const checked = checkCommon({ ...form, settleMode: 'auto', notes: '' }, { categories: ctx.categories }, common);
  const errors: FieldErrors<AddLineField> = {};
  for (const field of SHARED) {
    const error = common[field];
    if (error) errors[field as AddLineField] = error;
  }

  const date = form.date.trim();
  if (!isValidDate(date)) errors.date = 'Pick a date.';
  else if (date < ctx.today) errors.date = 'Today or later: a scenario cannot add a one-off in the past.';

  const note = form.note.trim();
  if (note.length > NOTE_MAX) errors.note = `At most ${NOTE_MAX} characters.`;

  if (Object.keys(errors).length) return { ok: false, body: null, errors };

  const body: AddAdjustmentWrite = {
    kind: 'add',
    accountId: checked.accountId,
    categoryId: checked.categoryId,
    direction: checked.direction,
    name: checked.name,
    newDate: date,
    newAmount: checked.amount,
    currency: checked.currency,
  };
  if (checked.counterparty) body.counterparty = checked.counterparty;
  if (note) body.note = note;
  return { ok: true, body, errors };
}
