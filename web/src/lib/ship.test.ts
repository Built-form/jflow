import { describe, expect, it } from 'vitest';
import { flagTags } from './grid';
import {
  HATCH,
  PLAN_STALE_TAG,
  blockedText,
  isShipKey,
  lastSyncText,
  shipExtId,
  shipFlagNotes,
  shipLineStyle,
  shipLook,
  shippingReasonText,
  shippingStatusParts,
  splitShipWarnings,
  stockPayments,
  unmappedNote,
} from './ship';

describe('ship. keys (CONTRACT §4, parse only)', () => {
  it.each([
    ['ship.bal-812-s311', 'bal-812-s311'],
    ['ship.dep-812', 'dep-812'],
    ['ship.pi-77-r0a1b2c3d4e', 'pi-77-r0a1b2c3d4e'],
    ['ship.inv-3-812-a', 'inv-3-812-a'],
    ['ship.spd_3_812', 'spd_3_812'],
  ])('reads the feed id of %s', (key, extId) => {
    expect(shipExtId(key)).toBe(extId);
    expect(isShipKey(key)).toBe(true);
  });

  it.each(['item.12', 'sched.45.2026-06-01', 'ship.', 'ship.PO 1', 'ship.PO#1', 'ship.a.b', 'SHIP.dep-1', `ship.${'x'.repeat(65)}`, '', null, 42])(
    'is not a ship key: %j',
    (key) => {
      expect(shipExtId(key)).toBeNull();
      expect(isShipKey(key)).toBe(false);
    },
  );

  it('takes the full 64-character id', () => {
    expect(shipExtId(`ship.${'A'.repeat(64)}`)).toBe('A'.repeat(64));
  });
});

describe('how a ship line looks, from its server flags', () => {
  it('hatches and italicises an estimated line, and only that', () => {
    expect(shipLineStyle(['estimated'])).toEqual({ fontStyle: 'italic', backgroundImage: HATCH });
    expect(shipLineStyle(['estimated', 'planned', 'overdue'])).toEqual({ fontStyle: 'italic', backgroundImage: HATCH });
    expect(shipLineStyle(['projected', 'blocked', 'planned'])).toEqual({});
    expect(shipLineStyle([])).toEqual({});
  });

  it('reads each feed flag on its own; none of them is inferred from another', () => {
    expect(shipLook(['blocked'])).toEqual({ estimated: false, projected: false, blocked: true, planned: false });
    expect(shipLook(['estimated', 'projected', 'blocked', 'planned'])).toEqual({
      estimated: true,
      projected: true,
      blocked: true,
      planned: true,
    });
  });

  it('names and colours the four feed flags as tags, in the order the server sent them', () => {
    expect(flagTags(['estimated', 'projected', 'blocked', 'planned', 'overdue'])).toEqual([
      { flag: 'estimated', label: 'ESTIMATED', tone: 'idle' },
      { flag: 'projected', label: 'PROJECTED', tone: 'idle' },
      { flag: 'blocked', label: 'BLOCKED', tone: 'warn' },
      { flag: 'planned', label: 'PLANNED', tone: 'live' },
      { flag: 'overdue', label: 'OVERDUE', tone: 'warn' },
    ]);
    expect(PLAN_STALE_TAG).toEqual({ flag: 'planStale', label: 'PLAN IGNORED', tone: 'warn' });
  });

  it('says what a blocked line waits on', () => {
    expect(blockedText('shipment')).toBe('Waiting on the shipment');
    expect(blockedText('artwork')).toBe('Waiting on artwork sign-off');
    expect(blockedText('pi')).toBe('Waiting on the PI');
    expect(blockedText('pi_signed')).toBe('Waiting on the signed PI');
    expect(blockedText('customs_hold')).toBe('Blocked (customs hold)');
    expect(blockedText(null)).toBe('Blocked');
  });

  it('explains each flag in a sentence', () => {
    expect(shipFlagNotes(['estimated', 'projected', 'blocked', 'planned'], { blocked: 'artwork' })).toEqual([
      "The date is shipping's estimate.",
      'The amount is projected by shipping, not yet stated on an invoice.',
      'Waiting on artwork sign-off.',
      "Planned in JFlow: this date, amount or skip is JFlow's, not shipping's.",
    ]);
    expect(shipFlagNotes(['overdue', 'adjusted'])).toEqual([]);
  });
});

describe('the feed state in words', () => {
  it.each([
    ['unconfigured', 'the shipping feed is not set up for this environment'],
    ['timeout', 'shipping did not answer in time'],
    ['unreachable', 'shipping could not be reached'],
    ['http_401', "shipping refused JFlow's key"],
    ['http_503', 'shipping answered with an error (HTTP 503)'],
    ['bad_response', "shipping's answer could not be read"],
    ['something_new', 'the refresh failed (something_new)'],
  ])('explains %s', (reason, text) => {
    expect(shippingReasonText(reason)).toBe(text);
  });

  it('gives the status line its parts from the shipping block', () => {
    const parts = shippingStatusParts({
      lastSuccessAt: '2026-09-29T12:00:00Z',
      feedToday: '2026-09-29',
      openCount: 12,
      undatedCount: 3,
      undatedGbp: 450000,
      unmappedCount: 2,
    });
    expect(parts[0]).toMatch(/^Last synced 29 Sep 2026, \d\d:\d\d$/);
    expect(parts.slice(1)).toEqual(['12 open', '3 undated (£4,500.00)', '2 unmapped']);
  });

  it('says a feed that has never succeeded has never synced', () => {
    expect(shippingStatusParts(null)).toEqual(['Never synced']);
    expect(shippingStatusParts(undefined)).toEqual(['Never synced']);
    expect(lastSyncText(null)).toBe('never');
  });

  it('counts stock payments in words', () => {
    expect(stockPayments(1)).toBe('1 stock payment');
    expect(stockPayments(4)).toBe('4 stock payments');
  });
});

describe('splitShipWarnings', () => {
  it('takes the four ship warnings out and keeps every other one in order', () => {
    const split = splitShipWarnings([
      { code: 'NO_ANCHOR', accountId: 2 },
      { code: 'SHIPPING_UNAVAILABLE', reason: 'timeout', lastSuccessAt: '2026-09-29T08:00:00Z' },
      { code: 'SHIP_UNMAPPED', shippingCompanyId: 3, count: 4, reason: 'company' },
      { code: 'SHIP_UNMAPPED', shippingCompanyId: null, count: 1, reason: 'company' },
      { code: 'SHIP_UNMAPPED', shippingCompanyId: 1, count: 6, reason: 'account', companyId: 11, currencies: ['EUR', 'USD'] },
      { code: 'ORPHAN_OVERRIDE', scheduleId: 1, naturalDate: '2026-09-01', overrideId: 2 },
      { code: 'SHIP_PLAN_ORPHANED', key: 'ship.dep-700' },
      { code: 'SHIP_PLAN_STALE', key: 'ship.bal-812-s311' },
    ]);
    expect(split.unavailable).toEqual({ reason: 'timeout', lastSuccessAt: '2026-09-29T08:00:00Z' });
    expect(split.unmapped).toEqual([
      { shippingCompanyId: 3, count: 4, reason: 'company', companyId: null, currencies: [] },
      { shippingCompanyId: null, count: 1, reason: 'company', companyId: null, currencies: [] },
      { shippingCompanyId: 1, count: 6, reason: 'account', companyId: 11, currencies: ['EUR', 'USD'] },
    ]);
    expect(split.orphaned).toEqual(['ship.dep-700']);
    expect(split.stale).toEqual(['ship.bal-812-s311']);
    expect(split.other.map((w) => w.code)).toEqual(['NO_ANCHOR', 'ORPHAN_OVERRIDE']);
  });

  it('is empty for no warnings, and reads a never-synced SHIPPING_UNAVAILABLE', () => {
    expect(splitShipWarnings(undefined)).toEqual({ unavailable: null, unmapped: [], stale: [], orphaned: [], other: [] });
    expect(splitShipWarnings([{ code: 'SHIPPING_UNAVAILABLE', reason: 'unconfigured', lastSuccessAt: null }]).unavailable).toEqual({
      reason: 'unconfigured',
      lastSuccessAt: null,
    });
  });
});

describe('unmappedNote (SHIP_UNMAPPED in words)', () => {
  const names = {
    shippingName: (id: number) => ({ 2: 'Hangerworld Ltd' } as Record<number, string>)[id] ?? `#${id}`,
    companyName: (id: number) => ({ 11: 'JFA' } as Record<number, string>)[id] ?? `company #${id}`,
  };
  const note = (u: Partial<Parameters<typeof unmappedNote>[0]>) =>
    unmappedNote({ shippingCompanyId: null, count: 1, reason: 'company', companyId: null, currencies: [], ...u }, names);

  it('no JFlow company linked: names the shipping company and links to Settings, Companies', () => {
    expect(note({ shippingCompanyId: 2, count: 3 })).toEqual({
      text: '3 stock payments belong to shipping company Hangerworld Ltd, which no JFlow company is linked to.',
      fix: { to: '/settings?tab=companies', label: 'Link it in Settings' },
    });
    expect(note({ shippingCompanyId: 9 }).text).toBe('1 stock payment belongs to shipping company #9, which no JFlow company is linked to.');
  });

  it('no company in shipping: nothing to fix in JFlow', () => {
    expect(note({ count: 2 })).toEqual({ text: '2 stock payments have no company in shipping.', fix: null });
    expect(note({}).text).toBe('1 stock payment has no company in shipping.');
  });

  it('no account to land on: the currencies and the JFlow company, linking to Settings, Accounts', () => {
    expect(note({ shippingCompanyId: 1, count: 5, reason: 'account', companyId: 11, currencies: ['USD', 'EUR'] })).toEqual({
      text:
        '5 stock payments (USD, EUR) for JFA have no account to land on: add an account in that currency, or mark one of ' +
        "JFA's accounts as default.",
      fix: { to: '/settings?tab=accounts', label: 'Open Settings → Accounts' },
    });
    expect(note({ shippingCompanyId: 1, reason: 'account', companyId: 12, currencies: ['CNY'] }).text).toBe(
      "1 stock payment (CNY) for company #12 has no account to land on: add an account in that currency, or mark one of company #12's accounts as default.",
    );
  });
});
