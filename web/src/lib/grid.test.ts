import { describe, expect, it } from 'vitest';
import { rows } from '../screens/forecast/fixtures';
import {
  attentionTags,
  balanceFlag,
  bucketIndexOf,
  bucketLabel,
  cellMoney,
  compactMoney,
  flagTags,
  groupLines,
  groupShipCombos,
  groupShipContainers,
  isClipped,
  isShipCategory,
  lineId,
  parseBucket,
  parseWindowDays,
  pinSummary,
  shipMatcher,
  signedMoney,
  stepScroll,
} from './grid';
import { line as fixtureLine, shipRow as stockRow } from '../screens/forecast/fixtures';

describe('bucket parameters', () => {
  it('defaults to week and 90 days, the server defaults (D7)', () => {
    expect(parseBucket(null)).toBe('week');
    expect(parseBucket('fortnight')).toBe('week');
    expect(parseBucket('day')).toBe('day');
    expect(parseBucket('month')).toBe('month');
    expect(parseWindowDays(null)).toBe(90);
    expect(parseWindowDays('365')).toBe(365);
    expect(parseWindowDays('100')).toBe(90);
  });
});

describe('bucket columns (D6: Monday weeks, calendar months, clipped at the window)', () => {
  it('names a day by weekday and date', () => {
    expect(bucketLabel({ start: '2026-09-29', end: '2026-09-29' }, 'day')).toBe('Tue 29 Sep');
    expect(isClipped({ start: '2026-09-29', end: '2026-09-29' }, 'day')).toBe(false);
  });

  it('names a whole Monday–Sunday week by its Monday', () => {
    const week = { start: '2026-10-05', end: '2026-10-11' };
    expect(isClipped(week, 'week')).toBe(false);
    expect(bucketLabel(week, 'week')).toBe('w/c 5 Oct');
  });

  it('names a clipped week by its real span, across a month end too', () => {
    const first = { start: '2026-09-29', end: '2026-10-04' };
    expect(isClipped(first, 'week')).toBe(true);
    expect(bucketLabel(first, 'week')).toBe('29 Sep–4 Oct');
    expect(bucketLabel({ start: '2026-10-12', end: '2026-10-14' }, 'week')).toBe('12–14 Oct');
    expect(bucketLabel({ start: '2026-10-12', end: '2026-10-12' }, 'week')).toBe('12 Oct');
  });

  it('names a whole calendar month by month and year, a clipped one by its days', () => {
    expect(bucketLabel({ start: '2026-10-01', end: '2026-10-31' }, 'month')).toBe('Oct 2026');
    expect(bucketLabel({ start: '2026-12-01', end: '2026-12-31' }, 'month')).toBe('Dec 2026');
    expect(bucketLabel({ start: '2028-02-01', end: '2028-02-29' }, 'month')).toBe('Feb 2028');
    expect(isClipped({ start: '2028-02-01', end: '2028-02-28' }, 'month')).toBe(true);
    expect(bucketLabel({ start: '2026-09-29', end: '2026-09-30' }, 'month')).toBe('29–30 Sep');
  });

  it('finds the bucket holding a date by the buckets\' own bounds', () => {
    const buckets = [
      { start: '2026-09-29', end: '2026-10-04' },
      { start: '2026-10-05', end: '2026-10-11' },
      { start: '2026-10-12', end: '2026-10-18' },
    ];
    expect(bucketIndexOf('2026-09-29', buckets)).toBe(0);
    expect(bucketIndexOf('2026-10-04', buckets)).toBe(0);
    expect(bucketIndexOf('2026-10-05', buckets)).toBe(1);
    expect(bucketIndexOf('2026-10-18', buckets)).toBe(2);
    expect(bucketIndexOf('2026-10-19', buckets)).toBe(-1);
    expect(bucketIndexOf('2026-09-28', buckets)).toBe(-1);
  });
});

describe('lines into rows and cells', () => {
  it("places each line in the server's bucket and keeps every line of one key", () => {
    const suppliers = rows()[2];
    const groups = groupLines(suppliers.items, 3);
    expect(groups.map((g) => g.key)).toEqual(['item.77', 'item.88']);
    const acme = groups[0];
    expect(acme.lines).toHaveLength(2);
    expect(acme.cells[0].map((l) => l.flags)).toEqual([['paid', 'partial']]);
    expect(acme.cells[1]).toEqual([]);
    expect(acme.cells[2].map((l) => l.flags)).toEqual([['remainder']]);
  });

  it('keeps two lines of one key in the same bucket as two entries, not one sum', () => {
    const [paid, remainder] = rows()[2].items;
    const groups = groupLines([paid, { ...remainder, bucketIndex: 0 }], 3);
    expect(groups).toHaveLength(1);
    expect(groups[0].cells[0].map((l) => l.gbpMinor)).toEqual([40000, 60000]);
  });

  it('puts every instance of one schedule on one row, each in its own bucket (Dev, 2026-10-07)', () => {
    const [oct] = rows()[1].items;
    const nov = { ...oct, key: 'sched.45.2026-11-01', naturalDate: '2026-11-01', date: '2026-11-01', bucketIndex: 2 };
    const other = { ...oct, key: 'sched.46.2026-10-01', id: 46, scheduleId: 46, name: 'Storage' };
    const groups = groupLines([oct, other, nov], 3);
    expect(groups.map((g) => g.key)).toEqual(['sched.45.2026-10-01', 'sched.46.2026-10-01']);
    expect(groups[0].keys).toEqual(['sched.45.2026-10-01', 'sched.45.2026-11-01']);
    expect(groups[0].cells.map((c) => c.map((l) => l.key))).toEqual([['sched.45.2026-10-01'], [], ['sched.45.2026-11-01']]);
    expect(groups[1].keys).toEqual(['sched.46.2026-10-01']);
  });

  it('lists the rows A to Z by name, whatever order the lines came in (Dev, 2026-10-07)', () => {
    const [oct] = rows()[1].items;
    const named = (id: number, name: string) => ({ ...oct, key: `item.${id}`, kind: 'item' as const, id, scheduleId: undefined, name });
    const groups = groupLines([named(1, 'JFA Amazon UK'), named(2, 'HW Amazon USA'), named(3, 'hw Amazon EUR'), named(4, 'JFA Amazon Euro')], 3);
    expect(groups.map((g) => g.name)).toEqual(['hw Amazon EUR', 'HW Amazon USA', 'JFA Amazon Euro', 'JFA Amazon UK']);
  });

  it('gives each line its own React key even when the item key repeats', () => {
    const [paid, remainder] = rows()[2].items;
    expect(lineId(paid, 0)).toBe('item.77:p5:0');
    expect(lineId(remainder, 0)).toBe('item.77:rem:0');
  });
});

describe('flags as words', () => {
  it('reads paid + partial as PART PAID, and names the remainder', () => {
    expect(flagTags(['paid', 'partial']).map((t) => t.label)).toEqual(['PART PAID']);
    expect(flagTags(['paid']).map((t) => t.label)).toEqual(['PAID']);
    expect(flagTags(['remainder']).map((t) => t.label)).toEqual(['REMAINDER']);
    expect(flagTags(['overdue', 'tuned']).map((t) => t.label)).toEqual(['OVERDUE', 'TUNED']);
  });

  it('still shows a flag it does not know', () => {
    expect(flagTags(['somethingNew']).map((t) => t.label)).toEqual(['SOMETHINGNEW']);
  });

  it("names a scenario's hypothetical one-off NEW and a split line SPLIT (D39, D40)", () => {
    expect(flagTags(['added'])).toEqual([{ flag: 'added', label: 'NEW', tone: 'live' }]);
    expect(flagTags(['adjusted', 'split'])).toEqual([
      { flag: 'adjusted', label: 'ADJUSTED', tone: 'live' },
      { flag: 'split', label: 'SPLIT', tone: 'idle' },
    ]);
    expect(flagTags(['added', 'split']).map((t) => t.label)).toEqual(['NEW', 'SPLIT']);
  });
});

describe('a collapsed category says what needs attention', () => {
  const line = (key: string, flags: string[]) => ({ key, flags });

  it('counts each warn or fail tag across the lines, and ignores the informational ones', () => {
    const tags = attentionTags([
      line('item.1', ['overdue']),
      line('item.2', ['overdue', 'tuned']),
      line('ship.a', ['projected', 'estimated']),
      line('item.3', ['paid']),
    ]);
    expect(tags.map((t) => [t.label, t.count])).toEqual([['OVERDUE', 2]]);
  });

  it('puts fail before warn, and counts the marks that come from warnings', () => {
    const marks = new Map([['ship.b', [{ flag: 'planStale', label: 'PLAN STALE', tone: 'fail' as const }]]]);
    const tags = attentionTags([line('ship.a', ['blocked']), line('ship.b', ['projected']), line('item.9', ['stale'])], marks);
    expect(tags.map((t) => [t.label, t.tone, t.count])).toEqual([
      ['PLAN STALE', 'fail', 1],
      ['STALE', 'fail', 1],
      ['BLOCKED', 'warn', 1],
    ]);
  });

  it('is empty when nothing needs attention', () => {
    expect(attentionTags([line('item.1', ['tuned'])])).toEqual([]);
    expect(attentionTags([])).toEqual([]);
  });
});

describe('negative cells', () => {
  it('flags a figure below zero, and a closing whose bucket dips below zero', () => {
    expect(balanceFlag(-1)).toBe('negative');
    expect(balanceFlag(0)).toBeNull();
    expect(balanceFlag(35000, -65000)).toBe('dips');
    expect(balanceFlag(-25000, -25000)).toBe('negative');
    expect(balanceFlag(5000, 5000)).toBeNull();
  });

  it('formats cells from minor units without floats', () => {
    expect(cellMoney(-6500001)).toBe('-£65,000.01');
    expect(cellMoney(0, { blankZero: true })).toBe('');
    expect(cellMoney(0)).toBe('£0.00');
    expect(signedMoney(3000)).toBe('+£30.00');
    expect(signedMoney(-3000)).toBe('-£30.00');
    expect(signedMoney(0)).toBe('£0.00');
  });

  it('shortens axis labels by cutting, never rounding up', () => {
    expect(compactMoney(0)).toBe('£0');
    expect(compactMoney(95000)).toBe('£950');
    expect(compactMoney(1_259_900)).toBe('£12.5k');
    expect(compactMoney(-120_000_000)).toBe('-£1.2m');
    expect(compactMoney(25_000_000)).toBe('£250k');
  });
});

describe('stock payments by supplier + shipment (groupShipCombos; Dev, 2026-10-06)', () => {
  // The fixture: Acme's deposit (no container, bucket 1, £3,700) and Acme's balance in
  // MSCU1234567 (bucket 2, £1,110); plus a second Acme balance in the same container.
  const stock = stockRow();
  const bal = stock.items[1];
  const second = fixtureLine({
    ...bal, key: 'ship.bal-813-s311', id: 'bal-813-s311', name: 'Acme Textiles · PO-813 · balance',
    amountMinor: 50000, accountMinor: 50000, gbpMinor: 37000, flags: ['overdue'], ship: { ...bal.ship!, poNumber: 'PO-813' },
  });
  const groups = () => groupLines([...stock.items, second], 3);

  it('one combo per supplier + container, in order of appearance; no container is a group of its own', () => {
    const combos = groupShipCombos(groups(), 3);
    expect(combos.map((c) => [c.key, c.supplier, c.containerRef, c.lines.map((l) => l.key)])).toEqual([
      ['acme textiles|-', 'Acme Textiles', null, ['ship.dep-812']],
      ['acme textiles|MSCU1234567', 'Acme Textiles', 'MSCU1234567', ['ship.bal-812-s311', 'ship.bal-813-s311']],
    ]);
    expect(combos[1].groups.map((g) => g.key)).toEqual(['ship.bal-812-s311', 'ship.bal-813-s311']);
  });

  it("sums its lines' GBP per bucket and over the window — the one sum the grid makes", () => {
    const combos = groupShipCombos(groups(), 3);
    expect(combos[0].cells).toEqual([0, 370000, 0]);
    expect(combos[0].total).toBe(370000);
    expect(combos[1].cells).toEqual([0, 0, 148000]);
    expect(combos[1].total).toBe(148000);
  });

  it('keys supplier and container case-blind, as ShipLine keys a payment', () => {
    const shouty = { ...second, counterparty: 'ACME TEXTILES', ship: { ...second.ship!, containerRef: 'mscu1234567' } };
    expect(groupShipCombos(groupLines([bal, shouty], 3), 3)).toHaveLength(1);
  });

  it('only a category whose lines are all stock payments is grouped this way', () => {
    expect(isShipCategory(groups())).toBe(true);
    expect(isShipCategory(groupLines(rows()[2].items, 3))).toBe(false);
    expect(isShipCategory([])).toBe(false);
  });
});

describe('stock payments by container, then supplier (groupShipContainers; Dev, 2026-11-19)', () => {
  // One ship line: `supplier` in `container` (null = none) for PO `po`, `gbp` in bucket `at`.
  const shipLine = (key: string, supplier: string, container: string | null, po: string, at: number, gbp: number, flags: string[] = []) => {
    const base = stockRow().items[1];
    return fixtureLine({
      ...base, key, id: key.slice(5), name: `${supplier} · ${po} · balance`, counterparty: supplier,
      gbpMinor: gbp, bucketIndex: at, flags, ship: { ...base.ship!, poNumber: po, containerRef: container },
    });
  };
  const lines = () => [
    shipLine('ship.a', 'Zeta Hangers', '315', 'PO_00355J', 0, 1000),
    shipLine('ship.b', 'Medoffice Saglik', 'Medoffice Post-Production', 'PO_00401J', 1, 2000),
    shipLine('ship.c', 'Acme Textiles', '315', 'PO_00360J', 2, 4000, ['overdue']),
    shipLine('ship.d', 'Guilin Yoho', null, 'PO_00370J', 1, 8000),
    shipLine('ship.e', 'Guilin Yoho', '1000', 'PO_00380J', 0, 16000),
    shipLine('ship.f', 'Suzhou Sunmed', '127. Air Freight', 'PO_00390J', 0, 32000),
    shipLine('ship.g', 'Suzhou Sunmed', '125. Air Freight', 'PO_00391J', 2, 64000),
    shipLine('ship.h', 'Acme Textiles', '315', 'PO_00361J', 2, 128000, ['excluded']),
    shipLine('ship.i', 'Roosin Medical', '314', 'PO_00350J', 1, 256000),
  ];
  const containers = (items = lines()) => groupShipContainers(groupLines(items, 3), 3);

  it('orders containers by number, then the named ones (air freight and the like) A to Z, then no container', () => {
    expect(containers().map((c) => [c.key, c.containerRef])).toEqual([
      ['314', '314'],
      ['315', '315'],
      ['1000', '1000'],
      ['125. AIR FREIGHT', '125. Air Freight'],
      ['127. AIR FREIGHT', '127. Air Freight'],
      ['MEDOFFICE POST-PRODUCTION', 'Medoffice Post-Production'],
      ['-', null],
    ]);
  });

  it('holds its suppliers A to Z, each the supplier + shipment combo of before', () => {
    const c315 = containers().find((c) => c.key === '315')!;
    expect(c315.suppliers.map((s) => [s.key, s.supplier, s.lines.map((l) => l.key)])).toEqual([
      ['acme textiles|315', 'Acme Textiles', ['ship.c', 'ship.h']],
      ['zeta hangers|315', 'Zeta Hangers', ['ship.a']],
    ]);
    expect(c315.lines.map((l) => l.key)).toEqual(['ship.a', 'ship.c', 'ship.h']);
  });

  it("sums its lines' GBP per bucket and over the window, leaving out what the server counts nothing for", () => {
    const c315 = containers().find((c) => c.key === '315')!;
    expect(c315.cells).toEqual([1000, 0, 4000]);
    expect(c315.total).toBe(5000);
    expect(c315.suppliers[0].cells).toEqual([0, 0, 4000]);
  });

  it('keys a container case-blind, as ShipLine keys a payment', () => {
    const shouty = shipLine('ship.x', 'Zeta Hangers', 'medoffice post-production', 'PO_00402J', 0, 1);
    const named = containers([...lines(), shouty]).filter((c) => c.key === 'MEDOFFICE POST-PRODUCTION');
    expect(named).toHaveLength(1);
    expect(named[0].suppliers.map((s) => s.supplier)).toEqual(['Medoffice Saglik', 'Zeta Hangers']);
  });
});

describe('finding stock payments (shipMatcher; Dev, 2026-11-19)', () => {
  const groups = () => {
    const base = stockRow().items;
    const other = fixtureLine({
      ...base[1], key: 'ship.bal-900-s315', id: 'bal-900-s315', name: 'Roosin Medical Co., Ltd. · PO_00355J · balance',
      counterparty: 'Roosin Medical Co., Ltd.', ship: { ...base[1].ship!, poNumber: 'PO_00355J', containerRef: '315' },
    });
    return groupLines([...base, other], 3);
  };
  const keys = (query: string) => {
    const match = shipMatcher(query);
    return match ? groups().filter(match).map((g) => g.key) : null;
  };

  it('is off for a blank search', () => {
    expect(shipMatcher('')).toBeNull();
    expect(shipMatcher('  ,  ')).toBeNull();
  });

  it('finds by container, supplier or PO, case-blind', () => {
    expect(keys('315')).toEqual(['ship.bal-900-s315']);
    expect(keys('mscu1234567')).toEqual(['ship.bal-812-s311']);
    expect(keys('ROOSIN')).toEqual(['ship.bal-900-s315']);
    expect(keys('po-812')).toEqual(['ship.dep-812', 'ship.bal-812-s311']);
  });

  it('needs every word of a search; commas find several at once', () => {
    expect(keys('acme mscu')).toEqual(['ship.bal-812-s311']);
    expect(keys('acme 315')).toEqual([]);
    expect(keys('315, PO-812')).toEqual(['ship.dep-812', 'ship.bal-812-s311', 'ship.bal-900-s315']);
  });
});

describe('the pinned balance summary (pinSummary; Dev, 2026-11-19)', () => {
  // Viewport positions, as getBoundingClientRect gives them: the grid's top and bottom, where
  // the zero-height pin at the grid's top sits now (sticky, so it stops at the scroll area's
  // top), and the height of the header and balance rows.
  it('stays put while the top of the grid is in view', () => {
    expect(pinSummary({ gridTop: 120, gridBottom: 2000, pinTop: 120, summaryHeight: 230 })).toBe(false);
  });

  it('pins once the top of the grid has scrolled past the top of the page', () => {
    expect(pinSummary({ gridTop: -400, gridBottom: 1500, pinTop: 0, summaryHeight: 230 })).toBe(true);
    expect(pinSummary({ gridTop: -1, gridBottom: 1500, pinTop: 0, summaryHeight: 230 })).toBe(true);
  });

  it('lets go when what is left of the grid is no taller than the summary', () => {
    expect(pinSummary({ gridTop: -1800, gridBottom: 230, pinTop: 0, summaryHeight: 230 })).toBe(false);
    expect(pinSummary({ gridTop: -1800, gridBottom: 231, pinTop: 0, summaryHeight: 230 })).toBe(true);
  });

  it('never pins with nothing measured (jsdom, a hidden tab)', () => {
    expect(pinSummary({ gridTop: 0, gridBottom: 0, pinTop: 0, summaryHeight: 0 })).toBe(false);
  });
});

describe('stepping the dates on a touch screen (stepScroll; Dev, 2026-11-20)', () => {
  // Six 100px columns after the label, 250px of them on show: the far end is 350.
  const six = [100, 100, 100, 100, 100, 100];

  it('later: the first column not fully on show becomes the first one', () => {
    expect(stepScroll(six, 0, 250, 1)).toBe(200);
    // Mid-column counts from what is fully on show now.
    expect(stepScroll(six, 30, 250, 1)).toBe(200);
  });

  it('later stops at the far end', () => {
    expect(stepScroll(six, 200, 250, 1)).toBe(350);
    expect(stepScroll(six, 350, 250, 1)).toBe(350);
  });

  it('earlier: a screenful back, landing on a column edge, never before the start', () => {
    expect(stepScroll(six, 350, 250, -1)).toBe(100);
    expect(stepScroll(six, 100, 250, -1)).toBe(0);
    expect(stepScroll(six, 0, 250, -1)).toBe(0);
  });

  it('always moves when it can, even past a column wider than the screen', () => {
    expect(stepScroll([400, 100, 100], 0, 250, 1)).toBe(350);
    expect(stepScroll([400, 400, 400], 0, 250, 1)).toBe(400);
    expect(stepScroll([400, 400, 400], 450, 250, -1)).toBe(400);
    expect(stepScroll([400, 400, 400], 400, 250, -1)).toBe(0);
  });

  it('has nowhere to go when everything is on show', () => {
    expect(stepScroll([100, 100], 0, 250, 1)).toBe(0);
    expect(stepScroll([], 0, 250, 1)).toBe(0);
  });
});
