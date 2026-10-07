import { describe, expect, it } from 'vitest';
import { alignedXs } from './BalanceChart';

const buckets = [
  { start: '2026-10-07', end: '2026-10-11' }, // clipped week: 5 days
  { start: '2026-10-12', end: '2026-10-18' },
];
const days = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ date: `2026-10-${String(from + i).padStart(2, '0')}` }));

describe('alignedXs', () => {
  it('spreads a bucket’s days across exactly its column, each at the middle of its slice', () => {
    const xs = alignedXs(days(7, 18), buckets, { label: 250, widths: [100, 140], total: 608 });
    expect(xs).toHaveLength(12);
    // Five days share the first 100px column: slices of 20, from 250.
    expect(xs?.slice(0, 5)).toEqual([260, 280, 300, 320, 340]);
    // Seven days share the 140px column that starts at 350.
    expect(xs?.[5]).toBe(360);
    expect(xs?.[11]).toBe(480);
  });

  it('is null until the measured columns are these buckets’', () => {
    expect(alignedXs(days(7, 18), buckets, { label: 250, widths: [100], total: 468 })).toBeNull();
    expect(alignedXs(days(7, 18), buckets, { label: 0, widths: [0, 0], total: 0 })).toBeNull();
    expect(alignedXs(days(7, 19), buckets, { label: 250, widths: [100, 140], total: 608 })).toBeNull();
  });
});
