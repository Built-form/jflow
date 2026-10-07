import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { schedules } from '../../api/schedules';
import type { Schedule } from '../../api/schedules';
import { useQuery } from '../../app/useQuery';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { PageHeader, openDetail } from '../../components/PageHeader';
import { Empty, ErrorNote, InfoText, Loading, Segmented, Tag } from '../../components/ui';
import { formatDay, londonToday } from '../../lib/dates';
import { formatDecimal } from '../../lib/money';
import { ScheduleDialog } from './ScheduleDialog';
import { cadenceLabel, endLabel } from './scheduleForm';

export const STATUS_PARAM = 'status';
type StatusFilter = 'active' | 'ended' | 'all';

export function parseStatusFilter(raw: string | null): StatusFilter {
  return raw === 'ended' || raw === 'all' ? raw : 'active';
}

const COLUMNS = 'minmax(0, 1.5fr) minmax(0, 1fr) 140px minmax(0, 1.2fr) 150px';

/**
 * Recurring money in and out. Each row opens the schedule, where its instances are tuned,
 * paid, split or ended. A split leaves two rows — the ended one and its successor — linked
 * both ways.
 */
const SIDES = [
  { direction: 'in', label: 'MONEY IN', color: 'var(--pass)' },
  { direction: 'out', label: 'MONEY OUT', color: 'var(--fail)' },
] as const;

/** A to Z, ignoring case, with numbers in order ("Rent 2" before "Rent 10"); then oldest first. */
const byName = (a: Schedule, b: Schedule) =>
  a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base', numeric: true }) || a.id - b.id;

export function SchedulesScreen() {
  const [today] = useState(() => londonToday());
  const [params, setParams] = useSearchParams();
  const [companyId, setCompanyId] = useCompanyFilter();
  const status = parseStatusFilter(params.get(STATUS_PARAM));
  const navigate = useNavigate();
  const location = useLocation();

  const companies = useQuery(() => api.companies.list(), []);
  const accounts = useQuery(() => api.accounts.list({ companyId }), [companyId]);
  const categories = useQuery(() => api.categories.list(), []);
  const list = useQuery(
    () => schedules.list({ companyId, status: status === 'all' ? undefined : status }),
    [companyId, status],
  );
  const [adding, setAdding] = useState(false);

  const companyRows = sortCompanies(companies.data?.data ?? []);
  const accountRows = accounts.data?.data ?? [];
  const pickable = accountRows.filter((a) => a.isActive && !a.deletedAt);
  const categoryRows = categories.data?.data ?? [];
  const nameOf = (id: number | null) => list.data?.data.find((s) => s.id === id)?.name ?? null;

  const setStatus = (next: StatusFilter) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === 'active') out.delete(STATUS_PARAM);
        else out.set(STATUS_PARAM, next);
        return out;
      },
      { replace: true },
    );

  const open = (s: Schedule) => navigate(...openDetail(`/schedules/${s.id}`, location));

  // Money in, then money out, each A to Z by name (Dev, 2026-10-07) — the API lists newest first.
  const sides = SIDES.map((side) => ({
    ...side,
    rows: (list.data?.data ?? []).filter((s) => s.direction === side.direction).sort(byName),
  })).filter((side) => side.rows.length > 0);

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <PageHeader
        title="Schedules"
        actions={
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <CompanyPicker companies={companyRows} value={companyId} onChange={setCompanyId} />
            <button type="button" className="btn-primary" disabled={pickable.length === 0} onClick={() => setAdding(true)}>
              Add a schedule
            </button>
          </div>
        }
      >
        <InfoText className="explainer">
          Recurring money in and out: salaries, rent, direct debits. Open one to tune, pay,
          split or end its instances. Once a schedule has started, a change to its amount or
          cadence is a split from a date, so the past stays as it was.
        </InfoText>
      </PageHeader>

      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}
      {accounts.error && <ErrorNote error={accounts.error} onRetry={accounts.reload} />}

      <div>
        <Segmented<StatusFilter>
          ariaLabel="Status"
          compact
          options={[
            { id: 'active', label: 'Active' },
            { id: 'ended', label: 'Ended' },
            { id: 'all', label: 'All' },
          ]}
          value={status}
          onChange={setStatus}
        />
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? (
        !list.error && <Loading what="Schedules" />
      ) : list.data.data.length === 0 ? (
        <Empty>
          No {status === 'all' ? '' : `${status} `}schedules {companyId === null ? 'yet' : 'for this company'}.
        </Empty>
      ) : (
        <div className="card-table">
          <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
            <div>SCHEDULE</div>
            <div>ACCOUNT · CATEGORY</div>
            <div style={{ textAlign: 'right' }}>AMOUNT</div>
            <div>WHEN</div>
            <div />
          </div>
          {sides.flatMap((side) => [
            <div
              key={side.direction}
              data-testid={`schedules-${side.direction}`}
              className="table-row"
              style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.1em', color: side.color, paddingTop: 14, paddingBottom: 6 }}
            >
              {side.label} · {side.rows.length}
            </div>,
            ...side.rows.map((s) => {
            const account = accountRows.find((a) => a.id === s.accountId);
            const category = categoryRows.find((c) => c.id === s.categoryId);
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${s.name}`}
                className="table-row clickable"
                style={{ gridTemplateColumns: COLUMNS, alignItems: 'start' }}
                onClick={() => open(s)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(s);
                  }
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontSize: 14.5 }}>{s.name}</span>
                  {s.counterparty && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>{s.counterparty}</span>}
                  {s.predecessorId !== null && (
                    <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                      Split from{' '}
                      <Link to={`/schedules/${s.predecessorId}`} onClick={(e) => e.stopPropagation()}>
                        {nameOf(s.predecessorId) ?? `schedule #${s.predecessorId}`}
                      </Link>
                    </span>
                  )}
                  {s.successorId !== null && (
                    <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                      Continues as{' '}
                      <Link to={`/schedules/${s.successorId}`} onClick={(e) => e.stopPropagation()}>
                        {nameOf(s.successorId) ?? `schedule #${s.successorId}`}
                      </Link>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.5 }}>
                  {account?.name ?? `Account ${s.accountId}`}
                  <br />
                  <span style={{ color: 'var(--dim)' }}>{category?.name ?? `Category ${s.categoryId}`}</span>
                </div>
                <div className="mono" style={{ fontSize: 13.5, textAlign: 'right' }}>
                  {s.direction === 'in' ? '+' : '−'}
                  {formatDecimal(s.amount, s.currency)}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  {cadenceLabel(s.frequency, s.intervalCount)}
                  <br />
                  <span style={{ color: 'var(--dim)' }}>
                    {s.activeFrom ? `Active from ${formatDay(s.activeFrom)}` : `From ${formatDay(s.startDate)}`} ·{' '}
                    {endLabel(s)}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {s.status === 'ended' && <Tag>ENDED</Tag>}
                  {s.structureLocked && <Tag>IN USE</Tag>}
                  {s.settleMode === 'manual' && <Tag>BY HAND</Tag>}
                </div>
              </div>
            );
            }),
          ])}
        </div>
      )}

      {adding && (
        <ScheduleDialog
          schedule={null}
          accounts={pickable}
          categories={categoryRows}
          today={today}
          defaultAccount={pickable.find((a) => a.isDefault) ?? (pickable.length === 1 ? pickable[0] : null)}
          onSaved={(row) => {
            setAdding(false);
            navigate(...openDetail(`/schedules/${row.id}`, location));
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
