import type { Frequency, WeekendRule } from '../../api/schedules';
import { FREQUENCIES, WEEKEND_RULES } from '../../api/schedules';
import { FormField, inputStyle } from '../../components/FormField';
import { Segmented } from '../../components/ui';
import type { FieldErrors } from '../../lib/validation';
import { FREQUENCY_LABEL, WEEKEND_RULE_LABEL } from './scheduleForm';
import type { EndKind, ScheduleField, ScheduleForm } from './scheduleForm';

type CadenceField = 'frequency' | 'intervalCount' | 'startDate' | 'endKind' | 'occurrenceCount' | 'endDate' | 'weekendRule';

/**
 * When a schedule happens: how often, from when, until when, and what a weekend date does.
 * One end or none — the choice makes "both" impossible to send (D22).
 */
export function CadenceFields({
  form,
  setForm,
  errors,
  touch,
  shown,
  hide = [],
  startNote,
}: {
  form: ScheduleForm;
  setForm: (update: (f: ScheduleForm) => ScheduleForm) => void;
  errors: FieldErrors<ScheduleField>;
  touch: (field: ScheduleField) => void;
  shown: (field: ScheduleField, error: string | undefined) => string | null;
  hide?: CadenceField[];
  startNote?: string;
}) {
  const set = (key: CadenceField, value: string) => {
    touch(key);
    setForm((f) => ({ ...f, [key]: value }));
  };
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 12 }}>
        <FormField label="HOW OFTEN" error={shown('frequency', errors.frequency)}>
          <select
            className="input"
            aria-label="How often"
            style={inputStyle}
            value={form.frequency}
            onChange={(e) => set('frequency', e.target.value as Frequency)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABEL[f]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="EVERY" error={shown('intervalCount', errors.intervalCount)}>
          <input
            className="input mono"
            aria-label="Interval"
            inputMode="numeric"
            style={inputStyle}
            value={form.intervalCount}
            onChange={(e) => set('intervalCount', e.target.value)}
          />
        </FormField>
      </div>

      {!hide.includes('startDate') && (
        <FormField label="FIRST DATE" note={startNote} error={shown('startDate', errors.startDate)}>
          <input
            type="date"
            className="input mono"
            aria-label="First date"
            style={inputStyle}
            value={form.startDate}
            onChange={(e) => set('startDate', e.target.value)}
          />
        </FormField>
      )}

      <FormField label="ENDS">
        <Segmented<EndKind>
          ariaLabel="Ends"
          compact
          options={[
            { id: 'none', label: 'Never' },
            { id: 'count', label: 'After a number' },
            { id: 'date', label: 'On a date' },
          ]}
          value={form.endKind}
          onChange={(next) => set('endKind', next)}
        />
      </FormField>
      {form.endKind === 'count' && (
        <FormField label="OCCURRENCES" note="Counted from the first date." error={shown('occurrenceCount', errors.occurrenceCount)}>
          <input
            className="input mono"
            aria-label="Occurrences"
            inputMode="numeric"
            style={inputStyle}
            value={form.occurrenceCount}
            onChange={(e) => set('occurrenceCount', e.target.value)}
          />
        </FormField>
      )}
      {form.endKind === 'date' && (
        <FormField label="LAST DATE" note="The last date an occurrence may fall on." error={shown('endDate', errors.endDate)}>
          <input
            type="date"
            className="input mono"
            aria-label="Last date"
            style={inputStyle}
            value={form.endDate}
            onChange={(e) => set('endDate', e.target.value)}
          />
        </FormField>
      )}

      <FormField label="ON A WEEKEND">
        <select
          className="input"
          aria-label="On a weekend"
          style={inputStyle}
          value={form.weekendRule}
          onChange={(e) => set('weekendRule', e.target.value as WeekendRule)}
        >
          {WEEKEND_RULES.map((r) => (
            <option key={r} value={r}>
              {WEEKEND_RULE_LABEL[r]}
            </option>
          ))}
        </select>
      </FormField>
    </>
  );
}
