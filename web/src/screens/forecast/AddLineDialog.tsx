import { useEffect, useState } from 'react';
import { api } from '../../api';
import { scenarios } from '../../api/scenarios';
import type { Account, Direction } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { ErrorNote, Segmented } from '../../components/ui';
import { RefusalNote } from '../scenarios/RefusalNote';
import { sortCategories } from '../settings/CategoriesSection';
import type { AddLineField, AddLineForm } from './addLine';
import { blankAddLineForm, checkAddLine } from './addLine';

/**
 * Add a hypothetical one-off to the open draft scenario (2026-10-07, D39) — an interest
 * payment, a fine for paying late. It is an `add` adjustment: it shows on the forecast only
 * while this scenario is open, and applying the scenario creates it as a real one-off.
 *
 * The fields follow the items form's conventions (`CommonFields`): the direction picks the
 * categories offered, the currency follows the account until someone types their own.
 */
export function AddLineDialog({
  scenario,
  accounts,
  today,
  onClose,
  onSaved,
}: {
  scenario: { id: number; name: string };
  /** Live, active accounts in view; the first is the default. */
  accounts: Account[];
  /** The server's today (`meta.today`). */
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const categories = useQuery(() => api.categories.list(), []);
  const [form, setForm] = useState<AddLineForm>(() => blankAddLineForm(today, accounts[0] ?? null));
  const { touch, shown } = useTouched<AddLineField>();
  const submit = useSubmit();
  const list = categories.data?.data ?? [];
  const checked = checkAddLine(form, { categories: list, today });
  const direction: Direction = form.direction || 'out';
  const offered = sortCategories(list).filter((c) => !c.deletedAt && c.direction === direction);
  const accountOf = (id: string) => accounts.find((a) => String(a.id) === id);

  // The accounts may still be on their way when the dialog opens: take the first once they land.
  const firstAccount = accounts[0] ?? null;
  useEffect(() => {
    if (!firstAccount) return;
    setForm((f) => (f.accountId ? f : { ...f, accountId: String(firstAccount.id), currency: f.currency.trim() ? f.currency : firstAccount.currency }));
  }, [firstAccount]);

  const set = (field: AddLineField, value: string) => {
    touch(field);
    setForm((f) => ({ ...f, [field]: value }));
  };

  const save = () => {
    if (!checked.ok) return;
    const body = checked.body;
    void submit.run(async () => {
      await scenarios.addAdjustment(scenario.id, body);
      onSaved();
    });
  };

  return (
    <Dialog
      kicker={`SCENARIO · ${scenario.name.toUpperCase()}`}
      title="Add a one-off to this scenario"
      width={560}
      confirmLabel="Add to scenario"
      confirmDisabled={!checked.ok}
      busy={submit.busy}
      warnTone="waived"
      warning="It exists only in this scenario. Apply writes it to the real plan as a new one-off."
      onConfirm={save}
      onClose={onClose}
    >
      {categories.error && <ErrorNote error={categories.error} onRetry={categories.reload} />}

      <FormField
        label="ACCOUNT"
        note={accounts.length === 0 ? 'No active account in view.' : undefined}
        error={shown('accountId', checked.errors.accountId)}
      >
        <select
          className="input"
          aria-label="Account"
          style={inputStyle}
          value={form.accountId}
          onChange={(e) => {
            const next = e.target.value;
            touch('accountId');
            setForm((f) => {
              const before = accountOf(f.accountId);
              const after = accountOf(next);
              // The currency follows the account unless someone typed a different one.
              const follows = !f.currency.trim() || (before && f.currency.trim().toUpperCase() === before.currency);
              return { ...f, accountId: next, currency: follows && after ? after.currency : f.currency };
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

      <FormField label="DIRECTION" error={shown('direction', checked.errors.direction)}>
        <Segmented<Direction>
          ariaLabel="Direction"
          options={[
            { id: 'in', label: 'Money in' },
            { id: 'out', label: 'Money out' },
          ]}
          value={direction}
          onChange={(next) => {
            touch('direction');
            setForm((f) => {
              const current = list.find((c) => String(c.id) === f.categoryId);
              return { ...f, direction: next, categoryId: current && current.direction !== next ? '' : f.categoryId };
            });
          }}
        />
      </FormField>

      <FormField
        label="CATEGORY"
        note={categories.data && offered.length === 0 ? `No money-${direction} categories yet — add one in Settings.` : undefined}
        error={shown('categoryId', checked.errors.categoryId)}
      >
        <select
          className="input"
          aria-label="Category"
          style={inputStyle}
          value={form.categoryId}
          onChange={(e) => set('categoryId', e.target.value)}
        >
          <option value="">{categories.data ? 'Pick a category' : 'Loading categories…'}</option>
          {offered.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="NAME" error={shown('name', checked.errors.name)}>
        <input className="input" aria-label="Name" style={inputStyle} value={form.name} onChange={(e) => set('name', e.target.value)} />
      </FormField>
      <FormField label="COUNTERPARTY" note="Who pays or is paid. Optional." error={shown('counterparty', checked.errors.counterparty)}>
        <input
          className="input"
          aria-label="Counterparty"
          style={inputStyle}
          value={form.counterparty}
          onChange={(e) => set('counterparty', e.target.value)}
        />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 12 }}>
        <FormField label="AMOUNT" error={shown('amount', checked.errors.amount)}>
          <input
            className="input mono"
            aria-label="Amount"
            inputMode="decimal"
            style={inputStyle}
            value={form.amount}
            onChange={(e) => set('amount', e.target.value)}
          />
        </FormField>
        <FormField label="CURRENCY" error={shown('currency', checked.errors.currency)}>
          <input
            className="input mono"
            aria-label="Currency"
            maxLength={3}
            style={inputStyle}
            value={form.currency}
            onChange={(e) => set('currency', e.target.value)}
          />
        </FormField>
      </div>

      <FormField label="DATE" note="Today or later." error={shown('date', checked.errors.date)}>
        <input
          type="date"
          className="input mono"
          aria-label="Date"
          min={today}
          style={inputStyle}
          value={form.date}
          onChange={(e) => set('date', e.target.value)}
        />
      </FormField>

      <FormField label="NOTE" note="Optional. Kept on the one-off when the scenario is applied." error={shown('note', checked.errors.note)}>
        <textarea className="textarea" aria-label="Note" rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
      </FormField>

      {submit.error && <RefusalNote error={submit.error} />}
    </Dialog>
  );
}
