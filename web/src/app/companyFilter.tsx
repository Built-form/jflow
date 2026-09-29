import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Company } from '../api/types';

/**
 * The company filter lives in the URL (PLAN "State"): `?company=<id>`, absent for every
 * company. A filtered screen is therefore a link someone can send, a refresh keeps it,
 * and the sidebar carries it from screen to screen. No state library holds it.
 */
export const COMPANY_PARAM = 'company';

/** `?company=` as an id; null for "every company" (absent, `all`, or not a positive id). */
export function parseCompanyParam(raw: string | null): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/** The filter and its setter. Setting it keeps every other query parameter as it was. */
export function useCompanyFilter(): [number | null, (next: number | null) => void] {
  const [params, setParams] = useSearchParams();
  const companyId = parseCompanyParam(params.get(COMPANY_PARAM));
  const setCompanyId = useCallback(
    (next: number | null) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === null) out.delete(COMPANY_PARAM);
          else out.set(COMPANY_PARAM, String(next));
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [companyId, setCompanyId];
}

/** Companies in the server's order: `sort_order`, then name (CONTRACT D28). */
export function sortCompanies(list: Company[]): Company[] {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function CompanyPicker({
  companies,
  value,
  onChange,
}: {
  companies: Company[];
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--mut)' }}>
      <span className="kicker">COMPANY</span>
      <select
        aria-label="Company"
        className="input"
        value={value === null ? 'all' : String(value)}
        onChange={(e) => onChange(e.target.value === 'all' ? null : parseCompanyParam(e.target.value))}
      >
        <option value="all">All companies</option>
        {sortCompanies(companies).map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.code} · {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
