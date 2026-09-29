import { useState } from 'react';
import { api } from '../../api';
import type { FxRate, FxRateUpdate } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSubmit, useTouched } from '../../app/useSubmit';
import { Dialog } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { Empty, ErrorNote, Loading, Tag } from '../../components/ui';
import { formatDay, londonToday } from '../../lib/dates';
import { formatRateMicro, parseRateMicro } from '../../lib/money';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { changedOnly, validateFxRate } from '../../lib/validation';
import type { FxRateForm } from '../../lib/validation';
import { RemoveDialog } from './RemoveDialog';

const COLUMNS = '90px 150px 150px minmax(0, 1fr) 120px 130px';

/** The server's order: currency, then newest `effective_from` first (§6.5). */
export function sortRates(list: FxRate[]): FxRate[] {
  return [...list].sort(
    (a, b) => a.currency.localeCompare(b.currency) || (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0),
  );
}

/** A stored rate at six decimals, whatever width the wire used. */
const canonicalRate = (rate: string) => {
  const micro = parseRateMicro(rate);
  return micro === null ? rate : formatRateMicro(micro);
};

export function FxRatesSection() {
  const list = useQuery(() => api.fxRates.list(), []);
  // Which row the engine would use today (§9.7) is the server's answer, not worked out here.
  const current = useQuery(() => api.fxRates.current(), []);
  const [editing, setEditing] = useState<FxRate | 'new' | null>(null);
  const [removing, setRemoving] = useState<FxRate | null>(null);

  if (!list.data) {
    return list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : <Loading what="FX rates" />;
  }
  const rows = sortRates(list.data.data);
  const inUse = new Set(Object.values(current.data?.rates ?? {}).map((r) => r.id));

  return (
    <section aria-label="FX rates" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div className="explainer">
          What one unit of each currency is worth in pounds, from the day it applies. The
          forecast uses one rate per currency for every date: the latest that applies today.
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          Add a rate
        </button>
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {current.error && <ErrorNote error={current.error} onRetry={current.reload} />}

      <div className="card-table">
        <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
          <div>CURRENCY</div>
          <div>1 UNIT IN GBP</div>
          <div>FROM</div>
          <div>NOTE</div>
          <div>STATUS</div>
          <div />
        </div>
        {/* GBP is the base: exactly 1, never stored, never editable (CONTRACT D3). */}
        <div className="table-row" style={{ gridTemplateColumns: COLUMNS }} data-testid="gbp-row">
          <div className="mono" style={{ fontSize: 13.5 }}>
            GBP
          </div>
          <div className="mono" style={{ fontSize: 13.5 }}>
            1.000000
          </div>
          <div style={{ fontSize: 13, color: 'var(--dim)' }}>always</div>
          <div style={{ fontSize: 13, color: 'var(--mut)' }}>The base currency. Not stored, not editable.</div>
          <div>
            <Tag>BASE</Tag>
          </div>
          <div />
        </div>
        {rows.length === 0 && <Empty>No other currency has a rate yet.</Empty>}
        {rows.map((rate) => (
          <div key={rate.id} className="table-row" style={{ gridTemplateColumns: COLUMNS }}>
            <div className="mono" style={{ fontSize: 13.5 }}>
              {rate.currency}
            </div>
            <div className="mono" style={{ fontSize: 13.5 }}>
              {rate.rateToGbp}
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: 'var(--mut)' }}>
              {formatDay(rate.effectiveFrom)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--mut)', overflowWrap: 'anywhere' }}>{rate.note ?? ''}</div>
            <div>{inUse.has(rate.id) && <Tag tone="live">IN USE TODAY</Tag>}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => setEditing(rate)}>
                edit
              </button>
              <button type="button" className="btn-quiet" style={{ color: 'var(--fail)' }} onClick={() => setRemoving(rate)}>
                remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <FxRateDialog
          rate={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            updateList(list, (currentRows) => upsertById(currentRows, row));
            current.reload();
            setEditing(null);
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          kicker="FX RATES"
          title={`Remove the ${removing.currency} rate from ${formatDay(removing.effectiveFrom)}?`}
          warning="Removed for good — the audit log keeps what it was. If it is the rate in use today, the one before it takes over; with none left, a forecast holding this currency is refused until a rate is added."
          remove={() => api.fxRates.remove(removing.id, removing.rowVersion)}
          onRemoved={() => {
            updateList(list, (currentRows) => removeById(currentRows, removing.id));
            current.reload();
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

export function FxRateDialog({
  rate,
  onClose,
  onSaved,
}: {
  rate: FxRate | null;
  onClose: () => void;
  onSaved: (row: FxRate) => void;
}) {
  const [form, setForm] = useState<FxRateForm>({
    currency: rate?.currency ?? '',
    rateToGbp: rate?.rateToGbp ?? '',
    effectiveFrom: rate?.effectiveFrom ?? londonToday(),
    note: rate?.note ?? '',
  });
  const { touch, shown } = useTouched<keyof FxRateForm>();
  const submit = useSubmit();
  const checked = validateFxRate(form);
  const update: FxRateUpdate | null = checked.ok
    ? { rateToGbp: checked.body.rateToGbp, effectiveFrom: checked.body.effectiveFrom, note: checked.body.note ?? null }
    : null;
  const changes =
    rate && update
      ? changedOnly(
          { rateToGbp: canonicalRate(rate.rateToGbp), effectiveFrom: rate.effectiveFrom, note: rate.note },
          update,
        )
      : null;
  const nothingChanged = changes !== null && Object.keys(changes).length === 0;

  const field = (key: keyof FxRateForm) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => {
      touch(key);
      setForm((f) => ({ ...f, [key]: e.target.value }));
    },
  });

  const save = () => {
    if (!checked.ok) return;
    void submit.run(async () => {
      const row = rate
        ? await api.fxRates.update(rate.id, changes ?? {}, rate.rowVersion)
        : await api.fxRates.create(checked.body);
      onSaved(row);
    });
  };

  const currency = form.currency.trim().toUpperCase() || 'one unit';

  return (
    <Dialog
      kicker="FX RATES"
      title={rate ? `Edit the ${rate.currency} rate` : 'Add a rate'}
      confirmLabel={rate ? 'Save' : 'Add it'}
      confirmDisabled={!checked.ok || nothingChanged}
      busy={submit.busy}
      onConfirm={save}
      onClose={onClose}
    >
      <FormField
        label="CURRENCY"
        note={rate ? 'A rate stays with its currency; add a new rate for another.' : 'Three letters, like EUR or USD. Not GBP — it is always 1.'}
        error={shown('currency', checked.errors.currency)}
      >
        <input
          className="input mono"
          aria-label="Currency"
          maxLength={3}
          disabled={!!rate}
          style={inputStyle}
          {...field('currency')}
        />
      </FormField>
      <FormField
        label="1 UNIT IN GBP"
        note={`What ${currency === 'one unit' ? 'one unit' : `1 ${currency}`} is worth in pounds, up to six decimals.`}
        error={shown('rateToGbp', checked.errors.rateToGbp)}
      >
        <input className="input mono" aria-label="Rate to GBP" inputMode="decimal" style={inputStyle} {...field('rateToGbp')} />
      </FormField>
      <FormField
        label="APPLIES FROM"
        note="The forecast uses the latest rate that applies on its today."
        error={shown('effectiveFrom', checked.errors.effectiveFrom)}
      >
        <input className="input mono" type="date" aria-label="Applies from" style={inputStyle} {...field('effectiveFrom')} />
      </FormField>
      <FormField label="NOTE" error={shown('note', checked.errors.note)}>
        <input className="input" aria-label="Note" style={inputStyle} {...field('note')} />
      </FormField>
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
