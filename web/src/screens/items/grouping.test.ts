import { describe, expect, it } from 'vitest';
import { GROUP_ORDER, groupByDerivedStatus, parseShowParam } from './grouping';

const row = (id: number, derivedStatus: string) => ({ id, derivedStatus });

describe('groupByDerivedStatus', () => {
  it("groups by the server's derivedStatus, in display order, leaving empty groups out", () => {
    const groups = groupByDerivedStatus([
      row(1, 'expected'),
      row(2, 'paid'),
      row(3, 'assumedSettled'),
      row(4, 'overdue'),
      row(5, 'expected'),
      row(6, 'assumedSettled'),
    ]);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
      ['overdue', [4]],
      ['assumedSettled', [3, 6]],
      ['expected', [1, 5]],
      ['paid', [2]],
    ]);
  });

  it('names the assumed-settled group and says what it means', () => {
    const [group] = groupByDerivedStatus([row(1, 'assumedSettled')]);
    expect(group.label).toBe('Assumed settled');
    expect(group.explain).toMatch(/latest recorded balance/);
    expect(group.tone).toBe('waived');
  });

  it('never drops a row: a band this client does not know gets its own group, last', () => {
    const groups = groupByDerivedStatus([row(1, 'somethingNew'), row(2, 'skipped')]);
    expect(groups.map((g) => g.id)).toEqual(['skipped', 'somethingNew']);
    expect(groups[1].label).toBe('somethingNew');
    expect(groups.flatMap((g) => g.rows)).toHaveLength(2);
  });

  it('knows every D10 value', () => {
    expect(GROUP_ORDER.map((g) => g.id).sort()).toEqual(
      ['assumed', 'assumedSettled', 'expected', 'overdue', 'paid', 'skipped', 'unresolved'],
    );
  });

  it('reads ?show= as a group id, or every group', () => {
    expect(parseShowParam('assumedSettled')).toBe('assumedSettled');
    expect(parseShowParam(null)).toBeNull();
    expect(parseShowParam('<script>')).toBeNull();
  });
});
