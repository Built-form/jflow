import { useState } from 'react';
import { api } from '../../api';
import type { Company } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { sortCompanies } from '../../app/companyFilter';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Empty, ErrorNote, Loading } from '../../components/ui';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { changedOnly, validateCompany } from '../../lib/validation';
import type { CompanyForm } from '../../lib/validation';
import { RemoveDialog } from './RemoveDialog';

const COLUMNS = '120px minmax(0, 1fr) 80px 150px';

export function CompaniesSection() {
  const list = useQuery(() => api.companies.list(), []);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const [removing, setRemoving] = useState<Company | null>(null);

  if (!list.data) {
    return list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : <Loading what="Companies" />;
  }
  const rows = sortCompanies(list.data.data);

  return (
    <section aria-label="Companies" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div className="explainer">
          Each company has its own bank accounts; the forecast shows one company or all of them
          together.
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          Add a company
        </button>
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}

      <div className="card-table">
        <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
          <div>CODE</div>
          <div>NAME</div>
          <div>ORDER</div>
          <div />
        </div>
        {rows.length === 0 && <Empty>No companies yet.</Empty>}
        {rows.map((company) => (
          <div key={company.id} className="table-row" style={{ gridTemplateColumns: COLUMNS }}>
            <div className="mono" style={{ fontSize: 13.5 }}>
              {company.code}
            </div>
            <div style={{ fontSize: 14.5 }}>{company.name}</div>
            <div className="mono" style={{ fontSize: 13, color: 'var(--mut)' }}>
              {company.sortOrder}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => setEditing(company)}>
                edit
              </button>
              <button type="button" className="btn-quiet" style={{ color: 'var(--fail)' }} onClick={() => setRemoving(company)}>
                remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <CompanyDialog
          company={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            updateList(list, (current) => upsertById(current, row));
            setEditing(null);
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          kicker="COMPANIES"
          title={`Remove ${removing.code}?`}
          warning="A company that still has accounts cannot be removed — remove or move its accounts first."
          remove={() => api.companies.remove(removing.id, removing.rowVersion)}
          onRemoved={() => {
            updateList(list, (current) => removeById(current, removing.id));
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        >
          {removing.name} disappears from every company filter. Its history stays on the record.
        </RemoveDialog>
      )}
    </section>
  );
}

export function CompanyDialog({
  company,
  onClose,
  onSaved,
}: {
  company: Company | null;
  onClose: () => void;
  onSaved: (row: Company) => void;
}) {
  const [form, setForm] = useState<CompanyForm>({
    code: company?.code ?? '',
    name: company?.name ?? '',
    sortOrder: company ? String(company.sortOrder) : '',
  });
  const { touch, shown } = useTouched<keyof CompanyForm>();
  const submit = useSubmit();
  const checked = validateCompany(form);
  const changes = company && checked.ok ? changedOnly(company, checked.body) : null;
  const nothingChanged = changes !== null && Object.keys(changes).length === 0;

  const field = (key: keyof CompanyForm) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      touch(key);
      setForm((f) => ({ ...f, [key]: e.target.value }));
    },
  });

  const save = () => {
    if (!checked.ok) return;
    void submit.run(async () => {
      const row = company
        ? await api.companies.update(company.id, changes ?? {}, company.rowVersion)
        : await api.companies.create(checked.body);
      onSaved(row);
    });
  };

  return (
    <Dialog
      kicker="COMPANIES"
      title={company ? `Edit ${company.code}` : 'Add a company'}
      confirmLabel={company ? 'Save' : 'Add it'}
      confirmDisabled={!checked.ok || nothingChanged}
      busy={submit.busy}
      onConfirm={save}
      onClose={onClose}
    >
      <FormField label="CODE" note="Short and unique, like JFA or HW. Stored in capitals." error={shown('code', checked.errors.code)}>
        <input className="input mono" aria-label="Code" style={inputStyle} {...field('code')} />
      </FormField>
      <FormField label="NAME" error={shown('name', checked.errors.name)}>
        <input className="input" aria-label="Name" style={inputStyle} {...field('name')} />
      </FormField>
      <FormField label="ORDER" note="Lower comes first. Blank is 0." error={shown('sortOrder', checked.errors.sortOrder)}>
        <input className="input mono" aria-label="Order" inputMode="numeric" style={inputStyle} {...field('sortOrder')} />
      </FormField>
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
