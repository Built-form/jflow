import { useState } from 'react';
import { items } from '../../api/items';
import type { Item } from '../../api/items';
import type { Account, Category } from '../../api/types';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { ErrorNote } from '../../components/ui';
import { CommonFields } from './CommonFields';
import { blankItemForm, itemChanges, itemToForm, moneyLocked, validateItem } from './itemForm';
import type { ItemField, ItemForm } from './itemForm';

export const ITEMS_KICKER = 'INCOME & OUTGOINGS';

/**
 * Add or edit a one-off. On edit only what changed is sent, with the row version read, so
 * a concurrent edit answers `STALE_WRITE` instead of being overwritten. A paid or part-paid
 * item's amount and currency belong to pay/unpay (`ITEM_NOT_EDITABLE`).
 */
export function ItemDialog({
  item,
  accounts,
  categories,
  today,
  defaultAccount,
  onSaved,
  onClose,
}: {
  item: Item | null;
  accounts: Account[];
  categories: Category[];
  today: string;
  defaultAccount: Account | null;
  onSaved: (row: Item) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ItemForm>(() => (item ? itemToForm(item) : blankItemForm(today, defaultAccount)));
  const { touch, shown } = useTouched<ItemField>();
  const submit = useSubmit();
  const checked = validateItem(form, { categories });
  const changes = item && checked.ok ? itemChanges(item, checked.body) : null;
  const nothingChanged = changes !== null && Object.keys(changes).length === 0;
  const locked = moneyLocked(item);
  const lockNote = 'Paid or part-paid: this changes only by unpaying it first.';

  const save = () => {
    if (!checked.ok) return;
    const body = checked.body;
    void submit.run(async () => {
      const row = item ? await items.update(item.id, changes ?? {}, item.rowVersion) : await items.create(body);
      onSaved(row);
    });
  };

  return (
    <Dialog
      kicker={ITEMS_KICKER}
      title={item ? `Edit ${item.name}` : 'Add a one-off'}
      width={560}
      confirmLabel={item ? 'Save' : 'Add it'}
      confirmDisabled={!checked.ok || nothingChanged}
      busy={submit.busy}
      warning={
        changes?.settleMode === 'manual' && item?.derivedStatus === 'assumedSettled'
          ? "Switching to settled by hand is the same as Didn't happen: it stops being assumed settled and shows as overdue."
          : undefined
      }
      warnTone="warn"
      onConfirm={save}
      onClose={onClose}
    >
      <CommonFields
        form={form}
        setForm={setForm}
        errors={checked.errors}
        touch={touch}
        shown={shown}
        accounts={accounts}
        categories={categories}
        locked={locked ? { amount: lockNote, currency: lockNote } : {}}
      />
      <FormField label="DUE ON" error={shown('dueDate', checked.errors.dueDate)}>
        <input
          type="date"
          className="input mono"
          aria-label="Due on"
          style={inputStyle}
          value={form.dueDate}
          onChange={(e) => {
            const value = e.target.value;
            touch('dueDate');
            setForm((f) => ({ ...f, dueDate: value }));
          }}
        />
      </FormField>
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
