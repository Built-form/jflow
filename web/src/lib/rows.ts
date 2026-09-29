/**
 * Replace-from-response, for lists: a mutation answers with the row as the server now
 * holds it, and that row replaces the one on screen — no re-read, no hand-patching of
 * fields. These are the two moves every list screen needs.
 */

import type { ListEnvelope } from '../api/types';
import type { QueryState } from '../app/useQuery';

/**
 * `row` replaces the row with its id, or joins the list when new. `keep` carries fields the
 * mutation response does not have over from the old row (an account's `anchorDate` rides
 * on reads only, CONTRACT §6.3).
 */
export function upsertById<T extends { id: number }>(rows: T[], row: T, keep: (keyof T)[] = []): T[] {
  const index = rows.findIndex((r) => r.id === row.id);
  if (index === -1) return [...rows, row];
  const old = rows[index];
  const next = { ...row };
  for (const key of keep) {
    if (next[key] === undefined) next[key] = old[key];
  }
  return rows.map((r, i) => (i === index ? next : r));
}

export function removeById<T extends { id: number }>(rows: T[], id: number): T[] {
  return rows.filter((r) => r.id !== id);
}

/** Apply `change` to a list query's rows, keeping its envelope (and its total) honest. */
export function updateList<T>(query: QueryState<ListEnvelope<T>>, change: (rows: T[]) => T[]): void {
  if (!query.data) return;
  const rows = change(query.data.data);
  query.set({ ...query.data, data: rows, total: query.data.total + rows.length - query.data.data.length });
}
