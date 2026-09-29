/**
 * Stock payments grouped by the server's `derivedStatus` (CONTRACT §6.12). Nothing here
 * classifies: the band is the server's, and `null` — nothing was classified — is its own
 * group, "Not in the forecast". Within that group each row says why, read straight off
 * its fields (gone, unmapped, undated); that is display, not a rule.
 */

import type { ExternalItem } from '../../api/external';
import type { Tone } from '../../lib/tone';
import { toneOfDerivedStatus } from '../../lib/tone';
import type { Group, GroupMeta } from '../items/grouping';

/** The group id for `derivedStatus: null`. */
export const NOT_IN_FORECAST = 'notInForecast';

/** Display order: what needs a person first, settled history last. */
export const STOCK_GROUPS: GroupMeta[] = [
  {
    id: 'overdue',
    label: 'Overdue',
    explain: 'Past their date and not paid in shipping. The forecast places them at today until shipping records the payment, or they are re-dated or skipped.',
    tone: toneOfDerivedStatus('overdue'),
  },
  {
    id: 'unresolved',
    label: 'Unresolved',
    explain: 'Long past their date and not paid in shipping. They are left out of the forecast until someone resolves them.',
    tone: toneOfDerivedStatus('unresolved'),
  },
  {
    id: NOT_IN_FORECAST,
    label: 'Not in the forecast',
    explain: 'Shipping has no date for them yet, no JFlow company or account takes them, or shipping no longer lists them. Each row says which.',
    tone: 'warn',
  },
  {
    id: 'expected',
    label: 'Expected',
    explain: 'Due today or later.',
    tone: toneOfDerivedStatus('expected'),
  },
  {
    id: 'skipped',
    label: 'Skipped',
    explain: 'Skipped in JFlow, so left out of the forecast. Open one to unskip it.',
    tone: toneOfDerivedStatus('skipped'),
  },
  {
    id: 'paid',
    label: 'Paid',
    explain: 'Paid, as shipping records it.',
    tone: toneOfDerivedStatus('paid'),
  },
];

const groupId = (row: ExternalItem) => row.derivedStatus ?? NOT_IN_FORECAST;

function metaFor(id: string): GroupMeta {
  return (
    STOCK_GROUPS.find((g) => g.id === id) ?? {
      id,
      label: id,
      explain: 'A status this screen does not know yet — shown as the server sent it.',
      tone: toneOfDerivedStatus(id),
    }
  );
}

/** Rows into their groups, in `STOCK_GROUPS` order, unknown bands last; empty groups left out. */
export function groupExternalItems(rows: ExternalItem[]): Group<ExternalItem>[] {
  const buckets = new Map<string, ExternalItem[]>();
  for (const row of rows) {
    const id = groupId(row);
    const list = buckets.get(id) ?? [];
    list.push(row);
    buckets.set(id, list);
  }
  const known = STOCK_GROUPS.map((g) => g.id);
  const unknown = [...buckets.keys()].filter((id) => !known.includes(id));
  return [...known, ...unknown]
    .filter((id) => (buckets.get(id)?.length ?? 0) > 0)
    .map((id) => ({ ...metaFor(id), rows: buckets.get(id)! }));
}

export interface RowTag {
  id: string;
  label: string;
  tone: Tone;
}

/** Why a row is not in the forecast (a `derivedStatus: null` row), from its own fields. */
export function notInForecastTags(row: ExternalItem): RowTag[] {
  if (row.derivedStatus != null) return [];
  const tags: RowTag[] = [];
  if (row.goneAt) tags.push({ id: 'gone', label: 'GONE FROM SHIPPING', tone: 'idle' });
  if (row.companyId == null || row.accountId == null) tags.push({ id: 'unmapped', label: 'UNMAPPED', tone: 'warn' });
  if (!row.goneAt && row.effectiveDate == null) tags.push({ id: 'undated', label: 'NO DATE YET', tone: 'warn' });
  return tags;
}
