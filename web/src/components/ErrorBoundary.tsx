// Copied from workflows/web/src/components/ErrorBoundary.tsx — changes: none
// Ported from mobileweb/src/components/ErrorBoundary.tsx — that file said to copy it here
// "if the same blank ever shows". It showed.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * The last line before a blank screen.
 *
 * React 18 unmounts the WHOLE tree on an uncaught render error. Without a boundary that is
 * a white page: no message, no retry, and no way to tell a dead API from a dead app — the
 * "sometimes I click a page and nothing loads" report. One bad row, one unexpected shape
 * from a route that changed, and the entire app goes, not just the screen that threw.
 *
 * Reload, not "try again": a render error is usually a shape the code cannot read, and
 * re-rendering the same state would throw the same way.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render failed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page">
        <div className="page-title">Could not show this screen</div>
        <div className="explainer">
          The app hit a problem drawing this page. Reloading usually fixes it — if it keeps
          happening, quote the line below when you report it.
        </div>
        <div className="mono" style={{ fontSize: 13, color: 'var(--dim)', wordBreak: 'break-word' }}>
          {error.name}: {error.message}
        </div>
        <div>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
