import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** The page's side gutter, the gap under the element, and how far a tap may wander. */
const GUTTER = 16;
const GAP = 6;
const SLOP = 10;

/** What a tap already means something on: its `title` only says what the tap will do. */
const CONTROL = 'button, a[href], input, select, textarea, label, summary, [role="button"]';

interface Tip {
  el: Element;
  text: string;
}

/**
 * The sentence a tap on `target` should show, or null. It is the nearest `title`, unless:
 * - it, or something round it, opts out with `data-tap-title="off"` (a title that is only
 *   a mouse instruction);
 * - it is a control's own title (the tap presses the control);
 * - it only repeats text that is already fully on show, or sits inside a control — in both
 *   cases it is still shown when the element's text is cut short, since the title is then
 *   the only way to read the whole of it.
 */
export function tapTitle(target: Element): Tip | null {
  const el = target.closest('[title]');
  const text = el?.getAttribute('title')?.trim();
  if (!el || !text) return null;
  if (el.closest('[data-tap-title="off"]')) return null;
  if (el.matches(CONTROL)) return null;
  const clipped = el.scrollWidth > el.clientWidth + 1;
  if (!clipped && (el.closest(CONTROL) !== null || text === el.textContent?.trim())) return null;
  return { el, text };
}

/**
 * Hover titles, for fingers (Dev, 2026-11-20, on an iPad): a `title` never shows on a touch
 * screen, and the Forecast keeps real information in them (a column's dates, a dip's day and
 * depth, what a flag means, a name cut short). Mounted once by the Shell. A tap with a
 * finger or pencil on anything `tapTitle` accepts shows its title in the hint box
 * (`.hint-tip`, as HintTag's) under it; the next tap, a scroll, a resize or Escape puts it
 * away, and a second tap on the same thing does not bring it straight back. A mouse is
 * left to the browser's own tooltip.
 */
export function TapTitles() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // What the handlers need between events, without re-binding them on every tip.
  const shown = useRef<Element | null>(null);
  shown.current = tip?.el ?? null;

  useEffect(() => {
    let press: { x: number; y: number; was: Element | null } | null = null;
    const away = () => setTip(null);
    const onDown = (e: PointerEvent) => {
      press = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY, was: shown.current };
      away();
    };
    const onUp = (e: PointerEvent) => {
      const from = press;
      press = null;
      // A drag or a swipe is not a tap.
      if (!from || Math.hypot(e.clientX - from.x, e.clientY - from.y) > SLOP) return;
      const next = e.target instanceof Element ? tapTitle(e.target) : null;
      if (next && next.el !== from.was) setTip(next);
    };
    const onCancel = () => {
      press = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') away();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onCancel, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, []);

  // Measured before paint: centred under the element, above it when there is no room below,
  // and always inside the side gutters.
  useLayoutEffect(() => {
    const box = tipRef.current;
    if (!tip || !box) {
      setPos(null);
      return;
    }
    const r = tip.el.getBoundingClientRect();
    const below = r.bottom + GAP + box.offsetHeight <= window.innerHeight - GUTTER || r.top - GAP - box.offsetHeight < GUTTER;
    const centred = r.left + r.width / 2 - box.offsetWidth / 2;
    setPos({
      top: below ? r.bottom + GAP : r.top - GAP - box.offsetHeight,
      left: Math.max(GUTTER, Math.min(centred, window.innerWidth - GUTTER - box.offsetWidth)),
    });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="hint-tip"
      data-testid="tap-title"
      // Above a dialog (40): a title inside one is tapped too.
      style={pos ? { top: pos.top, left: pos.left, zIndex: 50 } : { top: 0, left: 0, zIndex: 50, visibility: 'hidden' }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
