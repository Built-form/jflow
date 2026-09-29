/**
 * Calendar days on the client, the way the API does them (CONTRACT §2.5): `YYYY-MM-DD`
 * strings and epoch-day arithmetic. No `Date` object ever stands for a calendar day — a
 * `Date` is an instant, and turning one into a day needs a time zone, which is exactly how
 * a balance ends up on the day before.
 *
 * The one instant this file reads is "now", in `londonToday`, and it names its zone.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** A real calendar date in `YYYY-MM-DD` form — `2026-02-30` is not one. */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Days since 1970-01-01 (Hinnant's days-from-civil). Throws on anything but a real date. */
export function toEpochDay(ymd: string): number {
  if (!isValidDate(ymd)) throw new RangeError(`Not a calendar date: ${ymd}`);
  let year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of `toEpochDay` (Hinnant's civil-from-days). */
export function fromEpochDay(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(ymd: string, n: number): string {
  return fromEpochDay(toEpochDay(ymd) + n);
}

/** `a − b` in days. */
export function diffDays(a: string, b: string): number {
  return toEpochDay(a) - toEpochDay(b);
}

/** 0 = Monday … 6 = Sunday. 1970-01-01 was a Thursday. */
export function dayOfWeek(ymd: string): number {
  return (((toEpochDay(ymd) + 3) % 7) + 7) % 7;
}

/**
 * Today as the business counts it: the Europe/London calendar date, whatever zone the
 * browser is in (CONTRACT §2.5) — the same `Intl.DateTimeFormat('en-CA', {timeZone:
 * 'Europe/London'})` the API uses. `now` is injectable for tests.
 */
export function londonToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** `Tue 29 Sep 2026` — read straight off the string, never through a zone. `—` for a non-date. */
export function formatDay(ymd: string | null | undefined): string {
  if (!isValidDate(ymd)) return '—';
  const day = Number(ymd.slice(8, 10));
  const month = MONTHS[Number(ymd.slice(5, 7)) - 1];
  return `${WEEKDAYS[dayOfWeek(ymd)]} ${day} ${month} ${ymd.slice(0, 4)}`;
}

/** `today`, `yesterday`, `tomorrow`, or null for any other day. */
export function relativeDay(ymd: string, today: string): 'today' | 'yesterday' | 'tomorrow' | null {
  if (!isValidDate(ymd) || !isValidDate(today)) return null;
  const d = diffDays(ymd, today);
  if (d === 0) return 'today';
  if (d === -1) return 'yesterday';
  if (d === 1) return 'tomorrow';
  return null;
}
