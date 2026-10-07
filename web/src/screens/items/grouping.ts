/**
 * Groups for Income & outgoings and a schedule's instance table, by the server's
 * `derivedStatus` (CONTRACT D10, §9.6). Nothing here classifies: the band each row falls in
 * is the server's answer, and this file only orders, names and explains the bands. A value
 * this client does not know gets a group of its own, so a new band is shown, never lost.
 *
 * "Assumed settled" is visible, not silent (PLAN): an automatic line still `expected` and
 * dated before its account's latest recorded balance. Nothing was written — the server only
 * infers it — so the group offers Confirm paid or Didn't happen.
 */

import type { Tone } from '../../lib/tone';
import { toneOfDerivedStatus } from '../../lib/tone';

export interface GroupMeta {
  id: string;
  label: string;
  /** One line under the group's heading: what the band means. */
  explain: string;
  tone: Tone;
}

/** Display order: what needs a person first, settled history last. */
export const GROUP_ORDER: GroupMeta[] = [
  {
    id: 'overdue',
    label: 'Overdue',
    explain: 'Settled by hand and past their date. The forecast places them at today until they are paid or re-dated.',
    tone: toneOfDerivedStatus('overdue'),
  },
  {
    id: 'unresolved',
    label: 'Unresolved',
    explain: 'Settled by hand and long past their date. They are left out of the forecast until someone resolves them.',
    tone: toneOfDerivedStatus('unresolved'),
  },
  {
    id: 'assumedSettled',
    label: 'Assumed settled',
    explain:
      "Automatic, and dated before the account's latest recorded balance, so the balance is assumed to include them. Nothing was recorded: confirm each was paid, or say it didn't happen.",
    tone: toneOfDerivedStatus('assumedSettled'),
  },
  {
    id: 'assumed',
    label: 'Assumed since the last balance',
    explain:
      "Automatic, dated after the account's latest recorded balance but before today. The forecast counts them into today's opening figure.",
    tone: toneOfDerivedStatus('assumed'),
  },
  {
    id: 'expected',
    label: 'Expected',
    explain: 'Due today or later.',
    tone: toneOfDerivedStatus('expected'),
  },
  {
    id: 'paid',
    label: 'Paid',
    explain: 'Paid in full.',
    tone: toneOfDerivedStatus('paid'),
  },
  {
    id: 'skipped',
    label: 'Skipped',
    explain: 'Not happening. Left out of the forecast.',
    tone: toneOfDerivedStatus('skipped'),
  },
];

export const ASSUMED_SETTLED = 'assumedSettled';
export const ASSUMED = 'assumed';

export interface Group<T> extends GroupMeta {
  rows: T[];
}

function metaFor(id: string): GroupMeta {
  return (
    GROUP_ORDER.find((g) => g.id === id) ?? {
      id,
      label: id,
      explain: 'A status this screen does not know yet — shown as the server sent it.',
      tone: toneOfDerivedStatus(id),
    }
  );
}

/**
 * Rows into their server-given groups, in `GROUP_ORDER`, unknown bands last in first-seen
 * order. Rows keep the order they arrived in (the server's date order, D28). Empty groups
 * are left out.
 */
export function groupByDerivedStatus<T extends { derivedStatus: string }>(rows: T[]): Group<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const list = buckets.get(row.derivedStatus) ?? [];
    list.push(row);
    buckets.set(row.derivedStatus, list);
  }
  const known = GROUP_ORDER.map((g) => g.id);
  const unknown = [...buckets.keys()].filter((id) => !known.includes(id));
  return [...known, ...unknown]
    .filter((id) => (buckets.get(id)?.length ?? 0) > 0)
    .map((id) => ({ ...metaFor(id), rows: buckets.get(id)! }));
}

/** `?show=` as a group id (any string the server may send), or null for every group. */
export function parseShowParam(raw: string | null): string | null {
  return raw && /^[A-Za-z_]{1,40}$/.test(raw) ? raw : null;
}

/** The label a status reads as on a row's pill. */
export function derivedStatusLabel(id: string): string {
  return metaFor(id).label;
}
