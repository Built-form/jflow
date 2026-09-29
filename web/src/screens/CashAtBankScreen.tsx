import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { ApiError } from '../api/client';
import type { Account, Balance } from '../api/types';
import { useQuery } from '../app/useQuery';
import { useSubmit } from '../app/useSubmit';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../app/companyFilter';
import { PageHeader } from '../components/PageHeader';
import { Empty, ErrorNote, InfoText, Loading, Segmented, Tag } from '../components/ui';
import { RemoveDialog } from './settings/RemoveDialog';
import {
  START_OF_DAY_LABEL,
  START_OF_DAY_MEANING,
  combinedHistory,
  combinedLineAllowed,
  entryTotal,
  mergeBalances,
  planBulkBalances,
  startOfDay,
  startOfDayLine,
  withoutBalance,
} from '../lib/balances';
import type { BalanceDraft } from '../lib/balances';
import { addDays, formatDay, isValidDate, londonToday } from '../lib/dates';
import { shortEmail } from '../lib/format';
import { formatDecimal, formatMoney, parseMinor, parseMoneyInput } from '../lib/money';

export const DATE_PARAM = 'date';
export const DAYS_PARAM = 'days';
const WINDOWS = [30, 90, 365] as const;
type Window = (typeof WINDOWS)[number];

/** `?days=` as a history window; 90 for anything else. */
export function parseWindow(raw: string | null): Window {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as Window) : 90;
}

const ENTRY_COLUMNS = 'minmax(0, 1.3fr) 64px 190px minmax(0, 1fr) minmax(0, 1fr) 70px';

type Drafts = Record<number, { balance: string; note: string }>;

/**
 * Start-of-day balances: one date, every active account in view, entered together.
 *
 * The figure is the cash at bank at the START of the date — before that day's money in
 * and out. That is the anchor the forecast rolls each account forward from; what it means
 * for the items around it is the server's business (`/forecast`), not this screen's.
 *
 * History is what was recorded, per account and in that account's own currency. A
 * combined line appears only when every account in view is GBP: adding currencies
 * together needs a rate for each day, which JFlow does not keep.
 */
export function CashAtBankScreen() {
  // Europe/London, once per visit — the same "today" the API checks `balance_date` against.
  const [today] = useState(() => londonToday());
  const [params, setParams] = useSearchParams();
  const [companyId, setCompanyId] = useCompanyFilter();
  const rawDate = params.get(DATE_PARAM);
  const date = rawDate && isValidDate(rawDate) ? rawDate : today;
  const windowDays = parseWindow(params.get(DAYS_PARAM));
  const historyFrom = addDays(today, -(windowDays - 1));

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (value === null) out.delete(key);
        else out.set(key, value);
        return out;
      },
      { replace: true },
    );
  const setDate = (next: string) => setParam(DATE_PARAM, next === today ? null : next);

  const companies = useQuery(() => api.companies.list(), []);
  // Every live account, filtered to the active ones below: CONTRACT names `isActive` as a
  // filter but not how a boolean is spelled in a query string, and a misread would empty
  // the table rather than fail.
  const accounts = useQuery(() => api.accounts.list({ companyId }), [companyId]);
  const day = useQuery(() => api.balances.listAll({ companyId, from: date, to: date }), [companyId, date]);
  const history = useQuery(
    () => api.balances.listAll({ companyId, from: historyFrom, to: today }),
    [companyId, historyFrom, today],
  );

  const inView: Account[] = useMemo(
    () => (accounts.data?.data ?? []).filter((a) => a.isActive && !a.deletedAt),
    [accounts.data],
  );
  const companyRows = sortCompanies(companies.data?.data ?? []);
  const codeOf = (id: number) => companyRows.find((c) => c.id === id)?.code ?? '';

  // What is recorded for THIS date. Filtered by date as well as read for it: while a new
  // date's read is in flight the previous date's rows are still in `day.data`.
  const recorded = useMemo(
    () => new Map((day.data?.data ?? []).filter((b) => b.balanceDate === date).map((b) => [b.accountId, b])),
    [day.data, date],
  );

  const [drafts, setDrafts] = useState<Drafts>({});
  useEffect(() => {
    // Re-seed from what is recorded whenever that changes: a new date, a company, or the
    // rows a save or remove answered with.
    const next: Drafts = {};
    for (const [id, b] of recorded) next[id] = { balance: b.balance, note: b.note ?? '' };
    setDrafts(next);
  }, [recorded]);

  const draftList: BalanceDraft[] = inView.map((a) => ({
    accountId: a.id,
    balance: drafts[a.id]?.balance ?? '',
    note: drafts[a.id]?.note ?? '',
  }));
  const plan = planBulkBalances(date, today, draftList, recorded);
  const total = entryTotal(inView, draftList);
  const allGbp = combinedLineAllowed(inView);
  const heading = startOfDay(date, today);

  const submit = useSubmit();
  const [sent, setSent] = useState<number[]>([]);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Balance | null>(null);

  const edit = (accountId: number, key: 'balance' | 'note', value: string) => {
    setSavedNote(null);
    setDrafts((d) => ({
      ...d,
      [accountId]: { balance: d[accountId]?.balance ?? '', note: d[accountId]?.note ?? '', [key]: value },
    }));
  };

  const inHistory = (d: string) => d >= historyFrom && d <= today;

  const save = () => {
    const body = plan.body;
    if (!body) return;
    setSent(body.entries.map((e) => e.accountId));
    void submit.run(async () => {
      const res = await api.balances.bulk(body);
      // Replace from the response: the rows as the server now holds them.
      if (day.data) day.set({ ...day.data, data: mergeBalances(day.data.data, res.data) });
      if (history.data && inHistory(body.balanceDate)) {
        history.set({ ...history.data, data: mergeBalances(history.data.data, res.data) });
      }
      // Each account's latest recorded balance is the server's to say — it rides on the
      // account read, not on this response.
      accounts.reload();
      setSavedNote(`Saved ${res.data.length} ${res.data.length === 1 ? 'balance' : 'balances'}.`);
    });
  };

  const nameOf = (accountId: number) => inView.find((a) => a.id === accountId)?.name ?? `Account ${accountId}`;

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <PageHeader
        title="Cash at bank"
        actions={<CompanyPicker companies={companyRows} value={companyId} onChange={setCompanyId} />}
      >
        <InfoText className="explainer">
          Record what each bank account holds at the start of a day — every active account on
          one date, together. The forecast starts each account from its latest recorded figure.
        </InfoText>
      </PageHeader>

      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}

      <section className="panel" aria-label={START_OF_DAY_LABEL} style={{ gap: 14 }}>
        <div className="head-row" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h2 className="report-title" style={{ margin: 0 }}>
              {START_OF_DAY_LABEL}
            </h2>
            <div className="mono" style={{ fontSize: 13.5 }} data-testid="entry-day">
              {startOfDayLine(date, today)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>
              ←
            </button>
            <input
              type="date"
              className="input mono"
              aria-label="Balance date"
              max={today}
              value={date}
              onChange={(e) => {
                if (isValidDate(e.target.value)) setDate(e.target.value);
              }}
            />
            <button
              type="button"
              className="btn"
              aria-label="Next day"
              disabled={date >= today}
              onClick={() => setDate(addDays(date, 1))}
            >
              →
            </button>
            {date !== today && (
              <button type="button" className="btn" onClick={() => setDate(today)}>
                Today
              </button>
            )}
          </div>
        </div>
        <InfoText style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 1.6 }}>{START_OF_DAY_MEANING}</InfoText>

        {heading.error && (
          <div className="error-banner" role="alert">
            {heading.error}
          </div>
        )}
        {accounts.error && <ErrorNote error={accounts.error} onRetry={accounts.reload} />}
        {day.error && <ErrorNote error={day.error} onRetry={day.reload} />}

        {!accounts.data ? (
          <Loading what="Accounts" />
        ) : inView.length === 0 ? (
          <Empty>
            No active accounts {companyId === null ? 'yet' : 'for this company'}.{' '}
            <Link to="/settings?tab=accounts">Add one in Settings</Link>.
          </Empty>
        ) : (
          <div className="card-table">
            <div className="table-head" style={{ gridTemplateColumns: ENTRY_COLUMNS }}>
              <div>ACCOUNT</div>
              <div>CCY</div>
              <div>{START_OF_DAY_LABEL}</div>
              <div>NOTE</div>
              <div>RECORDED</div>
              <div />
            </div>
            {inView.map((account) => {
              const draft = drafts[account.id] ?? { balance: '', note: '' };
              const saved = recorded.get(account.id);
              const problem = plan.rowErrors[account.id];
              const typed = parseMoneyInput(draft.balance, { allowNegative: true });
              const negative = typed.kind === 'ok' && typed.minor < 0n;
              return (
                <div key={account.id} className="table-row" style={{ gridTemplateColumns: ENTRY_COLUMNS, alignItems: 'start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 7 }}>
                    <span style={{ fontSize: 14.5 }}>{account.name}</span>
                    {companyId === null && (
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--dim)' }}>
                        {codeOf(account.companyId)}
                      </span>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 13, paddingTop: 9 }}>
                    {account.currency}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input
                      className="input mono"
                      aria-label={`${START_OF_DAY_LABEL}, ${account.name}`}
                      aria-invalid={problem ? true : undefined}
                      inputMode="decimal"
                      placeholder="not recorded"
                      value={draft.balance}
                      disabled={!!heading.error}
                      onChange={(e) => edit(account.id, 'balance', e.target.value)}
                      style={{
                        width: '100%',
                        textAlign: 'right',
                        color: negative ? 'var(--fail)' : undefined,
                        borderColor: problem ? 'var(--fail)' : undefined,
                      }}
                    />
                    {problem && (
                      <span role="alert" style={{ fontSize: 12, color: 'var(--fail)' }}>
                        {problem}
                      </span>
                    )}
                  </div>
                  <input
                    className="input"
                    aria-label={`Note, ${account.name}`}
                    value={draft.note}
                    disabled={!!heading.error}
                    onChange={(e) => edit(account.id, 'note', e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <div style={{ fontSize: 12.5, color: 'var(--mut)', lineHeight: 1.5, paddingTop: 5 }}>
                    {saved ? (
                      <>
                        {formatDecimal(saved.balance, account.currency)}
                        <br />
                        <span style={{ color: 'var(--dim)' }}>by {shortEmail(saved.enteredBy)}</span>
                      </>
                    ) : account.anchorDate ? (
                      <span style={{ color: 'var(--dim)' }}>
                        Not for this day. Latest: {formatDay(account.anchorDate)},{' '}
                        {formatDecimal(account.anchorBalance, account.currency)}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--dim)' }}>Nothing recorded yet</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 5 }}>
                    {saved && (
                      <button
                        type="button"
                        className="btn-quiet"
                        style={{ color: 'var(--fail)' }}
                        aria-label={`Remove the balance for ${account.name}`}
                        onClick={() => setRemoving(saved)}
                      >
                        remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div
              className="table-row"
              data-testid="entry-total"
              style={{ gridTemplateColumns: ENTRY_COLUMNS, background: 'var(--panel2)' }}
            >
              <div className="kicker">{allGbp ? 'ALL ACCOUNTS' : 'NO COMBINED TOTAL'}</div>
              <div className="mono" style={{ fontSize: 13 }}>
                {allGbp ? 'GBP' : ''}
              </div>
              <div className="mono" style={{ fontSize: 14, textAlign: 'right', paddingRight: 12 }}>
                {total ? formatMoney(total.totalMinor, 'GBP') : allGbp ? '—' : ''}
              </div>
              <div style={{ gridColumn: 'span 3', fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.5 }}>
                {allGbp
                  ? total && total.filled < total.of
                    ? `${total.filled} of ${total.of} accounts have a figure — the total is incomplete.`
                    : ''
                  : `The accounts in view are in ${[...new Set(inView.map((a) => a.currency))].sort().join(', ')}. Each keeps its own currency here; pick a company whose accounts are all GBP for a combined figure.`}
              </div>
            </div>
          </div>
        )}

        {submit.error && (
          <ErrorNote
            error={submit.error}
            entryLabel={(i) => (sent[i] === undefined ? null : nameOf(sent[i]))}
          />
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {savedNote && !submit.busy && <span style={{ fontSize: 13.5, color: 'var(--mut)' }}>{savedNote}</span>}
          {plan.unchanged > 0 && !plan.body && !savedNote && (
            <span style={{ fontSize: 13.5, color: 'var(--dim)' }}>Nothing changed since it was recorded.</span>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={!plan.body || submit.busy}
            onClick={save}
          >
            {submit.busy
              ? 'Saving…'
              : plan.body
                ? `Save ${plan.body.entries.length} ${plan.body.entries.length === 1 ? 'balance' : 'balances'}`
                : 'Save balances'}
          </button>
        </div>
      </section>

      <HistorySection
        accounts={inView}
        rows={history.data?.data ?? null}
        error={history.error}
        onRetry={history.reload}
        windowDays={windowDays}
        onWindow={(next) => setParam(DAYS_PARAM, next === 90 ? null : String(next))}
        selected={date}
        onOpen={(d) => {
          setDate(d);
          if (typeof window !== 'undefined') window.scrollTo?.({ top: 0 });
        }}
      />

      {removing && (
        <RemoveDialog
          kicker="CASH AT BANK"
          title={`Remove the ${formatDay(removing.balanceDate)} balance for ${nameOf(removing.accountId)}?`}
          warning="The forecast starts this account from its latest recorded balance, so removing the latest one moves its starting point back to the one before."
          remove={() => api.balances.remove(removing.accountId, removing.balanceDate, removing.rowVersion)}
          onRemoved={() => {
            const { accountId, balanceDate } = removing;
            if (day.data) day.set({ ...day.data, data: withoutBalance(day.data.data, accountId, balanceDate) });
            if (history.data) {
              history.set({ ...history.data, data: withoutBalance(history.data.data, accountId, balanceDate) });
            }
            accounts.reload();
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        >
          {formatDecimal(removing.balance, inView.find((a) => a.id === removing.accountId)?.currency ?? 'GBP')} at the
          start of {formatDay(removing.balanceDate)}. It is deleted for good; the audit log keeps what it was.
        </RemoveDialog>
      )}
    </div>
  );
}

/**
 * The recorded balances, newest day first: one column per account in its own currency,
 * and a combined GBP column only when every account in view is GBP. A row opens that day
 * in the entry table above, which is where a figure is corrected.
 */
function HistorySection({
  accounts,
  rows,
  error,
  onRetry,
  windowDays,
  onWindow,
  selected,
  onOpen,
}: {
  accounts: Account[];
  rows: Balance[] | null;
  error: ApiError | null;
  onRetry: () => void;
  windowDays: Window;
  onWindow: (next: Window) => void;
  selected: string;
  onOpen: (date: string) => void;
}) {
  const combined = rows ? combinedHistory(accounts, rows) : null;
  const inView = new Set(accounts.map((a) => a.id));
  const byDate = new Map<string, Map<number, Balance>>();
  for (const b of rows ?? []) {
    if (!inView.has(b.accountId)) continue;
    const day = byDate.get(b.balanceDate) ?? new Map<number, Balance>();
    day.set(b.accountId, b);
    byDate.set(b.balanceDate, day);
  }
  const dates = [...byDate.keys()].sort().reverse();
  const combinedByDate = new Map((combined ?? []).map((p) => [p.date, p]));
  const columns = `150px repeat(${Math.max(accounts.length, 1)}, minmax(120px, 1fr))${combined ? ' 170px' : ''}`;

  return (
    <section className="panel" aria-label="History" style={{ gap: 12 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2 className="report-title" style={{ margin: 0 }}>
            History
          </h2>
          <div style={{ fontSize: 13, color: 'var(--mut)' }}>
            Recorded balances, each in its account's own currency. Pick a day to correct it above.
          </div>
        </div>
        <Segmented
          ariaLabel="History window"
          compact
          options={WINDOWS.map((w) => ({ id: String(w), label: `${w} days` }))}
          value={String(windowDays)}
          onChange={(next) => onWindow(Number(next) as Window)}
        />
      </div>

      {accounts.length > 0 && !combinedLineAllowed(accounts) && (
        <div style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.55 }} data-testid="no-combined-line">
          No combined line: the accounts in view are not all GBP. Adding currencies together
          needs a rate for each day, which JFlow does not keep.
        </div>
      )}

      {error && <ErrorNote error={error} onRetry={onRetry} />}
      {rows === null ? (
        !error && <Loading what="History" />
      ) : accounts.length === 0 ? null : dates.length === 0 ? (
        <Empty>Nothing recorded in the last {windowDays} days.</Empty>
      ) : (
        <div className="card-table" style={{ overflowX: 'auto' }}>
          <div className="table-head" style={{ gridTemplateColumns: columns }}>
            <div>START OF DAY</div>
            {accounts.map((a) => (
              <div key={a.id} style={{ textAlign: 'right' }} title={a.name}>
                {a.name.toUpperCase()} · {a.currency}
              </div>
            ))}
            {combined && <div style={{ textAlign: 'right' }}>ALL ACCOUNTS · GBP</div>}
          </div>
          {dates.map((d) => {
            const day = byDate.get(d)!;
            const point = combinedByDate.get(d);
            return (
              <button
                key={d}
                type="button"
                className="table-row clickable"
                aria-label={`Open ${formatDay(d)}`}
                aria-current={d === selected ? 'date' : undefined}
                onClick={() => onOpen(d)}
                style={{
                  gridTemplateColumns: columns,
                  background: d === selected ? 'var(--accBg)' : undefined,
                }}
              >
                <div className="mono" style={{ fontSize: 12.5 }}>
                  {formatDay(d)}
                </div>
                {accounts.map((a) => {
                  const b = day.get(a.id);
                  const minor = b ? parseMinor(b.balance) : null;
                  return (
                    <div
                      key={a.id}
                      className="mono"
                      style={{
                        fontSize: 13,
                        textAlign: 'right',
                        color: minor === null ? 'var(--dim)' : minor < 0n ? 'var(--fail)' : undefined,
                      }}
                    >
                      {b ? formatDecimal(b.balance, a.currency) : '—'}
                    </div>
                  );
                })}
                {combined && (
                  <div className="mono" style={{ fontSize: 13, textAlign: 'right' }}>
                    {point?.totalMinor != null ? (
                      <span style={{ color: point.totalMinor < 0n ? 'var(--fail)' : undefined }}>
                        {formatMoney(point.totalMinor, 'GBP')}
                      </span>
                    ) : (
                      <Tag>{`${point?.recorded ?? 0} OF ${point?.of ?? accounts.length}`}</Tag>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
