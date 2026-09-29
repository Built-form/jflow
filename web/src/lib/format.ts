// Copied from workflows/web/src/lib/format.ts — changes: none
/** Formatting helpers. All API DATETIMEs are UTC; the browser's zone is applied at render. */

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse an API datetime. MySQL DATETIMEs arrive without a zone — read them as UTC. */
export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `14 AUG 2026 09:41` — the mono form the history and round meta lines use. The year is
 * not optional: these stamps end up on permanent records an auditor reads years later.
 */
export function shortStamp(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return '—';
  const month = d.toLocaleString('en-GB', { month: 'short' }).toUpperCase();
  return `${d.getDate()} ${month} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The audit table's WHEN column, which is explicitly labelled UTC. */
export function utcStamp(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return '—';
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
}

export function dayStamp(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * A calendar day the API holds as `YYYY-MM-DD` (a DATE column with no time — the arrival
 * date), as `14 Sep 2026`. Read as written: never parsed through a timezone, so the day
 * cannot slip to the one before it for anyone west of the person who typed it.
 */
export function calendarDay(value: string | null | undefined): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  if (!m) return '—';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${d.getFullYear()}`;
}

/** An API datetime as the `YYYY-MM-DD` a date input holds — the browser's day, like the stamps. */
export function dayInput(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date input's `YYYY-MM-DD` as the datetime to send: NOON, local. A day has no time,
 * and midnight in one zone is the previous day in the next — noon lands on the same
 * calendar day for anyone within eleven hours of the person who typed it.
 */
export function dayInputToIso(ymd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Relative due date in the compact mono form the lots table uses: `today`, `+2d`, `-1d`. */
export function dueLabel(value: string | null | undefined, now: Date = new Date()): string {
  const d = parseUtc(value);
  if (!d) return '—';
  const startOf = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days > 0) return `+${days}d`;
  return `${days}d`;
}

export function isOverdue(value: string | null | undefined, now: Date = new Date()): boolean {
  const d = parseUtc(value);
  return !!d && d.getTime() < now.getTime();
}

/** Product codes and lot numbers are stored trimmed + uppercased. Match that as they type. */
export function normaliseCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Punctuation-blind substring match for the list searches — `goods in` finds
 * "Goods-in check", `jf1244` finds "JF-1244". An empty query matches everything.
 */
export function matchesQuery(text: string | null | undefined, query: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = norm(query);
  if (!q) return true;
  return norm(text ?? '').includes(q);
}

/** `m.reyes` from `m.reyes@built-form.co.uk` — the mono short form used in tables. */
export function shortEmail(email: string | null | undefined): string {
  if (!email) return '—';
  return email.split('@')[0];
}

export function initialsOf(email: string | null | undefined): string {
  return shortEmail(email);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function numberOrDash(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}
