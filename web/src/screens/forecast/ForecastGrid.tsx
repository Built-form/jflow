import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { BucketDelta, BucketKind, ForecastBucket, ForecastItem, ForecastRow, ForecastSummary } from '../../api/forecast';
import { formatDay } from '../../lib/dates';
import {
  balanceFlag,
  bucketIndexOf,
  bucketLabel,
  cellMoney,
  flagTags,
  groupLines,
  isClipped,
  lineId,
  shortDay,
  signedMoney,
} from '../../lib/grid';
import type { BalanceFlag, FlagTag } from '../../lib/grid';
import { formatMoney, toMinor } from '../../lib/money';
import { shipFlagNotes, shipLineStyle } from '../../lib/ship';
import { toneStyle } from '../../lib/tone';

/**
 * The timeline grid: one column per bucket, the balance rows on top (opening, in, out,
 * closing), then each category and the lines under it. Every figure is the server's —
 * the header rows are `buckets[]`, a category's cells are its `totals[]`, a line's cell
 * is its own `gbpMinor`. Nothing here adds money up.
 *
 * A ship line (Phase 2) looks the way its server flags say: `estimated` hatched and in
 * italics, `blocked` / `planned` / `projected` as marks; `lineMarks` adds the marks that
 * come from `warnings[]` rather than the line (a `SHIP_PLAN_STALE` key).
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
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const lowest = bucketIndexOf(summary.minDate, buckets);
  const toggle = (categoryId: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--panel)', boxShadow: 'var(--shadow)' }}>
      <table
        className="ledger"
        data-testid="forecast-grid"
        style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%', fontSize: 13.5 }}
      >
        <thead>
          <tr style={{ background: 'var(--panel2)' }}>
            <th scope="col" style={{ ...stickyLabel, background: 'var(--panel2)', verticalAlign: 'bottom', borderBottom: '1px solid var(--line2)' }}>
              <span className="kicker">GBP · ALL ACCOUNTS</span>
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
            const open = !collapsed.has(row.categoryId);
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
  onEdit,
}: {
  row: ForecastRow;
  open: boolean;
  onToggle: () => void;
  groups: ReturnType<typeof groupLines>;
  bucketCount: number;
  lineMarks: LineMarks;
  onEdit: (item: ForecastItem) => void;
}) {
  return (
    <>
      <tr data-testid={`category-${row.categoryId}`} style={{ background: 'var(--panel2)' }}>
        <th scope="rowgroup" style={{ ...stickyLabel, background: 'var(--panel2)', borderTop: '1px solid var(--line2)' }}>
          <button
            type="button"
            className="btn-quiet"
            aria-expanded={open}
            onClick={onToggle}
            style={{ color: 'var(--text)', fontWeight: 600, fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center' }}
          >
            <span aria-hidden="true" style={{ color: 'var(--dim)', width: 10 }}>
              {open ? '▾' : '▸'}
            </span>
            {row.categoryName}
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', letterSpacing: '.08em' }}>
              {row.direction === 'in' ? 'IN' : 'OUT'}
            </span>
          </button>
        </th>
        {Array.from({ length: bucketCount }, (_, i) => (
          <td key={i} style={{ ...cell, borderTop: '1px solid var(--line2)', fontWeight: 600 }}>
            {cellMoney(row.totals[i] ?? 0, { blankZero: true })}
          </td>
        ))}
        <td style={{ ...cell, borderTop: '1px solid var(--line2)', fontWeight: 600 }}>{cellMoney(row.total)}</td>
      </tr>
      {open &&
        groups.map((group) => {
          // A ship line's name already carries the supplier (§6.10); its container says more.
          const sub = group.kind === 'ship' ? group.lines[0]?.ship?.containerRef ?? null : group.counterparty;
          return (
          <tr key={group.key} data-testid={`line-${group.key}`}>
            <th scope="row" style={{ ...stickyLabel, fontWeight: 400, borderTop: '1px solid var(--line)', paddingLeft: 30 }}>
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
        })}
    </>
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
