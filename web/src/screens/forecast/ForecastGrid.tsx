import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import type { BucketDelta, BucketKind, ForecastBucket, ForecastItem, ForecastRow, ForecastSummary } from '../../api/forecast';
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
 * closing), then each category and the lines under it. Every figure is the server's —
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

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--panel)', boxShadow: 'var(--shadow)' }}
    >
      <table
        ref={tableRef}
        className="ledger"
        data-testid="forecast-grid"
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
            {buckets.map((b) => (
              <td key={b.start} style={cell}>
                {cellMoney(b.inflow, { blankZero: true })}
              </td>
            ))}
            <td style={cell}>{cellMoney(summary.inflow)}</td>
          </HeaderRow>
          <HeaderRow label="Out">
            {buckets.map((b) => (
              <td key={b.start} style={cell}>
                {cellMoney(b.outflow, { blankZero: true })}
              </td>
            ))}
            <td style={cell}>{cellMoney(summary.outflow)}</td>
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

          {rows.map((row) => {
            const open = expanded.has(row.categoryId);
            const groups = groupLines(row.items, buckets.length);
            return (
              <CategoryBlock
                key={`${row.direction}-${row.categoryId}`}
                row={row}
                open={open}
                onToggle={() => toggle(row.categoryId)}
                groups={groups}
                bucketCount={buckets.length}
                lineMarks={lineMarks}
                openCombos={openCombos}
                onToggleCombo={toggleCombo}
                onEdit={(item) => onEdit(item, row)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
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
  return (
    <>
      <tr data-testid={`category-${row.categoryId}`} style={{ background: 'var(--panel2)' }}>
        <th scope="rowgroup" style={{ ...stickyLabel, background: 'var(--panel2)', borderTop: '1px solid var(--line2)' }}>
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
            {row.categoryName}
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', letterSpacing: '.08em' }}>
              {row.direction === 'in' ? 'IN' : 'OUT'}
            </span>
          </button>
          {!open && <AttentionMarker id={row.categoryId} tags={attentionTags(row.items, lineMarks)} />}
        </th>
        {Array.from({ length: bucketCount }, (_, i) => (
          <td key={i} style={{ ...cell, borderTop: '1px solid var(--line2)', fontWeight: 600 }}>
            {cellMoney(row.totals[i] ?? 0, { blankZero: true })}
          </td>
        ))}
        <td style={{ ...cell, borderTop: '1px solid var(--line2)', fontWeight: 600 }}>{cellMoney(row.total)}</td>
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
    </>
  );
}

/** One line's row: its name (and container or counterparty under it) and its cells. */
function LineRow({
  group,
  indent,
  lineMarks,
  onEdit,
}: {
  group: LineGroup;
  indent: number;
  lineMarks: LineMarks;
  onEdit: (item: ForecastItem) => void;
}) {
  // A ship line's name already carries the supplier (§6.10); its container says more —
  // unless it sits under its supplier + shipment group, which already says both.
  const sub = group.kind === 'ship' ? (indent > 30 ? null : group.lines[0]?.ship?.containerRef ?? null) : group.counterparty;
  return (
    <tr data-testid={`line-${group.key}`}>
      <th scope="row" style={{ ...stickyLabel, fontWeight: 400, borderTop: '1px solid var(--line)', paddingLeft: indent }}>
        <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={group.name}>
          {group.name}
        </div>
        {sub && (
          <div style={{ fontSize: 12, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sub}
          </div>
        )}
      </th>
      {group.cells.map((lines, i) => (
        <td key={i} style={cell}>
          {lines.map((line, j) => (
            <LineCell key={lineId(line, j)} line={line} marks={lineMarks.get(line.key)} onEdit={onEdit} />
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
  const sub = `${combo.containerRef ?? 'No container'} · ${count} ${count === 1 ? 'payment' : 'payments'}`;
  return (
    <>
      <tr data-testid={`combo-${combo.key}`}>
        <th scope="row" style={{ ...stickyLabel, fontWeight: 500, borderTop: '1px solid var(--line)', paddingLeft: 30 }}>
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
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={combo.supplier ?? undefined}>
              {combo.supplier ?? 'No supplier'}
            </span>
          </button>
          <div style={{ fontSize: 12, color: 'var(--dim)', paddingLeft: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sub}
          </div>
          {!open && <AttentionMarker id={`combo:${combo.key}`} tags={attentionTags(combo.lines, lineMarks)} />}
        </th>
        {combo.cells.map((sum, i) => (
          <td key={i} style={{ ...cell, fontWeight: 500 }}>
            {cellMoney(sum, { blankZero: true })}
          </td>
        ))}
        <td style={{ ...cell, fontWeight: 500 }}>{cellMoney(combo.total)}</td>
      </tr>
      {open && combo.groups.map((group) => <LineRow key={group.key} group={group} indent={46} lineMarks={lineMarks} onEdit={onEdit} />)}
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
  line,
  marks,
  onEdit,
}: {
  line: ForecastItem;
  marks?: FlagTag[];
  onEdit: (item: ForecastItem) => void;
}) {
  const tags = [...flagTags(line.flags), ...(marks ?? [])];
  const excluded = line.flags.includes('excluded');
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
      <span style={box} title={title} data-line={line.key} aria-label={describe}>
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
      onClick={() => onEdit(line)}
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
