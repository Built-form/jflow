import { useMemo, useState } from 'react';
import type { ForecastItem } from '../../api/forecast';
import { Dialog, DialogBody } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Segmented } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { plural } from '../../lib/format';
import { formatMoney, toMinor } from '../../lib/money';
import { RefusalNote } from '../scenarios/RefusalNote';
import { QUICK_SHIFTS } from './edit';
import { sendEdit } from './EditLineDialog';
import { checkMove, initialMove, movePayments, runMoves } from './moveContainer';
import type { MoveForm, MoveMode, MoveOutcome, MoveRow } from './moveContainer';

const MODES: { id: MoveMode; label: string }[] = [
  { id: 'shift', label: 'Shift by days' },
  { id: 'date', label: 'Same date for all' },
];

/**
 * Move every payment of one container inside the open scenario (Dev, 2026-11-20): shift
 * them all by a number of days, or put them all on one date. Each payment has a tick box, so
 * one can be left where it is — a deposit that is not slipping with the container, say.
 *
 * Web only: it writes one ordinary adjustment per ticked payment, one after another
 * (`moveContainer.ts`). That is not all or nothing, so when a payment is refused the dialog
 * stays open on what moved, what did not and why, and closing it re-reads the forecast.
 * Nothing here touches the real plan.
 */
export function MoveContainerDialog({
  containerRef,
  lines,
  scenario,
  today,
  windowEnd,
  onClose,
  onSaved,
}: {
  /** The container as shipping names it. */
  containerRef: string;
  /** Every stock payment of the container in the forecast window. */
  lines: readonly ForecastItem[];
  scenario: { id: number; name: string };
  /** The server's today (`meta.today`). */
  today: string;
  /** The last day of the forecast window (`meta.to`): later payments are not in `lines`. */
  windowEnd: string;
  onClose: () => void;
  /** Something was written: close, and read the forecast again. */
  onSaved: () => void;
}) {
  const payments = useMemo(() => movePayments(lines), [lines]);
  const [form, setForm] = useState<MoveForm>(initialMove);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);

  const check = checkMove(payments, form, { scenario, today });
  const movable = payments.filter((p) => p.fixed === null);
  const count = check.steps?.length ?? 0;

  const move = () => {
    const steps = check.steps;
    if (!steps || busy) return;
    setBusy(true);
    setSent(0);
    void runMoves(steps, (action) => sendEdit(action, scenario.id), setSent).then((result) => {
      setBusy(false);
      if (result.failed.length === 0) onSaved();
      else setOutcome(result);
    });
  };

  const kicker = `SCENARIO · ${scenario.name.toUpperCase()}`;
  const title = `Move the payments in ${containerRef}`;

  // Some went through and some did not: the forecast behind the dialog is out of date, so
  // there is nothing more to send from here — only what happened, and a way out that re-reads.
  if (outcome) {
    const total = outcome.moved.length + outcome.failed.length + outcome.unsent.length;
    return (
      <Dialog kicker={kicker} title={title} width={640} confirmLabel="Close and reload" cancelLabel={null} onConfirm={onSaved} onClose={onSaved}>
        <div data-testid="move-outcome" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div role="status" style={{ fontSize: 15, fontWeight: 600 }}>
            {outcome.moved.length} of {plural(total, 'payment')} moved.
          </div>
          {outcome.failed.map(({ step, error }) => (
            <div key={step.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 13.5 }}>
                <span className="kicker" style={{ marginRight: 8, color: 'var(--fail)' }}>
                  NOT MOVED
                </span>
                {step.name}
              </div>
              <RefusalNote error={error} nameOf={(key) => (key === step.key ? step.name : null)} />
            </div>
          ))}
          {outcome.unsent.length > 0 && (
            <div data-testid="move-unsent" style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--mut)' }}>
              That refusal is not about one payment, so the move stopped there. Not sent:{' '}
              {outcome.unsent.map((s) => s.name).join('; ')}.
            </div>
          )}
          {outcome.moved.length > 0 && (
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--mut)' }}>
              Moved: {outcome.moved.map((s) => s.name).join('; ')}.
            </div>
          )}
        </div>
      </Dialog>
    );
  }

  const tickAll = (on: boolean) => setForm((f) => ({ ...f, skip: on ? [] : movable.map((p) => p.key) }));
  const tick = (key: string, on: boolean) =>
    setForm((f) => ({ ...f, skip: on ? f.skip.filter((k) => k !== key) : [...f.skip.filter((k) => k !== key), key] }));

  return (
    <Dialog
      kicker={kicker}
      title={title}
      width={640}
      confirmLabel={count > 0 ? `Move ${plural(count, 'payment')}` : 'Move the payments'}
      confirmDisabled={count === 0}
      busy={busy}
      warnTone="waived"
      warning={`This writes one adjustment per payment to "${scenario.name}". The real stock payments do not change unless the scenario is applied.`}
      onConfirm={move}
      onClose={onClose}
    >
      <Segmented
        ariaLabel="How to move them"
        options={MODES}
        value={form.mode}
        onChange={(mode) => {
          if (!busy) setForm((f) => ({ ...f, mode }));
        }}
      />

      {form.mode === 'shift' ? (
        <FormField
          label="DAYS"
          note="Each payment moves by this many days, so they keep their gaps. A minus number moves them earlier. An overdue payment counts from today."
          error={form.days.trim() === '' ? null : check.errors.days}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input mono"
              aria-label="Days"
              inputMode="numeric"
              style={{ ...inputStyle, width: 110, flex: 'none' }}
              value={form.days}
              disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
            />
            {QUICK_SHIFTS.map((n) => (
              <button
                key={n}
                type="button"
                className="btn"
                aria-label={`+${n} days`}
                aria-pressed={form.days.trim() === String(n)}
                disabled={busy}
                onClick={() => setForm((f) => ({ ...f, days: String(n) }))}
              >
                +{n}
              </button>
            ))}
          </div>
        </FormField>
      ) : (
        <FormField label="DATE" note="Every ticked payment lands on this date. Today or later." error={form.date === '' ? null : check.errors.date}>
          <div>
            <input
              type="date"
              className="input mono"
              aria-label="Date"
              min={today}
              value={form.date}
              disabled={busy}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>
        </FormField>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 11, letterSpacing: '.1em', color: 'var(--dim)' }}>
            {plural(payments.length, 'PAYMENT', 'PAYMENTS')} · TO {formatDay(windowEnd).toUpperCase()}
          </span>
          {movable.length > 1 && (
            <span style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
              <button type="button" className="link-btn" disabled={busy} onClick={() => tickAll(true)}>
                Tick all
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={() => tickAll(false)}>
                Untick all
              </button>
            </span>
          )}
        </div>
        <ul
          aria-label="Payments"
          style={{ margin: 0, padding: 0, listStyle: 'none', border: '1px solid var(--line)', borderRadius: 9, maxHeight: 280, overflow: 'auto' }}
        >
          {check.rows.map((row, i) => (
            <PaymentRow key={row.key} row={row} first={i === 0} disabled={busy} onTick={(on) => tick(row.key, on)} />
          ))}
        </ul>
        <div style={{ fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.5 }}>
          Only this container's payments inside the forecast window are listed. Choose a longer window on the Forecast to reach later ones.
        </div>
      </div>

      {check.errors.form && (
        <div role="alert" style={{ fontSize: 13.5, color: 'var(--fail)' }}>
          {check.errors.form}
        </div>
      )}
      {busy && (
        <DialogBody>
          <span role="status" data-testid="move-progress">
            Moving {Math.min(sent + 1, count)} of {count}…
          </span>
        </DialogBody>
      )}
    </Dialog>
  );
}

/** One payment: its tick box, what it is, and where it goes from and to. */
function PaymentRow({ row, first, disabled, onTick }: { row: MoveRow; first: boolean; disabled: boolean; onTick: (on: boolean) => void }) {
  const { item } = row;
  const from = `${formatDay(item.date)}${item.flags.includes('overdue') ? ' (overdue)' : ''}`;
  const where =
    row.fixed !== null
      ? `${from} · ${row.fixed}`
      : !row.ticked
        ? `${from} · stays`
        : row.to === null
          ? from
          : row.same
            ? `${from} · already there`
            : `${from} → ${formatDay(row.to)}`;
  const dim = row.fixed !== null || !row.ticked;
  const body = (
    <>
      <span style={{ width: 18, flex: 'none', display: 'flex', justifyContent: 'center' }}>
        {row.fixed === null && (
          <input type="checkbox" aria-label={`Move ${item.name}`} checked={row.ticked} disabled={disabled} onChange={(e) => onTick(e.target.checked)} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span
            title={item.name}
            style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: dim ? 'var(--mut)' : undefined }}
          >
            {item.name}
          </span>
          <span className="mono" style={{ fontSize: 13, flex: 'none', color: dim ? 'var(--mut)' : undefined }}>
            {formatMoney(toMinor(item.amountMinor), item.currency)}
          </span>
        </span>
        <span className="mono" style={{ fontSize: 12.5, color: dim ? 'var(--dim)' : 'var(--mut)' }}>
          {where}
        </span>
        {row.error && <span style={{ fontSize: 12.5, color: 'var(--fail)' }}>{row.error}</span>}
      </span>
    </>
  );
  const style = { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 12px', borderTop: first ? 0 : '1px solid var(--line)' } as const;
  return (
    <li data-testid={`move-row-${row.key}`}>
      {row.fixed === null ? (
        <label style={{ ...style, cursor: disabled ? 'default' : 'pointer' }}>{body}</label>
      ) : (
        <div style={style}>{body}</div>
      )}
    </li>
  );
}
