import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { ApiError } from '../../api/client';
import type {
  ForecastAccount,
  ForecastHidden,
  ForecastHide,
  ForecastItem,
  ForecastRow,
  ForecastScenario,
  ForecastSummary,
  ForecastWarning,
  UnresolvedLine,
} from '../../api/forecast';
import { forecast } from '../../api/forecast';
import type { Account } from '../../api/types';
import { useScenario } from '../../app/ScenarioContext';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { useQuery } from '../../app/useQuery';
import { PageHeader } from '../../components/PageHeader';
import { Empty, ErrorNote, InfoText, Loading, Pill, Segmented, Tag } from '../../components/ui';
import { addDays, formatDay, londonToday } from '../../lib/dates';
import { plural } from '../../lib/format';
import {
  BUCKET_OPTIONS,
  WINDOW_OPTIONS,
  balanceFlag,
  flagTags,
  parseBucket,
  parseWindowDays,
  sameColumns,
  signedMoney,
} from '../../lib/grid';
import type { GridColumns } from '../../lib/grid';
import { formatMoney, toMinor } from '../../lib/money';
import { PLAN_STALE_TAG, splitShipWarnings } from '../../lib/ship';
import { toneOfScenarioStatus } from '../../lib/tone';
import { SCENARIO_STATUS_LABEL, staleReason } from '../scenarios/stale';
import { BalanceChart } from './BalanceChart';
import type { ChartAlign, ChartLabels } from './BalanceChart';
import { EditLineDialog } from './EditLineDialog';
import { ForecastGrid } from './ForecastGrid';
import type { GridHide, LineMarks } from './ForecastGrid';
import { ShipPlanDialog } from './ShipPlanDialog';
import { ShipNotes, ShippingStatus, ShippingUnavailableBanner } from './shipping';

export const BUCKET_PARAM = 'bucket';
export const WINDOW_PARAM = 'days';

/** The server's cap on each of `hide` and `hideCategories` (§6.10). */
const MAX_HIDE = 100;
const NOTHING_HIDDEN: ForecastHide = { keys: [], categoryIds: [] };
/** The chart's two lines while rows are hidden and no scenario is open. */
const HIDE_LABELS: ChartLabels = { main: 'Without hidden rows', baseline: 'Everything', baselineLegend: 'With everything' };

/**
 * The forecast: the combined GBP balance from today, as a chart and as a day / week /
 * month grid of categories and their lines. Click a line the server marked `editable` to
 * change its amount or date — the real item, or, while a scenario is open, an adjustment
 * to that scenario.
 *
 * Overdue, paid, remainder, adjusted, stale… are the server's flags, shown as they come.
 * The client computes no band and no total (CLAUDE.md "Never").
 *
 * Stock payments (Phase 2) arrive as ship lines in their own row. With no scenario open, an
 * edit of one writes JFlow's plan over shipping's figures (the overlay); inside a scenario
 * it is an adjustment like any other line. The shipping feed's state is one status line
 * with "Refresh now"; its warnings are shown in words.
 *
 * The eye on a grid row hides it (Dev, 2026-10-07): the forecast is re-read without that
 * row's money, so the balance, the chart and the tiles show what difference it makes. It is
 * held here, for this visit only — nothing is saved, and a reload shows everything again.
 */
export function ForecastScreen() {
  const [today] = useState(() => londonToday());
  const [params, setParams] = useSearchParams();
  const [companyId, setCompanyId] = useCompanyFilter();
  const bucket = parseBucket(params.get(BUCKET_PARAM));
  const windowDays = parseWindowDays(params.get(WINDOW_PARAM));
  const to = addDays(today, windowDays);
  const { active, open, close } = useScenario();
  const scenarioId = active?.id ?? null;

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

  const companies = useQuery(() => api.companies.list(), []);
  const accounts = useQuery(() => api.accounts.list({ companyId }), [companyId]);
  const [hide, setHide] = useState<ForecastHide>(NOTHING_HIDDEN);
  const hiding = hide.keys.length > 0 || hide.categoryIds.length > 0;
  const data = useQuery(
    () => forecast.get({ companyId, to, bucket, scenarioId, include: 'grid', hide: hiding ? hide : null }),
    [companyId, to, bucket, scenarioId, hide],
  );
  const gridHide: GridHide = useMemo(
    () => ({
      keys: new Set(hide.keys),
      categoryIds: new Set(hide.categoryIds),
      setKeys: (keys, hidden) =>
        setHide((prev) => {
          const rest = prev.keys.filter((k) => !keys.includes(k));
          return { ...prev, keys: hidden ? [...rest, ...keys].slice(0, MAX_HIDE) : rest };
        }),
      setCategory: (categoryId, hidden) =>
        setHide((prev) => {
          const rest = prev.categoryIds.filter((id) => id !== categoryId);
          return { ...prev, categoryIds: hidden ? [...rest, categoryId].slice(0, MAX_HIDE) : rest };
        }),
    }),
    [hide],
  );

  const [editing, setEditing] = useState<{ item: ForecastItem; row: ForecastRow } | null>(null);

  const accountName = useMemo(() => {
    const names = new Map<number, string>((accounts.data?.data ?? []).map((a: Account) => [a.id, a.name]));
    for (const a of data.data?.accounts ?? []) names.set(a.accountId, a.name);
    return (id: number) => names.get(id) ?? `Account ${id}`;
  }, [accounts.data, data.data]);

  const companyName = useMemo(() => {
    const names = new Map<number, string>((companies.data?.data ?? []).map((c) => [c.id, c.name]));
    return (id: number) => names.get(id) ?? `company #${id}`;
  }, [companies.data]);

  const lineName = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of data.data?.rows ?? []) for (const item of row.items) names.set(item.key, item.name);
    return (key: string) => names.get(key) ?? null;
  }, [data.data]);

  const res = data.data;
  const scenario = res?.scenario ?? null;
  // With rows hidden and no scenario open, the chart and the tiles compare with everything
  // shown; inside a scenario they keep comparing with the real plan, and the panel says the rest.
  const hidden = res?.hidden ?? null;
  const compareHidden = scenario === null && hidden !== null;
  const chartDays = useMemo(
    () => (res && compareHidden ? res.days.map((d) => ({ ...d, baselineClosing: d.fullClosing })) : res?.days ?? []),
    [res, compareHidden],
  );

  // The chart sits on the grid's columns (Dev, 2026-10-07): the grid reports them as laid
  // out, the chart draws each bucket that wide, and the two scroll sideways as one.
  const [columns, setColumns] = useState<GridColumns | null>(null);
  const onColumns = useCallback((next: GridColumns) => setColumns((prev) => (sameColumns(prev, next) ? prev : next)), []);
  const chartScroll = useRef<HTMLDivElement>(null);
  const gridScroll = useRef<HTMLDivElement>(null);
  const follow = (from: RefObject<HTMLDivElement | null>, to: RefObject<HTMLDivElement | null>) => () => {
    if (from.current && to.current && to.current.scrollLeft !== from.current.scrollLeft) to.current.scrollLeft = from.current.scrollLeft;
  };
  const align: ChartAlign | null = useMemo(
    () =>
      res && res.rows !== undefined && columns && columns.total > 0
        ? { kind: res.meta.bucket ?? bucket, buckets: res.buckets, columns }
        : null,
    [res, columns, bucket],
  );
  const shipWarnings = useMemo(() => splitShipWarnings(res?.warnings), [res]);
  const lineMarks: LineMarks = useMemo(
    () => new Map(shipWarnings.stale.map((key) => [key, [PLAN_STALE_TAG]])),
    [shipWarnings],
  );

  // The banner's name is remembered from when the scenario was opened; the server's is current.
  useEffect(() => {
    if (active && scenario && scenario.id === active.id && scenario.name !== active.name) open({ id: scenario.id, name: scenario.name });
  }, [active, scenario, open]);

  return (
    <div className="page">
      <PageHeader
        title="Forecast"
        actions={<CompanyPicker companies={sortCompanies(companies.data?.data ?? [])} value={companyId} onChange={setCompanyId} />}
      >
        <InfoText className="explainer">
          Cash at bank from today, every account in GBP: the balance line, then the money in
          and out by category. Click an amount to move it or change it.
        </InfoText>
      </PageHeader>

      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}

      {data.error ? (
        <ForecastError
          error={data.error}
          scenarioName={active?.name ?? null}
          onCloseScenario={close}
          onRetry={data.reload}
        />
      ) : !res ? (
        <Loading what="Forecast" />
      ) : (
        <>
          {scenario && <ScenarioPanel scenario={scenario} lineName={lineName} />}
          <ShippingUnavailableBanner warning={shipWarnings.unavailable} />
          <Warnings warnings={shipWarnings.other} accountName={accountName} />
          <ShipNotes warnings={shipWarnings} lineName={lineName} companyName={companyName} onChanged={data.reload} />
          <UnresolvedBanner summary={res.summary} unresolved={res.unresolved} accountName={accountName} />
          <SummaryTiles
            summary={res.summary}
            baseline={scenario?.baselineSummary ?? hidden?.fullSummary ?? null}
            baselineLabel={scenario ? 'real plan' : 'with everything'}
          />
          <ShippingStatus shipping={res.shipping} onRefreshed={data.reload} />

          {/* Aligned, the chart runs edge to edge like the grid, so its columns start where the
              grid's do; the panel's padding moves to the heading. */}
          <section
            className="panel"
            aria-label="Balance chart"
            style={align && res.days.length > 0 ? { padding: 0, overflow: 'hidden' } : undefined}
          >
            <div className="kicker" style={align && res.days.length > 0 ? { padding: '15px 15px 0' } : undefined}>
              CLOSING BALANCE · GBP
            </div>
            {res.days.length === 0 ? (
              <Empty>No days in the window.</Empty>
            ) : (
              <BalanceChart
                days={chartDays}
                withBaseline={scenario !== null || compareHidden}
                labels={compareHidden ? HIDE_LABELS : undefined}
                minDate={res.summary.minDate}
                align={align}
                scrollRef={chartScroll}
                onScroll={follow(chartScroll, gridScroll)}
              />
            )}
          </section>

          <section aria-label="Timeline" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* The grid's controls sit with the table, under the chart (Dev, 2026-10-06). */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Segmented
                ariaLabel="Bucket"
                options={BUCKET_OPTIONS}
                value={bucket}
                onChange={(next) => setParam(BUCKET_PARAM, next === 'week' ? null : next)}
              />
              <Segmented
                ariaLabel="Window"
                compact
                options={WINDOW_OPTIONS.map((d) => ({ id: String(d), label: `${d} days` }))}
                value={String(windowDays)}
                onChange={(next) => setParam(WINDOW_PARAM, next === '90' ? null : next)}
              />
              <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
                {formatDay(res.meta.from)} – {formatDay(res.meta.to)}
                {res.meta.toClamped ? ' (capped)' : ''}
              </span>
            </div>
            {hiding && (
              <HiddenPanel
                hide={hide}
                hidden={hidden}
                summary={res.summary}
                waiting={data.loading}
                onShowAll={() => setHide(NOTHING_HIDDEN)}
              />
            )}
            {res.rows === undefined ? (
              <Empty>The grid was not included in this answer.</Empty>
            ) : (
              <>
                <ForecastGrid
                  kind={res.meta.bucket ?? bucket}
                  buckets={res.buckets}
                  rows={res.rows}
                  summary={res.summary}
                  delta={scenario?.deltaByBucket ?? null}
                  lineMarks={lineMarks}
                  hide={gridHide}
                  onEdit={(item, row) => setEditing({ item, row })}
                  onColumns={onColumns}
                  scrollRef={gridScroll}
                  onScroll={follow(gridScroll, chartScroll)}
                />
                {res.rows.length === 0 && <Empty>No money in or out in this window.</Empty>}
              </>
            )}
          </section>

          <StartingPoint accounts={res.accounts} />
        </>
      )}

      {editing && res && editing.item.kind === 'ship' && !scenario && (
        <ShipPlanDialog
          itemKey={editing.item.key}
          title={editing.item.name}
          today={res.meta.today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // The plan moves the line, its bucket and every balance after it: re-read.
            data.reload();
          }}
        />
      )}

      {editing && res && !(editing.item.kind === 'ship' && !scenario) && (
        <EditLineDialog
          item={editing.item}
          categoryName={editing.row.categoryName}
          scenario={scenario ? { id: scenario.id, name: scenario.name } : null}
          today={res.meta.today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // The forecast is derived from every row at once; the write answered with one
            // row, so the honest replacement is the forecast as the server now computes it.
            data.reload();
          }}
        />
      )}
    </div>
  );
}

/** A refusal of the whole read. A missing FX rate and a vanished scenario say how to fix them. */
function ForecastError({
  error,
  scenarioName,
  onCloseScenario,
  onRetry,
}: {
  error: ApiError;
  scenarioName: string | null;
  onCloseScenario: () => void;
  onRetry: () => void;
}) {
  if (error.code === 'FX_RATE_MISSING') {
    const currencies = Array.isArray(error.details?.currencies) ? (error.details?.currencies as string[]) : [];
    return (
      <div className="error-banner" role="alert" data-testid="fx-missing">
        <span>
          No exchange rate for {currencies.length ? currencies.join(', ') : 'a currency in view'}, so nothing can be
          added up in GBP. <Link to="/settings?tab=fx">Add the rate in Settings</Link>.
          <span className="mono" style={{ color: 'var(--dim)', marginLeft: 8, fontSize: 12 }}>
            FX_RATE_MISSING
          </span>
        </span>
      </div>
    );
  }
  if (error.status === 404 && scenarioName) {
    return (
      <div className="error-banner" role="alert">
        <span>The open scenario, "{scenarioName}", no longer exists.</span>
        <button type="button" className="btn" onClick={onCloseScenario}>
          Close it and show the real plan
        </button>
      </div>
    );
  }
  return <ErrorNote error={error} onRetry={onRetry} />;
}

function ScenarioPanel({ scenario, lineName }: { scenario: ForecastScenario; lineName: (key: string) => string | null }) {
  const draft = scenario.status === 'draft';
  return (
    <section
      className="panel"
      aria-label="Scenario"
      style={{ borderColor: 'var(--waivedBd)', gap: 8 }}
      data-testid="forecast-scenario"
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="kicker">SCENARIO</span>
        <span style={{ fontWeight: 600 }}>{scenario.name}</span>
        <Pill tone={toneOfScenarioStatus(scenario.status)}>{SCENARIO_STATUS_LABEL[scenario.status] ?? scenario.status}</Pill>
        <Link to={`/scenarios/${scenario.id}`} style={{ fontSize: 13.5 }}>
          Adjustments, rebase and apply
        </Link>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 1.55 }}>
        {draft
          ? 'The solid line and the grid are this scenario; the dashed line is the real plan. Edits here write adjustments to it.'
          : `This scenario is ${scenario.status}, so it is shown for reading only — nothing here can be edited.`}
      </div>
      {draft && (
        <div style={{ fontSize: 13.5, lineHeight: 1.55 }} data-testid="scenario-how">
          <strong>To change a payment:</strong> open its category in the grid below (or Expand all), then click the
          underlined amount. You can move its date, change the amount or leave it out. Only lines on the forecast
          can be changed.
        </div>
      )}
      {scenario.warnings.length > 0 && (
        <ul data-testid="scenario-warnings" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {scenario.warnings.map((w, i) => {
            const reason = w.code === 'STALE' ? staleReason(w.reason) : null;
            return (
              <li key={`${w.code}-${w.key}-${i}`} style={{ fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Tag tone={w.code === 'STALE' ? 'fail' : 'warn'}>{reason ? `STALE · ${reason.label}` : w.code.replace(/_/g, ' ')}</Tag>
                <span>{lineName(w.key) ?? w.key}</span>
                <span style={{ color: 'var(--mut)' }}>
                  {reason
                    ? `${reason.text} Not applied.`
                    : w.code === 'ADJUSTMENT_OUT_OF_SCOPE'
                      ? 'Its account is outside the company in view, so it is not shown here.'
                      : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * What the eyes in the grid have hidden, in the server's figures: how much money that is,
 * and where the window ends without it against with it. One click shows everything again.
 */
function HiddenPanel({
  hide,
  hidden,
  summary,
  waiting,
  onShowAll,
}: {
  hide: ForecastHide;
  hidden: ForecastHidden | null;
  summary: ForecastSummary;
  waiting: boolean;
  onShowAll: () => void;
}) {
  const asked = [
    hide.categoryIds.length > 0 ? plural(hide.categoryIds.length, 'category', 'categories') : null,
    hide.keys.length > 0 ? plural(hide.keys.length, 'row') : null,
  ]
    .filter(Boolean)
    .join(' and ');
  const m = (v: number) => toMinor(v);
  return (
    <div
      role="status"
      data-testid="hidden-panel"
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'baseline',
        flexWrap: 'wrap',
        border: '1px solid var(--warnBd)',
        background: 'var(--warnBg)',
        borderRadius: 'var(--radius)',
        padding: '9px 13px',
        fontSize: 13.5,
        lineHeight: 1.55,
      }}
    >
      <span className="kicker" style={{ color: 'var(--warn)' }}>
        HIDDEN
      </span>
      {hidden ? (
        <>
          <span>
            {asked} hidden: <span className="mono">{formatMoney(m(hidden.outflow), 'GBP')}</span> out and{' '}
            <span className="mono">{formatMoney(m(hidden.inflow), 'GBP')}</span> in left out of this view.
          </span>
          <span>
            End of window <strong className="mono">{formatMoney(m(summary.closing), 'GBP')}</strong>, against{' '}
            <span className="mono">{formatMoney(m(hidden.fullSummary.closing), 'GBP')}</span> with everything (
            <span className="mono">{signedMoney(m(summary.closing) - m(hidden.fullSummary.closing))}</span>). Lowest point{' '}
            <strong className="mono">{formatMoney(m(summary.minClosing), 'GBP')}</strong>, against{' '}
            <span className="mono">{formatMoney(m(hidden.fullSummary.minClosing), 'GBP')}</span>.
          </span>
        </>
      ) : waiting ? (
        <span>{asked} hidden — working out the forecast without them…</span>
      ) : (
        <span>
          {asked} hidden, but this server did not leave them out: the API has not been updated to hide rows yet.
        </span>
      )}
      <span style={{ color: 'var(--mut)' }}>Nothing is changed or saved.</span>
      <button type="button" className="link-btn" style={{ marginLeft: 'auto' }} onClick={onShowAll}>
        Show everything
      </button>
    </div>
  );
}

/** `warnings[]` — what the forecast left out or could not place, and why. */
export function Warnings({ warnings, accountName }: { warnings: ForecastWarning[]; accountName: (id: number) => string }) {
  if (warnings.length === 0) return null;
  return (
    <section
      aria-label="Warnings"
      data-testid="forecast-warnings"
      style={{
        border: '1px solid var(--warnBd)',
        background: 'var(--warnBg)',
        borderRadius: 'var(--radius)',
        padding: '12px 15px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {warnings.map((w, i) => (
        <div key={i} style={{ fontSize: 13.5, lineHeight: 1.55, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--warn)' }}>
            {String(w.code)}
          </span>
          <span>{warningText(w, accountName)}</span>
        </div>
      ))}
    </section>
  );
}

export function warningText(w: ForecastWarning, accountName: (id: number) => string): string {
  const f = w as Record<string, unknown>;
  switch (w.code) {
    case 'NO_ANCHOR':
      return `${accountName(Number(f.accountId))} has no recorded balance, so it is left out of the forecast. Record one on Cash at bank.`;
    case 'ORPHAN_OVERRIDE':
      return `Schedule #${String(f.scheduleId)} has a tuned instance for ${formatDay(String(f.naturalDate))}, which is no longer one of its dates. It is not in the forecast.`;
    case 'FX_RATE_MISSING':
      return `No exchange rate for ${Array.isArray(f.currencies) ? (f.currencies as string[]).join(', ') : 'a currency'}.`;
    default:
      return Object.entries(f)
        .filter(([k]) => k !== 'code')
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(' · ');
  }
}

/** Where each kind of unresolved line is resolved. */
const UNRESOLVED_HOME: Record<string, { to: string; label: string }> = {
  item: { to: '/items', label: 'Income & outgoings' },
  sched: { to: '/schedules', label: 'Schedules' },
  ship: { to: '/stock-payments', label: 'Stock payments' },
};

/**
 * Manual lines long past due: not in the balance line at all until someone pays, moves or
 * skips them. The count and total are the server's (`summary.unresolved*`).
 */
export function UnresolvedBanner({
  summary,
  unresolved,
  accountName,
}: {
  summary: ForecastSummary;
  unresolved: UnresolvedLine[];
  accountName: (id: number) => string;
}) {
  const [open, setOpen] = useState(false);
  if (summary.unresolvedCount === 0) return null;
  return (
    <section
      role="alert"
      aria-label="Unresolved"
      data-testid="unresolved-banner"
      style={{
        border: '1px solid var(--failBd)',
        background: 'var(--failBg)',
        borderRadius: 'var(--radius)',
        padding: '12px 15px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, lineHeight: 1.55 }}>
          <strong>{plural(summary.unresolvedCount, 'line')}</strong> long overdue and unresolved, worth{' '}
          <span className="mono">{formatMoney(toMinor(summary.unresolvedTotal), 'GBP')}</span>, and not in the
          forecast. Pay, re-date or skip them.
        </span>
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide them' : 'Show them'}
        </button>
      </div>
      {open && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {unresolved.map((u) => (
            <li key={u.key} style={{ fontSize: 13.5, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 600 }}>{u.name}</span>
              <span className="mono">
                {u.direction === 'in' ? 'in ' : 'out '}
                {formatMoney(toMinor(u.amountMinor), u.currency)}
              </span>
              <span style={{ color: 'var(--mut)' }}>
                due {formatDay(u.date)} · {plural(u.ageDays, 'day')} ago · {accountName(u.accountId)}
              </span>
              <Link to={UNRESOLVED_HOME[u.kind]?.to ?? '/items'} style={{ fontSize: 13 }}>
                {UNRESOLVED_HOME[u.kind]?.label ?? 'Income & outgoings'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  baseline,
  baselineLabel = 'real plan',
  flagged,
}: {
  label: string;
  value: bigint;
  sub?: string;
  baseline?: bigint | null;
  /** What `baseline` is: the real plan (a scenario is open), or everything (rows are hidden). */
  baselineLabel?: string;
  flagged?: boolean;
}) {
  return (
    <div
      className="panel"
      style={{
        gap: 6,
        flex: '1 1 170px',
        padding: '14px 16px',
        borderColor: flagged ? 'var(--failBd)' : undefined,
        // A figure below zero is marked on the tile's edge as well as in red ink.
        borderTop: flagged ? '3px solid var(--fail)' : '3px solid var(--acc)',
      }}
    >
      <div className="kicker">{label}</div>
      <div
        className="mono"
        style={{ fontSize: 23, fontWeight: 650, letterSpacing: '-0.015em', color: flagged ? 'var(--fail)' : undefined }}
        data-flag={flagged ? 'negative' : undefined}
      >
        {flagged && <span aria-label="below zero">▼ </span>}
        {formatMoney(value, 'GBP')}
      </div>
      {sub && <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>{sub}</div>}
      {baseline != null && (
        <div className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
          {baselineLabel} {formatMoney(baseline, 'GBP')} · {signedMoney(value - baseline)}
        </div>
      )}
    </div>
  );
}

function SummaryTiles({
  summary,
  baseline,
  baselineLabel,
}: {
  summary: ForecastSummary;
  baseline: ForecastSummary | null;
  baselineLabel?: string;
}) {
  const m = (v: number) => toMinor(v);
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }} data-testid="summary">
      <Tile label="TODAY, START OF DAY" value={m(summary.opening)} baseline={baseline ? m(baseline.opening) : null} baselineLabel={baselineLabel} flagged={balanceFlag(summary.opening) === 'negative'} />
      <Tile
        label="LOWEST POINT"
        value={m(summary.minClosing)}
        sub={formatDay(summary.minDate)}
        baseline={baseline ? m(baseline.minClosing) : null} baselineLabel={baselineLabel}
        flagged={balanceFlag(summary.minClosing) === 'negative'}
      />
      <Tile label="END OF WINDOW" value={m(summary.closing)} baseline={baseline ? m(baseline.closing) : null} baselineLabel={baselineLabel} flagged={balanceFlag(summary.closing) === 'negative'} />
      <Tile label="MONEY IN" value={m(summary.inflow)} baseline={baseline ? m(baseline.inflow) : null} baselineLabel={baselineLabel} />
      <Tile label="MONEY OUT" value={m(summary.outflow)} baseline={baseline ? m(baseline.outflow) : null} baselineLabel={baselineLabel} />
    </div>
  );
}

/**
 * Where today's opening comes from: each account's recorded balance, plus what the server
 * counted between that day and today (payments recorded, and auto lines it assumed went
 * through). "Assumed" is visible here, never silent.
 */
function StartingPoint({ accounts }: { accounts: ForecastAccount[] }) {
  const [open, setOpen] = useState(false);
  if (accounts.length === 0) return null;
  const absorbed = accounts.reduce((n, a) => n + a.absorbed.length, 0);
  return (
    <section className="panel" aria-label="Starting point" style={{ gap: 10 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div className="kicker">STARTING POINT · {plural(accounts.length, 'ACCOUNT', 'ACCOUNTS')}</div>
        {absorbed > 0 && (
          <button type="button" className="btn-quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ color: 'var(--acc)' }}>
            {open ? 'Hide' : 'Show'} {plural(absorbed, 'line')} counted since each balance was recorded
          </button>
        )}
      </div>
      <div className="card-table">
        {accounts.map((a) => (
          <div key={a.accountId} className="table-row" style={{ gridTemplateColumns: 'minmax(0,1.4fr) repeat(3, minmax(0,1fr))' }}>
            <div>
              <div style={{ fontSize: 14 }}>{a.name}</div>
              <div className="mono" style={{ fontSize: 11.5, color: 'var(--dim)' }}>
                {a.currency} · recorded {formatDay(a.anchorDate)}
                {a.anchorAgeDays > 0 ? ` · ${plural(a.anchorAgeDays, 'day')} ago` : ' · today'}
              </div>
            </div>
            <div className="mono" style={{ fontSize: 13, textAlign: 'right' }}>
              {formatMoney(toMinor(a.anchorNative), a.currency)}
            </div>
            <div className="mono" style={{ fontSize: 12.5, textAlign: 'right', color: 'var(--mut)' }}>
              {a.absorbed.length ? `+ ${plural(a.absorbed.length, 'line')}` : ''}
            </div>
            <div
              className="mono"
              style={{ fontSize: 13, textAlign: 'right', color: toMinor(a.openingNative) < 0n ? 'var(--fail)' : undefined }}
              title="Today, start of day"
            >
              {formatMoney(toMinor(a.openingNative), a.currency)}
            </div>
            {open &&
              a.absorbed.map((line, i) => (
                <div
                  key={`${line.key}-${line.paymentId ?? 'a'}-${i}`}
                  style={{ gridColumn: '1 / -1', display: 'flex', gap: 10, fontSize: 12.5, color: 'var(--mut)', paddingLeft: 14, flexWrap: 'wrap' }}
                >
                  <span className="mono">{formatDay(line.date)}</span>
                  <span>{line.name}</span>
                  <span className="mono">
                    {line.direction === 'in' ? '+' : '−'}
                    {formatMoney(toMinor(line.accountMinor), a.currency)}
                  </span>
                  {flagTags(line.flags).map((t) => (
                    <Tag key={t.flag} tone={t.tone}>
                      {t.label}
                    </Tag>
                  ))}
                </div>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

