/**
 * Stock payments (Phase 2) on the client: display only.
 *
 * A ship line's band, its flags (`estimated`, `projected`, `blocked`, `planned`, plus the
 * usual `overdue`, `adjusted`…), `editable` and every warning come from the server
 * (CONTRACT §6.10; CLAUDE.md "Never"). This file turns them into looks and words: which
 * flag hatches a line, what a blocker is waiting on, why a refresh failed, what the
 * `shipping` block says. It decides nothing.
 *
 * A `ship.` key is only ever PARSED here (`lib/keys.ts`), never built.
 */

import type { CSSProperties } from 'react';
import type { ForecastShipping, ForecastWarning, ItemFlag, ShipInfo, ShippingReason } from '../api/forecast';
import type { IsoDateTime } from '../api/types';
import { parseUtc, plural } from './format';
import { parseKey } from './keys';
import { formatMoney, toMinor } from './money';
import type { Tone } from './tone';

/* ---------- keys ---------- */

/** The feed id behind a `ship.<ext_id>` key; null for any other key or a malformed one. */
export function shipExtId(key: unknown): string | null {
  const parsed = parseKey(key);
  return parsed?.targetKind === 'ship' ? parsed.targetId : null;
}

export function isShipKey(key: unknown): key is string {
  return shipExtId(key) !== null;
}

/* ---------- how a ship line looks ---------- */

/** Diagonal hatching for an estimated date — the figure is shipping's guess, not a date anyone set. */
export const HATCH = 'repeating-linear-gradient(135deg, transparent 0 4px, var(--line2) 4px 5px)';

export interface ShipLook {
  /** `estimated`: hatched background, italic figure. */
  estimated: boolean;
  /** `projected`: the amount is derived, not stated — noted. */
  projected: boolean;
  /** `blocked`: marked. */
  blocked: boolean;
  /** `planned`: marked — JFlow's overlay is in force. */
  planned: boolean;
}

export function shipLook(flags: readonly ItemFlag[]): ShipLook {
  return {
    estimated: flags.includes('estimated'),
    projected: flags.includes('projected'),
    blocked: flags.includes('blocked'),
    planned: flags.includes('planned'),
  };
}

/** The inline style a line's figure takes: italic and hatched when its date is estimated. */
export function shipLineStyle(flags: readonly ItemFlag[]): CSSProperties {
  const look = shipLook(flags);
  if (!look.estimated) return {};
  return { fontStyle: 'italic', backgroundImage: HATCH };
}

/** What a blocked line waits on (the feed's `blocked`, §3.5), in words. */
export const BLOCKER_TEXT: Record<string, string> = {
  shipment: 'Waiting on the shipment',
  artwork: 'Waiting on artwork sign-off',
  pi: 'Waiting on the PI',
  pi_signed: 'Waiting on the signed PI',
};

export function blockedText(blocked: string | null | undefined): string {
  if (!blocked) return 'Blocked';
  return BLOCKER_TEXT[blocked] ?? `Blocked (${blocked.replace(/_/g, ' ')})`;
}

/**
 * One sentence per feed flag the line carries, for a tooltip or a dialog. `ship` gives the
 * blocker; without it a blocked line just says "Blocked".
 */
export function shipFlagNotes(flags: readonly ItemFlag[], ship?: Pick<ShipInfo, 'blocked'> | null): string[] {
  const look = shipLook(flags);
  const notes: string[] = [];
  if (look.estimated) notes.push("The date is shipping's estimate.");
  if (look.projected) notes.push('The amount is projected by shipping, not yet stated on an invoice.');
  if (look.blocked) notes.push(`${blockedText(ship?.blocked)}.`);
  if (look.planned) notes.push("Planned in JFlow: this date, amount or skip is JFlow's, not shipping's.");
  return notes;
}

/* ---------- the feed's state ---------- */

/** Why a refresh failed (`SHIPPING_UNAVAILABLE.reason`, §6.10), in words. */
export function shippingReasonText(reason: ShippingReason | null | undefined): string {
  if (!reason) return 'the shipping feed did not answer';
  switch (reason) {
    case 'unconfigured':
      return 'the shipping feed is not set up for this environment';
    case 'timeout':
      return 'shipping did not answer in time';
    case 'unreachable':
      return 'shipping could not be reached';
    case 'http_401':
      return "shipping refused JFlow's key";
    case 'bad_response':
      return "shipping's answer could not be read";
    default: {
      const m = /^http_(\d{3})$/.exec(reason);
      return m ? `shipping answered with an error (HTTP ${m[1]})` : `the refresh failed (${reason})`;
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An instant (a sync time, UTC on the wire) as `29 Sep 2026, 09:41` in the browser's zone,
 * or "never" for a feed that has not succeeded once. Month names are the app's own
 * (`lib/dates`), not the locale's, which spells September "Sept".
 */
export function lastSyncText(lastSuccessAt: IsoDateTime | null | undefined): string {
  const d = parseUtc(lastSuccessAt);
  if (!d) return 'never';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The `shipping` block as the status line's parts: last sync, open count, undated count
 * with its GBP total, unmapped count. Null (the feed has never succeeded) is one part.
 */
export function shippingStatusParts(shipping: ForecastShipping | null | undefined): string[] {
  if (!shipping) return ['Never synced'];
  return [
    `Last synced ${lastSyncText(shipping.lastSuccessAt)}`,
    `${shipping.openCount} open`,
    `${shipping.undatedCount} undated (${formatMoney(toMinor(shipping.undatedGbp), 'GBP')})`,
    `${shipping.unmappedCount} unmapped`,
  ];
}

/* ---------- the four ship warnings ---------- */

export interface ShipWarnings {
  /** `SHIPPING_UNAVAILABLE` — at most one per answer. */
  unavailable: { reason: ShippingReason; lastSuccessAt: IsoDateTime | null } | null;
  /** `SHIP_UNMAPPED`, one per shipping company (null = POs with no company). */
  unmapped: { shippingCompanyId: number | null; count: number }[];
  /** `SHIP_PLAN_STALE` keys: the planned amount is ignored. */
  stale: string[];
  /** `SHIP_PLAN_ORPHANED` keys: a plan on a row shipping no longer lists. */
  orphaned: string[];
  /** Every other warning, in the server's order. */
  other: ForecastWarning[];
}

/** `warnings[]` split into the ship ones the screen shows in their own places, and the rest. */
export function splitShipWarnings(warnings: readonly ForecastWarning[] | null | undefined): ShipWarnings {
  const out: ShipWarnings = { unavailable: null, unmapped: [], stale: [], orphaned: [], other: [] };
  for (const w of warnings ?? []) {
    const f = w as Record<string, unknown>;
    switch (w.code) {
      case 'SHIPPING_UNAVAILABLE':
        out.unavailable = {
          reason: typeof f.reason === 'string' ? f.reason : 'unreachable',
          lastSuccessAt: typeof f.lastSuccessAt === 'string' ? f.lastSuccessAt : null,
        };
        break;
      case 'SHIP_UNMAPPED':
        out.unmapped.push({
          shippingCompanyId: typeof f.shippingCompanyId === 'number' ? f.shippingCompanyId : null,
          count: typeof f.count === 'number' ? f.count : 0,
        });
        break;
      case 'SHIP_PLAN_STALE':
        if (typeof f.key === 'string') out.stale.push(f.key);
        break;
      case 'SHIP_PLAN_ORPHANED':
        if (typeof f.key === 'string') out.orphaned.push(f.key);
        break;
      default:
        out.other.push(w);
    }
  }
  return out;
}

/** The mark a `SHIP_PLAN_STALE` key wears on its line in the grid. */
export const PLAN_STALE_TAG: { flag: string; label: string; tone: Tone } = {
  flag: 'planStale',
  label: 'PLAN IGNORED',
  tone: 'warn',
};

/** `12 stock payments` / `1 stock payment`. */
export function stockPayments(n: number): string {
  return plural(n, 'stock payment');
}
