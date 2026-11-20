import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { SHIP_PARAM } from './ForecastScreen';

/** Marks a URL change this box made itself, so it is not read back over what is being typed. */
const FROM_FIND = { fromFind: true } as const;

/**
 * The Forecast's stock payments search, in the sidebar (Dev, 2026-11-19): the sidebar never
 * scrolls, so the box stays in reach however far down the grid is. The Shell shows it under
 * "Forecast" while the Forecast is open.
 *
 * The search lives in the URL (`?ship=`), which the Forecast reads. Stock payments' "edit in
 * scenario" links set it the same way. The box keeps its own text, so typing never waits on
 * the router, and takes the URL's value whenever something else changes it.
 */
export function ForecastFind({ autoFocus = false }: { autoFocus?: boolean }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const value = params.get(SHIP_PARAM) ?? '';
  const [text, setText] = useState(value);

  useEffect(() => {
    if ((location.state as typeof FROM_FIND | null)?.fromFind) return;
    setText(value);
    // Only on a new location (a link, the nav, the screen's own controls): read it from there.
  }, [location.key]);

  const change = (next: string) => {
    setText(next);
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next.trim() === '') out.delete(SHIP_PARAM);
        else out.set(SHIP_PARAM, next);
        return out;
      },
      { replace: true, state: FROM_FIND },
    );
  };

  return (
    <div role="search" aria-label="Stock payments on the Forecast" className="sidebar-find">
      <input
        type="search"
        aria-label="Find stock payments"
        placeholder="Find container, supplier, PO"
        // Only when the folded sidebar's search button opened the menu to get here.
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && text !== '') {
            e.preventDefault();
            change('');
          }
        }}
      />
      <div className="hint">Commas find several: 315, 323</div>
    </div>
  );
}
