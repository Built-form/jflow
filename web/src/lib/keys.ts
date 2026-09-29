/**
 * Item keys on the client: a PARSE-ONLY mirror of `api/src/lib/keys.js` (CONTRACT §4).
 *
 * A key names one forecast line — `item.123`, `sched.45.2026-06-01`, `ship.PO-778`. The
 * server builds every key; the client never assembles one. It only reads a key it was
 * given, to find the row behind it: a one-off's id, or an instance's schedule id and
 * NATURAL date (never its effective date) for `PUT /schedules/:id/instances/:naturalDate`.
 *
 * The grammar is copied exactly, so a key the server would refuse with
 * `422 ITEM_KEY_INVALID` is refused here first — nothing is sent for it.
 */

import { isValidDate } from './dates';

export type TargetKind = 'item' | 'sched' | 'ship';

export interface ParsedKey {
  targetKind: TargetKind;
  /** The decimal string of the id (`item`/`sched`), or the raw id (`ship`) — CONTRACT D32. */
  targetId: string;
  /** The instance's natural date for `sched`, else null. */
  targetDate: string | null;
}

/** `item_key VARCHAR(80)`. */
export const KEY_MAX_LENGTH = 80;

const ITEM = /^item\.([1-9][0-9]{0,17})$/;
const SCHED = /^sched\.([1-9][0-9]{0,17})\.([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
const SHIP = /^ship\.([A-Za-z0-9_-]{1,64})$/;

/** The parsed form, or null for anything CONTRACT §4 rejects. */
export function parseKey(key: unknown): ParsedKey | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX_LENGTH) return null;
  let m = ITEM.exec(key);
  if (m) return { targetKind: 'item', targetId: m[1], targetDate: null };
  m = SCHED.exec(key);
  if (m) return isValidDate(m[2]) ? { targetKind: 'sched', targetId: m[1], targetDate: m[2] } : null;
  m = SHIP.exec(key);
  if (m) return { targetKind: 'ship', targetId: m[1], targetDate: null };
  return null;
}

export function isValidKey(key: unknown): key is string {
  return parseKey(key) !== null;
}
