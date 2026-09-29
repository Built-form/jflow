// Copied from workflows/web/src/app/useQuery.ts — changes: none
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  /** Replace local state from a mutation response — never re-fetch, never patch by hand. */
  set: (next: T) => void;
}

/**
 * Minimal fetch-once-per-dep-change hook. Deliberately small: the API's own rule is to
 * replace local state from each mutation response, so a caching layer would mostly be
 * something to invalidate.
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  /**
   * Which read is the current one. `live` alone only stopped a read whose own effect had
   * been cleaned up — it said nothing about two reads in flight at once, so the SLOWER
   * one wrote last and put stale rows on screen for good. React 18 StrictMode double-
   * invokes every effect on mount, so this is the ordinary path, not a rare race.
   */
  const runId = useRef(0);

  /**
   * The deps, as ONE stable string.
   *
   * `[...deps, tick]` spread the caller's array into React's dep list, which makes the
   * dep COUNT part of the caller's data. A screen whose dep list changes length between
   * renders trips "The final argument passed to useEffect changed size between renders"
   * and React then compares the wrong positions against each other — a re-read that never
   * fires, or one that fires every render. Serializing sidesteps both: one dep, always.
   */
  const depKey = JSON.stringify(deps, (_k, v) => (typeof v === 'bigint' ? String(v) : v));

  useEffect(() => {
    const id = (runId.current += 1);
    /**
     * Only the NEWEST read may write. Two guards, and both are needed:
     *  - `runId.current === id` drops a read that a newer one has already overtaken,
     *    whichever order they happen to land in;
     *  - `live` drops a read whose own effect was cleaned up (a real unmount).
     *
     * The cleanup must NOT bump `runId`: StrictMode runs mount → cleanup → mount, so the
     * first cleanup fires AFTER the second effect has started. Bumping there would retire
     * the run that is still current and leave the screen loading forever.
     */
    let live = true;
    const current = () => live && runId.current === id;
    setLoading(true);
    fnRef
      .current()
      .then((result) => {
        if (!current()) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!current()) return;
        setError(e instanceof ApiError ? e : new ApiError(0, { error: String(e) }));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, set: setData };
}
