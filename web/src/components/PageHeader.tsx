// Copied from workflows/web/src/components/PageHeader.tsx — changes: `SECTION_LABEL` names JFlow's sections (forecast, cash, items, schedules, scenarios, settings, people, about)
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { Location, NavigateOptions } from 'react-router-dom';

/**
 * The one page header, and the return address that makes it honest.
 *
 * A detail screen cannot know its own parent: a workflow is reached from the
 * workflows list, from a process, from a product and from a stage's filtered
 * list, and every one of those hardcoded "← All workflows" back to a list the
 * operator never came from. The arrival knows what the screen cannot, so the
 * opener records where it opened from (`openDetail`) and the header honours it,
 * falling back to a canonical parent for a deep link or a refresh.
 *
 * The address carries the query string on purpose: the list filters live in the
 * URL precisely so a filtered list can be returned to, and a bare
 * `navigate('/workflows')` threw that away every time.
 */

export interface Crumb {
  to: string;
  label: string;
  /** After the label, inside the same link — a product's name after its code, say. */
  detail?: ReactNode;
}

/** What router state an opened detail screen carries. */
export interface FromState {
  from?: string;
}

/**
 * Arguments for `navigate()` that open `to` and record where from.
 *
 * Spread it: `navigate(...openDetail('/workflows/7', location))`. Taking the
 * location rather than reading it means this stays a plain function, callable
 * from a dialog callback or an event handler without hook rules.
 */
export function openDetail(
  to: string,
  location: RouterLocation,
  options: NavigateOptions = {},
): [string, NavigateOptions] {
  return [to, { ...options, state: { ...(options.state as object), from: address(location) } }];
}

/**
 * The router's location, not the DOM's.
 *
 * `location` is a global in a browser, so a component that forgot `useLocation()`
 * still type-checked against `window.location` and silently recorded the whole
 * href — origin included — which `usable()` then refused, losing the way back with
 * no error anywhere. Requiring `key` makes that mistake a compile error: only the
 * router's location has one.
 */
type RouterLocation = Pick<Location, 'pathname' | 'search' | 'key'>;

/** `pathname` plus `search` — the whole address, filters included. */
export function address(location: RouterLocation): string {
  return `${location.pathname}${location.search}`;
}

/**
 * Only an in-app path may come back through router state, and it must not point
 * at the screen already showing — a self-return is a control that does nothing.
 * `//host` is a protocol-relative URL, not a path, so both slashes are refused.
 */
function usable(from: unknown, here: string): from is string {
  return (
    typeof from === 'string' &&
    from.startsWith('/') &&
    !from.startsWith('//') &&
    from !== here
  );
}

/**
 * The resolved way out: where the operator came from, else the canonical parent.
 *
 * Screens with their own returning control — a Cancel, a dialog closing onto the
 * list — read this so their destination and the header's can never disagree.
 */
export function useReturnTo(fallback: Crumb): Crumb;
export function useReturnTo(fallback?: Crumb): Crumb | null;
export function useReturnTo(fallback?: Crumb): Crumb | null {
  const location = useLocation();
  const from = (location.state as FromState | null)?.from;
  // The fallback's own label is authored by the screen and used verbatim; only a
  // label DERIVED from an arrival path needs naming from the section table.
  if (usable(from, address(location))) return { to: from, label: labelFor(from, fallback) };
  return fallback ?? null;
}

/**
 * A path names itself. "Back to processes" reads as the place it goes, which is
 * the whole job of the control — a generic "Back" makes the operator guess.
 */
const SECTION_LABEL: Record<string, string> = {
  forecast: 'forecast',
  cash: 'cash at bank',
  items: 'income & outgoings',
  schedules: 'schedules',
  scenarios: 'scenarios',
  settings: 'settings',
  people: 'people',
  about: 'about',
};

function labelFor(from: string, fallback?: Crumb): string {
  const [path] = from.split('?');
  const section = path.split('/').filter(Boolean)[0] ?? '';
  // An address names its section whether or not it carries an id: coming back from
  // one open process is still going back to Processes, and the section is the word
  // the operator recognises from the sidebar they navigated by.
  return SECTION_LABEL[section] ?? fallback?.label.toLowerCase() ?? 'where you were';
}

export function PageHeader({
  fallback,
  crumbs = [],
  kicker,
  title,
  actions,
  children,
}: {
  /** Where this screen belongs when nothing says where the operator came from. */
  fallback?: Crumb;
  /** Ancestry that is true wherever you arrived from — a check's lot, say. */
  crumbs?: Crumb[];
  /** Record identity beside the ancestry: ROUND 2 OF 3, VERSION 4. */
  kicker?: ReactNode;
  /** `null` where the screen titles itself below — an editable name, say. */
  title: ReactNode;
  /** Buttons for this page, kept on the title's row. */
  actions?: ReactNode;
  /** Status pills and the sentence under the title. */
  children?: ReactNode;
}) {
  const back = useReturnTo(fallback);

  return (
    <header role="banner" className="page-header">
      {(back || crumbs.length > 0 || kicker) && (
        <div className="page-header-trail">
          {back && (
            // The visible text opens with a capital because it starts a line; the
            // accessible name reads as a sentence, so it stays lower. Same words.
            <Link
              className="back-link"
              to={back.to}
              aria-label={`Back to ${back.label.toLowerCase()}`}
            >
              ← {back.label.charAt(0).toUpperCase()}
              {back.label.slice(1)}
            </Link>
          )}
          {crumbs.map((crumb) => (
            <span key={crumb.to} className="kicker-lg">
              <Link
                to={crumb.to}
                className="link-btn kicker-lg"
                style={{ letterSpacing: 'inherit' }}
              >
                {crumb.label}
                {crumb.detail}
              </Link>
            </span>
          ))}
          {kicker && <span className="kicker-lg">{kicker}</span>}
        </div>
      )}
      {(title || children || actions) && (
        <div className="head-row">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            {title && <h1 className="page-title">{title}</h1>}
            {children}
          </div>
          {actions && <div className="page-header-actions">{actions}</div>}
        </div>
      )}
    </header>
  );
}
