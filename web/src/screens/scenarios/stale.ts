/**
 * Why an adjustment cannot stand — the four stale reasons of CONTRACT §7 / §9.5 (D38) —
 * in words, with what fixes each. The reason itself is always the server's: it comes on
 * `adjustment.stale`, on a `STALE` forecast warning, or in a `SCENARIO_STALE` refusal.
 *
 * Also why un-apply refused (2026-10-07, D41): the four reasons inside
 * `SCENARIO_UNAPPLY_BLOCKED`.
 */

import type { StaleReason } from '../../api/forecast';
import type { AdjustmentKind, UnapplyReason } from '../../api/scenarios';

export interface StaleReasonText {
  /** The marker's word. */
  label: string;
  /** What happened, in a sentence. */
  text: string;
  /** What the person can do about it. */
  fix: string;
  /** Whether `POST …/rebase` fixes it (only BASE_CHANGED), or only `dropStale` removes it. */
  rebaseFixes: boolean;
}

export const STALE_REASONS: Record<StaleReason, StaleReasonText> = {
  BASE_CHANGED: {
    label: 'BASE CHANGED',
    text: 'The real item has changed since this adjustment was made — its date or amount is not what the adjustment started from.',
    fix: 'Rebase to take the new values as the starting point, then check the adjustment still makes sense.',
    rebaseFixes: true,
  },
  TARGET_SETTLED: {
    label: 'SETTLED',
    text: 'The real item has been paid, part paid or skipped, so there is nothing left to adjust.',
    fix: 'Remove the adjustment, or rebase with "drop what can\'t be rebased".',
    rebaseFixes: false,
  },
  TARGET_MISSING: {
    label: 'MISSING',
    text: 'The real item is gone — deleted, or no longer an occurrence of its schedule.',
    fix: 'Remove the adjustment, or rebase with "drop what can\'t be rebased".',
    rebaseFixes: false,
  },
  DATE_PASSED: {
    label: 'DATE PASSED',
    text: 'The new date this adjustment moves the item to is now in the past.',
    fix: 'Pick a new date on the Forecast. Rebasing cannot fix a date; dropping removes the adjustment.',
    rebaseFixes: false,
  },
};

/**
 * An `add` has no real item behind it (D39): its `TARGET_MISSING` means its own account or
 * category went, not a target.
 */
const ADD_TARGET_MISSING = 'Its account or category is gone — deleted, or the account is inactive.';

/**
 * The words for a reason — an unknown one (a newer server) still says something true.
 * `kind` is the adjustment's kind when known: an `add`'s missing target reads differently.
 */
export function staleReason(reason: string | null | undefined, kind?: AdjustmentKind | (string & {}) | null): StaleReasonText | null {
  if (!reason) return null;
  if (kind === 'add' && reason === 'TARGET_MISSING') return { ...STALE_REASONS.TARGET_MISSING, text: ADD_TARGET_MISSING };
  return (
    STALE_REASONS[reason as StaleReason] ?? {
      label: reason.replace(/_/g, ' '),
      text: `The server marked this adjustment stale (${reason}).`,
      fix: 'Reload the scenario to see what changed.',
      rebaseFixes: false,
    }
  );
}

/** Why un-apply refused a line (§7, D41): the marker's word and what happened. Nothing was written. */
export const UNAPPLY_REASONS: Record<UnapplyReason, { label: string; text: string }> = {
  TARGET_MISSING: { label: 'MISSING', text: 'That item is gone (deleted, or its instance no longer exists).' },
  TARGET_SETTLED: { label: 'SETTLED', text: 'That item has been paid or part paid since the scenario was applied.' },
  CHANGED: { label: 'CHANGED', text: "That item's date, amount or status has been changed since the scenario was applied." },
  NO_RECORD: {
    label: 'NO RECORD',
    text: 'This scenario was applied before un-apply existed, so there is nothing to restore from.',
  },
};

/** The words for an un-apply reason; an unknown one still says something true. */
export function unapplyReason(reason: string | null | undefined): { label: string; text: string } {
  if (reason && reason in UNAPPLY_REASONS) return UNAPPLY_REASONS[reason as UnapplyReason];
  return { label: reason ? reason.replace(/_/g, ' ') : 'BLOCKED', text: `The server refused to put this one back${reason ? ` (${reason})` : ''}.` };
}

export const SCENARIO_STATUS_LABEL: Record<string, string> = {
  draft: 'DRAFT',
  applied: 'APPLIED',
  archived: 'ARCHIVED',
};
