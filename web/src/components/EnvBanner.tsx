// Copied from workflows/web/src/components/EnvBanner.tsx — changes: ticker font IBM Plex Mono → the --font-num token
import { IS_TEST } from '../config/env';
import { useLayoutEffect } from 'react';

// Production and test are the same build serving the same UI against different
// data. Nothing on a test screen should be mistakable for the live record, and
// the sidebar pill this replaces was only on screens that have the sidebar.
//
// A full-width yellow strip across the top, "TEST" repeated along it and
// scrolling left as a ticker — the same marker as JFPRO, ShipLine, NorthernLine
// and Cashboard. It does not overlay the UI: while it is mounted <html> carries
// `env-test`, and shell.css uses that to push the page down and shorten .shell
// by --env-banner-h. Change the height there, never here.
//
// The [TEST] tab title is set in main.tsx (windowTitle) and is not this
// component's job. Mounted in main.tsx outside the auth gate, so it shows on
// the sign-in screen too. pointer-events:none — an environment marker that can
// swallow a click on the UI underneath is worse than no marker.

// Enough repeats that one copy of the loop is wider than a 4K window (each is
// ~130px with its spacing) — narrower, and the ticker shows a gap as it wraps.
const REPEATS = 32;

// Test builds served from this machine (`npm run dev` resolves to test) get no
// strip: the developer knows where they are, and it only eats screen. IS_TEST
// still drives API routing and the tab title.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);
const SHOW =
  IS_TEST &&
  typeof window !== 'undefined' &&
  !LOCAL_HOSTS.has(window.location.hostname) &&
  !window.location.hostname.endsWith('.localhost');

export function EnvBanner() {
  // Layout effect, not effect: the space must be reserved before first paint,
  // or the whole app visibly jumps down once.
  useLayoutEffect(() => {
    if (!SHOW) return;
    const root = document.documentElement;
    root.classList.add('env-test');
    return () => root.classList.remove('env-test');
  }, []);

  if (!SHOW) return null;

  // Two identical copies side by side; the track slides left by exactly one
  // copy (-50%) and restarts, so the loop has no visible seam. Spacing is
  // padding on each item rather than flex gap, so the join between the copies
  // is spaced the same as everywhere else.
  const copy = (copyIndex: number) => (
    <div aria-hidden={copyIndex > 0 || undefined} style={{ display: 'flex', flex: '0 0 auto' }}>
      {Array.from({ length: REPEATS }, (_, i) => (
        <span
          key={i}
          style={{
            flex: '0 0 auto',
            paddingRight: 72,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.24em',
            textTransform: 'uppercase',
            fontFamily: 'var(--font-num)',
  fontVariantNumeric: 'tabular-nums lining-nums',
          }}
        >
          Test
        </span>
      ))}
    </div>
  );

  return (
    <div
      role="status"
      aria-label="Test environment — not live data"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 'var(--env-banner-h)',
        // Literal: this marker's only job is to be visible, so it should not
        // depend on the app's layering resolving.
        zIndex: 1200,
        pointerEvents: 'none',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        // Fixed yellow in both themes: a warning colour that follows the theme
        // stops reading as a warning.
        background: '#f5c518',
        borderBottom: '1px solid #c99a00',
        color: '#2a2100',
      }}
    >
      <div className="env-ticker-track" style={{ display: 'flex', width: 'max-content' }}>
        {copy(0)}
        {copy(1)}
      </div>
    </div>
  );
}
