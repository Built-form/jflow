/**
 * Money on the client: display and input only, never arithmetic through floats.
 *
 * The API sends CRUD money as DECIMAL strings (`"1024.00"`, `"-250.50"`, CONTRACT D1) and
 * `/forecast` money as integer minor units. Both become `bigint` minor units here, and
 * every sum is a `bigint` sum — `0.10 + 0.20` is `30n`, not `0.30000000000000004`. A
 * `number` is accepted only as an integer count of minor units (the `/forecast` wire form)
 * and is refused if it is not a safe integer.
 *
 * Every currency has two decimal places in phase 1 (D2).
 */

/** The API's DECIMAL(14,2) grammar (CONTRACT §2.6): up to 12 whole digits, up to 2 decimals. */
const DECIMAL = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/;

/** The API's DECIMAL(12,6) rate grammar (CONTRACT §2.6). */
const RATE = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

/** A DECIMAL string as minor units, or null when it is not one. */
export function parseMinor(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null;
  const m = DECIMAL.exec(value.trim());
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const minor = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return sign === '-' ? -minor : minor;
}

/** `/forecast`'s integer minor units (or an already-parsed bigint) as a bigint. */
export function toMinor(value: number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer count of minor units: ${value}`);
  return BigInt(value);
}

/** Minor units as the wire's DECIMAL string: `102450n` → `"1024.50"`. */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

const SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };

/** `1234567` → `1,234,567`, on the digit string — no float, no locale surprises. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Minor units for reading: `£1,024.50`, `-€250.00`, `1,024.50 SEK`. The three currencies
 * with a symbol everyone reads the same get it in front; anything else carries its code
 * after the figure, so a CHF balance is never mistaken for pounds.
 */
export function formatMoney(value: bigint | number, currency: string): string {
  const minor = toMinor(value);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const figure = `${group(String(abs / 100n))}.${String(abs % 100n).padStart(2, '0')}`;
  const code = currency.toUpperCase();
  const symbol = SYMBOLS[code];
  const body = symbol ? `${symbol}${figure}` : `${figure} ${code}`;
  return negative ? `-${body}` : body;
}

/** A DECIMAL string from the API, for reading; `—` when there is none (or it is malformed). */
export function formatDecimal(value: string | null | undefined, currency: string): string {
  const minor = parseMinor(value);
  return minor === null ? '—' : formatMoney(minor, currency);
}

export type MoneyInput =
  | { kind: 'blank' }
  | { kind: 'ok'; minor: bigint; decimal: string }
  | { kind: 'error'; error: string };

/**
 * What someone typed into an amount box, as the DECIMAL string to send.
 *
 * Forgiving about presentation — spaces, thousands commas, a leading `£`/`€`/`$`, a
 * typographic minus — and strict about the value: at most two decimal places, at most
 * twelve whole digits, and a sign only where the field allows one (a bank balance can be
 * an overdraft; an item amount cannot).
 */
export function parseMoneyInput(
  raw: string,
  { allowNegative = false, allowZero = true }: { allowNegative?: boolean; allowZero?: boolean } = {},
): MoneyInput {
  const text = raw.trim().replace(/[\s,]/g, '').replace(/^([-−]?)[£€$]/, '$1').replace(/^−/, '-');
  if (text === '') return { kind: 'blank' };
  if (/^-?\d*\.\d{3,}$/.test(text)) return { kind: 'error', error: 'At most two decimal places.' };
  const minor = parseMinor(text);
  if (minor === null) return { kind: 'error', error: 'Enter an amount like 1024.50.' };
  if (minor < 0n && !allowNegative) return { kind: 'error', error: 'Must not be negative.' };
  if (minor === 0n && !allowZero) return { kind: 'error', error: 'Must be more than zero.' };
  return { kind: 'ok', minor, decimal: formatMinor(minor) };
}

/** A rate as micro-units (six decimals), or null when it does not fit DECIMAL(12,6). */
export function parseRateMicro(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null;
  const m = RATE.exec(value.trim());
  if (!m) return null;
  const [, whole, frac = ''] = m;
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** Micro-units back to a six-decimal string: `1170000n` → `"1.170000"`. */
export function formatRateMicro(micro: bigint): string {
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
}
