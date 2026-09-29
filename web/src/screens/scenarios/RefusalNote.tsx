import type { ApiError } from '../../api/client';
import { ErrorNote } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { staleReason } from './stale';

/**
 * A refusal from a scenario or forecast-edit route, as the server worded it (`ErrorNote`),
 * plus what its `details` say in words: for `SCENARIO_STALE`, every key and its reason —
 * and that NOTHING was written (§10.9 is all or nothing).
 *
 * `nameOf` turns an item key into the line's name when the screen knows it.
 */
export interface RefusalLine {
  key: string;
  label: string | null;
  message: string;
}

export function refusalLines(error: ApiError, nameOf?: (itemKey: string) => string | null): RefusalLine[] {
  const d = (error.details ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  switch (error.code) {
    case 'SCENARIO_STALE': {
      const stale = Array.isArray(d.stale) ? (d.stale as { itemKey?: unknown; reason?: unknown }[]) : [];
      const lines: RefusalLine[] = [
        { key: 'nothing', label: null, message: 'Nothing was applied — not one adjustment was written.' },
      ];
      stale.forEach((entry, i) => {
        const itemKey = str(entry.itemKey) ?? '?';
        const reason = staleReason(str(entry.reason));
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
  onRetry,
}: {
  error: ApiError;
  nameOf?: (itemKey: string) => string | null;
  onRetry?: () => void;
}) {
  const lines = refusalLines(error, nameOf);
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
