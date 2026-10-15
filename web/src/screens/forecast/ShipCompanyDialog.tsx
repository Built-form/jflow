import { useState } from 'react';
import { api } from '../../api';
import type { ExternalItem } from '../../api/external';
import { external } from '../../api/external';
import type { Company } from '../../api/types';
import { sortCompanies } from '../../app/companyFilter';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { inputStyle } from '../../components/FormField';
import { Empty, ErrorNote, Loading } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { formatDecimal } from '../../lib/money';
import { shipRowName } from './shipPlan';

export const SHIP_COMPANY_KICKER = 'STOCK PAYMENTS · COMPANY';

/**
 * The company picker for one stock payment shipping gives no company (CONTRACT §10.11a):
 * a select of the live companies and a button that writes the choice. Shipping is not
 * changed, and the choice counts only while shipping has no company of its own.
 */
export function CompanyChoice({
  row,
  companies,
  onSaved,
}: {
  row: ExternalItem;
  companies: Company[];
  onSaved: (row: ExternalItem) => void;
}) {
  const [value, setValue] = useState<string>(row.assignedCompanyId == null ? '' : String(row.assignedCompanyId));
  const submit = useSubmit();
  const chosen = value === '' ? null : Number(value);
  const unchanged = chosen === row.assignedCompanyId;
  const save = () =>
    void submit.run(async () => {
      onSaved(await external.assignCompany(row.key, chosen, row.rowVersion));
    });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="input"
          aria-label={`Company for ${shipRowName(row)}`}
          style={{ ...inputStyle, flex: '1 1 200px', width: 'auto' }}
          value={value}
          disabled={submit.busy}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">No company</option>
          {sortCompanies(companies).map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={unchanged || submit.busy} onClick={save}>
          {submit.busy ? 'Saving…' : chosen === null && row.assignedCompanyId != null ? 'Clear' : 'Use this company'}
        </button>
      </div>
      {submit.error && <ErrorNote error={submit.error} />}
    </div>
  );
}

/**
 * `SHIP_UNMAPPED` with no company in shipping: every such stock payment
 * (`GET /external-items?noCompany=1`), each with a company picker. A row that takes a company
 * stays listed, marked, until the dialog closes; closing after any change re-reads the
 * Forecast, which then places it (or says its company has no account to land it on).
 */
export function ChooseCompanyDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const rows = useQuery(() => external.listAll({ noCompany: true }), []);
  const companies = useQuery(() => api.companies.list(), []);
  const [saved, setSaved] = useState<Record<string, ExternalItem>>({});
  const changed = Object.keys(saved).length > 0;
  const close = () => {
    if (changed) onChanged();
    onClose();
  };
  const companyName = (id: number | null) =>
    id == null ? null : (companies.data?.data ?? []).find((c) => c.id === id)?.name ?? `Company ${id}`;

  const list = rows.data?.data ?? [];
  const live = companies.data?.data ?? [];
  return (
    <Dialog
      kicker={SHIP_COMPANY_KICKER}
      title="Choose the company"
      width={640}
      confirmLabel="Done"
      cancelLabel={null}
      warning="Shipping is not changed. JFlow uses the company you choose only while shipping has none; once the PO gets a company in shipping, shipping's wins."
      onConfirm={close}
      onClose={close}
    >
      {rows.error && <ErrorNote error={rows.error} onRetry={rows.reload} />}
      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}
      {!rows.data || !companies.data ? (
        !rows.error && !companies.error && <Loading what="Stock payments" />
      ) : list.length === 0 ? (
        <Empty>Every stock payment has a company now.</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {list.map((row) => {
            const current = saved[row.key] ?? row;
            const date = row.feedStatus === 'paid' ? row.paidOn : row.effectiveDate;
            return (
              <div key={row.key} data-testid={`choose-company-${row.key}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14 }}>
                    {shipRowName(row)}
                    {row.containerRef && <span style={{ color: 'var(--mut)', fontSize: 12.5 }}> · {row.containerRef}</span>}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                    {row.feedStatus === 'paid' ? 'paid ' : ''}
                    {date ? formatDay(date) : 'no date yet'} · {formatDecimal(row.effectiveAmount, row.currency)}
                  </span>
                </div>
                <CompanyChoice
                  row={current}
                  companies={live}
                  onSaved={(next) => setSaved((s) => ({ ...s, [row.key]: next }))}
                />
                {saved[row.key] && (
                  <div style={{ fontSize: 12.5, color: 'var(--mut)' }} data-testid="choose-company-saved">
                    {current.assignedCompanyId == null
                      ? 'Cleared: no company.'
                      : `Now under ${companyName(current.assignedCompanyId)}${current.accountId == null ? ', which has no account to land it on yet' : ''}.`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
