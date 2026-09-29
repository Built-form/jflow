/**
 * Why an adjustment cannot stand — the four stale reasons of CONTRACT §7 / §9.5 (D38) —
 * in words, with what fixes each. The reason itself is always the server's: it comes on
 * `adjustment.stale`, on a `STALE` forecast warning, or in a `SCENARIO_STALE` refusal.
 */

import type { StaleReason } from '../../api/forecast';

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

/** The words for a reason — an unknown one (a newer server) still says something true. */
export function staleReason(reason: string | null | undefined): StaleReasonText | null {
  if (!reason) return null;
  return (
    STALE_REASONS[reason as StaleReason] ?? {
      label: reason.replace(/_/g, ' '),
      text: `The server marked this adjustment stale (${reason}).`,
      fix: 'Reload the scenario to see what changed.',
      rebaseFixes: false,
    }
  );
}

export const SCENARIO_STATUS_LABEL: Record<string, string> = {
  draft: 'DRAFT',
  applied: 'APPLIED',
  archived: 'ARCHIVED',
};
