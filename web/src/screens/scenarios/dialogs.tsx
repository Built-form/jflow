import { useState } from 'react';
import type { Company } from '../../api/types';
import type { ApplyResult, RebaseResult, Scenario, ScenarioCreate } from '../../api/scenarios';
import { scenarios } from '../../api/scenarios';
import { sortCompanies } from '../../app/companyFilter';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Toggle } from '../../components/ui';
import { plural } from '../../lib/format';
import { RefusalNote } from './RefusalNote';

const NAME_MAX = 255;

/** A scenario's name: required, at most 255 characters, trimmed as sent. */
export function checkScenarioName(raw: string): { name: string; error: string | null } {
  const name = raw.trim();
  if (!name) return { name, error: 'Give it a name.' };
  if (name.length > NAME_MAX) return { name, error: `At most ${NAME_MAX} characters.` };
  return { name, error: null };
}

export function CreateScenarioDialog({
  companies,
  defaultCompanyId,
  onClose,
  onCreated,
}: {
  companies: Company[];
  defaultCompanyId: number | null;
  onClose: () => void;
  onCreated: (row: Scenario) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [companyId, setCompanyId] = useState<number | null>(defaultCompanyId);
  const { touch, shown } = useTouched<'name'>();
  const submit = useSubmit();
  const checked = checkScenarioName(name);

  const save = () => {
    if (checked.error) return;
    const body: ScenarioCreate = { name: checked.name };
    if (description.trim()) body.description = description.trim();
    if (companyId !== null) body.companyId = companyId;
    void submit.run(async () => onCreated(await scenarios.create(body)));
  };

  return (
    <Dialog
      kicker="SCENARIOS"
      title="New scenario"
      confirmLabel="Create it"
      confirmDisabled={!!checked.error}
      busy={submit.busy}
      onConfirm={save}
      onClose={onClose}
    >
      <DialogBody>
        A named what-if. While it is open, changes on the Forecast are written to it instead of
        the real plan; apply it when you want them for real.
      </DialogBody>
      <FormField label="NAME" error={shown('name', checked.error ?? undefined)}>
        <input
          className="input"
          aria-label="Name"
          style={inputStyle}
          value={name}
          onChange={(e) => {
            touch('name');
            setName(e.target.value);
          }}
        />
      </FormField>
      <FormField label="DESCRIPTION" note="Optional.">
        <textarea
          className="textarea"
          aria-label="Description"
          rows={3}
          style={inputStyle}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      <FormField label="COMPANY" note="Which company the forecast shows when this scenario is opened. It limits nothing else.">
        <select
          className="input"
          aria-label="Company"
          style={inputStyle}
          value={companyId === null ? 'all' : String(companyId)}
          onChange={(e) => setCompanyId(e.target.value === 'all' ? null : Number(e.target.value))}
        >
          <option value="all">All companies</option>
          {sortCompanies(companies).map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </FormField>
      {submit.error && <RefusalNote error={submit.error} />}
    </Dialog>
  );
}

export function DuplicateScenarioDialog({
  source,
  onClose,
  onDuplicated,
}: {
  source: Scenario;
  onClose: () => void;
  onDuplicated: (row: Scenario) => void;
}) {
  const [name, setName] = useState(`${source.name} (copy)`);
  const submit = useSubmit();
  const checked = checkScenarioName(name);
  return (
    <Dialog
      kicker={`SCENARIO · ${source.name.toUpperCase()}`}
      title="Duplicate it"
      confirmLabel="Duplicate"
      confirmDisabled={!!checked.error}
      busy={submit.busy}
      onConfirm={() => void submit.run(async () => onDuplicated(await scenarios.duplicate(source.id, checked.name)))}
      onClose={onClose}
    >
      <DialogBody>
        A new draft with a copy of every adjustment, exactly as they are. Anything the real plan
        has changed since shows as stale on the copy.
      </DialogBody>
      <FormField label="NAME" error={checked.error}>
        <input className="input" aria-label="Name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      {submit.error && <RefusalNote error={submit.error} />}
    </Dialog>
  );
}

export function RebaseDialog({
  scenario,
  staleCount,
  onClose,
  onRebased,
}: {
  scenario: Scenario;
  staleCount: number;
  onClose: () => void;
  onRebased: (result: RebaseResult) => void;
}) {
  const [dropStale, setDropStale] = useState(false);
  const submit = useSubmit();
  return (
    <Dialog
      kicker={`SCENARIO · ${scenario.name.toUpperCase()}`}
      title="Rebase on the real plan"
      confirmLabel={dropStale ? 'Rebase and drop' : 'Rebase'}
      busy={submit.busy}
      warnTone={dropStale ? 'warn' : 'idle'}
      warning={
        dropStale
          ? 'Adjustments whose item is settled or gone, or whose new date has passed, are deleted from this scenario.'
          : undefined
      }
      onConfirm={() => void submit.run(async () => onRebased(await scenarios.rebase(scenario.id, dropStale)))}
      onClose={onClose}
    >
      <DialogBody>
        Every adjustment takes the real item's current date and amount as its new starting point
        — so one whose base changed can be applied again. Settled or missing items, and new dates
        that have passed, cannot be rebased.
        {staleCount > 0 && ` ${plural(staleCount, 'adjustment')} ${staleCount === 1 ? 'is' : 'are'} stale now.`}
      </DialogBody>
      <Toggle
        on={dropStale}
        label="Drop what can't be rebased"
        detail="Delete the adjustments marked SETTLED, MISSING or DATE PASSED."
        onChange={setDropStale}
      />
      {submit.error && <RefusalNote error={submit.error} />}
    </Dialog>
  );
}

export function ApplyDialog({
  scenario,
  staleCount,
  nameOf,
  onClose,
  onApplied,
  onRefused,
}: {
  scenario: Scenario;
  staleCount: number;
  nameOf: (itemKey: string) => string | null;
  onClose: () => void;
  onApplied: (result: ApplyResult) => void;
  /** The server refused (e.g. `SCENARIO_STALE`): the screen re-reads what is stale now. */
  onRefused: () => void;
}) {
  const submit = useSubmit();
  const apply = () =>
    void submit
      .run(async () => onApplied(await scenarios.apply(scenario.id, scenario.rowVersion)))
      .then((ok) => {
        if (!ok) onRefused();
      });
  return (
    <Dialog
      kicker={`SCENARIO · ${scenario.name.toUpperCase()}`}
      title="Apply to the real plan"
      confirmLabel="Apply it"
      busy={submit.busy}
      warnTone="warn"
      warning={
        staleCount > 0
          ? `${plural(staleCount, 'adjustment')} ${staleCount === 1 ? 'is' : 'are'} stale. Apply is all or nothing, so it will be refused until they are rebased or removed.`
          : 'Every adjustment is written to the real items and instances, all at once or not at all. The scenario is then applied and can no longer change.'
      }
      onConfirm={apply}
      onClose={onClose}
    >
      <DialogBody>
        Moves and amount changes become real; lines left out are marked skipped. Each change is
        recorded against this scenario.
      </DialogBody>
      {submit.error && <RefusalNote error={submit.error} nameOf={nameOf} />}
    </Dialog>
  );
}

export function DiscardDialog({
  scenario,
  onClose,
  onDiscarded,
}: {
  scenario: Scenario;
  onClose: () => void;
  onDiscarded: (row: Scenario) => void;
}) {
  const submit = useSubmit();
  return (
    <Dialog
      kicker={`SCENARIO · ${scenario.name.toUpperCase()}`}
      title={scenario.status === 'draft' ? 'Discard it' : 'Archive it'}
      confirmLabel={scenario.status === 'draft' ? 'Discard' : 'Archive'}
      busy={submit.busy}
      warnTone="warn"
      warning="Archiving is final: an archived scenario can be read and duplicated, never changed or applied."
      onConfirm={() =>
        void submit.run(async () => onDiscarded(await scenarios.update(scenario.id, { status: 'archived' }, scenario.rowVersion)))
      }
      onClose={onClose}
    >
      <DialogBody>
        {scenario.status === 'draft'
          ? 'Nothing is written to the real plan. The scenario is archived with its adjustments, as a record of what was tried.'
          : 'The scenario moves out of the working list. What it applied stays applied.'}
      </DialogBody>
      {submit.error && <RefusalNote error={submit.error} />}
    </Dialog>
  );
}
