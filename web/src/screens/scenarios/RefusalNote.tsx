import type { ApiError } from '../../api/client';
import { ErrorNote } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { isNewKey } from '../../lib/keys';
import { formatDecimal } from '../../lib/money';
import { staleReason, unapplyReason } from './stale';

/**
 * A refusal from a scenario or forecast-edit route, as the server worded it (`ErrorNote`),
 * plus what its `details` say in words: for `SCENARIO_STALE` and `SCENARIO_UNAPPLY_BLOCKED`,
 * every key and its reason — and that NOTHING was written (§10.9 and §10.13 are all or
 * nothing).
 *
 * `nameOf` turns an item key into the line's name when the screen knows it; `currency`
 * prices a split's `SPLIT_AMOUNTS_MISMATCH` figures when the screen knows the line's.
 */
export interface RefusalLine {
  key: string;
  label: string | null;
  message: string;
}

export function refusalLines(
  error: ApiError,
  nameOf?: (itemKey: string) => string | null,
  { currency = null }: { currency?: string | null } = {},
): RefusalLine[] {
  const d = (error.details ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const money = (v: unknown) => {
    const s = str(v);
    if (s === null) return '?';
    if (!currency) return s;
    const formatted = formatDecimal(s, currency);
    return formatted === '—' ? s : formatted;
  };
  switch (error.code) {
    case 'SCENARIO_UNAPPLY_BLOCKED': {
      const blocked = Array.isArray(d.blocked) ? (d.blocked as { itemKey?: unknown; reason?: unknown }[]) : [];
      const lines: RefusalLine[] = [
        { key: 'nothing', label: null, message: 'Nothing was un-applied — every item is as it was.' },
      ];
      blocked.forEach((entry, i) => {
        const itemKey = str(entry.itemKey) ?? '?';
        const reason = unapplyReason(str(entry.reason));
        // An applied scenario's targets carry no current name; the key alone is shown then.
        const name = nameOf?.(itemKey) ?? null;
        lines.push({
          key: `blocked-${i}`,
          label: reason.label,
          message: `${name ? `${name} (${itemKey})` : itemKey} — ${reason.text}`,
        });
      });
      return lines;
    }
    case 'SCENARIO_NOT_APPLIED':
      return [
        {
          key: 'not-applied',
          label: null,
          message: `This scenario is ${str(d.status) ?? 'not applied'}. Only an applied scenario can be un-applied.`,
        },
      ];
    case 'SPLIT_AMOUNTS_MISMATCH':
      return [
        {
          key: 'split-sum',
          label: null,
          message: `The parts add up to ${money(d.total)}, but the line is ${money(d.expected)}.`,
        },
      ];
    case 'SCENARIO_STALE': {
      const stale = Array.isArray(d.stale) ? (d.stale as { itemKey?: unknown; reason?: unknown }[]) : [];
      const lines: RefusalLine[] = [
        { key: 'nothing', label: null, message: 'Nothing was applied — not one adjustment was written.' },
      ];
      stale.forEach((entry, i) => {
        const itemKey = str(entry.itemKey) ?? '?';
        // A scenario's own one-off (a `new.` key) is missing when its account or category went.
        const reason = staleReason(str(entry.reason), isNewKey(itemKey) ? 'add' : null);
        lines.push({
          key: `stale-${i}`,
          label: reason?.label ?? 'STALE',
          message: `${nameOf?.(itemKey) ?? itemKey} (${itemKey}) — ${reason?.text ?? 'stale.'}`,
        });
      });
      return lines;
    }
    case 'SCENARIO_NOT_DRAFT':
      return [
        {
          key: 'not-draft',
          label: null,
          message: `This scenario is ${str(d.status) ?? 'no longer a draft'}. Adjustments, rebase and apply only work on a draft; duplicate it to keep working.`,
        },
      ];
    case 'TARGET_SETTLED':
      return [
        {
          key: 'settled',
          label: null,
          message: `${nameOf?.(str(d.key) ?? '') ?? 'The item'} is ${str(d.status) ?? 'settled'} now — a paid, part-paid or skipped line cannot be adjusted.`,
        },
      ];
    case 'TARGET_MISSING':
      return [{ key: 'missing', label: null, message: 'The item is gone — deleted, or no longer an occurrence of its schedule.' }];
    case 'ADJUSTMENT_DATE_IN_PAST':
      return [
        {
          key: 'past',
          label: null,
          message: `${formatDay(str(d.newDate))} is before today (${formatDay(str(d.today))}). Pick today or later.`,
        },
      ];
    case 'ITEM_KEY_INVALID':
      return [{ key: 'key', label: null, message: `The server does not accept the key ${str(d.key) ?? ''}.` }];
    default:
      return [];
  }
}

export function RefusalNote({
  error,
  nameOf,
  currency,
  onRetry,
}: {
  error: ApiError;
  nameOf?: (itemKey: string) => string | null;
  /** The line's currency, when one line is in question (a split's amounts). */
  currency?: string | null;
  onRetry?: () => void;
}) {
  const lines = refusalLines(error, nameOf, { currency });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ErrorNote error={error} onRetry={onRetry} />
      {lines.length > 0 && (
        <ul
          data-testid="refusal-lines"
          style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          {lines.map((line) => (
            <li key={line.key} style={{ fontSize: 13.5, lineHeight: 1.5, display: 'flex', gap: 8 }}>
              {line.label && (
                <span className="mono" style={{ fontSize: 11.5, letterSpacing: '.05em', flex: 'none', color: 'var(--fail)' }}>
                  {line.label}
                </span>
              )}
              <span>{line.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
