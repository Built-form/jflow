import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { external } from '../../api/external';
import type { ExternalItem } from '../../api/external';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { HintTag } from '../../components/HintTag';
import { PageHeader } from '../../components/PageHeader';
import { Empty, ErrorNote, InfoText, Loading, Tag, Toggle } from '../../components/ui';
import { formatDay, londonToday } from '../../lib/dates';
import { flagTags } from '../../lib/grid';
import { formatDecimal, formatMoney, parseMinor } from '../../lib/money';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { DUE_SET_GLYPH, DUE_SET_STYLE, PLAN_STALE_TAG, blockedText, dateMovedText, dueSetLine, dueSetText, lastSyncText } from '../../lib/ship';
import { ShipPlanDialog } from '../forecast/ShipPlanDialog';
import { RefreshButton } from '../forecast/shipping';
import { hasOverlay, targetFromRow } from '../forecast/shipPlan';
import { GroupFilter, GroupSection, RowAction, useShowFilter } from '../items/groups';
import { applyStockFilters, filterOptions, sortStockRows, totalsByCurrency } from './filters';
import { groupExternalItems, notInForecastTags } from './grouping';
import { SortHeading, StockFilterBar, useStockView } from './StockViewControls';

const COLUMNS = '130px minmax(0, 1.6fr) minmax(0, 1fr) 150px minmax(0, 0.9fr)';
const NO_ROWS: ExternalItem[] = [];

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

  const view = useStockView();

  const accountList = accounts.data?.data;
  const accountName = useCallback(
    (id: number | null) => (id == null ? null : (accountList ?? []).find((a) => a.id === id)?.name ?? `Account ${id}`),
    [accountList],
  );

  // Search, filters and sort run over every row already fetched; the server's band still
  // decides each row's section, and each section keeps the chosen order.
  const rows = list.data?.data ?? NO_ROWS;
  const allGroups = useMemo(() => groupExternalItems(rows), [rows]);
  const options = useMemo(() => filterOptions(rows, accountName), [rows, accountName]);
  const filters = useDeferredValue(view.filters);
  const shownRows = useMemo(
    () => sortStockRows(applyStockFilters(rows, filters, accountName), view.sort, accountName),
    [rows, filters, view.sort, accountName],
  );
  const groups = useMemo(() => groupExternalItems(shownRows), [shownRows]);
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

      {list.data && allGroups.length > 0 && (
        <StockFilterBar
          filters={view.filters}
          options={options}
          shown={shownRows.length}
          total={rows.length}
          active={view.active}
          onChange={view.setFilter}
          onClear={view.clear}
        />
      )}

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
      ) : allGroups.length === 0 ? (
        <Empty>
          No stock payments{companyId !== null ? ' for this company' : ''}. Refresh the feed, or map companies in{' '}
          <Link to="/settings?tab=companies">Settings</Link>.
        </Empty>
      ) : groups.length === 0 ? (
        <Empty>
          No stock payments match the search or filters.{' '}
          <button type="button" className="link-btn" onClick={view.clear}>
            Clear filters
          </button>
        </Empty>
      ) : visible.length === 0 ? (
        <Empty>{view.active ? 'Nothing in that group matches the search or filters.' : 'Nothing in that group now.'}</Empty>
      ) : (
        visible.map((group) => (
          <GroupSection key={group.id} group={group}>
            <div className="card-table">
              <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
                <div>
                  <SortHeading k="date" label="Date" sort={view.sort} onSort={view.sortBy} />
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <SortHeading k="supplier" label="Supplier" sort={view.sort} onSort={view.sortBy} />
                  <SortHeading k="po" label="PO" sort={view.sort} onSort={view.sortBy} />
                  <SortHeading k="container" label="Container" sort={view.sort} onSort={view.sortBy} />
                </div>
                <div>
                  <SortHeading k="account" label="Account" sort={view.sort} onSort={view.sortBy} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <SortHeading k="amount" label="Amount" sort={view.sort} onSort={view.sortBy} />
                </div>
                <div />
              </div>
              {group.rows.map((row) => {
                const target = targetFromRow(row);
                const tags = [
                  ...flagTags(target.flags).map((t) => ({ id: t.flag, label: t.label, tone: t.tone })),
                  ...(row.planStale ? [{ id: PLAN_STALE_TAG.flag, label: PLAN_STALE_TAG.label, tone: PLAN_STALE_TAG.tone }] : []),
                  ...(row.sourceScenarioId != null ? [{ id: 'fromScenario', label: 'FROM SCENARIO', tone: 'idle' as const }] : []),
                  // Shipping gives no company; the one it sits under was chosen in JFlow (§10.11a).
                  ...(row.shippingCompanyId == null && row.assignedCompanyId != null
                    ? [{ id: 'companyInJflow', label: 'COMPANY SET IN JFLOW', tone: 'idle' as const }]
                    : []),
                  ...notInForecastTags(row),
                ];
                const open = row.feedStatus === 'open' && !row.goneAt;
                const overlay = hasOverlay(row);
                const shownDate = row.feedStatus === 'paid' ? row.paidOn : row.effectiveDate;
                // A JFlow plan wins the date; shipping's own date then sits on the second line.
                // A date set by hand in ShipLine wears ShipLine's mark (pen, dotted underline)
                // wherever shipping's date shows, with who set it and the derived date under it.
                const planOverridesDate = Boolean(row.plannedDate && row.dueDate !== row.plannedDate);
                const markMain = Boolean(row.dueSet) && !planOverridesDate;
                const pen = <span aria-label="Date set by hand in shipping">{DUE_SET_GLYPH} </span>;
                return (
                  <div
                    key={row.id}
                    className="table-row"
                    data-testid={`stock-${row.key}`}
                    style={{ gridTemplateColumns: COLUMNS, alignItems: 'start' }}
                  >
                    <div className="mono" style={{ fontSize: 12.5, paddingTop: 2 }}>
                      <span
                        data-due-set={markMain ? '1' : undefined}
                        title={markMain && row.dueSet ? dueSetText(row.dueSet) : undefined}
                        style={markMain ? DUE_SET_STYLE : undefined}
                      >
                        {markMain && pen}
                        {shownDate ? formatDay(shownDate) : 'No date yet'}
                      </span>
                      {planOverridesDate && (
                        <div
                          style={{ fontSize: 11.5, color: 'var(--dim)' }}
                          data-due-set={row.dueSet ? '1' : undefined}
                          title={row.dueSet ? dueSetText(row.dueSet) : undefined}
                        >
                          shipping {row.dueSet && pen}
                          <span style={row.dueSet ? DUE_SET_STYLE : undefined}>{row.dueDate ? formatDay(row.dueDate) : 'no date'}</span>
                        </div>
                      )}
                      {row.dueSet && (
                        <div style={{ fontSize: 11.5, color: 'var(--dim)' }} data-testid="stock-due-set">
                          {dueSetLine(row.dueSet)}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      <span style={{ fontSize: 14.5 }}>{target.name}</span>
                      {row.containerRef && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>{row.containerRef}</span>}
                      {row.blocked && <span style={{ fontSize: 12.5, color: 'var(--warn)' }}>{blockedText(row.blocked)}</span>}
                      {row.plannedNote && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>“{row.plannedNote}”</span>}
                      {row.dueSet?.note && (
                        <span style={{ fontSize: 12.5, color: 'var(--mut)' }} data-testid="stock-due-set-note">
                          shipping: “{row.dueSet.note}”
                        </span>
                      )}
                      {tags.length > 0 && (
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {tags.map((t) =>
                            // What a moved date moved from sits behind its tag (2026-11-13), not under the date.
                            t.id === 'date_moved' && row.dueDateMovedAt ? (
                              <HintTag key={t.id} tone={t.tone} hint={dateMovedText(row.dueDatePrev, row.dueDateMovedAt)}>
                                {t.label}
                              </HintTag>
                            ) : (
                              <Tag key={t.id} tone={t.tone}>
                                {t.label}
                              </Tag>
                            ),
                          )}
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
              {group.rows.length > 1 && (
                <div
                  className="table-row"
                  data-testid={`stock-total-${group.id}`}
                  style={{ gridTemplateColumns: COLUMNS, alignItems: 'start', background: 'var(--panel2)' }}
                >
                  <div />
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Total</div>
                  <div />
                  <div className="mono" style={{ fontSize: 13.5, fontWeight: 600, textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {totalsByCurrency(group.rows).map((t) => (
                      <span key={t.currency} data-testid="stock-total-amount">
                        −{formatMoney(t.minor, t.currency)}
                      </span>
                    ))}
                  </div>
                  <div />
                </div>
              )}
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
