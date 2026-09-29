import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { external } from '../../api/external';
import type { ExternalItem } from '../../api/external';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { PageHeader } from '../../components/PageHeader';
import { Empty, ErrorNote, InfoText, Loading, Tag, Toggle } from '../../components/ui';
import { formatDay, londonToday } from '../../lib/dates';
import { flagTags } from '../../lib/grid';
import { formatDecimal, parseMinor } from '../../lib/money';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { PLAN_STALE_TAG, blockedText, lastSyncText } from '../../lib/ship';
import { ShipPlanDialog } from '../forecast/ShipPlanDialog';
import { RefreshButton } from '../forecast/shipping';
import { hasOverlay, targetFromRow } from '../forecast/shipPlan';
import { GroupFilter, GroupSection, RowAction, useShowFilter } from '../items/groups';
import { groupExternalItems, notInForecastTags } from './grouping';

const COLUMNS = '130px minmax(0, 1.6fr) minmax(0, 1fr) 150px minmax(0, 0.9fr)';

/**
 * Stock payments: every row of the shipping snapshot (`GET /external-items`), grouped by
 * the server's `derivedStatus`. It is where a stock payment that is not on the Forecast
 * can still be reached — an undated one to date, a skipped one to unskip, a plan left on a
 * payment shipping no longer lists to clear. Shipping's own figures are never edited here:
 * a plan is JFlow's overlay on top of them (CONTRACT §6.12).
 */
export function StockPaymentsScreen() {
  const [today] = useState(() => londonToday());
  const [companyId, setCompanyId] = useCompanyFilter();
  const [show, setShow] = useShowFilter();
  const [includeGone, setIncludeGone] = useState(false);

  const companies = useQuery(() => api.companies.list(), []);
  const accounts = useQuery(() => api.accounts.list(), []);
  const status = useQuery(() => external.status(), []);
  const list = useQuery(() => external.listAll({ companyId, includeGone }), [companyId, includeGone]);
  const [planning, setPlanning] = useState<ExternalItem | null>(null);
  const action = useSubmit();

  const accountName = (id: number | null) =>
    id == null ? null : (accounts.data?.data ?? []).find((a) => a.id === id)?.name ?? `Account ${id}`;

  const groups = useMemo(() => groupExternalItems(list.data?.data ?? []), [list.data]);
  const visible = show === null ? groups : groups.filter((g) => g.id === show);

  const clearPlan = (row: ExternalItem) =>
    void action.run(async () => {
      // Replace-from-response; an older server's 204 is re-read instead.
      const next = await external.unplan(row.key, row.rowVersion);
      if (next) updateList(list, (rows) => upsertById(rows, next));
      else list.reload();
    });

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <PageHeader
        title="Stock payments"
        actions={<CompanyPicker companies={sortCompanies(companies.data?.data ?? [])} value={companyId} onChange={setCompanyId} />}
      >
        <InfoText className="explainer">
          Supplier deposits and balances from shipping. Shipping owns the figures; JFlow can plan
          its own date or amount on top, or skip one, and can always revert to what shipping says.
        </InfoText>
      </PageHeader>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, color: 'var(--mut)' }}>
        <span className="kicker">FEED</span>
        <span className="mono" data-testid="stock-feed-line">
          {status.data
            ? `Last synced ${lastSyncText(status.data.lastSuccessAt)} · ${status.data.itemCount} rows`
            : status.error
              ? 'Status unavailable'
              : '…'}
        </span>
        <RefreshButton
          onRefreshed={() => {
            status.reload();
            list.reload();
          }}
        />
      </div>

      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}
      {action.error && <ErrorNote error={action.error} />}

      <div className="head-row" style={{ alignItems: 'center' }}>
        <GroupFilter groups={groups} value={show} onChange={setShow} />
        <div style={{ minWidth: 240 }}>
          <Toggle
            on={includeGone}
            label="Include gone rows"
            detail="Rows shipping no longer lists, kept for any plan left on them."
            onChange={setIncludeGone}
          />
        </div>
      </div>

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? (
        !list.error && <Loading what="Stock payments" />
      ) : groups.length === 0 ? (
        <Empty>
          No stock payments{companyId !== null ? ' for this company' : ''}. Refresh the feed, or map companies in{' '}
          <Link to="/settings?tab=companies">Settings</Link>.
        </Empty>
      ) : visible.length === 0 ? (
        <Empty>Nothing in that group now.</Empty>
      ) : (
        visible.map((group) => (
          <GroupSection key={group.id} group={group}>
            <div className="card-table">
              <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
                <div>DATE</div>
                <div>PAYMENT</div>
                <div>ACCOUNT</div>
                <div style={{ textAlign: 'right' }}>AMOUNT</div>
                <div />
              </div>
              {group.rows.map((row) => {
                const target = targetFromRow(row);
                const tags = [
                  ...flagTags(target.flags).map((t) => ({ id: t.flag, label: t.label, tone: t.tone })),
                  ...(row.planStale ? [{ id: PLAN_STALE_TAG.flag, label: PLAN_STALE_TAG.label, tone: PLAN_STALE_TAG.tone }] : []),
                  ...(row.sourceScenarioId != null ? [{ id: 'fromScenario', label: 'FROM SCENARIO', tone: 'idle' as const }] : []),
                  ...notInForecastTags(row),
                ];
                const open = row.feedStatus === 'open' && !row.goneAt;
                const overlay = hasOverlay(row);
                const shownDate = row.feedStatus === 'paid' ? row.paidOn : row.effectiveDate;
                return (
                  <div
                    key={row.id}
                    className="table-row"
                    data-testid={`stock-${row.key}`}
                    style={{ gridTemplateColumns: COLUMNS, alignItems: 'start' }}
                  >
                    <div className="mono" style={{ fontSize: 12.5, paddingTop: 2 }}>
                      {shownDate ? formatDay(shownDate) : 'No date yet'}
                      {row.plannedDate && row.dueDate !== row.plannedDate && (
                        <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>
                          shipping {row.dueDate ? formatDay(row.dueDate) : 'no date'}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      <span style={{ fontSize: 14.5 }}>{target.name}</span>
                      {row.containerRef && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>{row.containerRef}</span>}
                      {row.blocked && <span style={{ fontSize: 12.5, color: 'var(--warn)' }}>{blockedText(row.blocked)}</span>}
                      {row.plannedNote && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>“{row.plannedNote}”</span>}
                      {tags.length > 0 && (
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {tags.map((t) => (
                            <Tag key={t.id} tone={t.tone}>
                              {t.label}
                            </Tag>
                          ))}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.5 }}>{accountName(row.accountId) ?? '—'}</div>
                    <div className="mono" style={{ fontSize: 13.5, textAlign: 'right' }}>
                      −{formatDecimal(row.effectiveAmount, row.currency)}
                      {parseMinor(row.effectiveAmount) !== parseMinor(row.amount) && (
                        <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>shipping {formatDecimal(row.amount, row.currency)}</div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      {open && (
                        <RowAction label={`Plan, ${target.name}`} onClick={() => setPlanning(row)}>
                          plan
                        </RowAction>
                      )}
                      {!open && overlay && (
                        <RowAction label={`Clear the plan, ${target.name}`} tone="mut" onClick={() => clearPlan(row)}>
                          clear plan
                        </RowAction>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </GroupSection>
        ))
      )}

      {planning && (
        <ShipPlanDialog
          itemKey={planning.key}
          row={planning}
          today={today}
          onClose={() => setPlanning(null)}
          onSaved={(row) => {
            setPlanning(null);
            // Replace-from-response when the write answered a row; a revert (204) or a
            // refusal that means this list is out of date is re-read instead.
            if (row) updateList(list, (rows) => (row.goneAt && !includeGone ? removeById(rows, row.id) : upsertById(rows, row)));
            else list.reload();
          }}
        />
      )}
    </div>
  );
}
