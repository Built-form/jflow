import { useState } from 'react';
import type { ForecastItem } from '../../api/forecast';
import { forecast } from '../../api/forecast';
import { scenarios } from '../../api/scenarios';
import { useSubmit } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Tag, Toggle } from '../../components/ui';
import { formatDay, isValidDate } from '../../lib/dates';
import { flagTags, shortDay } from '../../lib/grid';
import { formatMoney, toMinor } from '../../lib/money';
import { shipFlagNotes } from '../../lib/ship';
import { RefusalNote } from '../scenarios/RefusalNote';
import type { EditAction, EditForm } from './edit';
import { QUICK_SHIFTS, checkEdit, initialForm, shiftedDate } from './edit';

/** Send what `checkEdit` decided. The answers are rows; the forecast is re-read after. */
export async function sendEdit(action: EditAction, scenarioId: number | null): Promise<void> {
  switch (action.kind) {
    case 'item':
      await forecast.editItem(action.itemId, action.body);
      return;
    case 'instance':
      await forecast.tuneInstance(action.scheduleId, action.naturalDate, action.body);
      return;
    case 'adjustment':
      if (scenarioId === null) throw new Error('No scenario is open.');
      await scenarios.putAdjustment(scenarioId, action.itemKey, action.body);
      return;
    case 'unadjust':
      if (scenarioId === null) throw new Error('No scenario is open.');
      await scenarios.removeAdjustment(scenarioId, action.itemKey);
  }
}

/**
 * Change one line's amount or date. With no scenario open this edits the REAL item or
 * instance; with one open it writes an adjustment to the scenario and the real data is
 * untouched. The dialog says which, in its kicker, its button and its warning.
 */
export function EditLineDialog({
  item,
  categoryName,
  scenario,
  today,
  onClose,
  onSaved,
}: {
  item: ForecastItem;
  categoryName: string;
  scenario: { id: number; name: string } | null;
  /** The server's today (`meta.today`). */
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditForm>(() => initialForm(item));
  const submit = useSubmit();
  const check = checkEdit(item, form, { scenario, today });
  const adjusted = item.flags.includes('adjusted') || item.flags.includes('excluded');
  const notGbp = item.currency !== 'GBP';

  const save = (action: EditAction | null) => {
    if (!action) return;
    void submit.run(async () => {
      await sendEdit(action, scenario?.id ?? null);
      onSaved();
    });
  };

  const what = item.kind === 'sched' ? 'instance' : item.kind === 'ship' ? 'stock payment' : 'item';
  const ship = item.kind === 'ship' ? item.ship ?? null : null;
  const confirmLabel = scenario
    ? form.exclude
      ? 'Leave it out'
      : check.action?.kind === 'unadjust'
        ? 'Back to the real plan'
        : 'Save to scenario'
    : `Change the ${what}`;

  return (
    <Dialog
      kicker={scenario ? `SCENARIO · ${scenario.name.toUpperCase()}` : `FORECAST · ${categoryName.toUpperCase()}`}
      title={item.name}
      width={540}
      confirmLabel={confirmLabel}
      confirmDisabled={!check.action}
      busy={submit.busy}
      warnTone={scenario ? 'waived' : 'warn'}
      warning={
        scenario
          ? `This writes an adjustment to "${scenario.name}". The real ${what} does not change unless the scenario is applied.`
          : `This changes the real ${what}${item.kind === 'sched' ? ' (just this one date of the schedule)' : ''}. To try it out first, open a scenario.`
      }
      onConfirm={() => save(check.action)}
      onClose={onClose}
    >
      <DialogBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>
            <span className="mono" style={{ color: 'var(--text)' }}>
              {formatMoney(toMinor(item.amountMinor), item.currency)}
            </span>{' '}
            on {formatDay(item.date)}
            {notGbp && (
              <span className="mono" style={{ color: 'var(--dim)' }}>
                {' '}
                · {formatMoney(toMinor(item.gbpMinor), 'GBP')}
              </span>
            )}
          </div>
          {item.counterparty && !ship && <div>{item.counterparty}</div>}
          {ship && (
            <div data-testid="edit-ship-feed">
              Shipping says{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {formatMoney(toMinor(ship.feedAmountMinor), item.currency)}
              </span>{' '}
              on {ship.feedDate ? formatDay(ship.feedDate) : 'no date yet'}.
            </div>
          )}
          {ship && shipFlagNotes(item.flags, ship).map((n) => <div key={n} style={{ fontSize: 13 }}>{n}</div>)}
          {scenario && item.baseline && adjusted && (
            <div data-testid="edit-baseline">
              Real plan: {formatMoney(toMinor(item.baseline.amountMinor), item.currency)} on {formatDay(item.baseline.date)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
              {item.key}
            </span>
            {flagTags(item.flags).map((t) => (
              <Tag key={t.flag} tone={t.tone}>
                {t.label}
              </Tag>
            ))}
          </div>
        </div>
      </DialogBody>

      {scenario && (
        <Toggle
          on={form.exclude}
          label="Leave it out of this scenario"
          detail="The line stays in the grid, crossed out, and adds nothing to any total."
          onChange={(next) => setForm((f) => ({ ...f, exclude: next }))}
        />
      )}

      {!(scenario && form.exclude) && (
        <>
          <FormField label={`AMOUNT · ${item.currency}`} error={check.errors.amount}>
            <input
              className="input mono"
              aria-label="Amount"
              inputMode="decimal"
              style={inputStyle}
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            />
          </FormField>
          <FormField
            label="DATE"
            note={scenario ? 'Today or later.' : undefined}
            error={check.errors.date}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="date"
                className="input mono"
                aria-label="Date"
                min={scenario ? today : undefined}
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
              {QUICK_SHIFTS.map((n) => {
                const target = shiftedDate(item.date, n, today);
                return (
                  <button
                    key={n}
                    type="button"
                    className="btn"
                    aria-label={`Move to ${formatDay(target)} (+${n} days)`}
                    title={formatDay(target)}
                    aria-pressed={form.date === target}
                    onClick={() => setForm((f) => ({ ...f, date: target }))}
                  >
                    +{n}
                  </button>
                );
              })}
            </div>
            {isValidDate(form.date) && form.date !== item.date && (
              <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                From {shortDay(item.date)} to {shortDay(form.date)}.
              </div>
            )}
          </FormField>
        </>
      )}

      {scenario && adjusted && (
        <div>
          <button
            type="button"
            className="btn"
            disabled={submit.busy}
            onClick={() => save({ kind: 'unadjust', itemKey: item.key })}
          >
            Undo this adjustment
          </button>
        </div>
      )}

      {check.errors.form && (
        <div role="alert" style={{ fontSize: 13.5, color: 'var(--fail)' }}>
          {check.errors.form}
        </div>
      )}
      {check.unchanged && (
        <div style={{ fontSize: 13, color: 'var(--dim)' }}>Nothing changed yet.</div>
      )}
      {submit.error && <RefusalNote error={submit.error} nameOf={(key) => (key === item.key ? item.name : null)} />}
    </Dialog>
  );
}
