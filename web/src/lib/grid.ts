/**
 * The Forecast grid's bucketing and display helpers.
 *
 * The server decides everything that is a rule: which bucket a line falls in
 * (`bucketIndex`), every total, every flag and whether a line may be edited (CONTRACT
 * §6.10, §9.12). This file only arranges what it was sent — lines into rows and cells,
 * labels for bucket columns, words for flags — and says which figures are below zero.
 *
 * `/forecast` money arrives as integer minor units; it becomes `bigint` through
 * `toMinor` before any comparison, and nothing here adds two amounts.
 */

import type { BucketKind, ForecastBucket, ForecastItem, ItemFlag } from '../api/forecast';
import type { Tone } from './tone';
import { addDays, dayOfWeek, diffDays, isValidDate } from './dates';
import { formatMoney, toMinor } from './money';

export const BUCKET_OPTIONS: { id: BucketKind; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

/** `?bucket=` as a bucket kind; `week` for anything else — the server's own default (D7). */
export function parseBucket(raw: string | null | undefined): BucketKind {
  return raw === 'day' || raw === 'month' ? raw : 'week';
}

/** The forecast window lengths the screen offers, in days after today. 90 is D7's default. */
export const WINDOW_OPTIONS = [30, 90, 180, 365] as const;
export type WindowDays = (typeof WINDOW_OPTIONS)[number];

export function parseWindowDays(raw: string | null | undefined): WindowDays {
  const n = Number(raw);
  return (WINDOW_OPTIONS as readonly number[]).includes(n) ? (n as WindowDays) : 90;
}

/* ---------- bucket columns ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dayNum = (ymd: string) => Number(ymd.slice(8, 10));
const monthName = (ymd: string) => MONTHS[Number(ymd.slice(5, 7)) - 1];

/** `29 Sep`. */
export function shortDay(ymd: string): string {
  if (!isValidDate(ymd)) return '—';
  return `${dayNum(ymd)} ${monthName(ymd)}`;
}

function lastOfMonth(ymd: string): string {
  const firstOfNext =
    ymd.slice(5, 7) === '12'
      ? `${Number(ymd.slice(0, 4)) + 1}-01-01`
      : `${ymd.slice(0, 4)}-${String(Number(ymd.slice(5, 7)) + 1).padStart(2, '0')}-01`;
  return addDays(firstOfNext, -1);
}

/**
 * Whether a bucket is cut short by the window (D6: the first and last are clipped to
 * `[today, to]`). A clipped column says its real dates, so a four-day "week" is never
 * read as a whole one.
 */
export function isClipped(bucket: Pick<ForecastBucket, 'start' | 'end'>, kind: BucketKind): boolean {
  if (kind === 'day') return false;
  if (kind === 'week') return !(dayOfWeek(bucket.start) === 0 && diffDays(bucket.end, bucket.start) === 6);
  return !(dayNum(bucket.start) === 1 && bucket.end === lastOfMonth(bucket.start));
}

/**
 * A column heading: `Tue 29 Sep` (day), `w/c 5 Oct` (a whole week), `Oct 2026` (a whole
 * month); a clipped bucket names its span instead — `29 Sep–4 Oct`, `29–30 Sep`.
 */
export function bucketLabel(bucket: Pick<ForecastBucket, 'start' | 'end'>, kind: BucketKind): string {
  const { start, end } = bucket;
  if (kind === 'day') return `${WEEKDAYS[dayOfWeek(start)]} ${shortDay(start)}`;
  if (!isClipped(bucket, kind)) {
    return kind === 'week' ? `w/c ${shortDay(start)}` : `${monthName(start)} ${start.slice(0, 4)}`;
  }
  if (start === end) return shortDay(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${dayNum(start)}–${dayNum(end)} ${monthName(start)}`;
  return `${shortDay(start)}–${shortDay(end)}`;
}

/**
 * The bucket holding `date`, by the buckets' own `start`/`end` (strings compare as dates);
 * -1 when none does. Used to mark where the window's lowest day falls — never to place a
 * line, which carries the server's `bucketIndex`.
 */
export function bucketIndexOf(date: string, buckets: Pick<ForecastBucket, 'start' | 'end'>[]): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid];
    if (date < b.start) hi = mid - 1;
    else if (date > b.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/* ---------- lines into rows and cells ---------- */

/**
 * Every line of one key, laid out across the buckets. One key can own several lines — a
 * line per payment in the window plus the remainder (§6.10) — and each is kept as its
 * own entry in its cell: they are shown, and edited, one by one; nothing here sums them.
 */
export interface LineGroup {
  key: string;
  name: string;
  counterparty: string | null;
  kind: ForecastItem['kind'];
  currency: string;
  lines: ForecastItem[];
  /** `cells[i]` = the lines with `bucketIndex === i`, in the server's order. */
  cells: ForecastItem[][];
}

export function groupLines(items: ForecastItem[], bucketCount: number): LineGroup[] {
  const groups = new Map<string, LineGroup>();
  for (const item of items) {
    let group = groups.get(item.key);
    if (!group) {
      group = {
        key: item.key,
        name: item.name,
        counterparty: item.counterparty,
        kind: item.kind,
        currency: item.currency,
        lines: [],
        cells: Array.from({ length: Math.max(bucketCount, 0) }, () => []),
      };
      groups.set(item.key, group);
    }
    group.lines.push(item);
    if (item.bucketIndex >= 0 && item.bucketIndex < bucketCount) group.cells[item.bucketIndex].push(item);
  }
  return [...groups.values()];
}

/**
 * A stable React key for one LINE. `key` alone is not unique — a paid line and the
 * remainder share it — so the payment id (or the remainder flag) and the position join it.
 */
export function lineId(item: ForecastItem, index: number): string {
  const part = item.paymentId !== undefined ? `p${item.paymentId}` : item.flags.includes('remainder') ? 'rem' : 'line';
  return `${item.key}:${part}:${index}`;
}

/* ---------- flags as words ---------- */

export interface FlagTag {
  flag: string;
  label: string;
  tone: Tone;
}

/** Words for §6.10's flags. The flags are the server's; this only names and colours them. */
export const FLAG_LABEL: Record<string, { label: string; tone: Tone }> = {
  overdue: { label: 'OVERDUE', tone: 'warn' },
  // Absorbed lines only (accounts[].absorbed): an auto line the server assumed went through
  // between the recorded balance and today.
  assumed: { label: 'ASSUMED', tone: 'waived' },
  paid: { label: 'PAID', tone: 'done' },
  remainder: { label: 'REMAINDER', tone: 'warn' },
  tuned: { label: 'TUNED', tone: 'idle' },
  adjusted: { label: 'ADJUSTED', tone: 'live' },
  excluded: { label: 'LEFT OUT', tone: 'idle' },
  stale: { label: 'STALE', tone: 'fail' },
  fromScenario: { label: 'FROM SCENARIO', tone: 'idle' },
  // Phase 2 ship lines' feed flags (§6.10). None of them changes a band; they say how firm
  // shipping's figures are, and whether JFlow has planned over them (lib/ship.ts explains each).
  estimated: { label: 'ESTIMATED', tone: 'idle' },
  projected: { label: 'PROJECTED', tone: 'idle' },
  blocked: { label: 'BLOCKED', tone: 'warn' },
  planned: { label: 'PLANNED', tone: 'live' },
};

/**
 * The tags a line wears. `paid` with `partial` reads PART PAID (that payment belongs to a
 * part-paid parent); every other flag is its own tag, and an unknown one still shows.
 */
export function flagTags(flags: ItemFlag[]): FlagTag[] {
  const out: FlagTag[] = [];
  const partial = flags.includes('partial');
  for (const flag of flags) {
    if (flag === 'partial') continue;
    if (flag === 'paid' && partial) {
      out.push({ flag: 'paid', label: 'PART PAID', tone: 'done' });
      continue;
    }
    const known = FLAG_LABEL[flag];
    out.push({ flag, label: known?.label ?? flag.toUpperCase(), tone: known?.tone ?? 'idle' });
  }
  if (partial && !flags.includes('paid')) out.push({ flag: 'partial', label: 'PARTIAL', tone: 'idle' });
  return out;
}

/* ---------- money in cells ---------- */

export function isNegative(value: number | bigint): boolean {
  return toMinor(value) < 0n;
}

/**
 * How a balance cell is flagged: `negative` when its figure is below zero; for a
 * closing, `dips` when it ends at or above zero but a day inside the bucket closes below
 * it (`minClosing`, the server's lowest daily closing). Null when neither.
 */
export type BalanceFlag = 'negative' | 'dips' | null;

export function balanceFlag(value: number | bigint, minClosing?: number | bigint): BalanceFlag {
  if (isNegative(value)) return 'negative';
  if (minClosing !== undefined && isNegative(minClosing)) return 'dips';
  return null;
}

/** A GBP figure for a grid cell; blank for a zero movement so the grid reads at a glance. */
export function cellMoney(value: number | bigint, { blankZero = false } = {}): string {
  const minor = toMinor(value);
  if (blankZero && minor === 0n) return '';
  return formatMoney(minor, 'GBP');
}

/** A signed difference: `+£120.00`, `-£40.00`, `£0.00`. */
export function signedMoney(value: number | bigint, currency = 'GBP'): string {
  const minor = toMinor(value);
  return minor > 0n ? `+${formatMoney(minor, currency)}` : formatMoney(minor, currency);
}

/**
 * An axis label: `£0`, `£950`, `£12.5k`, `-£1.2m` — one decimal, cut (not rounded) on the
 * bigint, so a label never claims more than the figure.
 */
export function compactMoney(value: number | bigint, currency = 'GBP'): string {
  const minor = toMinor(value);
  const negative = minor < 0n;
  const pounds = (negative ? -minor : minor) / 100n;
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '';
  const scaled = (unit: bigint, suffix: string) => {
    const whole = pounds / unit;
    const tenth = (pounds % unit) / (unit / 10n);
    return `${whole}${tenth > 0n && whole < 100n ? `.${tenth}` : ''}${suffix}`;
  };
  const body =
    pounds >= 1_000_000n ? scaled(1_000_000n, 'm') : pounds >= 1_000n ? scaled(1_000n, 'k') : String(pounds);
  const text = symbol ? `${symbol}${body}` : `${body} ${currency}`;
  return negative ? `-${text}` : text;
}
