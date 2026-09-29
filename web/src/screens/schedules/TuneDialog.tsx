import { useState } from 'react';
import { schedules } from '../../api/schedules';
import type { Instance, Schedule, TuneBody } from '../../api/schedules';
import type { SettleMode } from '../../api/items';
import { useSubmit } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { ErrorNote, Segmented } from '../../components/ui';
import { formatDay, isValidDate } from '../../lib/dates';
import { formatDecimal, parseMoneyInput } from '../../lib/money';
import { NOTE_MAX } from '../../components/PayDialog';
import { sameDecimal } from '../items/itemForm';
import { SCHEDULES_KICKER } from './ScheduleDialog';
import { hasPaymentState } from './scheduleForm';

export interface TuneForm {
  amount: string;
  dueDate: string;
  note: string;
  settleMode: '' | SettleMode;
  status: 'expected' | 'skipped';
}

export function tuneFormOf(instance: Instance): TuneForm {
  const o = instance.override;
  return {
    amount: o?.amount ?? '',
    dueDate: o?.dueDate ?? '',
    note: o?.note ?? '',
    settleMode: o?.settleMode ?? '',
    status: o?.status === 'skipped' ? 'skipped' : 'expected',
  };
}

type TuneField = 'amount' | 'dueDate' | 'note';

/**
 * The form → the PUT body: only what changed from the override row, `null` for a field
 * cleared back to the schedule's (§6.9). With payment state, `amount` and `status` are not
 * sent (`OVERRIDE_HAS_PAYMENT`).
 */
export function checkTune(
  instance: Instance,
  form: TuneForm,
): { body: TuneBody; errors: Partial<Record<TuneField, string>>; empty: boolean } {
  const o = instance.override;
  const paid = hasPaymentState(instance);
  const errors: Partial<Record<TuneField, string>> = {};
  const body: TuneBody = {};

  let amount: string | null = null;
  if (form.amount.trim()) {
    const typed = parseMoneyInput(form.amount, { allowZero: false });
    if (typed.kind === 'ok') amount = typed.decimal;
    else if (typed.kind === 'error') errors.amount = typed.error;
  }
  if (!paid && !sameDecimal(amount, o?.amount ?? null)) body.amount = amount;

  const dueDate = form.dueDate.trim() || null;
  if (dueDate && !isValidDate(dueDate)) errors.dueDate = 'Pick a date, or clear it for the predicted one.';
  if (dueDate !== (o?.dueDate ?? null)) body.dueDate = dueDate;

  const note = form.note.trim() || null;
  if (note && note.length > NOTE_MAX) errors.note = `At most ${NOTE_MAX} characters.`;
  if (note !== (o?.note ?? null)) body.note = note;

  const settleMode = form.settleMode || null;
  if (settleMode !== (o?.settleMode ?? null)) body.settleMode = settleMode;

  const status = form.status === 'skipped' ? 'skipped' : null;
  const current = o?.status === 'skipped' ? 'skipped' : null;
  if (!paid && status !== current) body.status = status;

  // After the merge nothing tuned is left: the server answers 400 ("DELETE reverts").
  const empty = !paid && !amount && !dueDate && !note && !settleMode && !status;
  return { body, errors, empty };
}

/**
 * Tune one instance: its amount, date, note, settle mode, or skip it. Only this instance
 * changes; the series is untouched. Blank means "the schedule's".
 */
export function TuneDialog({
  schedule,
  instance,
  onSaved,
  onClose,
}: {
  schedule: Schedule;
  instance: Instance;
  onSaved: (next: Instance) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<TuneForm>(() => tuneFormOf(instance));
  const submit = useSubmit();
  const paid = hasPaymentState(instance);
  const check = checkTune(instance, form);
  const nothing = Object.keys(check.body).length === 0;
  const invalid = Object.keys(check.errors).length > 0;
  const set = (key: keyof TuneForm) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };
  const paidNote = 'It has a payment recorded: the amount and skip change only after unpaying it.';

  return (
    <Dialog
      kicker={`${SCHEDULES_KICKER} · ${schedule.name.toUpperCase()}`}
      title={`Tune ${formatDay(instance.naturalDate)}`}
      confirmLabel="Save"
      confirmDisabled={nothing || invalid || check.empty}
      busy={submit.busy}
      warning={
        check.empty && instance.tuned && !nothing
          ? 'Nothing would be left tuned. Close this and use revert to go back to the prediction.'
          : undefined
      }
      onConfirm={() =>
        void submit.run(async () => {
          const baseVersion = instance.override?.rowVersion;
          onSaved(await schedules.tune(schedule.id, instance.naturalDate, check.body, baseVersion));
        })
      }
      onClose={onClose}
    >
      <FormField
        label={`AMOUNT · ${instance.currency}`}
        note={paid ? paidNote : `Blank: the schedule's ${formatDecimal(schedule.amount, schedule.currency)}.`}
        error={check.errors.amount}
      >
        <input
          className="input mono"
          aria-label="Tuned amount"
          inputMode="decimal"
          disabled={paid}
          placeholder={schedule.amount}
          style={inputStyle}
          value={form.amount}
          onChange={set('amount')}
        />
      </FormField>
      <FormField
        label="DUE ON"
        note={
          instance.override?.dueDate
            ? 'Blank: back to the predicted date. A date set here is kept exactly, weekend or not.'
            : `Blank: the predicted ${formatDay(instance.dueDate)}. A date set here is kept exactly, weekend or not.`
        }
        error={check.errors.dueDate}
      >
        <input
          type="date"
          className="input mono"
          aria-label="Tuned date"
          style={inputStyle}
          value={form.dueDate}
          onChange={set('dueDate')}
        />
      </FormField>
      <FormField
        label="SETTLES"
        note={
          form.settleMode === ''
            ? `As the schedule: ${schedule.settleMode === 'auto' ? 'automatically' : 'by hand'}.`
            : form.settleMode === 'manual'
              ? 'By hand for this instance only: it stays owed until marked paid.'
              : 'Automatically for this instance only.'
        }
      >
        <Segmented<'' | SettleMode>
          ariaLabel="Settles"
          compact
          options={[
            { id: '', label: 'As the schedule' },
            { id: 'auto', label: 'Automatically' },
            { id: 'manual', label: 'By hand' },
          ]}
          value={form.settleMode}
          onChange={(next) => setForm((f) => ({ ...f, settleMode: next }))}
        />
      </FormField>
      <FormField label="HAPPENS" note={paid ? paidNote : undefined}>
        {paid ? (
          <div className="mono" style={{ fontSize: 13.5 }}>
            Yes
          </div>
        ) : (
          <Segmented<'expected' | 'skipped'>
            ariaLabel="Happens"
            compact
            options={[
              { id: 'expected', label: 'Yes' },
              { id: 'skipped', label: 'Skip this one' },
            ]}
            value={form.status}
            onChange={(next) => setForm((f) => ({ ...f, status: next }))}
          />
        )}
      </FormField>
      <FormField label="NOTE" error={check.errors.note}>
        <input className="input" aria-label="Tune note" style={inputStyle} value={form.note} onChange={set('note')} />
      </FormField>
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
