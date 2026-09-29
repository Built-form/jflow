import { useState } from 'react';
import { api } from '../../api';
import type { Category, Direction } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSession } from '../../app/session';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { ChoiceButton, Empty, ErrorNote, Loading, Tag } from '../../components/ui';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { changedOnly, validateCategory } from '../../lib/validation';
import type { CategoryForm } from '../../lib/validation';
import { RemoveDialog } from './RemoveDialog';

const COLUMNS = 'minmax(0, 1fr) 140px 80px 150px';

export const DIRECTION_LABEL: Record<Direction, string> = { in: 'Money in', out: 'Money out' };

/** The server's order: direction, then `sort_order`, then name (§6.4). */
export function sortCategories(list: Category[]): Category[] {
  return [...list].sort(
    (a, b) => a.direction.localeCompare(b.direction) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

export function CategoriesSection() {
  const list = useQuery(() => api.categories.list(), []);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [removing, setRemoving] = useState<Category | null>(null);

  if (!list.data) {
    return list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : <Loading what="Categories" />;
  }
  const rows = sortCategories(list.data.data);

  return (
    <section aria-label="Categories" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div className="explainer">
          The forecast's rows: every item and schedule sits under one category, and goes the
          same way as it — money in or money out.
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          Add a category
        </button>
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}

      <div className="card-table">
        <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
          <div>NAME</div>
          <div>DIRECTION</div>
          <div>ORDER</div>
          <div />
        </div>
        {rows.length === 0 && <Empty>No categories yet.</Empty>}
        {rows.map((category) => (
          <div key={category.id} className="table-row" style={{ gridTemplateColumns: COLUMNS }}>
            <div style={{ fontSize: 14.5 }}>{category.name}</div>
            <div>
              <Tag tone={category.direction === 'in' ? 'live' : 'idle'}>{DIRECTION_LABEL[category.direction].toUpperCase()}</Tag>
            </div>
            <div className="mono" style={{ fontSize: 13, color: 'var(--mut)' }}>
              {category.sortOrder}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => setEditing(category)}>
                edit
              </button>
              <button type="button" className="btn-quiet" style={{ color: 'var(--fail)' }} onClick={() => setRemoving(category)}>
                remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <CategoryDialog
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            updateList(list, (current) => upsertById(current, row));
            setEditing(null);
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          kicker="CATEGORIES"
          title={`Remove ${removing.name}?`}
          warning="A category that items or schedules still use cannot be removed."
          remove={() => api.categories.remove(removing.id, removing.rowVersion)}
          onRemoved={() => {
            updateList(list, (current) => removeById(current, removing.id));
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

export function CategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: Category | null;
  onClose: () => void;
  onSaved: (row: Category) => void;
}) {
  const { enums } = useSession();
  const directions = (enums?.directions?.length ? enums.directions : ['in', 'out']) as Direction[];
  const [form, setForm] = useState<CategoryForm>({
    name: category?.name ?? '',
    direction: category?.direction ?? '',
    sortOrder: category ? String(category.sortOrder) : '',
  });
  const { touch, shown } = useTouched<keyof CategoryForm>();
  const submit = useSubmit();
  const checked = validateCategory(form);
  const changes = category && checked.ok ? changedOnly(category, checked.body) : null;
  const nothingChanged = changes !== null && Object.keys(changes).length === 0;

  const save = () => {
    if (!checked.ok) return;
    void submit.run(async () => {
      const row = category
        ? await api.categories.update(category.id, changes ?? {}, category.rowVersion)
        : await api.categories.create(checked.body);
      onSaved(row);
    });
  };

  return (
    <Dialog
      kicker="CATEGORIES"
      title={category ? `Edit ${category.name}` : 'Add a category'}
      confirmLabel={category ? 'Save' : 'Add it'}
      confirmDisabled={!checked.ok || nothingChanged}
      busy={submit.busy}
      warning={
        changes?.direction !== undefined
          ? 'The direction can only change while no item or schedule uses the category.'
          : undefined
      }
      warnTone="warn"
      onConfirm={save}
      onClose={onClose}
    >
      <FormField label="NAME" error={shown('name', checked.errors.name)}>
        <input
          className="input"
          aria-label="Name"
          style={inputStyle}
          value={form.name}
          onChange={(e) => {
            touch('name');
            setForm((f) => ({ ...f, name: e.target.value }));
          }}
        />
      </FormField>
      <FormField label="DIRECTION" error={shown('direction', checked.errors.direction)}>
        <div role="radiogroup" aria-label="Direction" style={{ display: 'flex', gap: 9 }}>
          {directions.map((d) => (
            <ChoiceButton
              key={d}
              selected={form.direction === d}
              label={DIRECTION_LABEL[d] ?? d}
              onClick={() => {
                touch('direction');
                setForm((f) => ({ ...f, direction: d }));
              }}
            />
          ))}
        </div>
      </FormField>
      <FormField label="ORDER" note="Lower comes first. Blank is 0." error={shown('sortOrder', checked.errors.sortOrder)}>
        <input
          className="input mono"
          aria-label="Order"
          inputMode="numeric"
          style={inputStyle}
          value={form.sortOrder}
          onChange={(e) => {
            touch('sortOrder');
            setForm((f) => ({ ...f, sortOrder: e.target.value }));
          }}
        />
      </FormField>
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
