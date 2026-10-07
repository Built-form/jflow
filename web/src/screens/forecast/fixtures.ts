/**
 * A `/forecast` answer shaped exactly as CONTRACT §6.10 writes it, for the tests. The API
 * route does not exist yet, so every Forecast and Scenario test is built on this stub.
 *
 * Today is Tue 29 Sep 2026; week buckets, to 18 Oct: 29 Sep–4 Oct (clipped), w/c 5 Oct,
 * w/c 12 Oct. Bucket 0 closes below zero; bucket 1 closes above zero but dips below it.
 */

import type { ExternalItem } from '../../api/external';
import type { ForecastDay, ForecastItem, ForecastResponse, ForecastRow, ForecastShipping } from '../../api/forecast';
import { addDays } from '../../lib/dates';

export const TODAY = '2026-09-29';
export const TO = '2026-10-18';

export function line(overrides: Partial<ForecastItem> & Pick<ForecastItem, 'key' | 'name'>): ForecastItem {
  return {
    kind: overrides.key.startsWith('sched.') ? 'sched' : overrides.key.startsWith('new.') ? 'new' : 'item',
    id: 1,
    counterparty: null,
    accountId: 1,
    currency: 'GBP',
    amountMinor: 10000,
    accountMinor: 10000,
    gbpMinor: 10000,
    date: TODAY,
    bucketIndex: 0,
    status: 'expected',
    settleMode: 'auto',
    flags: [],
    editable: true,
    ...overrides,
  };
}

export function rows(): ForecastRow[] {
  return [
    {
      categoryId: 1,
      categoryName: 'Sales',
      direction: 'in',
      sortOrder: 1,
      totals: [0, 100000, 0],
      total: 100000,
      items: [
        line({ key: 'item.10', id: 10, name: 'Invoice 1041', counterparty: 'Brightside Ltd', amountMinor: 100000, accountMinor: 100000, gbpMinor: 100000, date: '2026-10-06', bucketIndex: 1 }),
      ],
    },
    {
      categoryId: 2,
      categoryName: 'Rent',
      direction: 'out',
      sortOrder: 1,
      totals: [120000, 0, 0],
      total: 120000,
      items: [
        line({
          key: 'sched.45.2026-10-01',
          id: 45,
          scheduleId: 45,
          naturalDate: '2026-10-01',
          name: 'Office rent',
          amountMinor: 120000,
          accountMinor: 120000,
          gbpMinor: 120000,
          date: '2026-10-01',
          bucketIndex: 0,
          flags: ['tuned'],
          settleMode: 'manual',
        }),
      ],
    },
    {
      categoryId: 3,
      categoryName: 'Suppliers',
      direction: 'out',
      sortOrder: 2,
      totals: [45000, 0, 60000],
      total: 105000,
      items: [
        // One key, two lines: a payment made today on a part-paid item, and its remainder.
        line({
          key: 'item.77',
          id: 77,
          name: 'Acme Packaging',
          amountMinor: 40000,
          accountMinor: 40000,
          gbpMinor: 40000,
          date: TODAY,
          bucketIndex: 0,
          status: 'part_paid',
          flags: ['paid', 'partial'],
          editable: false,
          paymentId: 5,
        }),
        line({
          key: 'item.77',
          id: 77,
          name: 'Acme Packaging',
          amountMinor: 60000,
          accountMinor: 60000,
          gbpMinor: 60000,
          date: '2026-10-13',
          bucketIndex: 2,
          status: 'part_paid',
          settleMode: 'manual',
          flags: ['remainder'],
          editable: false,
        }),
        line({
          key: 'item.88',
          id: 88,
          name: 'Late courier invoice',
          amountMinor: 5000,
          accountMinor: 5000,
          gbpMinor: 5000,
          date: TODAY,
          bucketIndex: 0,
          settleMode: 'manual',
          flags: ['overdue'],
        }),
      ],
    },
  ];
}

/**
 * The Stock payments row (Phase 2, §6.10): a USD deposit whose date is shipping's estimate
 * and which JFlow has planned (a date moved from 2 Oct to 6 Oct), and a USD balance blocked
 * on artwork whose amount is derived from the terms (amountBasis 'derived'; no flag for that
 * since 2026-10-06). Both editable.
 */
export function shipRow(): ForecastRow {
  return {
    categoryId: 90,
    categoryName: 'Stock payments',
    direction: 'out',
    sortOrder: 900,
    totals: [0, 370000, 111000],
    total: 481000,
    items: [
      line({
        key: 'ship.dep-812',
        kind: 'ship',
        id: 'dep-812',
        name: 'Acme Textiles · PO-812 · deposit',
        counterparty: 'Acme Textiles',
        currency: 'USD',
        amountMinor: 500000,
        accountMinor: 500000,
        gbpMinor: 370000,
        date: '2026-10-06',
        dueDate: '2026-10-06',
        bucketIndex: 1,
        settleMode: 'manual',
        flags: ['estimated', 'planned'],
        ship: {
          kind: 'deposit',
          poNumber: 'PO-812',
          containerRef: null,
          dateBasis: 'estimated',
          amountBasis: 'stated',
          blocked: null,
          feedDate: '2026-10-02',
          feedAmountMinor: 500000,
          dueSet: null,
          dateMovedFrom: null,
          dateMovedAt: null,
        },
      }),
      line({
        key: 'ship.bal-812-s311',
        kind: 'ship',
        id: 'bal-812-s311',
        name: 'Acme Textiles · PO-812 · balance',
        counterparty: 'Acme Textiles',
        currency: 'USD',
        amountMinor: 150000,
        accountMinor: 150000,
        gbpMinor: 111000,
        date: '2026-10-13',
        dueDate: '2026-10-13',
        bucketIndex: 2,
        settleMode: 'manual',
        flags: ['blocked'],
        ship: {
          kind: 'balance',
          poNumber: 'PO-812',
          containerRef: 'MSCU1234567',
          dateBasis: 'firm',
          amountBasis: 'derived',
          blocked: 'artwork',
          feedDate: '2026-10-13',
          feedAmountMinor: 150000,
          dueSet: null,
          dateMovedFrom: null,
          dateMovedAt: null,
        },
      }),
    ],
  };
}

/** A `shipping` block (§6.10): synced this morning, three undated rows worth £4,500.00. */
export const SHIPPING: ForecastShipping = {
  lastSuccessAt: '2026-09-29T12:00:00Z',
  feedToday: TODAY,
  openCount: 12,
  undatedCount: 3,
  undatedGbp: 450000,
  unmappedCount: 2,
};

function days(withBaseline: boolean): ForecastDay[] {
  const out: ForecastDay[] = [];
  let opening = 100000;
  for (let i = 0; i < 20; i += 1) {
    const date = addDays(TODAY, i);
    const net = i === 0 ? -45000 : i === 2 ? -120000 : i === 7 ? 100000 : i === 14 ? -60000 : 0;
    const closing = opening + net;
    const day: ForecastDay = {
      date,
      opening,
      inflow: net > 0 ? net : 0,
      outflow: net < 0 ? -net : 0,
      net,
      closing,
    };
    if (withBaseline) day.baselineClosing = closing - (i >= 2 ? 30000 : 0);
    out.push(day);
    opening = closing;
  }
  return out;
}

/**
 * The scenario's adds and split (2026-10-07, D39/D40), as `/forecast` would place them with
 * `scenarioId`: Invoice 1041 (`item.10`, £1,000.00 on 6 Oct) split into £600.00 on 6 Oct (the
 * anchor, adjustment 21) and £400.00 on 13 Oct (the part, `new.22`); and a £75.00 late-filing
 * penalty to HMRC on 13 Oct (`new.23`), a hypothetical one-off of its own.
 */
export const SPLIT_GROUP = 21;

function addScenarioLines(r: ForecastRow[]): void {
  const sales = r[0];
  const invoice = sales.items[0];
  invoice.amountMinor = 60000;
  invoice.accountMinor = 60000;
  invoice.gbpMinor = 60000;
  invoice.flags = ['adjusted', 'split'];
  invoice.splitGroup = SPLIT_GROUP;
  sales.items.push(
    line({
      key: 'new.22',
      id: 22,
      name: 'Invoice 1041',
      counterparty: 'Brightside Ltd',
      amountMinor: 40000,
      accountMinor: 40000,
      gbpMinor: 40000,
      date: '2026-10-13',
      bucketIndex: 2,
      flags: ['added', 'split'],
      baseline: null,
      splitGroup: SPLIT_GROUP,
    }),
  );
  sales.totals = [0, 60000, 40000];
  const suppliers = r[2];
  suppliers.items.push(
    line({
      key: 'new.23',
      id: 23,
      name: 'Late filing penalty',
      counterparty: 'HMRC',
      amountMinor: 7500,
      accountMinor: 7500,
      gbpMinor: 7500,
      date: '2026-10-13',
      bucketIndex: 2,
      flags: ['added'],
      baseline: null,
      splitGroup: null,
    }),
  );
  suppliers.totals = [45000, 0, 67500];
  suppliers.total = 112500;
}

export function forecastFixture({
  scenario = false,
  unresolved = false,
  warnings = [],
  ship = false,
  shipping = null,
  adds = false,
}: {
  scenario?: boolean;
  unresolved?: boolean;
  warnings?: ForecastResponse['warnings'];
  /** Add the Stock payments row. */
  ship?: boolean;
  shipping?: ForecastShipping | null;
  /** With `scenario`: the scenario's split of Invoice 1041 and its late-filing penalty (`addScenarioLines`). */
  adds?: boolean;
} = {}): ForecastResponse {
  const summary = {
    opening: 100000,
    inflow: 100000,
    outflow: 225000,
    net: -125000,
    closing: -25000,
    minClosing: -65000,
    minDate: '2026-10-01',
    unresolvedCount: unresolved ? 2 : 0,
    unresolvedTotal: unresolved ? 83000 : 0,
    absorbedCount: 1,
  };
  const r = ship ? [...rows(), shipRow()] : rows();
  if (scenario) {
    for (const row of r) {
      for (const item of row.items) {
        item.baseline = { date: item.date, amountMinor: item.amountMinor, gbpMinor: item.gbpMinor, flags: [] };
        item.splitGroup = null;
      }
    }
    // The rent has been moved a week later in the scenario.
    const rent = r[1].items[0];
    rent.flags = ['tuned', 'adjusted'];
    rent.baseline = { date: '2026-09-24', amountMinor: 120000, gbpMinor: 120000, flags: ['tuned'] };
    if (adds) addScenarioLines(r);
  }
  return {
    meta: {
      today: TODAY,
      from: TODAY,
      to: TO,
      bucket: 'week',
      fromClamped: false,
      toClamped: false,
      companyId: 'all',
      scenarioId: scenario ? 9 : null,
      include: 'grid',
      ratesUsed: { GBP: { rateToGbp: '1.000000', effectiveFrom: null } },
      generatedAt: '2026-09-29T08:00:00Z',
    },
    accounts: [
      {
        accountId: 1,
        name: 'Barclays',
        companyId: 1,
        currency: 'GBP',
        rateToGbp: '1.000000',
        anchorDate: '2026-09-28',
        anchorAgeDays: 1,
        anchorNative: 95000,
        anchorGbp: 95000,
        openingNative: 100000,
        openingGbp: 100000,
        absorbed: [
          { key: 'item.5', name: 'Card takings', categoryId: 1, date: '2026-09-28', currency: 'GBP', amountMinor: 5000, accountMinor: 5000, gbpMinor: 5000, direction: 'in', flags: ['assumed'] },
        ],
      },
    ],
    days: days(scenario),
    buckets: [
      { start: TODAY, end: '2026-10-04', opening: 100000, inflow: 0, outflow: 165000, net: -165000, closing: -65000, minClosing: -65000, minDate: '2026-10-01' },
      { start: '2026-10-05', end: '2026-10-11', opening: -65000, inflow: 100000, outflow: 0, net: 100000, closing: 35000, minClosing: -65000, minDate: '2026-10-05' },
      { start: '2026-10-12', end: TO, opening: 35000, inflow: 0, outflow: 60000, net: -60000, closing: -25000, minClosing: -25000, minDate: '2026-10-13' },
    ],
    rows: r,
    summary,
    scenario: scenario
      ? {
          id: 9,
          name: 'Delay the rent',
          status: 'draft',
          baselineSummary: { ...summary, closing: -55000, minClosing: -95000 },
          deltaByBucket: [
            { start: TODAY, end: '2026-10-04', inflow: 0, outflow: 0, net: 0, closing: 30000 },
            { start: '2026-10-05', end: '2026-10-11', inflow: 0, outflow: 0, net: 0, closing: 30000 },
            { start: '2026-10-12', end: TO, inflow: 0, outflow: 0, net: 0, closing: 30000 },
          ],
          warnings: [{ code: 'STALE', key: 'item.99', reason: 'TARGET_SETTLED' }],
        }
      : null,
    unresolved: unresolved
      ? [
          { key: 'item.3', kind: 'item', name: 'Old VAT query', categoryId: 3, accountId: 1, currency: 'GBP', amountMinor: 50000, gbpMinor: 50000, direction: 'out', date: '2026-07-01', ageDays: 90, settleMode: 'manual' },
          { key: 'sched.7.2026-08-01', kind: 'sched', name: 'Storage', categoryId: 3, accountId: 2, currency: 'GBP', amountMinor: 33000, gbpMinor: 33000, direction: 'out', date: '2026-08-01', ageDays: 59, settleMode: 'manual' },
        ]
      : [],
    shipping,
    warnings,
  };
}

/** An `/external-items` row (§6.12): the USD balance above, open, unplanned, row version 4. */
export function externalRow(overrides: Partial<ExternalItem> = {}): ExternalItem {
  return {
    key: 'ship.bal-812-s311', id: 31, source: 'ship', extId: 'bal-812-s311', feedKind: 'balance', feedStatus: 'open',
    supplier: 'Acme Textiles', shippingCompanyId: 11, companyId: 1, accountId: 1, poId: 812, poNumber: 'PO-812',
    shipmentId: 311, containerRef: 'MSCU1234567', label: null, currency: 'USD', amount: '1500.00', dueDate: '2026-10-13',
    paidOn: null, settles: null, dateBasis: 'firm', amountBasis: 'derived', blocked: 'artwork', flags: [],
    dueSet: null, dueDatePrev: null, dueDateMovedAt: null, dateMoved: false,
    goneAt: null, plannedDate: null, plannedAmount: null, plannedSkipped: false, plannedBaseAmount: null,
    plannedNote: null, sourceScenarioId: null, plannedBy: null, plannedAt: null, effectiveDate: '2026-10-13',
    effectiveAmount: '1500.00', planStale: false, derivedStatus: 'expected', rowVersion: 4, createdBy: 'shipping-feed',
    createdAt: '2026-09-29T08:00:00Z', updatedAt: '2026-09-29T08:00:00Z',
    ...overrides,
  };
}

/**
 * `GET /external-items/ship.dep-812`: the row behind the deposit line in `shipRow()` —
 * shipping says $5,000.00 on 2 Oct (estimated); JFlow has pinned 6 Oct, with a note.
 */
export function depositRow(overrides: Partial<ExternalItem> = {}): ExternalItem {
  return externalRow({
    key: 'ship.dep-812', id: 30, extId: 'dep-812', feedKind: 'deposit', shipmentId: null, containerRef: null,
    amount: '5000.00', dueDate: '2026-10-02', dateBasis: 'estimated', amountBasis: 'stated', blocked: null,
    plannedDate: '2026-10-06', plannedNote: 'Factory holiday', plannedBy: 'dev@built-form.co.uk',
    plannedAt: '2026-09-28T09:00:00Z', effectiveDate: '2026-10-06', effectiveAmount: '5000.00', rowVersion: 7,
    ...overrides,
  });
}
