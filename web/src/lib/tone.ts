// Copied from workflows/web/src/lib/tone.ts — changes: status mappings switched to JFlow's vocabularies (`toneOfDerivedStatus` for CONTRACT D10's derivedStatus, `toneOfScenarioStatus`, `toneOfAmount`); dropped workflows' `toneOfStatus`, `toneOfResult`, `toneOfVerdict`; `toneStyle`, `toneAccent`, `pipFill`, `lineFill` unchanged
/**
 * Status -> tone. Tones are the only place a colour decision is made, so the rule
 * "green means settled and nothing else" holds by construction: `done` is reachable from a
 * paid item and an applied scenario, never from a primary action.
 *
 * The statuses themselves come from the server (`derivedStatus`, CONTRACT D10) — this file
 * only colours them; it never decides one.
 */

export type Tone = 'live' | 'warn' | 'fail' | 'done' | 'idle' | 'waived';

/** An item's or instance's `derivedStatus`, as the server computed it. */
export function toneOfDerivedStatus(status: string): Tone {
  switch (status) {
    case 'expected':
      return 'live';
    case 'overdue':
      return 'warn';
    case 'unresolved':
      return 'fail';
    case 'paid':
      return 'done';
    // Assumed settled is its own colour: it is the server's inference, not a payment
    // anyone recorded, and it must not read as either.
    case 'assumedSettled':
      return 'waived';
    case 'assumed':
    case 'skipped':
    default:
      return 'idle';
  }
}

export function toneOfScenarioStatus(status: string): Tone {
  if (status === 'draft') return 'live';
  if (status === 'applied') return 'done';
  return 'idle';
}

/** A balance below zero (an overdraft) is flagged; zero and above are plain. */
export function toneOfAmount(negative: boolean): Tone {
  return negative ? 'fail' : 'live';
}

/** Inline style for a bordered, tinted pill or row in the given tone. */
export function toneStyle(tone: Tone): { borderColor: string; background: string; color: string } {
  switch (tone) {
    case 'live':
      return { borderColor: 'var(--line2)', background: 'transparent', color: 'var(--text)' };
    case 'warn':
      return { borderColor: 'var(--warnBd)', background: 'var(--warnBg)', color: 'var(--warn)' };
    case 'fail':
      return { borderColor: 'var(--failBd)', background: 'var(--failBg)', color: 'var(--fail)' };
    case 'done':
      return { borderColor: 'var(--passBd)', background: 'var(--passBg)', color: 'var(--pass)' };
    case 'waived':
      return { borderColor: 'var(--waivedBd)', background: 'var(--waivedBg)', color: 'var(--waived)' };
    case 'idle':
    default:
      return { borderColor: 'var(--line)', background: 'transparent', color: 'var(--mut)' };
  }
}

/** The bar/edge colour for a tone — used by progress segments and card top borders. */
export function toneAccent(tone: Tone): string {
  switch (tone) {
    case 'warn':
      return 'var(--warn)';
    case 'fail':
      return 'var(--fail)';
    case 'done':
      return 'var(--pass)';
    case 'live':
      return 'var(--acc)';
    case 'waived':
      return 'var(--waived)';
    case 'idle':
    default:
      return 'var(--line2)';
  }
}

export function pipFill(tone: Tone): 'acc' | 'pass' | 'fail' | 'warn' {
  if (tone === 'done') return 'pass';
  if (tone === 'fail') return 'fail';
  if (tone === 'warn') return 'warn';
  return 'acc';
}

/**
 * One line per thing, each in its own state: unfilled (grey) while idle, else the tone's
 * fill. Unlike `pipFill`, which paints a count of done things in one colour, this keeps
 * every thing visible on its own.
 */
export function lineFill(tone: Tone): 'acc' | 'pass' | 'fail' | 'warn' | undefined {
  return tone === 'idle' ? undefined : pipFill(tone);
}
