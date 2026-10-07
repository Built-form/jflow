import { useState } from 'react';
import type { ForecastItem } from '../../api/forecast';
import { scenarios } from '../../api/scenarios';
import { useSubmit } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { inputStyle } from '../../components/FormField';
import { formatMoney } from '../../lib/money';
import { RefusalNote } from '../scenarios/RefusalNote';
import { MIN_PARTS, addPart, checkSplit, initialSplit, removePart, setPart, splitBase, splitsRealAmount } from './split';
import type { SplitForm } from './split';

/**
 * Split one forecast line into dated parts inside the open scenario (2026-10-07, D40).
 *
 * Part 1 is the line itself, resized and perhaps moved; each further part becomes a new
 * one-off in the scenario with the line's account and category. The parts must add up to
 * the line's real amount — the dialog keeps the running "left to allocate" and holds
 * "Split it" back until it is zero. A split replaces whatever adjustment the line had; it
 * is undone from the line's own edit dialog ("Undo the split").
 */
export function SplitLineDialog({
  item,
  scenario,
  today,
  onClose,
  onSaved,
}: {
  item: ForecastItem;
  scenario: { id: number; name: string };
  /** The server's today (`meta.today`). */
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const base = splitBase(item);
  const [form, setForm] = useState<SplitForm>(() => initialSplit(item, today));
  const submit = useSubmit();
  const check = checkSplit(form, { base, currency: item.currency, today });
  const what = item.kind === 'sched' ? 'instance' : item.kind === 'ship' ? 'stock payment' : 'item';
  const fromBaseline = splitsRealAmount(item);
  const money = (minor: bigint) => formatMoney(minor, item.currency);

  const save = () => {
    const body = check.body;
    if (!body) return;
    void submit.run(async () => {
      await scenarios.splitAdjustment(scenario.id, item.key, body);
      onSaved();
    });
  };

  return (
    <Dialog
      kicker={`SCENARIO · ${scenario.name.toUpperCase()}`}
      title={`Split ${item.name}`}
      width={600}
      confirmLabel="Split it"
      confirmDisabled={!check.body}
      busy={submit.busy}
      warnTone="waived"
      warning={`This is written to "${scenario.name}" only. Applying the scenario changes the real ${what} to part 1 and creates the other parts as one-offs.`}
      onConfirm={save}
      onClose={onClose}
    >
      <DialogBody>
        The line becomes part 1; each further part is a new one-off in this scenario with the same
        account and category. Together they add up to what the line is now.
      </DialogBody>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13.5 }}>
        <span>
          <span className="kicker" style={{ marginRight: 6 }}>
            TO SHARE OUT
          </span>
          <span className="mono" data-testid="split-base">
            {money(base)}
          </span>
          {fromBaseline && <span style={{ color: 'var(--dim)' }}> — its amount in the real plan</span>}
        </span>
        <span>
          <span className="kicker" style={{ marginRight: 6 }}>
            LEFT TO ALLOCATE
          </span>
          <span className="mono" data-testid="split-left" style={{ color: check.left === 0n ? 'var(--pass)' : 'var(--fail)' }}>
            {money(check.left)}
          </span>
        </span>
      </div>

      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Parts">
        {form.parts.map((part, i) => {
          const n = i + 1;
          const errors = check.errors.parts[i] ?? {};
          return (
            <li key={i} data-testid={`split-part-${n}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 11, letterSpacing: '.1em', color: 'var(--dim)', width: 58 }}>
                  PART {n}
                </span>
                <input
                  type="date"
                  className="input mono"
                  aria-label={`Part ${n} date`}
                  min={today}
                  value={part.date}
                  onChange={(e) => setForm((f) => setPart(f, i, { date: e.target.value }))}
                />
                <input
                  className="input mono"
                  aria-label={`Part ${n} amount`}
                  inputMode="decimal"
                  style={{ ...inputStyle, width: 140, flex: 'none' }}
                  value={part.amount}
                  onChange={(e) => setForm((f) => setPart(f, i, { amount: e.target.value }))}
                />
                <span style={{ fontSize: 12, color: 'var(--dim)' }}>{n === 1 ? 'the line itself' : 'a new one-off'}</span>
                <button
                  type="button"
                  className="btn-quiet"
                  aria-label={`Remove part ${n}`}
                  disabled={form.parts.length <= MIN_PARTS}
                  onClick={() => setForm((f) => removePart(f, i))}
                  style={{ marginLeft: 'auto', color: form.parts.length <= MIN_PARTS ? 'var(--dim)' : 'var(--fail)' }}
                >
                  remove
                </button>
              </div>
              {(errors.date || errors.amount) && (
                <div role="alert" style={{ fontSize: 12.5, color: 'var(--fail)', paddingLeft: 66 }}>
                  {[errors.date && `Date: ${errors.date}`, errors.amount && `Amount: ${errors.amount}`].filter(Boolean).join(' ')}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div>
        <button type="button" className="btn" onClick={() => setForm((f) => addPart(f, today))}>
          Add a part
        </button>
      </div>

      {check.errors.form && (
        <div data-testid="split-error" style={{ fontSize: 13.5, color: 'var(--fail)' }}>
          {check.errors.form}
        </div>
      )}
      {submit.error && <RefusalNote error={submit.error} currency={item.currency} nameOf={(key) => (key === item.key ? item.name : null)} />}
    </Dialog>
  );
}
