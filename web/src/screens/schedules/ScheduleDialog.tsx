import { useState } from 'react';
import { schedules } from '../../api/schedules';
import type { Schedule, ScheduleStructure } from '../../api/schedules';
import type { Account, Category } from '../../api/types';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { ErrorNote } from '../../components/ui';
import { CommonFields } from '../items/CommonFields';
import type { CommonField } from '../items/itemForm';
import { CadenceFields } from './CadenceFields';
import {
  blankScheduleForm,
  createBody,
  scheduleChanges,
  scheduleToForm,
  structureLockMessage,
  structureLockOf,
  validateSchedule,
} from './scheduleForm';
import type { ScheduleField, ScheduleForm } from './scheduleForm';

export const SCHEDULES_KICKER = 'SCHEDULES';

/**
 * Add a schedule, or edit one. Name, counterparty, category and notes always edit in place.
 * The structure (amount, currency, account, cadence, ends, weekend rule, settle mode — D37)
 * edits in place only while the server says the schedule is not `structureLocked`; after
 * that a change is a split, and this dialog says so and offers "Split from…" carrying the
 * change over. A `SCHEDULE_STRUCTURE_LOCKED` answer (the flag was stale) reads the same.
 */
export function ScheduleDialog({
  schedule,
  accounts,
  categories,
  today,
  defaultAccount,
  onSaved,
  onSplit,
  onClose,
}: {
  schedule: Schedule | null;
  accounts: Account[];
  categories: Category[];
  today: string;
  defaultAccount: Account | null;
  onSaved: (row: Schedule) => void;
  /** Open the split wizard carrying these structural changes. */
  onSplit?: (changes: Partial<ScheduleStructure>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ScheduleForm>(() =>
    schedule ? scheduleToForm(schedule) : blankScheduleForm(today, defaultAccount),
  );
  const { touch, shown } = useTouched<ScheduleField>();
  const submit = useSubmit();
  // A refusal answers the form as it was sent; a change to the form retires it.
  const edit = (update: (f: ScheduleForm) => ScheduleForm) => {
    submit.clear();
    setForm(update);
  };
  const checked = validateSchedule(form, { categories });
  const changes = schedule && checked.ok ? scheduleChanges(schedule, checked.values) : null;
  const structuralFields = changes ? Object.keys(changes.structural) : [];
  const nothingChanged =
    changes !== null && Object.keys(changes.descriptive).length === 0 && structuralFields.length === 0;
  const lockedAhead = !!schedule?.structureLocked && structuralFields.length > 0;
  const serverLock = structureLockOf(submit.error);

  const save = () => {
    if (!checked.ok) return;
    const values = checked.values;
    void submit.run(async () => {
      if (schedule) {
        const body = { ...changes?.descriptive, ...changes?.structural };
        onSaved(await schedules.update(schedule.id, body, schedule.rowVersion));
      } else {
        onSaved(await schedules.create(createBody(values)));
      }
    });
  };

  const lockText = serverLock
    ? structureLockMessage(structuralFields, serverLock)
    : lockedAhead
      ? structureLockMessage(structuralFields)
      : null;

  const warning = lockText ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="structure-lock">
      <div>{lockText}</div>
      {onSplit && changes && (
        <div>
          <button type="button" className="btn" onClick={() => onSplit(changes.structural)}>
            Split from…
          </button>
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <Dialog
      kicker={SCHEDULES_KICKER}
      title={schedule ? `Edit ${schedule.name}` : 'Add a schedule'}
      width={580}
      confirmLabel={schedule ? 'Save' : 'Add it'}
      confirmDisabled={!checked.ok || nothingChanged || lockedAhead || !!serverLock}
      busy={submit.busy}
      warning={warning}
      warnTone="warn"
      onConfirm={save}
      onClose={onClose}
    >
      <CommonFields
        form={form}
        setForm={edit}
        errors={checked.errors}
        touch={touch as (field: CommonField) => void}
        shown={shown as (field: CommonField, error: string | undefined) => string | null}
        accounts={accounts}
        categories={categories}
      />
      <CadenceFields form={form} setForm={edit} errors={checked.errors} touch={touch} shown={shown} />
      {submit.error && !serverLock && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
