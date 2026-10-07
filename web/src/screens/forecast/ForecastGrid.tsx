import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, Ref } from 'react';
import type {
  BucketDelta,
  BucketKind,
  ForecastBucket,
  ForecastItem,
  ForecastRow,
  ForecastSummary,
  LineDirection,
} from '../../api/forecast';
import { formatDay } from '../../lib/dates';
import {
  balanceFlag,
  bucketIndexOf,
  bucketLabel,
  cellMoney,
  attentionTags,
  flagTags,
  groupLines,
  groupShipCombos,
  isClipped,
  isShipCategory,
  lineId,
  shortDay,
  signedMoney,
} from '../../lib/grid';
import type { BalanceFlag, FlagTag, GridColumns, LineGroup, ShipCombo } from '../../lib/grid';
import { formatMoney, toMinor } from '../../lib/money';
import { shipFlagNotes, shipLineStyle } from '../../lib/ship';
import { toneStyle } from '../../lib/tone';

/**
 * The timeline grid: one column per bucket, the balance rows on top (opening, in, out,
 * closing), then the categories — money in, then money out, each under its own band — and
 * the lines under each category. Every figure is the server's —
 * the header rows are `buckets[]`, a category's cells are its `totals[]`, a line's cell
 * is its own `gbpMinor`. Nothing here adds money up, with one display-only exception:
 * the Stock payments category shows one line per supplier + shipment (Dev, 2026-10-06, as
 * ShipLine's Balances due does), whose cells are the sum of its lines' `gbpMinor`; the
 * lines themselves sit under it, one click away, and are the ones edited.
 *
 * A ship line (Phase 2) looks the way its server flags say: `estimated` hatched and in
 * italics, `blocked` / `planned` / `due_set` / `date_moved` as marks; `lineMarks` adds the
 * marks that come from `warnings[]` rather than the line (a `SHIP_PLAN_STALE` key).
 */
export type LineMarks = ReadonlyMap<string, FlagTag[]>;
const NO_MARKS: LineMarks = new Map();

const LABEL_W = 250;
const CELL_W = 118;

const stickyLabel: CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  background: 'var(--panel)',
  minWidth: LABEL_W,
  maxWidth: LABEL_W,
  textAlign: 'left',
  padding: '7px 12px',
  borderRight: '1px solid var(--line)',
};

const cell: CSSProperties = {
  minWidth: CELL_W,
  padding: '7px 10px',
  textAlign: 'right',
  verticalAlign: 'top',
  borderTop: '1px solid var(--line)',
  fontFamily: 'var(--font-num)',
  fontVariantNumeric: 'tabular-nums lining-nums',
  fontSize: 12.5,
  whiteSpace: 'nowrap',
};

/**
 * Adding figures up, as a spreadsheet's status bar does (Dev, 2026-10-07): click an In, Out,
 * category or supplier-group figure — or Ctrl/⌘-click a line's, whose plain click edits it —
 * and the bar under the grid shows what the picked figures come to. Display only: every
 * figure picked is one already on screen, and nothing is sent anywhere.
 */
interface Picked {
  minor: bigint;
  direction: LineDirection;
}
const PickedContext = createContext<ReadonlyMap<string, Picked>>(new Map());
/** The side a category's rows are on — a line does not carry its own. */
const DirectionContext = createContext<LineDirection>('out');

/**
 * Hiding (Dev, 2026-10-07): the eye on a category, a supplier group or a line asks the
 * server for the forecast without it, to see what difference it makes. Which rows are
 * hidden is the screen's to hold; every figure is still the server's, and nothing is saved.
 */
export interface GridHide {
  keys: ReadonlySet<string>;
  categoryIds: ReadonlySet<number>;
  setKeys: (keys: string[], hidden: boolean) => void;
  setCategory: (categoryId: number, hidden: boolean) => void;
}
const HideContext = createContext<GridHide | null>(null);
/** True under a hidden category: its rows are hidden with it, and come back with it. */
const CategoryHiddenContext = createContext(false);
/** Room in a label cell for the eye, which sits in its top right corner. */
const EYE_PAD: CSSProperties = { paddingRight: 34 };
const HIDDEN_NAME: CSSProperties = { textDecoration: 'line-through', color: 'var(--dim)' };

function EyeToggle({ what, hidden, locked, onToggle }: { what: string; hidden: boolean; locked?: boolean; onToggle: () => void }) {
  const label = locked
    ? `${what} is hidden with its category — show the category to bring it back`
    : hidden
      ? `Show ${what} in the forecast again`
      : `Hide ${what} from the forecast, to see the balance without it`;
  return (
    <button
      type="button"
      className="ledger-eye"
      aria-pressed={hidden}
      aria-label={label}
      title={label}
      disabled={locked}
      onClick={onToggle}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
        <circle cx="8" cy="8" r="2" />
        {hidden && <path d="M2.5 13.5 13.5 2.5" />}
      </svg>
    </button>
  );
}

const PICK_HINT ='Click to add to the sum';
const PICK_LINE_HINT = 'Ctrl-click to add to the sum';

/** The attributes that make a figure pickable; the grid's one click handler reads them. */
function pickProps(id: string, minor: number | bigint, direction: LineDirection, picked: ReadonlyMap<string, Picked>) {
  const on = picked.has(id);
  return {
    'data-pick': id,
    'data-pick-minor': String(toMinor(minor)),
    'data-pick-direction': direction,
    'data-picked': on ? 'true' : undefined,
  };
}

/** A total's cell (In, Out, a category, a supplier group): pickable unless it is blank. */
function TotalCell({
  id,
  value,
  direction,
  blankZero,
  style,
}: {
  id: string;
  value: number;
  direction: LineDirection;
  blankZero?: boolean;
  style: CSSProperties;
}) {
  const picked = useContext(PickedContext);
  if (blankZero && toMinor(value) === 0n) return <td style={style} />;
  return (
    <td style={{ ...style, cursor: 'cell' }} title={PICK_HINT} {...pickProps(id, value, direction, picked)}>
      {cellMoney(value)}
    </td>
  );
}

/** What the picked figures come to: one sum, or money in, money out and the net of the two. */
function SumBar({ picked, onClear }: { picked: ReadonlyMap<string, Picked>; onClear: () => void }) {
  if (picked.size === 0) return null;
  let moneyIn = 0n;
  let moneyOut = 0n;
  let ins = 0;
  for (const p of picked.values()) {
    if (p.direction === 'in') {
      moneyIn += p.minor;
      ins += 1;
    } else moneyOut += p.minor;
  }
  const mixed = ins > 0 && ins < picked.size;
  return (
    <div
      role="status"
      data-testid="sum-bar"
      style={{
        position: 'sticky',
        bottom: 12,
        zIndex: 2,
        alignSelf: 'flex-end',
        marginLeft: 'auto',
        width: 'fit-content',
        display: 'flex',
        gap: 14,
        alignItems: 'baseline',
        padding: '8px 12px',
        background: 'var(--raise)',
        border: '1px solid var(--acc)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow)',
        fontSize: 13.5,
      }}
    >
      <span style={{ color: 'var(--mut)' }}>
        {picked.size} {picked.size === 1 ? 'figure' : 'figures'}
      </span>
      {mixed ? (
        <>
          <span className="mono">In {formatMoney(moneyIn, 'GBP')}</span>
          <span className="mono">Out {formatMoney(moneyOut, 'GBP')}</span>
          <strong className="mono">Net {signedMoney(moneyIn - moneyOut)}</strong>
        </>
      ) : (
        <strong className="mono">Sum {formatMoney(moneyIn + moneyOut, 'GBP')}</strong>
      )}
      <button type="button" className="link-btn" style={{ fontSize: 12.5 }} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

function flagStyle(flag: BalanceFlag): CSSProperties {
  if (flag === 'negative') {
    const s = toneStyle('fail');
    return { background: s.background, color: s.color, fontWeight: 600 };
  }
  if (flag === 'dips') return { color: 'var(--warn)' };
  return {};
}

/** A balance figure, flagged when it (or, for a closing, a day inside it) is below zero. */
function BalanceCell({ value, minClosing, minDate }: { value: number; minClosing?: number; minDate?: string }) {
  const flag = balanceFlag(value, minClosing);
  const title =
    flag === 'negative'
      ? 'Below zero'
      : flag === 'dips' && minClosing !== undefined
        ? `Dips to ${formatMoney(toMinor(minClosing), 'GBP')} on ${formatDay(minDate)}`
        : undefined;
  return (
    <td style={{ ...cell, ...flagStyle(flag) }} data-flag={flag ?? undefined} title={title}>
      {flag === 'negative' && <span aria-label="below zero">▼ </span>}
      {flag === 'dips' && <span aria-label={`dips below zero on ${formatDay(minDate)}`}>▾ </span>}
      {cellMoney(value)}
    </td>
  );
}

function HeaderRow({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  // The strong row is the period's total: ruled above and double-ruled below, as on a
  // statement (styles/base.css `.ledger-total`).
  return (
    <tr className={strong ? 'ledger-total' : undefined}>
      <th scope="row" style={{ ...stickyLabel, fontWeight: strong ? 600 : 400, fontSize: 13.5, borderTop: '1px solid var(--line)' }}>
        {label}
      </th>
      {children}
    </tr>
  );
}

export function ForecastGrid({
  kind,
  buckets,
  rows,
  summary,
  delta,
  lineMarks = NO_MARKS,
  hide = null,
  onEdit,
  onColumns,
  scrollRef,
  onScroll,
}: {
  kind: BucketKind;
  buckets: ForecastBucket[];
  rows: ForecastRow[];
  summary: ForecastSummary;
  /** `scenario.deltaByBucket`, when a scenario is open. */
  delta: BucketDelta[] | null;
  /** Extra marks per key, from `warnings[]`. */
  lineMarks?: LineMarks;
  /** What is hidden and how to change it; without it the grid shows no eyes. */
  hide?: GridHide | null;
  onEdit: (item: ForecastItem, row: ForecastRow) => void;
  /** The columns as laid out, whenever they change — the chart above draws on them. */
  onColumns?: (columns: GridColumns) => void;
  /** The sideways scroller — the screen keeps the chart's in step with it. */
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
}) {
  // The header cells are the columns: measured on every resize of any of them (a category
  // opening can widen one), so the chart's buckets stay exactly as wide as the grid's.
  const tableRef = useRef<HTMLTableElement>(null);

  // The sideways scrollbar sits under the Closing row (Dev, 2026-10-07), not at the foot of
  // a long list or under the chart: a bar in a table row, pinned to the visible width, that
  // moves the grid (and, through `onScroll`, the chart). The scrollers' own bars are hidden.
  const scrollerEl = useRef<HTMLDivElement | null>(null);
  const barEl = useRef<HTMLDivElement>(null);
  const setScroller = (el: HTMLDivElement | null) => {
    scrollerEl.current = el;
    if (typeof scrollRef === 'function') scrollRef(el);
    else if (scrollRef) (scrollRef as { current: HTMLDivElement | null }).current = el;
  };
  const [view, setView] = useState({ client: 0, total: 0, label: 0 });
  useLayoutEffect(() => {
    const scroller = scrollerEl.current;
    const table = tableRef.current;
    if (!scroller || !table) return;
    const measure = () => {
      const next = {
        client: scroller.clientWidth,
        total: table.scrollWidth,
        label: table.querySelector<HTMLElement>('thead th')?.getBoundingClientRect().width ?? 0,
      };
      setView((prev) => (prev.client === next.client && prev.total === next.total && prev.label === next.label ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(table);
    return () => observer.disconnect();
  }, [buckets]);
  const scrollable = view.total > view.client + 1;
  const onGridScroll = () => {
    const scroller = scrollerEl.current;
    if (scroller && barEl.current && barEl.current.scrollLeft !== scroller.scrollLeft) barEl.current.scrollLeft = scroller.scrollLeft;
    onScroll?.();
  };
  const onBarScroll = () => {
    const scroller = scrollerEl.current;
    if (scroller && barEl.current && scroller.scrollLeft !== barEl.current.scrollLeft) scroller.scrollLeft = barEl.current.scrollLeft;
  };

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || !onColumns) return;
    const heads = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
    const measure = () => {
      const widths = heads.map((h) => h.getBoundingClientRect().width);
      onColumns({ label: widths[0] ?? 0, widths: widths.slice(1, -1), total: table.getBoundingClientRect().width });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    for (const h of heads) observer.observe(h);
    return () => observer.disconnect();
  }, [onColumns, buckets]);

  // Categories open collapsed (Dev, 2026-09-30): the totals read first, and a category's
  // lines are one click away. This set holds the ones opened since.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // The supplier + shipment groups of the Stock payments category, keyed
  // `<categoryId>:<combo key>`. They open collapsed too (the group's total reads first);
  // "Expand all" opens them with the categories.
  const [openCombos, setOpenCombos] = useState<Set<string>>(new Set());
  const allOpen = rows.length > 0 && rows.every((r) => expanded.has(r.categoryId));
  const lowest = bucketIndexOf(summary.minDate, buckets);
  const toggle = (categoryId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  const toggleCombo = (comboId: string) =>
    setOpenCombos((prev) => {
      const next = new Set(prev);
      if (next.has(comboId)) next.delete(comboId);
      else next.add(comboId);
      return next;
    });
  const comboIdsOf = (row: ForecastRow): string[] => {
    const groups = groupLines(row.items, buckets.length);
    if (!isShipCategory(groups)) return [];
    return groupShipCombos(groups, buckets.length).map((c) => `${row.categoryId}:${c.key}`);
  };
  const expandAll = () => {
    setExpanded(new Set(rows.map((r) => r.categoryId)));
    setOpenCombos(new Set(rows.flatMap(comboIdsOf)));
  };
  const collapseAll = () => {
    setExpanded(new Set());
    setOpenCombos(new Set());
  };

  // The figures picked for the sum bar, by cell. A fresh forecast (an edit, another window)
  // changes what the cells hold, so it starts the sum again.
  const [picked, setPicked] = useState<ReadonlyMap<string, Picked>>(new Map());
  useEffect(() => setPicked(new Map()), [rows, buckets]);
  const onPick = (e: MouseEvent<HTMLTableElement>) => {
    const target = e.target as HTMLElement;
    const el = target.closest<HTMLElement>('[data-pick]');
    if (!el) return;
    // A plain click on a line's figure edits it (or does nothing); picking one takes Ctrl/⌘.
    if (el.tagName !== 'TD' && !(e.ctrlKey || e.metaKey)) return;
    const id = el.dataset.pick as string;
    const minor = BigInt(el.dataset.pickMinor ?? '0');
    const direction: LineDirection = el.dataset.pickDirection === 'in' ? 'in' : 'out';
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, { minor, direction });
      return next;
    });
  };

  // One side of the category list (Dev, 2026-10-07): the categories sit under the balance
  // rows, as they did, but each side under a band that names it and with its own edge colour —
  // the small IN / OUT tag beside every name was too easy to miss.
  const section = (which: LineDirection, label: string) => {
    const mine = rows.filter((r) => r.direction === which);
    if (mine.length === 0) return null;
    return (
      <>
        <tr data-testid={`section-${which}`} className="ledger-section" data-direction={which}>
          <th scope="rowgroup" style={{ position: 'sticky', left: 0, zIndex: 1 }}>
            {label}
          </th>
          <td colSpan={buckets.length + 1} />
        </tr>
        {mine.map((row) => (
          <CategoryBlock
            key={`${row.direction}-${row.categoryId}`}
            row={row}
            open={expanded.has(row.categoryId)}
            onToggle={() => toggle(row.categoryId)}
            groups={groupLines(row.items, buckets.length)}
            bucketCount={buckets.length}
            lineMarks={lineMarks}
            openCombos={openCombos}
            onToggleCombo={toggleCombo}
            onEdit={(item) => onEdit(item, row)}
          />
        ))}
      </>
    );
  };

  return (
    <HideContext.Provider value={hide}>
    <PickedContext.Provider value={picked}>
    <div
      ref={setScroller}
      onScroll={onGridScroll}
      className={scrollable ? 'no-scrollbar' : undefined}
      style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--panel)', boxShadow: 'var(--shadow)' }}
    >
      <table
        ref={tableRef}
        className="ledger"
        data-testid="forecast-grid"
        onClick={onPick}
        style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%', fontSize: 13.5 }}
      >
        <thead>
          <tr style={{ background: 'var(--panel2)' }}>
            <th scope="col" style={{ ...stickyLabel, background: 'var(--panel2)', verticalAlign: 'bottom', borderBottom: '1px solid var(--line2)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <span className="kicker">GBP · ALL ACCOUNTS</span>
                {rows.length > 0 && (
                  <button
                    type="button"
                    className="link-btn"
                    style={{ fontSize: 12, fontWeight: 500 }}
                    onClick={allOpen ? collapseAll : expandAll}
                  >
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                )}
              </div>
            </th>
            {buckets.map((b, i) => (
              <th
                key={b.start}
                scope="col"
                title={`${formatDay(b.start)} – ${formatDay(b.end)}${isClipped(b, kind) ? ' (part of the period, clipped to the window)' : ''}`}
                style={{
                  ...cell,
                  borderTop: 0,
                  borderBottom: '1px solid var(--line2)',
                  verticalAlign: 'bottom',
                  fontSize: 12,
                  color: 'var(--mut)',
                  fontWeight: 600,
                  boxShadow: i === lowest ? 'inset 0 -2px 0 var(--acc)' : undefined,
                }}
              >
                {bucketLabel(b, kind)}
                {i === lowest && (
                  <div style={{ fontSize: 10.5, color: 'var(--acc)' }} data-testid="lowest-bucket">
                    Lowest {shortDay(summary.minDate)}
                  </div>
                )}
              </th>
            ))}
            <th
              scope="col"
              style={{ ...cell, borderTop: 0, borderBottom: '1px solid var(--line2)', verticalAlign: 'bottom', fontSize: 12, color: 'var(--mut)', fontWeight: 600 }}
            >
              Window
            </th>
          </tr>
        </thead>
        <tbody>
          <HeaderRow label="Opening">
            {buckets.map((b) => (
              <BalanceCell key={b.start} value={b.opening} />
            ))}
            <BalanceCell value={summary.opening} />
          </HeaderRow>
          <HeaderRow label="In">
            {buckets.map((b, i) => (
              <TotalCell key={b.start} id={`side:in:${i}`} value={b.inflow} direction="in" blankZero style={cell} />
            ))}
            <TotalCell id="side:in:window" value={summary.inflow} direction="in" style={cell} />
          </HeaderRow>
          <HeaderRow label="Out">
            {buckets.map((b, i) => (
              <TotalCell key={b.start} id={`side:out:${i}`} value={b.outflow} direction="out" blankZero style={cell} />
            ))}
            <TotalCell id="side:out:window" value={summary.outflow} direction="out" style={cell} />
          </HeaderRow>
          <HeaderRow label="Closing" strong>
            {buckets.map((b) => (
              <BalanceCell key={b.start} value={b.closing} minClosing={b.minClosing} minDate={b.minDate} />
            ))}
            <BalanceCell value={summary.closing} minClosing={summary.minClosing} minDate={summary.minDate} />
          </HeaderRow>
          {delta && (
            <HeaderRow label="Closing vs real plan">
              {buckets.map((b, i) => {
                const d = delta[i];
                const minor = d ? toMinor(d.closing) : 0n;
                return (
                  <td
                    key={b.start}
                    style={{ ...cell, color: minor === 0n ? 'var(--dim)' : minor < 0n ? 'var(--fail)' : 'var(--pass)' }}
                    data-testid="delta-cell"
                  >
                    {d ? (minor === 0n ? '—' : signedMoney(minor)) : ''}
                  </td>
                );
              })}
              <td style={cell} />
            </HeaderRow>
          )}
          {scrollable && (
            <tr className="ledger-scroll-row" data-testid="grid-scroll">
              <td colSpan={buckets.length + 2}>
                <div style={{ position: 'sticky', left: 0, width: view.client, display: 'flex', alignItems: 'center' }}>
                  <span className="kicker" style={{ width: view.label, flexShrink: 0, padding: '0 12px' }}>
                    ◂ SCROLL DATES ▸
                  </span>
                  <div
                    ref={barEl}
                    className="ledger-scroll"
                    aria-hidden="true"
                    onScroll={onBarScroll}
                  >
                    <div style={{ width: view.total - view.label, height: 1 }} />
                  </div>
                </div>
              </td>
            </tr>
          )}

          {section('in', 'Money in')}
          {section('out', 'Money out')}
        </tbody>
      </table>
    </div>
    <SumBar picked={picked} onClear={() => setPicked(new Map())} />
    </PickedContext.Provider>
    </HideContext.Provider>
  );
}

function CategoryBlock({
  row,
  open,
  onToggle,
  groups,
  bucketCount,
  lineMarks,
  openCombos,
  onToggleCombo,
  onEdit,
}: {
  row: ForecastRow;
  open: boolean;
  onToggle: () => void;
  groups: ReturnType<typeof groupLines>;
  bucketCount: number;
  lineMarks: LineMarks;
  openCombos: ReadonlySet<string>;
  onToggleCombo: (comboId: string) => void;
  onEdit: (item: ForecastItem) => void;
}) {
  const shipCategory = isShipCategory(groups);
  const combos = shipCategory ? groupShipCombos(groups, bucketCount) : [];
  const hide = useContext(HideContext);
  const hidden = hide?.categoryIds.has(row.categoryId) ?? false;
  return (
    <DirectionContext.Provider value={row.direction}>
    <CategoryHiddenContext.Provider value={hidden}>
      <tr
        data-testid={`category-${row.categoryId}`}
        className="ledger-category"
        data-direction={row.direction}
        style={{ background: 'var(--panel2)' }}
      >
        <th scope="rowgroup" style={{ ...stickyLabel, background: 'var(--panel2)', borderTop: '1px solid var(--line2)', ...(hide ? EYE_PAD : {}) }}>
          <button
            type="button"
            className="btn-quiet"
            aria-expanded={open}
            onClick={onToggle}
            style={{ color: 'var(--text)', fontWeight: 600, fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left' }}
          >
            <span aria-hidden="true" style={{ color: 'var(--dim)', width: 10 }}>
              {open ? '▾' : '▸'}
            </span>
            <span style={hidden ? HIDDEN_NAME : undefined}>{row.categoryName}</span>
          </button>
          {hide && <EyeToggle what={row.categoryName} hidden={hidden} onToggle={() => hide.setCategory(row.categoryId, !hidden)} />}
          {!open && <AttentionMarker id={row.categoryId} tags={attentionTags(row.items, lineMarks)} />}
        </th>
        {Array.from({ length: bucketCount }, (_, i) => (
          <TotalCell
            key={i}
            id={`category:${row.categoryId}:${i}`}
            value={row.totals[i] ?? 0}
            direction={row.direction}
            blankZero
            style={{ ...cell, borderTop: '1px solid var(--line2)', fontWeight: 600 }}
          />
        ))}
        <TotalCell
          id={`category:${row.categoryId}:window`}
          value={row.total}
          direction={row.direction}
          style={{ ...cell, borderTop: '1px solid var(--line2)', fontWeight: 600 }}
        />
      </tr>
      {open && !shipCategory && groups.map((group) => <LineRow key={group.key} group={group} indent={30} lineMarks={lineMarks} onEdit={onEdit} />)}
      {open &&
        shipCategory &&
        combos.map((combo) => {
          const comboId = `${row.categoryId}:${combo.key}`;
          return (
            <ShipComboRows
              key={combo.key}
              combo={combo}
              open={openCombos.has(comboId)}
              onToggle={() => onToggleCombo(comboId)}
              lineMarks={lineMarks}
              onEdit={onEdit}
            />
          );
        })}
    </CategoryHiddenContext.Provider>
    </DirectionContext.Provider>
  );
}

/** One line's row: its name (and container or counterparty under it) and its cells. */
function LineRow({
  group,
  indent,
  underCombo,
  lineMarks,
  onEdit,
}: {
  group: LineGroup;
  indent: number;
  /** Under its supplier + shipment group, which already names the container. */
  underCombo?: boolean;
  lineMarks: LineMarks;
  onEdit: (item: ForecastItem) => void;
}) {
  // A ship line's name already carries the supplier (§6.10); its container says more —
  // unless it sits under its supplier + shipment group, which already says both.
  const sub = group.kind === 'ship' ? (underCombo ? null : group.lines[0]?.ship?.containerRef ?? null) : group.counterparty;
  const hide = useContext(HideContext);
  const withCategory = useContext(CategoryHiddenContext);
  const hidden = withCategory || (hide !== null && group.keys.every((k) => hide.keys.has(k)));
  return (
    <tr data-testid={`line-${group.key}`}>
      <th scope="row" style={{ ...stickyLabel, fontWeight: 400, borderTop: '1px solid var(--line)', paddingLeft: indent, ...(hide ? EYE_PAD : {}) }}>
        <div
          style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(hidden ? HIDDEN_NAME : {}) }}
          title={group.name}
        >
          {group.name}
        </div>
        {hide && <EyeToggle what={group.name} hidden={hidden} locked={withCategory} onToggle={() => hide.setKeys(group.keys, !hidden)} />}
        {sub && (
          <div style={{ fontSize: 12, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sub}
          </div>
        )}
      </th>
      {group.cells.map((lines, i) => (
        <td key={i} style={cell}>
          {lines.map((line, j) => (
            <LineCell key={lineId(line, j)} pickId={`line:${i}:${lineId(line, j)}`} line={line} marks={lineMarks.get(line.key)} onEdit={onEdit} />
          ))}
        </td>
      ))}
      <td style={cell} />
    </tr>
  );
}

/**
 * A supplier + shipment group of stock payments (Dev, 2026-10-06, as ShipLine's Balances
 * due): one row with the group's summed figures, and under it, once opened, the
 * individual payments — the lines that are edited.
 */
function ShipComboRows({
  combo,
  open,
  onToggle,
  lineMarks,
  onEdit,
}: {
  combo: ShipCombo;
  open: boolean;
  onToggle: () => void;
  lineMarks: LineMarks;
  onEdit: (item: ForecastItem) => void;
}) {
  const count = combo.lines.length;
  const direction = useContext(DirectionContext);
  const sub = `${combo.containerRef ?? 'No container'} · ${count} ${count === 1 ? 'payment' : 'payments'}`;
  // The group is hidden when every payment in it is; its eye hides or shows them all.
  const hide = useContext(HideContext);
  const withCategory = useContext(CategoryHiddenContext);
  const keys = combo.groups.flatMap((g) => g.keys);
  const hidden = withCategory || (hide !== null && keys.every((k) => hide.keys.has(k)));
  return (
    <>
      <tr data-testid={`combo-${combo.key}`}>
        <th scope="row" style={{ ...stickyLabel, fontWeight: 500, borderTop: '1px solid var(--line)', paddingLeft: 30, ...(hide ? EYE_PAD : {}) }}>
          <button
            type="button"
            className="btn-quiet"
            aria-expanded={open}
            onClick={onToggle}
            style={{ color: 'var(--text)', fontWeight: 500, fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'baseline', textAlign: 'left', maxWidth: '100%' }}
          >
            <span aria-hidden="true" style={{ color: 'var(--dim)', width: 10, flexShrink: 0 }}>
              {open ? '▾' : '▸'}
            </span>
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(hidden ? HIDDEN_NAME : {}) }}
              title={combo.supplier ?? undefined}
            >
              {combo.supplier ?? 'No supplier'}
            </span>
          </button>
          {hide && (
            <EyeToggle
              what={`${combo.supplier ?? 'No supplier'} · ${combo.containerRef ?? 'no container'}`}
              hidden={hidden}
              locked={withCategory}
              onToggle={() => hide.setKeys(keys, !hidden)}
            />
          )}
          <div style={{ fontSize: 12, color: 'var(--dim)', paddingLeft: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sub}
          </div>
          {!open && <AttentionMarker id={`combo:${combo.key}`} tags={attentionTags(combo.lines, lineMarks)} />}
        </th>
        {combo.cells.map((sum, i) => (
          <TotalCell key={i} id={`combo:${combo.key}:${i}`} value={sum} direction={direction} blankZero style={{ ...cell, fontWeight: 500 }} />
        ))}
        <TotalCell id={`combo:${combo.key}:window`} value={combo.total} direction={direction} style={{ ...cell, fontWeight: 500 }} />
      </tr>
      {open && combo.groups.map((group) => <LineRow key={group.key} group={group} indent={46} underCombo lineMarks={lineMarks} onEdit={onEdit} />)}
    </>
  );
}

/**
 * On a collapsed category: each warn or fail tag its hidden lines wear, with a count, so an
 * OVERDUE or STALE line is not lost behind the fold. Open, the lines show their own tags.
 */
function AttentionMarker({ id, tags }: { id: number | string; tags: ReturnType<typeof attentionTags> }) {
  if (tags.length === 0) return null;
  return (
    <span data-testid={`attention-${id}`} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4, paddingLeft: 18 }}>
      {tags.map((t) => {
        const s = toneStyle(t.tone);
        return (
          <span
            key={t.flag}
            data-flag={t.flag}
            title={`${t.count} ${t.count === 1 ? 'line' : 'lines'} ${t.label.toLowerCase()} — open the category to see which`}
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: '.06em',
              border: `1px solid ${s.borderColor}`,
              background: s.background,
              color: s.color,
              borderRadius: 4,
              padding: '0 4px',
            }}
          >
            {t.label} {t.count}
          </span>
        );
      })}
    </span>
  );
}

/** One line in one cell: its GBP figure and its flags; a button when the server allows an edit. */
function LineCell({
  pickId,
  line,
  marks,
  onEdit,
}: {
  pickId: string;
  line: ForecastItem;
  marks?: FlagTag[];
  onEdit: (item: ForecastItem) => void;
}) {
  const pick = pickProps(pickId, line.gbpMinor, useContext(DirectionContext), useContext(PickedContext));
  const tags = [...flagTags(line.flags), ...(marks ?? [])];
  // Left out by the scenario or hidden with an eye: either way the server counts nothing for it.
  const excluded = line.flags.includes('excluded') || line.flags.includes('hidden');
  const stale = line.flags.includes('stale');
  const ship = line.kind === 'ship';
  const estimated = ship && line.flags.includes('estimated');
  const figure = (
    <span
      data-estimated={estimated ? 'true' : undefined}
      style={{
        ...(ship ? shipLineStyle(line.flags) : {}),
        textDecoration: excluded ? 'line-through' : undefined,
        color: excluded ? 'var(--dim)' : undefined,
        padding: estimated ? '0 3px' : undefined,
        borderRadius: estimated ? 3 : undefined,
      }}
    >
      {cellMoney(line.gbpMinor)}
    </span>
  );
  const body = (
    <>
      {figure}
      {tags.length > 0 && (
        <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 2 }}>
          {tags.map((t) => {
            const s = toneStyle(t.tone);
            return (
              <span
                key={t.flag}
                data-flag={t.flag}
                style={{
                  fontSize: 9.5,
                  letterSpacing: '.06em',
                  border: `1px solid ${s.borderColor}`,
                  background: s.background,
                  color: s.color,
                  borderRadius: 4,
                  padding: '0 4px',
                }}
              >
                {t.label}
              </span>
            );
          })}
        </span>
      )}
    </>
  );
  const describe = `${line.name}, ${formatMoney(toMinor(line.amountMinor), line.currency)} on ${formatDay(line.date)}${
    tags.length ? `, ${tags.map((t) => t.label.toLowerCase()).join(', ')}` : ''
  }`;
  const notes = ship ? shipFlagNotes(line.flags, line.ship) : [];
  const title = [
    line.currency !== 'GBP' ? `${formatMoney(toMinor(line.amountMinor), line.currency)} · ${formatDay(line.date)}` : formatDay(line.date),
    ...notes,
    `· ${PICK_LINE_HINT}`,
  ].join(' ');
  const box: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    width: '100%',
    padding: '2px 4px',
    margin: '0 -4px 2px 0',
    borderRadius: 6,
    outline: stale ? '1px dashed var(--fail)' : undefined,
  };
  if (!line.editable) {
    return (
      <span style={box} title={title} data-line={line.key} aria-label={describe} {...pick}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-line={line.key}
      aria-label={`Edit ${describe}`}
      title={title}
      {...pick}
      // Ctrl/⌘-click picks the figure for the sum bar (the grid's handler); it does not edit.
      onClick={(e) => {
        if (!(e.ctrlKey || e.metaKey)) onEdit(line);
      }}
      // Ink, not link-blue: a ledger's figures are all one colour. `.ledger-edit` shows the
      // figure is editable on hover and focus instead.
      className="pressable ledger-edit"
      style={{
        ...box,
        border: 0,
        font: 'inherit',
        cursor: 'pointer',
        textAlign: 'right',
      }}
    >
      {body}
    </button>
  );
}
