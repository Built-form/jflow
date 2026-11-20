/**
 * PayPulse's mark: one heartbeat on a white tile. Used by the sidebar and the sign-in
 * wordmark (Dev, 2026-11-20: "less like PayPal", so no letter monogram). Decoration only;
 * whatever holds it carries the name for screen readers.
 */
export function PulseMark({ className }: { className?: string }) {
  return (
    <span className={className ? `pulse-mark ${className}` : 'pulse-mark'} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M2.5 13 H7 L9 8.5 L12 17.5 L15 5 L17 13 H21.5" />
      </svg>
    </span>
  );
}
