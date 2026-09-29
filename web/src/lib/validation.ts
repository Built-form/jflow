/**
 * The Settings dialogs' form checks: the API's own grammar (CONTRACT §6.2–6.5), said
 * before the click so a refusal is visible while the form is still open. The server still
 * decides — a code already taken, a category in use, a rate that collides are its answers
 * (409s), and the dialog shows them as they come.
 *
 * Each `validate*` takes the form as typed (strings) and returns either the body to send
 * or the message for each field that is wrong. `changedOnly` trims an update to the
 * fields that actually changed: sending an unchanged `currency` or `direction` must never
 * be what trips an in-use guard.
 */

import type { AccountCreate, CategoryCreate, CompanyInput, Direction, FxRateCreate } from '../api/types';
import { isValidDate } from './dates';
import { formatRateMicro, parseRateMicro } from './money';

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type Checked<T, K extends string> =
  | { ok: true; body: T; errors: FieldErrors<K> }
  | { ok: false; body: null; errors: FieldErrors<K> };

function done<T, K extends string>(body: T, errors: FieldErrors<K>): Checked<T, K> {
  return Object.keys(errors).length ? { ok: false, body: null, errors } : { ok: true, body, errors };
}

const NAME_MAX = 255;
const NOTE_MAX = 500;
export const COMPANY_CODE = /^[A-Z0-9_]{1,16}$/;
export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** A blank sort order is "not set" (the server defaults it to 0); anything else must be a whole number. */
function sortOrderOf(raw: string, errors: FieldErrors<'sortOrder'>): number | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  if (!/^-?\d{1,9}$/.test(text)) {
    errors.sortOrder = 'A whole number, or leave it blank.';
    return undefined;
  }
  return Number(text);
}

function nameOf(raw: string, errors: FieldErrors<'name'>): string {
  const name = raw.trim();
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > NAME_MAX) errors.name = `At most ${NAME_MAX} characters.`;
  return name;
}

/* ---------- companies ---------- */

export interface CompanyForm {
  code: string;
  name: string;
  sortOrder: string;
}

type CompanyField = 'code' | 'name' | 'sortOrder';

/** Code is trimmed and upper-cased, as the server stores it (§6.2). */
export function validateCompany(form: CompanyForm): Checked<CompanyInput, CompanyField> {
  const errors: FieldErrors<CompanyField> = {};
  const code = form.code.trim().toUpperCase();
  if (!code) errors.code = 'Give it a short code, like JFA.';
  else if (!COMPANY_CODE.test(code)) errors.code = 'Letters, digits and _ only, at most 16.';
  const name = nameOf(form.name, errors);
  const sortOrder = sortOrderOf(form.sortOrder, errors);
  return done(sortOrder === undefined ? { code, name } : { code, name, sortOrder }, errors);
}

/* ---------- accounts ---------- */

export interface AccountForm {
  companyId: string;
  name: string;
  currency: string;
  sortOrder: string;
  isActive: boolean;
  isDefault: boolean;
}

type AccountField = 'companyId' | 'name' | 'currency' | 'sortOrder';

export function validateAccount(form: AccountForm): Checked<AccountCreate, AccountField> {
  const errors: FieldErrors<AccountField> = {};
  const companyId = Number(form.companyId);
  if (!form.companyId || !Number.isSafeInteger(companyId) || companyId <= 0) errors.companyId = 'Pick a company.';
  const name = nameOf(form.name, errors);
  const currency = form.currency.trim().toUpperCase();
  if (!CURRENCY_CODE.test(currency)) errors.currency = 'A three-letter code, like GBP or EUR.';
  const sortOrder = sortOrderOf(form.sortOrder, errors);
  const body: AccountCreate = { companyId, name, currency, isActive: form.isActive, isDefault: form.isDefault };
  if (sortOrder !== undefined) body.sortOrder = sortOrder;
  return done(body, errors);
}

/* ---------- categories ---------- */

export interface CategoryForm {
  name: string;
  direction: Direction | '';
  sortOrder: string;
}

type CategoryField = 'name' | 'direction' | 'sortOrder';

export function validateCategory(form: CategoryForm): Checked<CategoryCreate, CategoryField> {
  const errors: FieldErrors<CategoryField> = {};
  const name = nameOf(form.name, errors);
  if (form.direction !== 'in' && form.direction !== 'out') errors.direction = 'Money in or money out?';
  const sortOrder = sortOrderOf(form.sortOrder, errors);
  const body: CategoryCreate = { name, direction: form.direction as Direction };
  if (sortOrder !== undefined) body.sortOrder = sortOrder;
  return done(body, errors);
}

/* ---------- FX rates ---------- */

export interface FxRateForm {
  currency: string;
  rateToGbp: string;
  effectiveFrom: string;
  note: string;
}

type FxField = 'currency' | 'rateToGbp' | 'effectiveFrom' | 'note';

/**
 * GBP is the base currency: always exactly 1 and never stored, so it cannot be entered
 * (CONTRACT D3 — the API answers 400 to it too). The rate is "1 unit of this currency is
 * worth this many pounds", up to six decimals, above zero.
 */
export function validateFxRate(form: FxRateForm): Checked<FxRateCreate, FxField> {
  const errors: FieldErrors<FxField> = {};
  const currency = form.currency.trim().toUpperCase();
  if (!CURRENCY_CODE.test(currency)) errors.currency = 'A three-letter code, like EUR.';
  else if (currency === 'GBP') errors.currency = 'GBP is the base currency — always 1, never entered.';
  const micro = parseRateMicro(form.rateToGbp);
  if (micro === null) errors.rateToGbp = 'A rate like 0.853210 — up to six decimal places.';
  else if (micro === 0n) errors.rateToGbp = 'Must be more than zero.';
  // Six decimals, as the column stores it — so "1.17" and "1.170000" compare equal on edit.
  const rateToGbp = micro === null ? form.rateToGbp.trim() : formatRateMicro(micro);
  const effectiveFrom = form.effectiveFrom.trim();
  if (!isValidDate(effectiveFrom)) errors.effectiveFrom = 'Pick the day it applies from.';
  const note = form.note.trim();
  if (note.length > NOTE_MAX) errors.note = `At most ${NOTE_MAX} characters.`;
  const body: FxRateCreate = { currency, rateToGbp, effectiveFrom };
  if (note) body.note = note;
  return done(body, errors);
}

/* ---------- updates ---------- */

/**
 * The fields of `next` whose value differs from `before` — the PUT body for an edit.
 * `immutable` fields are never sent (an account's company, a rate's currency).
 */
export function changedOnly<T extends object>(
  before: Partial<Record<keyof T, unknown>>,
  next: T,
  immutable: (keyof T)[] = [],
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (immutable.includes(key)) continue;
    const value = next[key];
    const old = before[key];
    // The server treats null and "" alike for optional text; so does this.
    const same = value === old || ((value === '' || value == null) && (old === '' || old == null));
    if (!same) out[key] = value;
  }
  return out;
}
