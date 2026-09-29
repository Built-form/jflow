import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSubmit } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { ErrorNote, Pill } from '../../components/ui';
import type { Group } from './grouping';
import { ASSUMED_SETTLED, parseShowParam } from './grouping';

/** The group filter lives in the URL (`?show=assumedSettled`), like the company filter. */
export const SHOW_PARAM = 'show';

export function useShowFilter(): [string | null, (next: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const show = parseShowParam(params.get(SHOW_PARAM));
  const setShow = useCallback(
    (next: string | null) =>
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === null) out.delete(SHOW_PARAM);
          else out.set(SHOW_PARAM, next);
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [show, setShow];
}

/**
 * One pill per non-empty group, with its count, plus "All". The assumed-settled pill is
 * always offered while that group has rows — it is the one a person comes here to check.
 */
export function GroupFilter<T>({
  groups,
  value,
  onChange,
}: {
  groups: Group<T>[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div role="group" aria-label="Show" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="filter-pill" aria-pressed={value === null} onClick={() => onChange(null)}>
        All · {total}
      </button>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          className="filter-pill"
          aria-pressed={value === g.id}
          onClick={() => onChange(value === g.id ? null : g.id)}
          style={g.id === ASSUMED_SETTLED && value !== g.id ? { borderColor: 'var(--waivedBd)' } : undefined}
        >
          {g.label} · {g.rows.length}
        </button>
      ))}
    </div>
  );
}

/** A group's heading: its pill, count and the one line that says what the band means. */
export function GroupSection<T>({ group, children }: { group: Group<T>; children: ReactNode }) {
  return (
    <section aria-label={group.label} data-group={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill tone={group.tone}>{group.label.toUpperCase()}</Pill>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--dim)' }}>
          {group.rows.length}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.55 }}>{group.explain}</div>
      {children}
    </section>
  );
}

/**
 * "Didn't happen": the line was assumed settled, but the money never moved (a bounced
 * payment, a cancelled order). It becomes settled-by-hand — `settleMode: 'manual'` on the
 * item, or on the instance's override — so it stops being assumed and reappears as overdue
 * (unresolved, if it is long past), where it stays until it is paid, re-dated or skipped.
 */
export const DIDNT_HAPPEN_EXPLAIN =
  'It will be switched to settled by hand, so it is no longer assumed to be in the bank balance. It reappears as overdue — or unresolved, if it is long past — until it is paid, re-dated or skipped.';

export function DidntHappenDialog({
  kicker,
  title,
  detail,
  confirm,
  onDone,
  onClose,
}: {
  kicker: ReactNode;
  title: string;
  detail?: ReactNode;
  /** Sends the settle-mode change and replaces the row from the response. */
  confirm: () => Promise<void>;
  onDone: () => void;
  onClose: () => void;
}) {
  const submit = useSubmit();
  return (
    <Dialog
      kicker={kicker}
      title={title}
      confirmLabel="It didn't happen"
      busy={submit.busy}
      warning={DIDNT_HAPPEN_EXPLAIN}
      warnTone="warn"
      onConfirm={() =>
        void submit.run(confirm).then((ok) => {
          if (ok) onDone();
        })
      }
      onClose={onClose}
    >
      {detail && <DialogBody>{detail}</DialogBody>}
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}

/** A quiet row action: `pay`, `edit`, `skip`. */
export function RowAction({
  children,
  onClick,
  tone = 'acc',
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'acc' | 'fail' | 'mut';
  label?: string;
}) {
  return (
    <button
      type="button"
      className="btn-quiet"
      aria-label={label}
      style={{ color: tone === 'acc' ? 'var(--acc)' : tone === 'fail' ? 'var(--fail)' : 'var(--mut)' }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
