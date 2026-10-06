/**
 * The stock-payment plan dialog's checks and the one write it turns into (CONTRACT §6.12,
 * §10.11).
 *
 * With no scenario open, an edit of a ship line writes JFlow's OVERLAY on the feed row —
 * `PUT /external-items/:key {plannedDate, plannedAmount, skipped, note}` — and "Revert to
 * feed" is `DELETE`. Shipping itself is never written. (Inside a scenario the line is an
 * ordinary adjustment target and goes through `edit.ts`.)
 *
 * The dialog works on the ROW (`GET /external-items/:key`), so it knows exactly which
 * overlay columns are set, the note, and the `rowVersion` it sends as `baseVersion` on
 * every PUT and DELETE (D4; a concurrent change answers 409 `STALE_WRITE`).
 *
 * The PUT is a MERGE: an absent field is left as it is and `null` clears one, so the body
 * carries only what changed. The date either FOLLOWS shipping's (`plannedDate` null, and
 * an ETA change moves the line) or is PINNED (`plannedDate` set, and it stays put) — the
 * form says which, and a pinned date may equal shipping's once the row has a plan.
 *
 * The checks say before the click what the server would refuse: a planned date must be
 * today or later (422 `PLANNED_DATE_IN_PAST`), an amount a DECIMAL above zero (§2.6), a
 * note at most 500 characters.
 */

import type { ApiError } from '../../api/client';
import type { ExternalItem, PlanWrite } from '../../api/external';
import type { ItemFlag, ShipDueSet } from '../../api/forecast';
import type { IsoDate, IsoDateTime } from '../../api/types';
import { formatDay, isValidDate } from '../../lib/dates';
import { formatMinor, parseMinor, parseMoneyInput } from '../../lib/money';
import { shipExtId } from '../../lib/ship';

export const NOTE_MAX = 500;

/** One stock payment as the dialog sees it: an `/external-items` row, in minor units. */
export interface ShipPlanTarget {
  key: string;
  name: string;
  currency: string;
  /** What shipping says: its date (null = no date yet) and amount. */
  feedDate: IsoDate | null;
  feedAmountMinor: bigint;
  /** What JFlow uses now — the overlay applied (§3.4). Null date = undated. */
  date: IsoDate | null;
  amountMinor: bigint;
  /** The overlay columns as stored. */
  plannedDate: IsoDate | null;
  plannedAmountMinor: bigint | null;
  skipped: boolean;
  note: string | null;
  /** Any overlay column is set. */
  planned: boolean;
  /** `planStale`: a planned amount exists but is ignored (P6). */
  planStale: boolean;
  /** Shipping no longer lists the row, or says it is paid: nothing to plan, only to revert. */
  gone: boolean;
  paid: boolean;
  flags: ItemFlag[];
  blocked: string | null;
  /** The feed's date was set by hand in ShipLine (flag `due_set`); null when derived. */
  dueSet: ShipDueSet | null;
  /** Flag `date_moved` (the server's `dateMoved`): the feed's date moved from here, at this instant. */
  dateMovedFrom: IsoDate | null;
  dateMovedAt: IsoDateTime | null;
  rowVersion: number;
}

/** Whether any overlay column is set on a row (what `DELETE` would clear). */
export function hasOverlay(row: Pick<ExternalItem, 'plannedDate' | 'plannedAmount' | 'plannedSkipped' | 'plannedNote'>): boolean {
  return row.plannedDate != null || row.plannedAmount != null || row.plannedSkipped || (row.plannedNote ?? '') !== '';
}

/**
 * The row's name as `/forecast` sends it: `<supplier> · <poNumber> · deposit|balance`, or what
 * the row is when it is not goods (`label`): `Fast Forwarders · Freight`, `… · Mould cost`,
 * `… · QC units X`.
 */
export function shipRowName(row: Pick<ExternalItem, 'supplier' | 'poNumber' | 'feedKind' | 'extId'> & { label?: string | null }): string {
  const what = row.label || (row.feedKind === 'qc' ? 'QC units' : row.feedKind);
  return [row.supplier, row.poNumber, what].filter((p) => p != null && p !== '').join(' · ') || row.extId;
}

export function targetFromRow(row: ExternalItem): ShipPlanTarget {
  const flags: ItemFlag[] = [];
  if (row.dateBasis === 'estimated') flags.push('estimated');
  // No `projected` flag since 2026-10-06 (CONTRACT §6.10): it read as "no invoice yet".
  if (row.blocked != null) flags.push('blocked');
  const planned = hasOverlay(row);
  if (planned) flags.push('planned');
  // The server's say (CONTRACT §6.12): `dueSet` set, `dateMoved` within its 14 days.
  if (row.dueSet) flags.push('due_set');
  if (row.dateMoved) flags.push('date_moved');
  const feedAmountMinor = parseMinor(row.amount) ?? 0n;
  return {
    key: row.key,
    name: shipRowName(row),
    currency: row.currency,
    feedDate: row.dueDate,
    feedAmountMinor,
    date: row.effectiveDate,
    amountMinor: parseMinor(row.effectiveAmount) ?? feedAmountMinor,
    plannedDate: row.plannedDate,
    plannedAmountMinor: parseMinor(row.plannedAmount),
    skipped: row.plannedSkipped,
    note: row.plannedNote,
    planned,
    planStale: row.planStale,
    gone: row.goneAt != null,
    paid: row.feedStatus === 'paid',
    flags,
    blocked: row.blocked,
    dueSet: row.dueSet ?? null,
    dateMovedFrom: row.dateMoved ? row.dueDatePrev ?? null : null,
    dateMovedAt: row.dateMoved ? row.dueDateMovedAt ?? null : null,
    rowVersion: row.rowVersion,
  };
}

export interface PlanForm {
  date: string;
  /** True: the date follows shipping's (`plannedDate` null). False: it is pinned to `date`. */
  dateFollowsFeed: boolean;
  amount: string;
  skipped: boolean;
  note: string;
}

export function initialPlanForm(t: ShipPlanTarget): PlanForm {
  return {
    date: t.date ?? '',
    dateFollowsFeed: t.plannedDate == null,
    amount: formatMinor(t.amountMinor),
    skipped: t.skipped,
    note: t.note ?? '',
  };
}

/** The form after a date is picked or typed: that date, pinned. */
export function pickDate(form: PlanForm, date: string): PlanForm {
  return { ...form, date, dateFollowsFeed: false };
}

/** The form after "Use shipping's": the date follows the feed again. */
export function followFeedDate(form: PlanForm, t: ShipPlanTarget): PlanForm {
  return { ...form, date: t.feedDate ?? '', dateFollowsFeed: true };
}

export type PlanAction =
  | { kind: 'plan'; key: string; body: PlanWrite; baseVersion: number }
  | { kind: 'unplan'; key: string; baseVersion: number };

type Field = 'date' | 'amount' | 'note' | 'form';

export interface PlanCheck {
  action: PlanAction | null;
  errors: Partial<Record<Field, string>>;
  /** Valid, but nothing differs from the row. */
  unchanged: boolean;
}

/** What saving would send, or why it cannot. `today` is the server's (`meta.today`). */
export function checkPlan(t: ShipPlanTarget, form: PlanForm, today: IsoDate): PlanCheck {
  const errors: Partial<Record<Field, string>> = {};
  if (shipExtId(t.key) === null) {
    errors.form = `This line's key (${t.key}) is not a stock payment.`;
    return { action: null, errors, unchanged: false };
  }
  if (t.gone || t.paid) {
    errors.form = t.gone
      ? 'Shipping no longer lists this payment, so it cannot be planned. Revert to feed clears what is left.'
      : 'Shipping says this payment has been made, so there is nothing left to plan.';
    return { action: null, errors, unchanged: false };
  }

  const body: PlanWrite = {};

  const note = form.note.trim();
  if (note.length > NOTE_MAX) errors.note = `At most ${NOTE_MAX} characters.`;
  else if (note !== (t.note ?? '')) body.note = note === '' ? null : note;

  if (form.skipped !== t.skipped) body.skipped = form.skipped;

  // Skipping takes neither a date nor an amount; whatever was planned stays for an unskip.
  if (!form.skipped) {
    if (form.dateFollowsFeed) {
      if (t.plannedDate != null) body.plannedDate = null;
    } else {
      const date = form.date.trim();
      // A pinned date equal to shipping's means something only once the row has a plan;
      // on a bare row it is the date the line already has.
      const bareFeedDate = t.plannedDate == null && !t.planned && date === t.feedDate;
      if (date === '') {
        // An undated row left undated is no change; a dated one needs a date.
        if (t.date != null) errors.date = "Pick a date, or use shipping's.";
      } else if (date === t.plannedDate || bareFeedDate) {
        // unchanged
      } else if (!isValidDate(date)) errors.date = 'Pick a date.';
      else if (date < today) errors.date = 'A planned date must be today or later.';
      else body.plannedDate = date;
    }

    const amount = parseMoneyInput(form.amount, { allowNegative: false, allowZero: false });
    if (amount.kind === 'blank') errors.amount = 'Enter an amount.';
    else if (amount.kind === 'error') errors.amount = amount.error;
    else if (amount.minor !== t.amountMinor) {
      // Back to shipping's amount = follow it again (a planned amount equal to the feed's
      // would be ignored the moment shipping's moved, P6).
      if (amount.minor === t.feedAmountMinor) {
        if (t.plannedAmountMinor != null) body.plannedAmount = null;
      } else body.plannedAmount = amount.decimal;
    }
  }

  if (Object.keys(errors).length) return { action: null, errors, unchanged: false };
  if (Object.keys(body).length === 0) return { action: null, errors, unchanged: true };
  return { action: { kind: 'plan', key: t.key, body, baseVersion: t.rowVersion }, errors, unchanged: false };
}

/** "Revert to feed": offered while anything of JFlow's is on the row. */
export function revertAction(t: ShipPlanTarget): PlanAction | null {
  if (!t.planned) return null;
  return { kind: 'unplan', key: t.key, baseVersion: t.rowVersion };
}

/* ---------- refusals ---------- */

export interface ShipRefusalLine {
  key: string;
  message: string;
}

/**
 * The overlay routes' refusals (§6.12, §7) in words, under the server's own line. A 400 is
 * shown as the server worded it; `STALE_WRITE` is explained by `ErrorNote` and offers a
 * reload of the row in the dialog.
 */
export function shipRefusalLines(error: ApiError, today: IsoDate): ShipRefusalLine[] {
  const d = (error.details ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  if (error.code === 'TARGET_MISSING') {
    return [
      {
        key: 'gone',
        message:
          'Shipping no longer lists this payment — its stage changed (a PI replaced the deposit, an invoice was recorded) or the PO went away. Plan the payment that replaced it; Revert to feed clears what is left here.',
      },
    ];
  }
  if (error.code === 'TARGET_SETTLED') {
    return [{ key: 'paid', message: 'Shipping says this payment has been made, so there is nothing left to plan.' }];
  }
  if (error.code === 'PLANNED_DATE_IN_PAST') {
    return [
      {
        key: 'past',
        message: `${formatDay(str(d.plannedDate))} is before today (${formatDay(str(d.today) ?? today)}). Pick today or later.`,
      },
    ];
  }
  if (error.status === 404) {
    return [{ key: 'none', message: 'There is no stock payment with this key any more. Reload to see the current list.' }];
  }
  return [];
}

/** A refusal after which what is on screen is out of date: the line is gone, paid or never existed. */
export function refusalNeedsReload(error: ApiError): boolean {
  return error.status === 404 || error.code === 'TARGET_SETTLED';
}

/** `STALE_WRITE`: someone changed the row since it was read; the dialog re-reads it. */
export function isStaleWrite(error: ApiError): boolean {
  return error.code === 'STALE_WRITE';
}
