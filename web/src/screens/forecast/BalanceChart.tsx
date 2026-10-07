import { useMemo, useRef, useState } from 'react';
import type { MouseEvent, Ref } from 'react';
import type { BucketKind, ForecastBucket, ForecastDay } from '../../api/forecast';
import { diffDays, formatDay } from '../../lib/dates';
import { bucketIndexOf, bucketLabel, columnLefts, compactMoney, shortDay, signedMoney } from '../../lib/grid';
import type { GridColumns } from '../../lib/grid';
import { formatMoney, toMinor } from '../../lib/money';

/**
 * The combined GBP closing balance, one point per day of `days[]` — hand-rolled SVG, no
 * chart library. With a scenario open it draws two lines from the one series (D34): the
 * scenario's `closing` (solid) and the baseline's `baselineClosing` (dashed), so the
 * difference a what-if makes is the gap between them.
 *
 * Given the grid's measured columns (`align`), the chart takes its x axis from them (Dev,
 * 2026-10-07): each bucket is drawn exactly as wide as its column and directly above it,
 * every other column is banded as in the grid, and the two scroll sideways together.
 * Without them it is the plain chart, evenly spaced across its own width.
 *
 * Money stays `bigint` for every label; only pixel geometry is a float, and a tick is a
 * whole number of pounds before it becomes a label.
 */

const W = 960;
const H = 250;
/** The height when the columns are the grid's: real pixels then, not a scaled viewBox. */
const ALIGNED_H = 300;
const PAD = { left: 70, right: 18, top: 14, bottom: 30 };

export interface ChartGeometry {
  min: number;
  max: number;
  ticks: number[];
  x: (i: number) => number;
  y: (v: number) => number;
}

/** What the chart needs to sit on the grid's columns. */
export interface ChartAlign {
  kind: BucketKind;
  buckets: ForecastBucket[];
  columns: GridColumns;
}

/** A 1-2-2.5-5 step, in whole pounds (100 pence at least). */
function niceStep(span: number, count: number): number {
  const raw = Math.max(span / count, 100);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  return Math.max(100, Math.round(step / 100) * 100);
}

/** Scales for the values (minor units). Zero joins the range when the line goes below it. */
export function chartGeometry(values: number[], count: number, height = H): ChartGeometry {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 0;
  }
  if (lo < 0 && hi < 0) hi = 0;
  if (lo === hi) {
    lo -= 10_000;
    hi += 10_000;
  }
  const step = niceStep(hi - lo, 4);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max; t += step) ticks.push(t);
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  return {
    min,
    max,
    ticks,
    x: (i) => PAD.left + (count <= 1 ? innerW / 2 : (i * innerW) / (count - 1)),
    y: (v) => PAD.top + innerH - ((v - min) / (max - min || 1)) * innerH,
  };
}

/**
 * Each day's x when the chart shares the grid's columns: a bucket spans its column, and its
 * days share that span equally, each drawn at the middle of its own slice. Null when the
 * columns are not (yet) these buckets', or a day sits outside every bucket.
 */
export function alignedXs(
  days: Pick<ForecastDay, 'date'>[],
  buckets: Pick<ForecastBucket, 'start' | 'end'>[],
  columns: GridColumns,
): number[] | null {
  if (columns.total <= 0 || buckets.length === 0 || columns.widths.length !== buckets.length) return null;
  const lefts = columnLefts(columns);
  const xs: number[] = [];
  for (const day of days) {
    const i = bucketIndexOf(day.date, buckets);
    if (i < 0) return null;
    const span = diffDays(buckets[i].end, buckets[i].start) + 1;
    xs.push(lefts[i] + ((diffDays(day.date, buckets[i].start) + 0.5) * columns.widths[i]) / span);
  }
  return xs;
}

export function linePath(values: number[], xs: number[], y: (v: number) => number): string {
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${y(v).toFixed(1)}`).join(' ');
}

/** About six evenly spaced date labels, always including the first and the last day. */
export function axisIndices(count: number, want = 6): number[] {
  if (count <= 0) return [];
  if (count <= want) return Array.from({ length: count }, (_, i) => i);
  const out = new Set<number>();
  for (let k = 0; k < want; k += 1) out.add(Math.round((k * (count - 1)) / (want - 1)));
  return [...out];
}

export function BalanceChart({
  days,
  withBaseline,
  minDate,
  align,
  scrollRef,
  onScroll,
}: {
  days: ForecastDay[];
  /** A scenario is open: draw `baselineClosing` too. */
  withBaseline: boolean;
  /** The window's lowest day (`summary.minDate`), marked on the line. */
  minDate?: string | null;
  /** The grid's buckets and measured columns: the chart lines up with them. */
  align?: ChartAlign | null;
  /** The sideways scroller (and its scrollbar), when aligned — the screen keeps it in step with the grid's. */
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
}) {
  const closing = useMemo(() => days.map((d) => Number(toMinor(d.closing))), [days]);
  const baseline = useMemo(
    () => (withBaseline ? days.map((d) => Number(toMinor(d.baselineClosing ?? d.closing))) : []),
    [days, withBaseline],
  );
  const alignedX = useMemo(() => (align ? alignedXs(days, align.buckets, align.columns) : null), [days, align]);
  const aligned = align && alignedX ? align : null;
  const height = aligned ? ALIGNED_H : H;
  const g = useMemo(
    () => chartGeometry([...closing, ...baseline], days.length, height),
    [closing, baseline, days.length, height],
  );
  const xs = useMemo(() => alignedX ?? days.map((_, i) => g.x(i)), [alignedX, days, g]);
  const [hover, setHover] = useState<{ i: number; flip: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  if (days.length === 0) return null;

  // The plot's box, in the SVG's own units: the grid's label column and bucket columns when
  // aligned (the Window column's span stays empty), else the fixed viewBox.
  const lefts = aligned ? columnLefts(aligned.columns) : [];
  const width = aligned ? aligned.columns.total : W;
  const left = aligned ? aligned.columns.label : PAD.left;
  const right = aligned ? left + aligned.columns.widths.reduce((sum, w) => sum + w, 0) : W - PAD.right;

  const zeroInside = g.min < 0 && g.max > 0;
  const minIndex = minDate ? days.findIndex((d) => d.date === minDate) : -1;

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const px = ((e.clientX - box.left) / box.width) * width;
    let i = 0;
    for (let k = 1; k < xs.length; k += 1) if (Math.abs(xs[k] - px) < Math.abs(xs[i] - px)) i = k;
    // The tooltip opens toward the middle of what is on screen, so it is never cut off.
    const frame = frameRef.current?.getBoundingClientRect();
    setHover({ i, flip: frame ? e.clientX > frame.left + frame.width / 2 : i > days.length / 2 });
  };

  const at = hover !== null && hover.i < days.length ? hover.i : null;
  const hovered = at === null ? null : days[at];
  const lineLabel = withBaseline ? 'Scenario' : 'Closing balance';

  const tickLabel = (t: number) => (
    <text
      key={t}
      x={left - 10}
      y={g.y(t)}
      textAnchor="end"
      dominantBaseline="middle"
      fontSize="11"
      fill="var(--dim)"
      fontFamily="var(--font-num)"
    >
      {compactMoney(BigInt(Math.round(t)))}
    </text>
  );

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {withBaseline && (
        <div
          data-testid="chart-legend"
          style={{ display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--mut)', padding: aligned ? '0 15px' : undefined }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="var(--acc)" strokeWidth="2" />
            </svg>
            Scenario
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="var(--mut)" strokeWidth="2" strokeDasharray="5 4" />
            </svg>
            Baseline (the real plan)
          </span>
        </div>
      )}
      <div ref={frameRef} style={{ position: 'relative' }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid={aligned ? 'chart-scroll' : undefined}
          // Its scrollbar shows, under the chart: the grid's own is at the bottom of a long
          // list (Dev, 2026-10-07). Either one moves both.
          style={aligned ? { overflowX: 'auto', overflowY: 'hidden' } : undefined}
        >
          <div style={{ position: 'relative', width: aligned ? width : undefined }}>
            <svg
              ref={svgRef}
              {...(aligned ? { width, height } : { viewBox: `0 0 ${W} ${H}`, width: '100%' })}
              role="img"
              aria-label={`${lineLabel}, all accounts in GBP, ${formatDay(days[0].date)} to ${formatDay(days[days.length - 1].date)}`}
              data-testid="balance-chart"
              style={{ display: 'block', overflow: aligned ? undefined : 'visible' }}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            >
              {/* Below zero is an overdraft: tinted, so a dip reads before any number does. */}
              {g.min < 0 && (
                <rect
                  x={left}
                  y={g.y(Math.min(0, g.max))}
                  width={right - left}
                  height={g.y(g.min) - g.y(Math.min(0, g.max))}
                  fill="var(--failBg)"
                  data-testid="chart-below-zero"
                />
              )}
              {/* Every other bucket is banded, top to bottom, as its column is in the grid
                  below (base.css `.col-band`), so a stretch of line reads down to its figures. */}
              {aligned &&
                lefts.map(
                  (x, i) =>
                    i % 2 === 1 && (
                      <rect
                        key={aligned.buckets[i].start}
                        className="col-band"
                        data-testid="chart-band"
                        x={x}
                        y={0}
                        width={aligned.columns.widths[i]}
                        height={height}
                      />
                    ),
                )}
              {g.ticks.map((t) => (
                <g key={t}>
                  <line
                    x1={left}
                    x2={right}
                    y1={g.y(t)}
                    y2={g.y(t)}
                    stroke={t === 0 && zeroInside ? 'var(--fail)' : 'var(--line)'}
                    strokeWidth={1}
                    strokeDasharray={t === 0 && zeroInside ? '3 3' : undefined}
                  />
                  {/* Aligned, the labels sit in the fixed gutter over the grid's label column. */}
                  {!aligned && tickLabel(t)}
                </g>
              ))}
              {aligned
                ? aligned.buckets.map((b, i) => (
                    <text
                      key={b.start}
                      x={lefts[i] + aligned.columns.widths[i] / 2}
                      y={height - 8}
                      textAnchor="middle"
                      fontSize="11"
                      fill="var(--dim)"
                      fontFamily="var(--font-num)"
                    >
                      {bucketLabel(b, aligned.kind)}
                    </text>
                  ))
                : axisIndices(days.length).map((i) => (
                    <text
                      key={i}
                      x={xs[i]}
                      y={H - 8}
                      textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
                      fontSize="11"
                      fill="var(--dim)"
                      fontFamily="var(--font-num)"
                    >
                      {shortDay(days[i].date)}
                    </text>
                  ))}

              {withBaseline && (
                <path
                  d={linePath(baseline, xs, g.y)}
                  fill="none"
                  stroke="var(--mut)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  strokeLinejoin="round"
                  data-testid="chart-line-baseline"
                />
              )}
              {/* A faint wash under the balance line, fading to nothing at the axis: it gives the
                  line weight without competing with the overdraft tint. */}
              <defs>
                <linearGradient id="balance-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: 'var(--acc)', stopOpacity: 0.14 }} />
                  <stop offset="100%" style={{ stopColor: 'var(--acc)', stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              {closing.length > 1 && (
                <path
                  d={`${linePath(closing, xs, g.y)} L${xs[closing.length - 1].toFixed(1)},${g.y(g.min).toFixed(1)} L${xs[0].toFixed(1)},${g.y(g.min).toFixed(1)} Z`}
                  fill="url(#balance-area)"
                  stroke="none"
                />
              )}
              <path
                d={linePath(closing, xs, g.y)}
                fill="none"
                stroke="var(--acc)"
                strokeWidth={2.25}
                strokeLinejoin="round"
                data-testid={withBaseline ? 'chart-line-scenario' : 'chart-line-closing'}
              />

              {minIndex >= 0 && (
                <g data-testid="chart-min">
                  <circle
                    cx={xs[minIndex]}
                    cy={g.y(closing[minIndex])}
                    r={4.5}
                    fill={closing[minIndex] < 0 ? 'var(--fail)' : 'var(--acc)'}
                    stroke="var(--panel)"
                    strokeWidth={2}
                  />
                </g>
              )}

              {at !== null && (
                <g pointerEvents="none">
                  <line x1={xs[at]} x2={xs[at]} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--line2)" />
                  {withBaseline && (
                    <circle cx={xs[at]} cy={g.y(baseline[at])} r={4} fill="var(--mut)" stroke="var(--panel)" strokeWidth={2} />
                  )}
                  <circle cx={xs[at]} cy={g.y(closing[at])} r={4} fill="var(--acc)" stroke="var(--panel)" strokeWidth={2} />
                </g>
              )}
            </svg>
            {hovered && at !== null && (
              <div
                role="tooltip"
                style={{
                  position: 'absolute',
                  top: 4,
                  left: `${(xs[at] / width) * 100}%`,
                  transform: hover?.flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                  background: 'var(--raise)',
                  border: '1px solid var(--line2)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <div className="mono" style={{ color: 'var(--dim)', fontSize: 11.5 }}>
                  {formatDay(hovered.date)} · closing
                </div>
                <div className="mono" style={{ color: toMinor(hovered.closing) < 0n ? 'var(--fail)' : undefined }}>
                  {withBaseline ? 'Scenario ' : ''}
                  {formatMoney(toMinor(hovered.closing), 'GBP')}
                </div>
                {withBaseline && hovered.baselineClosing !== undefined && (
                  <>
                    <div className="mono" style={{ color: 'var(--mut)' }}>
                      Baseline {formatMoney(toMinor(hovered.baselineClosing), 'GBP')}
                    </div>
                    <div className="mono" style={{ color: 'var(--mut)' }}>
                      Difference {signedMoney(toMinor(hovered.closing) - toMinor(hovered.baselineClosing))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {/* The value axis stays put over the grid's sticky label column while the plot scrolls. */}
        {aligned && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: left,
              height,
              boxSizing: 'border-box',
              overflow: 'hidden',
              background: 'var(--panel)',
              borderRight: '1px solid var(--line)',
            }}
          >
            <svg width={left} height={height} style={{ display: 'block' }}>
              {g.ticks.map(tickLabel)}
            </svg>
          </div>
        )}
      </div>
    </figure>
  );
}
