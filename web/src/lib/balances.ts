/**
 * Cash at bank: what a recorded balance means, and the few display rules the screen needs.
 *
 * A balance is the cash at bank at the START of its date, before that day's money in and
 * out — last night's closing figure, what the bank shows at 9am (PLAN "What a recorded
 * balance means", CONTRACT §6.6). Every entry screen calls it by one name, below.
 *
 * Nothing here is a forecast rule: which items a balance already contains, what is assumed
 * settled, how currencies convert — all of that is the server's (`/forecast`, step 9).
 * This file only validates what is typed, shapes what was recorded, and decides when a
 * combined line may be drawn at all.
 */

import type { Account, Balance, BalanceEntry, BulkBalances } from '../api/types';
import { formatDay, isValidDate, relativeDay } from './dates';
import { parseMinor, parseMoneyInput, sumMinor } from './money';

/** The label, exactly, on every place a balance is entered or shown (PLAN, CONTRACT §6.6). */
export const START_OF_DAY_LABEL = 'Cash at bank at start of day';

/** The one line under the label that says what the figure is — and is not. */
export const START_OF_DAY_MEANING =
  "Before that day's money in and out: last night's closing figure, what the bank shows first thing. " +
  'Anything dated on or after this day is not in it yet.';

/** The API's ceiling on one bulk save (CONTRACT §6.6). */
export const MAX_BULK_ENTRIES = 200;
export const MAX_NOTE_LENGTH = 500;

export interface StartOfDay {
  /** Always `START_OF_DAY_LABEL`. */
  label: string;
  /** `Tue 29 Sep 2026`, or `—` for a date that is not one. */
  day: string;
  /** `today` / `yesterday` when it is one of those, else null. */
  relative: 'today' | 'yesterday' | null;
  /** Why this date cannot take a balance; null when it can. */
  error: string | null;
}

/**
 * The heading for one entry date: the fixed label, the day it is for, and whether a
 * balance may be recorded on it at all. `balance_date <= today` is the API's own rule
 * (422 `BALANCE_DATE_IN_FUTURE`); saying so before the click saves a round trip, and the
 * server still decides.
 */
export function startOfDay(date: string, today: string): StartOfDay {
  if (!isValidDate(date)) {
    return { label: START_OF_DAY_LABEL, day: '—', relative: null, error: 'Pick a day.' };
  }
  const rel = relativeDay(date, today);
  const future = isValidDate(today) && date > today;
  return {
    label: START_OF_DAY_LABEL,
    day: formatDay(date),
    relative: rel === 'today' || rel === 'yesterday' ? rel : null,
    error: future
      ? 'A start-of-day balance can only be recorded for today or an earlier day — the bank has not shown it yet.'
      : null,
  };
}

/** `Tue 29 Sep 2026 (today)` — the day the entry is for, as one line. */
export function startOfDayLine(date: string, today: string): string {
  const s = startOfDay(date, today);
  return s.relative ? `${s.day} (${s.relative})` : s.day;
}

/* ---------- the combined GBP line ---------- */

/**
 * A combined line may be drawn only when every account in view is GBP (PLAN "Cash at
 * bank"). Adding a EUR balance to a GBP one needs a rate for that day, and a combined
 * history across currencies needs daily FX snapshots, which are deferred (CONTRACT §11).
 * No accounts in view, no line.
 */
export function combinedLineAllowed(accounts: Pick<Account, 'currency'>[]): boolean {
  return accounts.length > 0 && accounts.every((a) => a.currency.toUpperCase() === 'GBP');
}

export interface CombinedPoint {
  date: string;
  /** The GBP total in minor units — null unless every account in view recorded that day. */
  totalMinor: bigint | null;
  /** How many accounts in view recorded a balance on this date. */
  recorded: number;
  /** How many accounts are in view. */
  of: number;
}

/**
 * The combined history line: one point per date anyone in view recorded, newest first.
 *
 * Null when the line is not allowed. A date where some account has no recorded balance
 * gets no total — adding only the accounts that happened to record would draw a dip that
 * is really a missing entry, and carrying an older figure forward would be a number nobody
 * recorded. The point says how many of how many recorded instead.
 */
export function combinedHistory(
  accounts: Pick<Account, 'id' | 'currency'>[],
  balances: Pick<Balance, 'accountId' | 'balanceDate' | 'balance'>[],
): CombinedPoint[] | null {
  if (!combinedLineAllowed(accounts)) return null;
  const inView = new Set(accounts.map((a) => a.id));
  const byDate = new Map<string, Map<number, bigint>>();
  for (const b of balances) {
    if (!inView.has(b.accountId)) continue;
    const minor = parseMinor(b.balance);
    if (minor === null) continue;
    const day = byDate.get(b.balanceDate) ?? new Map<number, bigint>();
    day.set(b.accountId, minor);
    byDate.set(b.balanceDate, day);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, day]) => ({
      date,
      totalMinor: day.size === inView.size ? sumMinor(day.values()) : null,
      recorded: day.size,
      of: inView.size,
    }));
}

/* ---------- replace-from-response ---------- */

const byDateDescThenAccount = (a: Balance, b: Balance) =>
  a.balanceDate < b.balanceDate ? 1 : a.balanceDate > b.balanceDate ? -1 : a.accountId - b.accountId;

/**
 * Fold rows a mutation answered with into a list read earlier: a row for the same account
 * and date replaces the old one (a PUT may create or replace; the response is the same),
 * anything new joins, and the list keeps the server's order (date desc, then account).
 */
export function mergeBalances(list: Balance[], updated: Balance[]): Balance[] {
  const key = (b: Pick<Balance, 'accountId' | 'balanceDate'>) => `${b.accountId}|${b.balanceDate}`;
  const replacing = new Set(updated.map(key));
  return [...list.filter((b) => !replacing.has(key(b))), ...updated].sort(byDateDescThenAccount);
}

export function withoutBalance(list: Balance[], accountId: number, date: string): Balance[] {
  return list.filter((b) => !(b.accountId === accountId && b.balanceDate === date));
}

/** One account's recorded balances, newest first. */
export function historyFor(list: Balance[], accountId: number): Balance[] {
  return list.filter((b) => b.accountId === accountId).sort(byDateDescThenAccount);
}

/* ---------- the entry form ---------- */

export interface BalanceDraft {
  accountId: number;
  /** As typed. Blank means "not recording this account today", never "zero". */
  balance: string;
  note: string;
}

export interface BulkPlan {
  /** What to send, or null when there is nothing to send or something to fix first. */
  body: BulkBalances | null;
  dateError: string | null;
  /** By account id. */
  rowErrors: Record<number, string>;
  /** Filled rows that match what is already recorded, so are not sent again. */
  unchanged: number;
}

/**
 * Turns the entry table into one `POST /balances/bulk` (CONTRACT §6.6): a blank row is
 * skipped, a row equal to what is recorded is skipped, and anything else is validated as a
 * balance — which may be negative (an overdraft) or zero. Removing a recorded balance is a
 * separate, confirmed action, never a blanked box.
 */
export function planBulkBalances(
  date: string,
  today: string,
  drafts: BalanceDraft[],
  recorded: Map<number, Pick<Balance, 'balance' | 'note'>>,
): BulkPlan {
  const dateError = startOfDay(date, today).error;
  const rowErrors: Record<number, string> = {};
  const entries: BalanceEntry[] = [];
  let unchanged = 0;

  for (const draft of drafts) {
    const note = draft.note.trim();
    if (note.length > MAX_NOTE_LENGTH) {
      rowErrors[draft.accountId] = `The note is ${note.length} characters; at most ${MAX_NOTE_LENGTH}.`;
      continue;
    }
    const parsed = parseMoneyInput(draft.balance, { allowNegative: true });
    if (parsed.kind === 'blank') continue;
    if (parsed.kind === 'error') {
      rowErrors[draft.accountId] = parsed.error;
      continue;
    }
    const before = recorded.get(draft.accountId);
    if (before && parseMinor(before.balance) === parsed.minor && (before.note ?? '').trim() === note) {
      unchanged += 1;
      continue;
    }
    entries.push(note ? { accountId: draft.accountId, balance: parsed.decimal, note } : { accountId: draft.accountId, balance: parsed.decimal });
  }

  let tooMany: string | null = null;
  if (entries.length > MAX_BULK_ENTRIES) {
    tooMany = `At most ${MAX_BULK_ENTRIES} accounts in one save.`;
  }

  const blocked = dateError !== null || tooMany !== null || Object.keys(rowErrors).length > 0;
  return {
    body: blocked || entries.length === 0 ? null : { balanceDate: date, entries },
    dateError: dateError ?? tooMany,
    rowErrors,
    unchanged,
  };
}

export interface EntryTotal {
  /** The sum of what the rows hold, in minor units. */
  totalMinor: bigint;
  /** Rows with a figure. */
  filled: number;
  /** Rows in view. */
  of: number;
}

/**
 * The combined figure under an all-GBP entry table: the sum of what each row's box holds
 * (the screen seeds each box with the recorded figure, so an untouched row counts what is
 * recorded). Null when the line is not allowed or a row does not parse; `filled < of`
 * tells the screen the total is incomplete.
 */
export function entryTotal(
  accounts: Pick<Account, 'id' | 'currency'>[],
  drafts: BalanceDraft[],
): EntryTotal | null {
  if (!combinedLineAllowed(accounts)) return null;
  const byId = new Map(drafts.map((d) => [d.accountId, d]));
  const values: bigint[] = [];
  for (const account of accounts) {
    const draft = byId.get(account.id);
    if (!draft) continue;
    const parsed = parseMoneyInput(draft.balance, { allowNegative: true });
    if (parsed.kind === 'error') return null;
    if (parsed.kind === 'ok') values.push(parsed.minor);
  }
  return { totalMinor: sumMinor(values), filled: values.length, of: accounts.length };
}
