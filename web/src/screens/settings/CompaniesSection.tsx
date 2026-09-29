import { useState } from 'react';
import { api } from '../../api';
import type { ApiError } from '../../api/client';
import { external } from '../../api/external';
import type { ExternalStatus, ShippingCompany } from '../../api/external';
import type { Company } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { sortCompanies } from '../../app/companyFilter';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Empty, ErrorNote, Loading } from '../../components/ui';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { lastSyncText } from '../../lib/ship';
import { RefreshButton } from '../forecast/shipping';
import { changedOnly, validateCompany } from '../../lib/validation';
import type { CompanyForm } from '../../lib/validation';
import { RemoveDialog } from './RemoveDialog';

const COLUMNS = '110px minmax(0, 1fr) minmax(0, 1.2fr) 70px 130px';

export function CompaniesSection() {
  const list = useQuery(() => api.companies.list(), []);
  // The shipping feed's companies, for the picker (§6.2: Settings offers them from
  // GET /external/status; the server checks uniqueness only, never the feed).
  const status = useQuery(() => external.status(), []);
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
          together. Map each to its company in shipping, and its stock payments join its forecast.
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          Add a company
        </button>
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      <FeedNote status={status.data} error={status.error} onRetry={status.reload} />

      <div className="card-table">
        <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
          <div>CODE</div>
          <div>NAME</div>
          <div>SHIPPING COMPANY</div>
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
            <ShippingCompanyPicker
              company={company}
              companies={rows}
              feed={feedCompanies(status.data)}
              onSaved={(row) => updateList(list, (current) => upsertById(current, row))}
            />
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

/** The feed's companies from a status read; empty when there is none (never synced, or the read failed). */
export function feedCompanies(status: ExternalStatus | null | undefined): ShippingCompany[] {
  return Array.isArray(status?.companies) ? status.companies : [];
}

export interface ShippingOption {
  id: number;
  label: string;
}

/**
 * The picker's choices besides "Not mapped": every company the feed lists, each saying
 * which JFlow company already holds it (the server refuses a second holder with 409
 * `SHIPPING_COMPANY_TAKEN`, and that refusal is shown as it comes). A mapping the feed no
 * longer lists stays on offer so the select can show it.
 */
export function shippingOptions(company: Company, companies: Company[], feed: ShippingCompany[]): ShippingOption[] {
  const holderOf = (id: number) => companies.find((c) => c.id !== company.id && !c.deletedAt && c.shippingCompanyId === id);
  const options = feed.map((f) => {
    const holder = holderOf(f.id);
    return { id: f.id, label: holder ? `${f.name} · mapped to ${holder.code}` : f.name };
  });
  const current = company.shippingCompanyId;
  if (current != null && !feed.some((f) => f.id === current)) {
    options.push({ id: current, label: `Shipping company #${current} (not in the feed)` });
  }
  return options;
}

/** A `SHIPPING_COMPANY_TAKEN` refusal, naming the company that holds it. */
export function takenText(error: ApiError, companies: Company[]): string | null {
  if (error.code !== 'SHIPPING_COMPANY_TAKEN') return null;
  const holderId = typeof error.details?.companyId === 'number' ? error.details.companyId : null;
  const holder = companies.find((c) => c.id === holderId);
  return holder
    ? `${holder.code} · ${holder.name} is already mapped to that shipping company. Unmap it there first.`
    : 'Another company is already mapped to that shipping company. Unmap it there first.';
}

/**
 * One company's shipping company: picking one writes `PUT /companies/:id {shippingCompanyId}`
 * at once (null = not mapped) with the row version it read, and the row is replaced from
 * the answer.
 */
export function ShippingCompanyPicker({
  company,
  companies,
  feed,
  onSaved,
}: {
  company: Company;
  companies: Company[];
  feed: ShippingCompany[];
  onSaved: (row: Company) => void;
}) {
  const submit = useSubmit();
  const options = shippingOptions(company, companies, feed);
  const pick = (raw: string) => {
    const next = raw === '' ? null : Number(raw);
    if (next === company.shippingCompanyId) return;
    void submit.run(async () => {
      onSaved(await api.companies.update(company.id, { shippingCompanyId: next }, company.rowVersion));
    });
  };
  const taken = submit.error ? takenText(submit.error, companies) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <select
        className="input"
        aria-label={`Shipping company for ${company.code}`}
        value={company.shippingCompanyId == null ? '' : String(company.shippingCompanyId)}
        disabled={submit.busy}
        onChange={(e) => pick(e.target.value)}
        style={{ maxWidth: '100%' }}
      >
        <option value="">Not mapped</option>
        {options.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {o.label}
          </option>
        ))}
      </select>
      {submit.error && (
        <div data-testid={`shipping-map-error-${company.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ErrorNote error={submit.error} />
          {taken && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{taken}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * What the picker is fed from: a feed that has never synced has no companies to offer and
 * says how to get some; an unconfigured one says so.
 */
function FeedNote({
  status,
  error,
  onRetry,
}: {
  status: ExternalStatus | null;
  error: ApiError | null;
  onRetry: () => void;
}) {
  if (error) return <ErrorNote error={error} onRetry={onRetry} />;
  if (!status) return null;
  if (status.lastSuccessAt) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--dim)' }} data-testid="feed-note">
        Shipping companies as of the last sync, {lastSyncText(status.lastSuccessAt)}.
      </div>
    );
  }
  return (
    <div
      className="note-panel"
      data-testid="feed-note"
      style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <span style={{ flex: '1 1 320px' }}>
        {status.configured === false
          ? 'The shipping feed is not set up for this environment, so there are no shipping companies to pick from.'
          : 'The shipping feed has never synced, so there are no shipping companies to pick from yet. Refresh it to load them.'}
      </span>
      {status.configured !== false && <RefreshButton label="Refresh the feed" onRefreshed={onRetry} />}
    </div>
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
