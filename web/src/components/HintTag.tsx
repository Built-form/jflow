import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Tone } from '../lib/tone';
import { toneStyle } from '../lib/tone';

/** The page's side gutter, and the gap between the tag and its sentence. */
const GUTTER = 16;
const GAP = 6;

/**
 * A tag that holds its sentence back until asked (2026-11-13, user-specified: a line under
 * every moved date crowded out what mattered on Stock payments). Hover shows the sentence;
 * a click, tap or Enter keeps it open until a second click, Escape, a press anywhere else,
 * or focus moving away.
 *
 * The sentence is portalled to <body> at fixed coordinates: the tables a tag sits in clip
 * their content (`.card-table` is `overflow: hidden`), so a box placed under the tag would
 * be cut off on a table's last row. It opens above the tag when there is no room below,
 * and stays inside the side gutters.
 */
export function HintTag({ tone = 'idle', hint, children }: { tone?: Tone; hint: string; children: ReactNode }) {
  const id = useId();
  const tagRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = hover || pinned;

  const close = useCallback(() => {
    setPinned(false);
    setHover(false);
  }, []);

  const place = useCallback(() => {
    const tag = tagRef.current;
    const tip = tipRef.current;
    if (!tag || !tip) return;
    const r = tag.getBoundingClientRect();
    const below = r.bottom + GAP + tip.offsetHeight <= window.innerHeight - GUTTER || r.top - GAP - tip.offsetHeight < GUTTER;
    setPos({
      top: below ? r.bottom + GAP : r.top - GAP - tip.offsetHeight,
      left: Math.max(GUTTER, Math.min(r.left, window.innerWidth - GUTTER - tip.offsetWidth)),
    });
  }, []);

  // Measured before paint, so the sentence never shows in the wrong place.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPress = (e: PointerEvent) => {
      if (!tagRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, close, place]);

  const s = toneStyle(tone);
  return (
    <>
      <button
        ref={tagRef}
        type="button"
        className="tag tag-hint"
        style={tone === 'idle' ? undefined : { borderColor: s.borderColor, background: s.background, color: s.color }}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => (pinned ? close() : setPinned(true))}
        onBlur={close}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="hint-tip"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {hint}
          </div>,
          document.body,
        )}
    </>
  );
}
