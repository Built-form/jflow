// Copied from workflows/web/src/components/ui.tsx — changes: dropped `PassedAnyway` (a workflows review badge); `ErrorNote`'s detail lines read JFlow's refusal details (CONTRACT §7: bulk-balance `details.entries`, `STALE_WRITE` `currentVersion`, the `*_IN_USE` counts) instead of workflows' step/section/failure details; inline radii use the --radius token
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Tone } from '../lib/tone';
import { pipFill, toneStyle } from '../lib/tone';
import type { ApiError } from '../api/client';

/* ---------- pills and chips ---------- */

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const s = toneStyle(tone);
  return (
    <span className="pill" style={{ borderColor: s.borderColor, background: s.background, color: s.color }}>
      {children}
    </span>
  );
}

export function Tag({ tone = 'idle', children }: { tone?: Tone; children: ReactNode }) {
  const s = toneStyle(tone);
  const neutral = tone === 'idle';
  return (
    <span
      className="tag"
      style={
        neutral
          ? undefined
          : { borderColor: s.borderColor, background: s.background, color: s.color }
      }
    >
      {children}
    </span>
  );
}

/* ---------- segmented control ---------- */

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  compact,
  ariaLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  compact?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className={compact ? 'segmented compact' : 'segmented'} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- progress ---------- */

/**
 * One segment per required question in the check. Lots legitimately have different
 * segment counts — that difference is the point, so nothing here pads to a fixed width.
 */
export function Pips({
  done,
  total,
  tone = 'live',
  size,
  blocked,
}: {
  done: number;
  total: number;
  tone?: Tone;
  size?: 'sm' | 'xs';
  blocked?: boolean;
}) {
  const count = Math.max(total, 1);
  const fill = pipFill(tone);
  return (
    <div className={`pips${size ? ` ${size}` : ''}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} data-fill={blocked ? 'blocked' : i < done ? fill : undefined} />
      ))}
    </div>
  );
}

/* ---------- toggle ---------- */

export function Toggle({
  on,
  label,
  detail,
  onChange,
  disabled,
}: {
  on: boolean;
  label: string;
  detail?: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        border: 0,
        borderTop: '1px solid var(--line)',
        background: 'transparent',
        padding: '11px 2px',
        display: 'flex',
        gap: 11,
        alignItems: 'flex-start',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: '100%',
      }}
    >
      <span
        style={{
          width: 32,
          height: 18,
          borderRadius: 999,
          background: on ? 'var(--acc)' : 'var(--line2)',
          flex: 'none',
          padding: 2,
          display: 'block',
          transition: 'background-color 160ms ease',
        }}
      >
        {/* The knob slides (transform, not layout) — the state change is the animation. */}
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 999,
            display: 'block',
            background: on ? 'var(--accInk)' : 'var(--panel)',
            transform: on ? 'translateX(14px)' : 'translateX(0)',
            transition: 'transform 160ms var(--ease-out-strong), background-color 160ms ease',
          }}
        />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* Disabled dims the label, not the whole control: halving opacity took the dim
            detail line under 2:1. */}
        <span style={{ fontSize: 14, color: disabled ? 'var(--mut)' : undefined }}>{label}</span>
        {detail && (
          <span style={{ fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.5 }}>{detail}</span>
        )}
      </span>
    </button>
  );
}

/* ---------- radio-style choice button ---------- */

export function ChoiceButton({
  selected,
  label,
  detail,
  tone,
  size = 'md',
  disabled,
  onClick,
}: {
  selected: boolean;
  label: string;
  detail?: string;
  tone?: Tone;
  size?: 'md' | 'lg';
  disabled?: boolean;
  onClick: () => void;
}) {
  const s = tone ? toneStyle(tone) : null;
  const accent = selected ? (s?.color ?? 'var(--acc)') : 'var(--line2)';
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      className="pressable"
      onClick={onClick}
      style={{
        border: `1.5px solid ${accent}`,
        borderRadius: 'var(--radius)',
        background: selected ? (s?.background ?? 'var(--accBg)') : 'transparent',
        color: selected ? (s?.color ?? 'var(--acc)') : disabled ? 'var(--dim)' : 'var(--text)',
        padding: size === 'lg' ? '17px 16px' : '13px 20px',
        fontSize: size === 'lg' ? 17 : 16,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        // Unselected already goes --dim when disabled; fading it too left ~1.5:1 text.
        opacity: disabled && selected ? 0.8 : 1,
        display: 'flex',
        gap: detail ? 12 : 9,
        alignItems: detail ? 'flex-start' : 'center',
        textAlign: 'left',
        width: detail ? '100%' : undefined,
        // Includes transform so the .pressable press feedback survives this override.
        transition:
          'transform 140ms var(--ease-out-strong), border-color 150ms ease, background-color 150ms ease, color 150ms ease',
      }}
    >
      <span
        style={{
          width: detail ? 17 : 16,
          height: detail ? 17 : 16,
          borderRadius: 999,
          // The empty ring takes --dim, not the card's --line2 border: at 1.4:1 an unticked
          // circle all but vanished in light mode.
          border: `2px solid ${selected ? accent : 'var(--dim)'}`,
          background: selected ? accent : 'transparent',
          flex: 'none',
          marginTop: detail ? 1 : 0,
        }}
      />
      {detail ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 15.5, fontWeight: 600 }}>{label}</span>
          <span style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 1.55, fontWeight: 400 }}>
            {detail}
          </span>
        </span>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}

/* ---------- long explanatory text ---------- */

/**
 * A long intro, hint or instruction, cut to its first line with an ellipsis and an (i) to
 * open it (2026-09-17, user-specified). It takes the style of the element it replaces.
 *
 * The cut is a one-line clamp, not `nowrap`: the text still lays out at the width it
 * always had, so a page header's explainer does not push the buttons beside it around.
 * The (i) only becomes a button when the text is actually cut — a line that fits has
 * nothing to open. Inside a <label> only the (i) toggles, so a tap on the hint still
 * ticks the box it describes.
 */
export function InfoText({
  children,
  as: Tag = 'div',
  className,
  style,
  ...rest
}: {
  children: ReactNode;
  as?: 'div' | 'span';
  className?: string;
  style?: CSSProperties;
  [data: `data-${string}`]: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, children]);

  const expandable = open || cut;

  const onTextClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (!expandable) return;
    if (e.currentTarget.closest('label')) return;
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    // Selecting a phrase to copy it is not a request to fold the text away.
    if (open && String(window.getSelection?.() ?? '').length > 0) return;
    setOpen(!open);
  };

  const icon = (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="8" cy="8" r="6.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="4.9" r="1" fill="currentColor" />
      <path d="M8 7.2v4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
  const iconBox: CSSProperties = {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: '1lh',
    minHeight: '1.5em',
    marginLeft: -2,
    color: expandable ? 'var(--acc)' : 'var(--dim)',
  };

  return (
    <Tag
      {...rest}
      className={className}
      data-info-text={open ? 'open' : cut ? 'cut' : 'whole'}
      style={{ ...style, display: 'flex', gap: 6, alignItems: 'flex-start' }}
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Show less' : 'Show all of this'}
          title={open ? 'Show less' : 'Show all'}
          onClick={() => setOpen(!open)}
          style={{ ...iconBox, border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}
        >
          {icon}
        </button>
      ) : (
        <span style={iconBox}>{icon}</span>
      )}
      <span
        ref={textRef}
        onClick={onTextClick}
        style={{
          flex: 1,
          minWidth: 0,
          cursor: expandable ? 'pointer' : undefined,
          ...(open
            ? null
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 1,
                overflow: 'hidden',
              }),
        }}
      >
        {children}
      </span>
    </Tag>
  );
}

/* ---------- panels, states ---------- */

export function Panel({
  label,
  children,
  style,
}: {
  label?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="panel" style={style}>
      {label && <div className="kicker">{label}</div>}
      {children}
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="loading">{what}…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * `error` on the envelope is one line written to be shown to the operator. Show it as-is —
 * a 409 carrying a business rule is information, never something to swallow.
 */
/**
 * The lines under a refusal's headline: WHICH entry, and WHAT is wrong with it.
 *
 * A bulk balance save is all-or-nothing (CONTRACT §6.6), so "Some entries are not valid."
 * alone would leave the person guessing which of a dozen accounts broke it — the server
 * names each one under `details.entries[i]`, `i` being the position in the array that was
 * SENT. `entryLabel` lets the screen that sent it name that position (an account's name);
 * without one it reads "Entry 3".
 */
export function errorDetailLines(
  error: ApiError,
  entryLabel?: (index: number) => string | null,
): { key: string; label: string | null; message: string }[] {
  const details = error.details;
  if (!details) return [];
  const lines: { key: string; label: string | null; message: string }[] = [];

  // The contract names the key, not the element's shape: a bare string, or an object
  // carrying a message (and perhaps its own index or account). Read what is there.
  for (const [i, entry] of (Array.isArray(details.entries) ? details.entries : []).entries()) {
    if (entry == null) continue;
    const index = typeof entry === 'object' && typeof entry.index === 'number' ? entry.index : i;
    const message =
      typeof entry === 'string'
        ? entry
        : entry.message ?? entry.error ?? (entry.field ? `${entry.field} is not valid` : 'is not valid');
    lines.push({ key: `entry-${i}`, label: entryLabel?.(index) ?? `Entry ${index + 1}`, message });
  }

  if (error.code === 'STALE_WRITE' && typeof details.currentVersion === 'number') {
    lines.push({
      key: 'version',
      label: null,
      message: `Someone else saved it first (now version ${details.currentVersion}). Reload to see their change, then try again.`,
    });
  }

  const uses = [
    typeof details.itemCount === 'number' && details.itemCount > 0 ? plural(details.itemCount, 'item') : null,
    typeof details.scheduleCount === 'number' && details.scheduleCount > 0
      ? plural(details.scheduleCount, 'schedule')
      : null,
    typeof details.balanceCount === 'number' && details.balanceCount > 0
      ? plural(details.balanceCount, 'recorded balance')
      : null,
    Array.isArray(details.accountIds) && details.accountIds.length > 0
      ? plural(details.accountIds.length, 'account')
      : null,
    // Deactivating an account (D17): what the forecast would still show for it.
    countOf(details.owedItems) > 0 ? plural(countOf(details.owedItems), 'owed item') : null,
    countOf(details.liveSchedules) > 0 ? plural(countOf(details.liveSchedules), 'live schedule') : null,
    countOf(details.owedInstances) > 0 ? plural(countOf(details.owedInstances), 'owed instance') : null,
  ].filter((part): part is string => part !== null);
  if (uses.length) lines.push({ key: 'uses', label: 'Still used by', message: uses.join(' · ') });

  return lines;
}

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** `{count, keys}` / `{count, ids}` from an `ACCOUNT_IN_USE` refusal; 0 for anything else. */
function countOf(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const count = (value as { count?: unknown }).count;
  return typeof count === 'number' ? count : 0;
}

export function ErrorNote({
  error,
  onRetry,
  entryLabel,
}: {
  error: ApiError;
  onRetry?: () => void;
  /** Names `details.entries[i]` — the i-th entry of the request that was sent. */
  entryLabel?: (index: number) => string | null;
}) {
  const lines = errorDetailLines(error, entryLabel);
  return (
    <div
      className="error-banner"
      role="alert"
      style={lines.length ? { alignItems: 'flex-start' } : undefined}
    >
      <span>
        {error.message}
        {error.code && error.code !== 'NETWORK' && (
          <span className="mono" style={{ color: 'var(--dim)', marginLeft: 8, fontSize: 12 }}>
            {error.code}
          </span>
        )}
        {error.requestId && (
          <span
            className="mono"
            title="Quote this id when reporting the problem — it finds the request in the server logs."
            style={{ color: 'var(--dim)', marginLeft: 8, fontSize: 11 }}
          >
            ref {error.requestId}
          </span>
        )}
        {lines.length > 0 && (
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {lines.map((line) => (
              <li key={line.key} style={{ fontSize: 13.5, lineHeight: 1.5, display: 'flex', gap: 8 }}>
                {line.label && (
                  <span className="mono" style={{ fontSize: 11.5, letterSpacing: '.05em', flex: 'none', opacity: 0.75 }}>
                    {line.label}
                  </span>
                )}
                <span>{line.message}</span>
              </li>
            ))}
          </ul>
        )}
      </span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** A 16px square holding a tick or a bang — the review checklist and lot-record marks. */
export function Mark({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        background: ok ? 'var(--pass)' : 'var(--warn)',
        color: 'var(--onSolid)',
        fontSize: 11.5,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        marginTop: 2,
      }}
    >
      {ok ? '✓' : '!'}
    </span>
  );
}
