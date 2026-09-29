import { useState } from 'react';
import { schedules } from '../../api/schedules';
import type { EndResult, Schedule, ScheduleStructure, SettleMode, SplitResult } from '../../api';
import type { Account, Category } from '../../api/types';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { ErrorNote, Segmented } from '../../components/ui';
import { formatDay, isValidDate } from '../../lib/dates';
import { formatDecimal } from '../../lib/money';
import { SETTLE_MODE_HELP } from '../items/itemForm';
import { CadenceFields } from './CadenceFields';
import { SCHEDULES_KICKER } from './ScheduleDialog';
import {
  FIELD_LABEL,
  cadenceLabel,
  conflictConfirmLabel,
  endLabel,
  resendFlags,
  scheduleChanges,
  scheduleToForm,
  splitConflictOf,
  validateSchedule,
} from './scheduleForm';
import type { DropFlags, ScheduleField, ScheduleForm, SplitConflict } from './scheduleForm';

/**
 * One split or end in flight, and the three 409s it may answer (§6.8, §10.5), turned into
 * what the person is asked:
 *  - `SCHEDULE_HAS_PAYMENTS` is a refusal — paid instances cannot be moved; nothing resends.
 *  - `SCHEDULE_HAS_OVERRIDES` asks to drop those tunes → resend with `dropOverrides: true`.
 *  - `SCHEDULE_HAS_ADJUSTMENTS` asks to drop those draft-scenario adjustments → resend with
 *    `dropAdjustments: true`.
 * An answer given once is kept for the resends that follow it; changing the request
 * forgets every answer, because they were given about the request as it was.
 */
export function useDropFlow<R>(send: (flags: DropFlags) => Promise<R>, onDone: (result: R) => void) {
  const [flags, setFlags] = useState<DropFlags>({});
  const [conflict, setConflict] = useState<SplitConflict | null>(null);
  const submit = useSubmit();

  const go = () => {
    const next = conflict ? resendFlags(conflict, flags) : flags;
    if (next === null) return;
    setFlags(next);
    void submit.run(async () => {
      try {
        const result = await send(next);
        setConflict(null);
        onDone(result);
      } catch (e) {
        const found = splitConflictOf(e);
        if (!found) throw e;
        setConflict(found);
      }
    });
  };

  const reset = () => {
    setConflict(null);
    setFlags({});
    submit.clear();
  };

  return { conflict, flags, go, reset, busy: submit.busy, error: submit.error };
}

function DateList({ dates }: { dates: string[] }) {
  return (
    <ul data-testid="conflict-dates" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
      {dates.map((d) => (
        <li key={d} className="mono" style={{ fontSize: 13 }}>
          {formatDay(d)}
        </li>
      ))}
    </ul>
  );
}

/** What a conflict asks, in words, with the dates or scenarios it names. */
export function ConflictPanel({ conflict, action }: { conflict: SplitConflict; action: 'split' | 'end' }) {
  const doing = action === 'split' ? 'Splitting' : 'Ending it';
  if (conflict.kind === 'payments') {
    return (
      <div data-testid="conflict" data-kind="payments">
        <strong>These instances have payments recorded, so the schedule cannot be {action === 'split' ? 'split' : 'ended'} there.</strong>{' '}
        Unpay them first, or pick a later date.
        <DateList dates={conflict.naturalDates} />
      </div>
    );
  }
  if (conflict.kind === 'overrides') {
    return (
      <div data-testid="conflict" data-kind="overrides">
        <strong>These instances were tuned.</strong> {doing} drops the tunes (amount, date, note, settle mode)
        {action === 'split' ? ' — the new schedule predicts them afresh.' : ' along with the instances.'}
        <DateList dates={conflict.naturalDates} />
      </div>
    );
  }
  return (
    <div data-testid="conflict" data-kind="adjustments">
      <strong>Draft scenarios adjust instances that {action === 'split' ? 'the new schedule cannot carry over' : 'will no longer exist'}.</strong>{' '}
      {doing} drops these adjustments from the scenarios:
      <ul data-testid="conflict-adjustments" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {conflict.adjustments.map((a) => (
          <li key={`${a.scenarioId}-${a.itemKey}`} style={{ fontSize: 13.5 }}>
            {a.scenarioName} — <span className="mono">{formatDay(a.naturalDate)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The natural dates on offer: loaded instances after the first active one (D21). */
export function splitDateOptions(schedule: Schedule, naturalDates: string[]): string[] {
  const first = schedule.activeFrom ?? schedule.startDate;
  return [...new Set(naturalDates)].filter((d) => d > first).sort();
}

function firstOnOrAfter(options: string[], day: string): string {
  return options.find((d) => d >= day) ?? options[0] ?? '';
}

/** Structural changes carried in from the edit dialog, laid over the schedule's own form. */
function withChanges(form: ScheduleForm, changes: Partial<ScheduleStructure>): ScheduleForm {
  const next = { ...form };
  if (changes.amount !== undefined) next.amount = changes.amount;
  if (changes.currency !== undefined) next.currency = changes.currency;
  if (changes.accountId !== undefined) next.accountId = String(changes.accountId);
  if (changes.frequency !== undefined) next.frequency = changes.frequency;
  if (changes.intervalCount !== undefined) next.intervalCount = String(changes.intervalCount);
  if (changes.startDate !== undefined) next.startDate = changes.startDate;
  if (changes.weekendRule !== undefined) next.weekendRule = changes.weekendRule;
  if (changes.settleMode !== undefined) next.settleMode = changes.settleMode;
  if (changes.occurrenceCount !== undefined || changes.endDate !== undefined) {
    const count = changes.occurrenceCount ?? null;
    const end = changes.endDate ?? null;
    next.endKind = count != null ? 'count' : end ? 'date' : 'none';
    next.occurrenceCount = count != null ? String(count) : '';
    next.endDate = end ?? '';
  }
  return next;
}

/**
 * Split a schedule from one of its natural dates (D21, §10.5): it ends the day before, and a
 * successor carries the changes from that date on. Only structural fields change here —
 * descriptive ones edit in place.
 */
export function SplitWizard({
  schedule,
  naturalDates,
  today,
  accounts,
  categories,
  initialChanges,
  onDone,
  onClose,
}: {
  schedule: Schedule;
  /** Natural dates of the loaded instances — the candidates for the split. */
  naturalDates: string[];
  today: string;
  accounts: Account[];
  categories: Category[];
  initialChanges?: Partial<ScheduleStructure>;
  onDone: (result: SplitResult) => void;
  onClose: () => void;
}) {
  const options = splitDateOptions(schedule, naturalDates);
  const [from, setFrom] = useState(() => firstOnOrAfter(options, today));
  const [form, setForm] = useState<ScheduleForm>(() => withChanges(scheduleToForm(schedule), initialChanges ?? {}));
  const { touch, shown } = useTouched<ScheduleField>();
  const checked = validateSchedule(form, { categories });
  const changes = checked.ok ? scheduleChanges(schedule, checked.values).structural : {};
  const changed = Object.keys(changes) as (keyof ScheduleStructure)[];
  const flow = useDropFlow(
    (flags) => schedules.split(schedule.id, { fromNaturalDate: from, changes, ...flags }, schedule.rowVersion),
    onDone,
  );

  const edit = (update: (f: ScheduleForm) => ScheduleForm) => {
    flow.reset();
    setForm(update);
  };
  const text = (key: 'amount' | 'currency') => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      const value = e.target.value;
      touch(key);
      edit((f) => ({ ...f, [key]: value }));
    },
  });

  const refused = flow.conflict?.kind === 'payments';
  const ready = checked.ok && changed.length > 0 && isValidDate(from);

  return (
    <Dialog
      kicker={SCHEDULES_KICKER}
      title={`Split ${schedule.name}`}
      width={600}
      confirmLabel={flow.conflict ? conflictConfirmLabel(flow.conflict, 'split') : 'Split'}
      confirmDisabled={!ready || refused}
      busy={flow.busy}
      warning={flow.conflict ? <ConflictPanel conflict={flow.conflict} action="split" /> : undefined}
      warnTone={refused ? 'fail' : 'warn'}
      onConfirm={flow.go}
      onClose={onClose}
    >
      <DialogBody>
        The schedule ends the day before the date you pick, and a new schedule carries the
        changes from that date on. Everything before it — paid, tuned or assumed — stays as it
        was.
      </DialogBody>

      <FormField
        label="SPLIT FROM"
        note={options.length === 0 ? 'No later instance in the loaded window — widen it on the schedule first.' : 'The first instance the new schedule covers.'}
      >
        {options.length > 0 ? (
          <select
            className="input mono"
            aria-label="Split from"
            style={inputStyle}
            value={from}
            onChange={(e) => {
              flow.reset();
              setFrom(e.target.value);
            }}
          >
            {options.map((d) => (
              <option key={d} value={d}>
                {formatDay(d)}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="date"
            className="input mono"
            aria-label="Split from"
            style={inputStyle}
            value={from}
            onChange={(e) => {
              flow.reset();
              setFrom(e.target.value);
            }}
          />
        )}
      </FormField>

      <div className="kicker">FROM THEN ON</div>
      <FormField label="ACCOUNT" error={shown('accountId', checked.errors.accountId)}>
        <select
          className="input"
          aria-label="Account"
          style={inputStyle}
          value={form.accountId}
          onChange={(e) => {
            const value = e.target.value;
            touch('accountId');
            edit((f) => ({ ...f, accountId: value }));
          }}
        >
          {accounts.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.name} · {a.currency}
            </option>
          ))}
        </select>
      </FormField>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 12 }}>
        <FormField label="AMOUNT" error={shown('amount', checked.errors.amount)}>
          <input className="input mono" aria-label="Amount" inputMode="decimal" style={inputStyle} {...text('amount')} />
        </FormField>
        <FormField label="CURRENCY" error={shown('currency', checked.errors.currency)}>
          <input className="input mono" aria-label="Currency" maxLength={3} style={inputStyle} {...text('currency')} />
        </FormField>
      </div>
      <FormField label="SETTLES" note={SETTLE_MODE_HELP[form.settleMode]}>
        <Segmented<SettleMode>
          ariaLabel="Settles"
          options={[
            { id: 'auto', label: 'Automatically' },
            { id: 'manual', label: 'By hand' },
          ]}
          value={form.settleMode}
          onChange={(next) => edit((f) => ({ ...f, settleMode: next }))}
        />
      </FormField>
      <CadenceFields
        form={form}
        setForm={edit}
        errors={checked.errors}
        touch={touch}
        shown={shown}
        startNote="Leave it, with the same cadence and weekend rule, and the new schedule keeps this one's dates. Change the cadence and it starts afresh from here or from the split date."
      />

      <div data-testid="split-summary" style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 1.6 }}>
        {changed.length === 0
          ? 'Change at least one thing: a split with nothing different is not a split.'
          : `Changes from ${formatDay(from)}: ${changed
              .map((f) => `${FIELD_LABEL[f]} ${describeValue(f, schedule[f], schedule, accounts)} → ${describeValue(f, changes[f], schedule, accounts)}`)
              .join('; ')}.`}
      </div>

      {flow.error && <ErrorNote error={flow.error} />}
    </Dialog>
  );
}

function describeValue(
  field: keyof ScheduleStructure,
  value: unknown,
  schedule: Schedule,
  accounts: Account[],
): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (field === 'amount') return formatDecimal(String(value), schedule.currency);
  if (field === 'accountId') return accounts.find((a) => a.id === value)?.name ?? `#${String(value)}`;
  if (field === 'startDate' || field === 'endDate') return formatDay(String(value));
  if (field === 'frequency') return cadenceLabel(value as ScheduleStructure['frequency'], 1).toLowerCase();
  return String(value);
}

/**
 * End a schedule after one of its natural dates (§6.8): that instance is the last. The same
 * guards as a split from the next one; an end never carries adjustments over, so any draft
 * adjustment after it is always asked about.
 */
export function EndWizard({
  schedule,
  naturalDates,
  today,
  onDone,
  onClose,
}: {
  schedule: Schedule;
  naturalDates: string[];
  today: string;
  onDone: (result: EndResult) => void;
  onClose: () => void;
}) {
  const options = [...new Set(naturalDates)].sort();
  // Default: the latest instance on or before today — "stop after the last one that happened".
  const [last, setLast] = useState(() => [...options].reverse().find((d) => d <= today) ?? options[0] ?? '');
  const flow = useDropFlow(
    (flags) => schedules.end(schedule.id, { lastNaturalDate: last, ...flags }, schedule.rowVersion),
    onDone,
  );
  const refused = flow.conflict?.kind === 'payments';

  return (
    <Dialog
      kicker={SCHEDULES_KICKER}
      title={`End ${schedule.name}`}
      confirmLabel={flow.conflict ? conflictConfirmLabel(flow.conflict, 'end') : 'End it'}
      confirmDisabled={!isValidDate(last) || refused}
      busy={flow.busy}
      warning={flow.conflict ? <ConflictPanel conflict={flow.conflict} action="end" /> : undefined}
      warnTone={refused ? 'fail' : 'warn'}
      onConfirm={flow.go}
      onClose={onClose}
    >
      <DialogBody>
        Pick the last instance that happens; nothing after it does. It now {endLabel(schedule).toLowerCase()}. To
        extend a schedule instead, split it with a later end.
      </DialogBody>
      <FormField label="LAST INSTANCE">
        {options.length > 0 ? (
          <select
            className="input mono"
            aria-label="Last instance"
            style={inputStyle}
            value={last}
            onChange={(e) => {
              flow.reset();
              setLast(e.target.value);
            }}
          >
            {options.map((d) => (
              <option key={d} value={d}>
                {formatDay(d)}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="date"
            className="input mono"
            aria-label="Last instance"
            style={inputStyle}
            value={last}
            onChange={(e) => {
              flow.reset();
              setLast(e.target.value);
            }}
          />
        )}
      </FormField>
      {flow.error && <ErrorNote error={flow.error} />}
    </Dialog>
  );
}
