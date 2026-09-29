// Copied from workflows/web/src/components/Dialog.tsx — changes: none
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Tone } from '../lib/tone';
import { toneStyle } from '../lib/tone';

/**
 * The one dialog shell every modal uses. The confirm stays disabled — panel2 fill, dim
 * text, not-allowed cursor — until its conditions are met, so a refusal is visible before
 * the click rather than after it.
 */
export function Dialog({
  kicker,
  title,
  width = 500,
  children,
  warning,
  warnTone = 'idle',
  confirmLabel,
  confirmDisabled,
  busy,
  cancelLabel = 'Not now',
  onConfirm,
  onClose,
}: {
  /** Record identity above the title — a lot's code and number, say, with its name after. */
  kicker: ReactNode;
  title: string;
  width?: number;
  children?: ReactNode;
  warning?: ReactNode;
  warnTone?: Tone;
  confirmLabel: string;
  confirmDisabled?: boolean;
  busy?: boolean;
  /** null hides the secondary button — for modals where closing IS the only action. */
  cancelLabel?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // While the confirm is in flight, nothing closes: Escape, the backdrop, the ✕ and the
  // cancel all go quiet. Closing mid-mutation leaves the request running unseen, and the
  // natural next move — reopen and click again — is a double submit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const warn = toneStyle(warnTone);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="dialog-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,14,18,.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 26,
        zIndex: 40,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="dialog-panel"
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line2)',
          borderRadius: 14,
          width,
          maxWidth: '100%',
          maxHeight: '100%',
          overflow: 'auto',
        }}
      >
        <div
          style={{
            padding: '19px 21px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div className="kicker">{kicker}</div>
            <div style={{ fontSize: 20.5, fontWeight: 600, letterSpacing: '-0.015em' }}>{title}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={() => !busy && onClose()}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 7,
              background: 'var(--panel2)',
              width: 28,
              height: 28,
              fontSize: 16,
              cursor: 'pointer',
              flex: 'none',
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '18px 21px', display: 'flex', flexDirection: 'column', gap: 15 }}>
          {children}
          {warning && (
            <div
              style={{
                border: `1px solid ${warn.borderColor}`,
                borderRadius: 9,
                background: warnTone === 'idle' ? 'var(--panel2)' : warn.background,
                padding: '12px 14px',
                fontSize: 14,
                color: 'var(--text)',
                lineHeight: 1.6,
              }}
            >
              {warning}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '15px 21px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            gap: 9,
            justifyContent: 'flex-end',
          }}
        >
          {cancelLabel !== null && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={onClose}
              style={{ padding: '11px 15px', fontSize: 14.5 }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={confirmDisabled || busy}
            onClick={onConfirm}
            style={{ padding: '11px 18px' }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DialogBody({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 14.5, color: 'var(--mut)', lineHeight: 1.65 }}>{children}</div>;
}

export function DialogField({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        className="mono"
        style={{ fontSize: 11, letterSpacing: '.1em', color: 'var(--dim)' }}
      >
        {label}
      </div>
      {children}
      {note && <div style={{ fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
