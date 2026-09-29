import { useState } from 'react';
import { api } from '../../api';
import type { Account, AccountCreate, Company } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Empty, ErrorNote, Loading, Tag, Toggle } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { formatDecimal } from '../../lib/money';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { changedOnly, validateAccount } from '../../lib/validation';
import type { AccountForm } from '../../lib/validation';
import { RemoveDialog } from './RemoveDialog';

const COLUMNS = 'minmax(0, 1.4fr) 110px 80px 170px minmax(0, 1.2fr) 130px';

/** Read-only fields a mutation response does not carry (CONTRACT §6.3) — kept from the read. */
const READ_ONLY: (keyof Account)[] = ['anchorDate', 'anchorBalance'];

export function AccountsSection() {
  const companies = useQuery(() => api.companies.list(), []);
  const [companyId, setCompanyId] = useCompanyFilter();
  const list = useQuery(() => api.accounts.list({ companyId }), [companyId]);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  const companyRows = sortCompanies(companies.data?.data ?? []);
  const companyOf = (id: number) => companyRows.find((c) => c.id === id);

  if (!list.data) {
    return list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : <Loading what="Accounts" />;
  }
  const all = list.data.data;
  const rows = showInactive ? all : all.filter((a) => a.isActive);
  const inactiveCount = all.length - all.filter((a) => a.isActive).length;

  const saved = (row: Account, reread: boolean) => {
    // Making one account the default clears the flag on its siblings in the same
    // transaction (D16), and the response carries only this row — so the list is read
    // again rather than guessed at.
    if (reread) list.reload();
    else if (companyId === null || row.companyId === companyId) {
      updateList(list, (current) => upsertById(current, row, READ_ONLY));
    }
    setEditing(null);
  };

  return (
    <section aria-label="Accounts" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <CompanyPicker companies={companyRows} value={companyId} onChange={setCompanyId} />
          {inactiveCount > 0 && (
            <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', fontSize: 13.5, color: 'var(--mut)' }}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show {inactiveCount} inactive
            </label>
          )}
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={companyRows.length === 0}
          onClick={() => setEditing('new')}
        >
          Add an account
        </button>
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}

      <div className="card-table">
        <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
          <div>ACCOUNT</div>
          <div>COMPANY</div>
          <div>CURRENCY</div>
          <div>FLAGS</div>
          <div>LAST RECORDED</div>
          <div />
        </div>
        {rows.length === 0 && <Empty>No accounts {companyId === null ? 'yet' : 'for this company'}.</Empty>}
        {rows.map((account) => (
          <div key={account.id} className="table-row" style={{ gridTemplateColumns: COLUMNS }}>
            <div style={{ fontSize: 14.5, color: account.isActive ? undefined : 'var(--mut)' }}>{account.name}</div>
            <div className="mono" style={{ fontSize: 13 }}>
              {companyOf(account.companyId)?.code ?? `#${account.companyId}`}
            </div>
            <div className="mono" style={{ fontSize: 13 }}>
              {account.currency}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {account.isDefault && <Tag tone="live">DEFAULT</Tag>}
              {!account.isActive && <Tag>INACTIVE</Tag>}
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: 'var(--mut)' }}>
              {account.anchorDate
                ? `${formatDay(account.anchorDate)} · ${formatDecimal(account.anchorBalance, account.currency)}`
                : 'Nothing recorded'}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => setEditing(account)}>
                edit
              </button>
              <button type="button" className="btn-quiet" style={{ color: 'var(--fail)' }} onClick={() => setRemoving(account)}>
                remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          companies={companyRows}
          defaultCompanyId={companyId ?? (companyRows.length === 1 ? companyRows[0].id : null)}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}

      {removing && (
        <RemoveDialog
          kicker="ACCOUNTS"
          title={`Remove ${removing.name}?`}
          warning="An account with items, schedules or recorded balances cannot be removed. Mark it inactive instead to take it out of the forecast and the pickers."
          remove={() => api.accounts.remove(removing.id, removing.rowVersion)}
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

export function AccountDialog({
  account,
  companies,
  defaultCompanyId,
  onClose,
  onSaved,
}: {
  account: Account | null;
  companies: Company[];
  defaultCompanyId: number | null;
  onClose: () => void;
  /** `reread` when the change touched sibling rows the response does not carry. */
  onSaved: (row: Account, reread: boolean) => void;
}) {
  const [form, setForm] = useState<AccountForm>({
    companyId: String(account?.companyId ?? defaultCompanyId ?? ''),
    name: account?.name ?? '',
    currency: account?.currency ?? 'GBP',
    sortOrder: account ? String(account.sortOrder) : '',
    isActive: account?.isActive ?? true,
    isDefault: account?.isDefault ?? false,
  });
  const { touch, shown } = useTouched<keyof AccountForm>();
  const submit = useSubmit();
  const checked = validateAccount(form);
  const changes = account && checked.ok ? changedOnly<AccountCreate>(account, checked.body, ['companyId']) : null;
  const nothingChanged = changes !== null && Object.keys(changes).length === 0;

  const text = (key: 'name' | 'currency' | 'sortOrder') => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      touch(key);
      setForm((f) => ({ ...f, [key]: e.target.value }));
    },
  });

  const save = () => {
    if (!checked.ok) return;
    void submit.run(async () => {
      if (account) {
        const row = await api.accounts.update(account.id, changes ?? {}, account.rowVersion);
        onSaved(row, changes?.isDefault === true);
      } else {
        const row = await api.accounts.create(checked.body);
        onSaved(row, row.isDefault);
      }
    });
  };

  const warnings = [
    changes?.currency !== undefined &&
      'Changing the currency is refused while the account has items, schedules or recorded balances — their amounts are in the old one.',
    changes?.isActive === false &&
      'Making it inactive takes it out of the forecast and the pickers. It is refused while the forecast still shows money owed on it.',
    form.isDefault &&
      !account?.isDefault &&
      "This becomes the company's default account; the one that was default stops being it.",
  ].filter(Boolean);

  return (
    <Dialog
      kicker="ACCOUNTS"
      title={account ? `Edit ${account.name}` : 'Add an account'}
      confirmLabel={account ? 'Save' : 'Add it'}
      confirmDisabled={!checked.ok || nothingChanged}
      busy={submit.busy}
      warning={warnings.length ? warnings.map((w) => <div key={String(w)}>{w}</div>) : undefined}
      warnTone={changes?.currency !== undefined || changes?.isActive === false ? 'warn' : 'idle'}
      onConfirm={save}
      onClose={onClose}
    >
      <FormField
        label="COMPANY"
        note={account ? 'An account stays with the company it was opened under.' : undefined}
        error={shown('companyId', checked.errors.companyId)}
      >
        <select
          className="input"
          aria-label="Company"
          style={inputStyle}
          disabled={!!account}
          value={form.companyId}
          onChange={(e) => {
            touch('companyId');
            setForm((f) => ({ ...f, companyId: e.target.value }));
          }}
        >
          <option value="">Pick a company</option>
          {companies.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="NAME" error={shown('name', checked.errors.name)}>
        <input className="input" aria-label="Name" style={inputStyle} {...text('name')} />
      </FormField>
      <FormField
        label="CURRENCY"
        note="Balances and items on this account are in this currency."
        error={shown('currency', checked.errors.currency)}
      >
        <input className="input mono" aria-label="Currency" maxLength={3} style={inputStyle} {...text('currency')} />
      </FormField>
      <FormField label="ORDER" note="Lower comes first. Blank is 0." error={shown('sortOrder', checked.errors.sortOrder)}>
        <input className="input mono" aria-label="Order" inputMode="numeric" style={inputStyle} {...text('sortOrder')} />
      </FormField>
      <div>
        <Toggle
          on={form.isActive}
          label="Active"
          detail="Inactive accounts keep their history but leave the forecast, the pickers and the cash-at-bank entry."
          onChange={(next) => setForm((f) => ({ ...f, isActive: next }))}
        />
        <Toggle
          on={form.isDefault}
          label="Default for its company"
          detail="The company's main account. One per company: setting it here clears it on the others."
          onChange={(next) => setForm((f) => ({ ...f, isDefault: next }))}
        />
      </div>
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
