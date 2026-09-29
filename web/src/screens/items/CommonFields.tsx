import type { SettleMode } from '../../api/items';
import type { Account, Category, Direction } from '../../api/types';
import { FormField, inputStyle } from '../../components/FormField';
import { Segmented } from '../../components/ui';
import type { FieldErrors } from '../../lib/validation';
import { sortCategories } from '../settings/CategoriesSection';
import type { CommonField, CommonForm } from './itemForm';
import { SETTLE_MODE_HELP } from './itemForm';

/**
 * The fields an item and a schedule share. The direction picks which categories are
 * offered (an item goes the same way as its category, D14); the currency follows the
 * account until someone types their own.
 *
 * `locked` names the fields that cannot change here, with the reason shown under each —
 * a paid item's amount and currency, a used schedule's structure.
 */
export function CommonFields<F extends CommonForm>({
  form,
  setForm,
  errors,
  touch,
  shown,
  accounts,
  categories,
  locked = {},
}: {
  form: F;
  setForm: (update: (f: F) => F) => void;
  errors: FieldErrors<CommonField>;
  touch: (field: CommonField) => void;
  shown: (field: CommonField, error: string | undefined) => string | null;
  accounts: Account[];
  categories: Category[];
  locked?: Partial<Record<CommonField, string>>;
}) {
  const offered = sortCategories(categories).filter((c) => !c.deletedAt && (!form.direction || c.direction === form.direction));
  const accountOf = (id: string) => accounts.find((a) => String(a.id) === id);

  const text = (key: 'name' | 'counterparty' | 'amount' | 'currency' | 'notes') => ({
    value: form[key],
    disabled: !!locked[key],
    onChange: (e: { target: { value: string } }) => {
      const value = e.target.value;
      touch(key);
      setForm((f) => ({ ...f, [key]: value }));
    },
  });

  return (
    <>
      <FormField label="ACCOUNT" note={locked.accountId} error={shown('accountId', errors.accountId)}>
        <select
          className="input"
          aria-label="Account"
          style={inputStyle}
          disabled={!!locked.accountId}
          value={form.accountId}
          onChange={(e) => {
            const next = e.target.value;
            touch('accountId');
            setForm((f) => {
              const before = accountOf(f.accountId);
              const after = accountOf(next);
              // The currency follows the account unless someone typed a different one.
              const follows = !f.currency.trim() || (before && f.currency.trim().toUpperCase() === before.currency);
              return {
                ...f,
                accountId: next,
                currency: follows && after && !locked.currency ? after.currency : f.currency,
              };
            });
          }}
        >
          <option value="">Pick an account</option>
          {accounts.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.name} · {a.currency}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="DIRECTION" error={shown('direction', errors.direction)}>
        <Segmented<Direction>
          ariaLabel="Direction"
          options={[
            { id: 'in', label: 'Money in' },
            { id: 'out', label: 'Money out' },
          ]}
          value={(form.direction || 'out') as Direction}
          onChange={(next) => {
            touch('direction');
            setForm((f) => {
              const current = categories.find((c) => String(c.id) === f.categoryId);
              return { ...f, direction: next, categoryId: current && current.direction !== next ? '' : f.categoryId };
            });
          }}
        />
      </FormField>

      <FormField
        label="CATEGORY"
        note={offered.length === 0 ? `No money-${form.direction || 'out'} categories yet — add one in Settings.` : undefined}
        error={shown('categoryId', errors.categoryId)}
      >
        <select
          className="input"
          aria-label="Category"
          style={inputStyle}
          value={form.categoryId}
          onChange={(e) => {
            const value = e.target.value;
            touch('categoryId');
            setForm((f) => ({ ...f, categoryId: value }));
          }}
        >
          <option value="">Pick a category</option>
          {offered.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="NAME" error={shown('name', errors.name)}>
        <input className="input" aria-label="Name" style={inputStyle} {...text('name')} />
      </FormField>
      <FormField label="COUNTERPARTY" note="Who pays or is paid. Optional." error={shown('counterparty', errors.counterparty)}>
        <input className="input" aria-label="Counterparty" style={inputStyle} {...text('counterparty')} />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 12 }}>
        <FormField label="AMOUNT" note={locked.amount} error={shown('amount', errors.amount)}>
          <input className="input mono" aria-label="Amount" inputMode="decimal" style={inputStyle} {...text('amount')} />
        </FormField>
        <FormField label="CURRENCY" error={shown('currency', errors.currency)}>
          <input className="input mono" aria-label="Currency" maxLength={3} style={inputStyle} {...text('currency')} />
        </FormField>
      </div>

      <FormField label="SETTLES" note={locked.settleMode ?? SETTLE_MODE_HELP[form.settleMode]} error={shown('settleMode', errors.settleMode)}>
        {locked.settleMode ? (
          <div className="mono" style={{ fontSize: 13.5 }}>
            {form.settleMode === 'auto' ? 'Automatically' : 'By hand'}
          </div>
        ) : (
          <Segmented<SettleMode>
            ariaLabel="Settles"
            options={[
              { id: 'auto', label: 'Automatically' },
              { id: 'manual', label: 'By hand' },
            ]}
            value={form.settleMode}
            onChange={(next) => {
              touch('settleMode');
              setForm((f) => ({ ...f, settleMode: next }));
            }}
          />
        )}
      </FormField>

      <FormField label="NOTES">
        <textarea className="textarea" aria-label="Notes" rows={2} {...text('notes')} />
      </FormField>
    </>
  );
}
