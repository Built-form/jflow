import { useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ForecastDay } from '../../api/forecast';
import { formatDay } from '../../lib/dates';
import { compactMoney, shortDay, signedMoney } from '../../lib/grid';
import { formatMoney, toMinor } from '../../lib/money';

/**
 * The combined GBP closing balance, one point per day of `days[]` — hand-rolled SVG, no
 * chart library. With a scenario open it draws two lines from the one series (D34): the
 * scenario's `closing` (solid) and the baseline's `baselineClosing` (dashed), so the
 * difference a what-if makes is the gap between them.
 *
 * Money stays `bigint` for every label; only pixel geometry is a float, and a tick is a
 * whole number of pounds before it becomes a label.
 */

const W = 960;
const H = 250;
const PAD = { left: 70, right: 18, top: 14, bottom: 30 };

export interface ChartGeometry {
  min: number;
  max: number;
  ticks: number[];
  x: (i: number) => number;
  y: (v: number) => number;
}

/** A 1-2-2.5-5 step, in whole pounds (100 pence at least). */
function niceStep(span: number, count: number): number {
  const raw = Math.max(span / count, 100);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  return Math.max(100, Math.round(step / 100) * 100);
}

/** Scales for the values (minor units). Zero joins the range when the line goes below it. */
export function chartGeometry(values: number[], count: number): ChartGeometry {
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
  const innerH = H - PAD.top - PAD.bottom;
  return {
    min,
    max,
    ticks,
    x: (i) => PAD.left + (count <= 1 ? innerW / 2 : (i * innerW) / (count - 1)),
    y: (v) => PAD.top + innerH - ((v - min) / (max - min || 1)) * innerH,
  };
}

export function linePath(values: number[], g: ChartGeometry): string {
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`).join(' ');
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
}: {
  days: ForecastDay[];
  /** A scenario is open: draw `baselineClosing` too. */
  withBaseline: boolean;
  /** The window's lowest day (`summary.minDate`), marked on the line. */
  minDate?: string | null;
}) {
  const closing = useMemo(() => days.map((d) => Number(toMinor(d.closing))), [days]);
  const baseline = useMemo(
    () => (withBaseline ? days.map((d) => Number(toMinor(d.baselineClosing ?? d.closing))) : []),
    [days, withBaseline],
  );
  const g = useMemo(() => chartGeometry([...closing, ...baseline], days.length), [closing, baseline, days.length]);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (days.length === 0) return null;

  const zeroInside = g.min < 0 && g.max > 0;
  const minIndex = minDate ? days.findIndex((d) => d.date === minDate) : -1;

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const innerW = W - PAD.left - PAD.right;
    const i = days.length <= 1 ? 0 : Math.round(((px - PAD.left) / innerW) * (days.length - 1));
    setHover(Math.min(days.length - 1, Math.max(0, i)));
  };

  const hovered = hover === null ? null : days[hover];
  const lineLabel = withBaseline ? 'Scenario' : 'Closing balance';

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {withBaseline && (
        <div data-testid="chart-legend" style={{ display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--mut)' }}>
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
      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`${lineLabel}, all accounts in GBP, ${formatDay(days[0].date)} to ${formatDay(days[days.length - 1].date)}`}
          data-testid="balance-chart"
          style={{ display: 'block', overflow: 'visible' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* Below zero is an overdraft: tinted, so a dip reads before any number does. */}
          {g.min < 0 && (
            <rect
              x={PAD.left}
              y={g.y(Math.min(0, g.max))}
              width={W - PAD.left - PAD.right}
              height={g.y(g.min) - g.y(Math.min(0, g.max))}
              fill="var(--failBg)"
              data-testid="chart-below-zero"
            />
          )}
          {g.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={g.y(t)}
                y2={g.y(t)}
                stroke={t === 0 && zeroInside ? 'var(--fail)' : 'var(--line)'}
                strokeWidth={1}
                strokeDasharray={t === 0 && zeroInside ? '3 3' : undefined}
              />
              <text
                x={PAD.left - 10}
                y={g.y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize="11"
                fill="var(--dim)"
                fontFamily="var(--font-num)"
              >
                {compactMoney(BigInt(Math.round(t)))}
              </text>
            </g>
          ))}
          {axisIndices(days.length).map((i) => (
            <text
              key={i}
              x={g.x(i)}
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
              d={linePath(baseline, g)}
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
              d={`${linePath(closing, g)} L${g.x(closing.length - 1).toFixed(1)},${g.y(g.min).toFixed(1)} L${g.x(0).toFixed(1)},${g.y(g.min).toFixed(1)} Z`}
              fill="url(#balance-area)"
              stroke="none"
            />
          )}
          <path
            d={linePath(closing, g)}
            fill="none"
            stroke="var(--acc)"
            strokeWidth={2.25}
            strokeLinejoin="round"
            data-testid={withBaseline ? 'chart-line-scenario' : 'chart-line-closing'}
          />

          {minIndex >= 0 && (
            <g data-testid="chart-min">
              <circle
                cx={g.x(minIndex)}
                cy={g.y(closing[minIndex])}
                r={4.5}
                fill={closing[minIndex] < 0 ? 'var(--fail)' : 'var(--acc)'}
                stroke="var(--panel)"
                strokeWidth={2}
              />
            </g>
          )}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={g.x(hover)} x2={g.x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--line2)" />
              {withBaseline && (
                <circle cx={g.x(hover)} cy={g.y(baseline[hover])} r={4} fill="var(--mut)" stroke="var(--panel)" strokeWidth={2} />
              )}
              <circle cx={g.x(hover)} cy={g.y(closing[hover])} r={4} fill="var(--acc)" stroke="var(--panel)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hovered && hover !== null && (
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              top: 4,
              left: `${(g.x(hover) / W) * 100}%`,
              transform: hover > days.length / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
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
    </figure>
  );
}
