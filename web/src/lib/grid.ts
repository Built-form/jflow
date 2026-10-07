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

/**
 * The grid's columns as laid out, in CSS pixels: the sticky label column, each bucket's
 * column and the whole table. The grid measures them; the chart above draws on them.
 */
export interface GridColumns {
  label: number;
  /** `widths[i]` = bucket `i`'s column. */
  widths: number[];
  total: number;
}

/** Each bucket column's left edge, from the table's own left. */
export function columnLefts(columns: GridColumns): number[] {
  const out: number[] = [];
  let x = columns.label;
  for (const w of columns.widths) {
    out.push(x);
    x += w;
  }
  return out;
}

export function sameColumns(a: GridColumns | null, b: GridColumns | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.label === b.label &&
    a.total === b.total &&
    a.widths.length === b.widths.length &&
    a.widths.every((w, i) => w === b.widths[i])
  );
}

/* ---------- lines into rows and cells ---------- */

/**
 * One row of lines, laid out across the buckets: every line of one key, or of one schedule
 * (each instance has its own key). One key can own several lines — a line per payment in
 * the window plus the remainder (§6.10) — and each is kept as its own entry in its cell: they are shown, and edited, one by one; nothing here sums them.
 */
export interface LineGroup {
  /** The first line's key: the row's identity. */
  key: string;
  /** Every distinct key on the row — one, or one per instance of a schedule. */
  keys: string[];
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
    // A schedule is one row (Dev, 2026-10-07): its instances sit side by side in their own
    // buckets, as a spreadsheet would have them, not one row per date.
    const id = item.kind === 'sched' && item.scheduleId !== undefined ? `sched:${item.scheduleId}` : item.key;
    let group = groups.get(id);
    if (!group) {
      group = {
        key: item.key,
        keys: [],
        name: item.name,
        counterparty: item.counterparty,
        kind: item.kind,
        currency: item.currency,
        lines: [],
        cells: Array.from({ length: Math.max(bucketCount, 0) }, () => []),
      };
      groups.set(id, group);
    }
    if (!group.keys.includes(item.key)) group.keys.push(item.key);
    group.lines.push(item);
    if (item.bucketIndex >= 0 && item.bucketIndex < bucketCount) group.cells[item.bucketIndex].push(item);
  }
  return [...groups.values()];
}

/* ---------- stock payments by supplier + shipment ---------- */

/**
 * The Forecast shows stock payments the way ShipLine's Balances due does (Dev, 2026-10-06):
 * one line per supplier + shipment, expanding to the individual payments. A combo's cells
 * are the SUM of its lines' `gbpMinor` — the one place this file adds money up, and only for
 * display: every figure summed is the server's, and the lines underneath are the ones edited.
 */
export interface ShipCombo {
  /** `<supplier>|<container>`, lower-cased supplier and upper-cased container as ShipLine keys a payment; `-` when unknown. */
  key: string;
  supplier: string | null;
  containerRef: string | null;
  /** The ship LineGroups in it, in the server's order. */
  groups: LineGroup[];
  /** Every line of those groups. */
  lines: ForecastItem[];
  /** `cells[i]` = Σ gbpMinor of the lines with `bucketIndex === i`. */
  cells: number[];
  /** Σ gbpMinor of every line in the window. */
  total: number;
}

const comboPart = (s: string | null | undefined, fold: (v: string) => string): string => {
  const t = (s ?? '').trim();
  return t ? fold(t) : '-';
};

/** True for a category whose lines are all stock payments (the systemKey 'ship' category). */
export function isShipCategory(groups: readonly LineGroup[]): boolean {
  return groups.length > 0 && groups.every((g) => g.kind === 'ship');
}

export function groupShipCombos(groups: readonly LineGroup[], bucketCount: number): ShipCombo[] {
  const combos = new Map<string, ShipCombo>();
  for (const group of groups) {
    const supplier = group.counterparty ?? null;
    const containerRef = group.lines[0]?.ship?.containerRef ?? null;
    const key = `${comboPart(supplier, (v) => v.toLowerCase())}|${comboPart(containerRef, (v) => v.toUpperCase())}`;
    let combo = combos.get(key);
    if (!combo) {
      combo = {
        key,
        supplier,
        containerRef,
        groups: [],
        lines: [],
        cells: Array.from({ length: Math.max(bucketCount, 0) }, () => 0),
        total: 0,
      };
      combos.set(key, combo);
    }
    combo.groups.push(group);
    for (const line of group.lines) {
      combo.lines.push(line);
      // The server says which lines count nothing (left out by a scenario, or hidden).
      if (line.flags.includes('excluded') || line.flags.includes('hidden')) continue;
      if (line.bucketIndex >= 0 && line.bucketIndex < bucketCount) combo.cells[line.bucketIndex] += line.gbpMinor;
      combo.total += line.gbpMinor;
    }
  }
  return [...combos.values()];
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
  // Left out of this read with the grid's eye (§6.10 `hide`): shown, counts nothing.
  hidden: { label: 'HIDDEN', tone: 'idle' },
  // Phase 2 ship lines' feed flags (§6.10). None of them changes a band; they say how firm
  // shipping's figures are, and whether JFlow has planned over them (lib/ship.ts explains each).
  estimated: { label: 'ESTIMATED', tone: 'idle' },
  blocked: { label: 'BLOCKED', tone: 'warn' },
  planned: { label: 'PLANNED', tone: 'live' },
  // 2026-10-06: the feed's date was set by hand in ShipLine; the refresh moved the feed's
  // date within the last 14 days (lib/ship.ts says by whom and from what).
  due_set: { label: 'SET IN SHIPPING', tone: 'live' },
  date_moved: { label: 'DATE MOVED', tone: 'warn' },
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
    // Retired 2026-10-06 (it read as "no invoice yet"); an older API may still send it.
    if (flag === 'projected') continue;
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

export interface AttentionTag extends FlagTag {
  count: number;
}

/**
 * What a collapsed category must still say: each warn or fail tag its lines wear (their own
 * flags plus `marks` from `warnings[]`), with how many lines wear it. Fail comes before
 * warn; the informational tags (PAID, TUNED, ESTIMATED…) are left to the open category.
 */
export function attentionTags(
  lines: ReadonlyArray<{ key: string; flags: readonly string[] }>,
  marks?: ReadonlyMap<string, FlagTag[]>,
): AttentionTag[] {
  const byFlag = new Map<string, AttentionTag>();
  for (const line of lines) {
    for (const tag of [...flagTags(line.flags as ItemFlag[]), ...(marks?.get(line.key) ?? [])]) {
      if (tag.tone !== 'fail' && tag.tone !== 'warn') continue;
      const seen = byFlag.get(tag.flag);
      if (seen) seen.count += 1;
      else byFlag.set(tag.flag, { ...tag, count: 1 });
    }
  }
  const all = [...byFlag.values()];
  return [...all.filter((t) => t.tone === 'fail'), ...all.filter((t) => t.tone === 'warn')];
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
