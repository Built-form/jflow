/**
 * The item (and schedule) form's checks: the API's own grammar (CONTRACT §6.7, §6.8, D1,
 * D2, D14), said before the click. The server still decides.
 *
 * The amount is typed as text and parsed to bigint minor units by `parseMoneyInput`, then
 * sent as the DECIMAL string it round-trips to — never through a `number`.
 */

import type { Item, ItemCreate, ItemUpdate, SettleMode } from '../../api/items';
import type { Account, Category, Direction } from '../../api/types';
import { isValidDate } from '../../lib/dates';
import { parseMoneyInput } from '../../lib/money';
import { CURRENCY_CODE } from '../../lib/validation';
import type { FieldErrors } from '../../lib/validation';

const NAME_MAX = 255;

/** The fields items and schedules share: who, where, which way, how much, how settled. */
export interface CommonForm {
  accountId: string;
  direction: Direction | '';
  categoryId: string;
  name: string;
  counterparty: string;
  amount: string;
  currency: string;
  settleMode: SettleMode;
  notes: string;
}

export type CommonField = keyof CommonForm;

export interface CommonBody {
  accountId: number;
  categoryId: number;
  direction: Direction;
  name: string;
  counterparty: string | null;
  amount: string;
  currency: string;
  settleMode: SettleMode;
  notes: string | null;
}

export const SETTLE_MODE_HELP: Record<SettleMode, string> = {
  auto: 'Assumed to have happened on its date once a later bank balance is recorded. Most direct debits and salaries.',
  manual: 'Stays owed until someone marks it paid; shown as overdue once its date passes.',
};

function positiveId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Check the shared fields; `errors` collects every problem, keyed by field. */
export function checkCommon(
  form: CommonForm,
  ctx: { categories: Category[] },
  errors: FieldErrors<CommonField>,
): CommonBody {
  const accountId = positiveId(form.accountId);
  if (accountId === null) errors.accountId = 'Pick an account.';

  if (form.direction !== 'in' && form.direction !== 'out') errors.direction = 'Money in or money out?';

  const categoryId = positiveId(form.categoryId);
  const category = ctx.categories.find((c) => c.id === categoryId);
  if (categoryId === null) errors.categoryId = 'Pick a category.';
  else if (category && form.direction && category.direction !== form.direction) {
    // The API refuses a direction that differs from its category's (D14).
    errors.categoryId = `${category.name} is money ${category.direction}. Pick a money-${form.direction} category.`;
  }

  const name = form.name.trim();
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > NAME_MAX) errors.name = `At most ${NAME_MAX} characters.`;

  const counterparty = form.counterparty.trim();
  if (counterparty.length > NAME_MAX) errors.counterparty = `At most ${NAME_MAX} characters.`;

  const typed = parseMoneyInput(form.amount, { allowZero: false });
  let amount = '';
  if (typed.kind === 'blank') errors.amount = 'Enter the amount.';
  else if (typed.kind === 'error') errors.amount = typed.error;
  else amount = typed.decimal;

  const currency = form.currency.trim().toUpperCase();
  if (!CURRENCY_CODE.test(currency)) errors.currency = 'A three-letter code, like GBP or EUR.';

  if (form.settleMode !== 'auto' && form.settleMode !== 'manual') errors.settleMode = 'Automatic or by hand?';

  const notes = form.notes.trim();

  return {
    accountId: accountId ?? 0,
    categoryId: categoryId ?? 0,
    direction: (form.direction || 'out') as Direction,
    name,
    counterparty: counterparty || null,
    amount,
    currency,
    settleMode: form.settleMode,
    notes: notes || null,
  };
}

/* ---------- one-off items ---------- */

export interface ItemForm extends CommonForm {
  dueDate: string;
}

export type ItemField = keyof ItemForm;

export type ItemCheck =
  | { ok: true; body: ItemCreate; errors: FieldErrors<ItemField> }
  | { ok: false; body: null; errors: FieldErrors<ItemField> };

export function validateItem(form: ItemForm, ctx: { categories: Category[] }): ItemCheck {
  const errors: FieldErrors<ItemField> = {};
  const common = checkCommon(form, ctx, errors);
  const dueDate = form.dueDate.trim();
  if (!isValidDate(dueDate)) errors.dueDate = 'Pick the day it is due.';
  if (Object.keys(errors).length) return { ok: false, body: null, errors };

  const body: ItemCreate = {
    accountId: common.accountId,
    categoryId: common.categoryId,
    direction: common.direction,
    name: common.name,
    amount: common.amount,
    currency: common.currency,
    dueDate,
    settleMode: common.settleMode,
  };
  if (common.counterparty) body.counterparty = common.counterparty;
  if (common.notes) body.notes = common.notes;
  return { ok: true, body, errors };
}

/** A new item's form: the one account in view when there is one, today, automatic. */
export function blankItemForm(today: string, account: Account | null): ItemForm {
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
    dueDate: today,
  };
}

export function itemToForm(item: Item): ItemForm {
  return {
    accountId: String(item.accountId),
    direction: item.direction,
    categoryId: String(item.categoryId),
    name: item.name,
    counterparty: item.counterparty ?? '',
    amount: item.amount,
    currency: item.currency,
    settleMode: item.settleMode,
    notes: item.notes ?? '',
    dueDate: item.dueDate,
  };
}

/**
 * The PUT body for an edit: only what changed (an unchanged `amount` on a paid item must
 * never be what trips `ITEM_NOT_EDITABLE`). `direction` is not sent — it follows the
 * category (§6.7). A cleared counterparty or note is sent as null.
 */
export function itemChanges(item: Item, body: ItemCreate): ItemUpdate {
  const out: ItemUpdate = {};
  if (body.accountId !== item.accountId) out.accountId = body.accountId;
  if (body.categoryId !== item.categoryId) out.categoryId = body.categoryId;
  if (body.name !== item.name) out.name = body.name;
  if ((body.counterparty ?? null) !== (item.counterparty || null)) out.counterparty = body.counterparty ?? null;
  if (!sameDecimal(body.amount, item.amount)) out.amount = body.amount;
  if (body.currency !== item.currency) out.currency = body.currency;
  if (body.dueDate !== item.dueDate) out.dueDate = body.dueDate;
  if (body.settleMode !== undefined && body.settleMode !== item.settleMode) out.settleMode = body.settleMode;
  if ((body.notes ?? null) !== (item.notes || null)) out.notes = body.notes ?? null;
  return out;
}

/** `"1024"` and `"1024.00"` are the same amount; compared as minor units, not as numbers. */
export function sameDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = a == null ? null : parseMoneyInput(a, { allowNegative: true });
  const pb = b == null ? null : parseMoneyInput(b, { allowNegative: true });
  if (pa?.kind === 'ok' && pb?.kind === 'ok') return pa.minor === pb.minor;
  return (a ?? null) === (b ?? null);
}

/** A paid or part-paid item's amount and currency belong to pay/unpay (`ITEM_NOT_EDITABLE`). */
export function moneyLocked(item: Item | null): boolean {
  return !!item && (item.status === 'paid' || item.status === 'part_paid');
}
