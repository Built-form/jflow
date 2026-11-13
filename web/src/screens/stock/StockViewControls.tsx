import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isValidDate } from '../../lib/dates';
import type { AccountFilter, MarkFilter, SortKey, StockFilterOptions, StockFilters, StockSort } from './filters';
import { NO_FILTERS, hasActiveFilters, parseStockParams, writeStockParams } from './filters';

/**
 * The Stock payments view (search, filters, sort) in the URL. The search box keeps its own
 * text so typing never waits on the router; every change is written straight through.
 */
export function useStockView() {
  const [params, setParams] = useSearchParams();
  const parsed = useMemo(() => parseStockParams(params), [params]);
  const [q, setQ] = useState(parsed.filters.q);
  const filters = useMemo<StockFilters>(() => ({ ...parsed.filters, q }), [parsed.filters, q]);
  const sort = parsed.sort;

  const write = useCallback(
    (f: StockFilters, s: StockSort) => setParams((prev) => writeStockParams(prev, f, s), { replace: true }),
    [setParams],
  );
  const setFilter = (patch: Partial<StockFilters>) => {
    if (patch.q !== undefined) setQ(patch.q);
    write({ ...filters, ...patch }, sort);
  };
  const clear = () => {
    setQ('');
    write(NO_FILTERS, sort);
  };
  /** A new column starts ascending (amount: largest first); the same column again reverses. */
  const sortBy = (key: SortKey) =>
    write(
      filters,
      sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'amount' ? 'desc' : 'asc' },
    );
  return { filters, sort, setFilter, clear, sortBy, active: hasActiveFilters(filters) };
}

const FIELD: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--mut)' };

function FilterSelect<T extends string | number>({
  label,
  all,
  value,
  options,
  onChange,
}: {
  label: string;
  all: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (next: string | null) => void;
}) {
  return (
    <select
      aria-label={label}
      className="input"
      data-active={value != null ? '1' : undefined}
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Search box, date range and the four filters. A select is offered only when its rows give
 * it a choice (or it is already set), so a one-currency list shows no currency picker.
 */
export function StockFilterBar({
  filters,
  options,
  shown,
  total,
  active,
  onChange,
  onClear,
}: {
  filters: StockFilters;
  options: StockFilterOptions;
  shown: number;
  total: number;
  active: boolean;
  onChange: (patch: Partial<StockFilters>) => void;
  onClear: () => void;
}) {
  const date = (raw: string) => (raw === '' ? null : isValidDate(raw) ? raw : undefined);
  const offer = <T,>(list: T[], value: unknown) => list.length > 1 || value != null;
  return (
    <div role="search" aria-label="Stock payments" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          className="input"
          aria-label="Search stock payments"
          placeholder="Search supplier, PO, container, note, amount or date"
          value={filters.q}
          onChange={(e) => onChange({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filters.q !== '') {
              e.preventDefault();
              onChange({ q: '' });
            }
          }}
          style={{ flex: '1 1 320px', minWidth: 0, maxWidth: 560 }}
        />
        <label style={FIELD}>
          From
          <input
            type="date"
            className="input mono"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(e) => {
              const next = date(e.target.value);
              if (next !== undefined) onChange({ from: next });
            }}
          />
        </label>
        <label style={FIELD}>
          To
          <input
            type="date"
            className="input mono"
            value={filters.to ?? ''}
            min={filters.from ?? undefined}
            onChange={(e) => {
              const next = date(e.target.value);
              if (next !== undefined) onChange({ to: next });
            }}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {offer(options.kinds, filters.kind) && (
          <FilterSelect label="Kind" all="All kinds" value={filters.kind} options={options.kinds} onChange={(kind) => onChange({ kind })} />
        )}
        {offer(options.currencies, filters.currency) && (
          <FilterSelect
            label="Currency"
            all="All currencies"
            value={filters.currency}
            options={options.currencies}
            onChange={(currency) => onChange({ currency })}
          />
        )}
        {offer(options.accounts, filters.account) && (
          <FilterSelect<number | 'none'>
            label="Account"
            all="All accounts"
            value={filters.account}
            options={options.accounts}
            onChange={(raw) => onChange({ account: (raw === null ? null : raw === 'none' ? 'none' : Number(raw)) as AccountFilter })}
          />
        )}
        {(options.marks.length > 0 || filters.mark != null) && (
          <FilterSelect<MarkFilter>
            label="Mark"
            all="Any mark"
            value={filters.mark}
            options={options.marks}
            onChange={(mark) => onChange({ mark: mark as MarkFilter | null })}
          />
        )}
        {active && (
          <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center', marginLeft: 'auto' }}>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--mut)' }} data-testid="stock-shown">
              {shown} of {total} stock payment{total === 1 ? '' : 's'}
            </span>
            <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={onClear}>
              Clear filters
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

const DIR_WORDS: Record<SortKey, [asc: string, desc: string]> = {
  date: ['earliest first', 'latest first'],
  supplier: ['A to Z', 'Z to A'],
  po: ['lowest first', 'highest first'],
  container: ['A to Z', 'Z to A'],
  account: ['A to Z', 'Z to A'],
  amount: ['smallest first', 'largest first'],
};

/** A table heading that sorts: reads as the heading, darker with an arrow once it sorts. */
export function SortHeading({ k, label, sort, onSort }: { k: SortKey; label: string; sort: StockSort; onSort: (k: SortKey) => void }) {
  const active = sort.key === k;
  const words = DIR_WORDS[k][sort.dir === 'asc' ? 0 : 1];
  return (
    <button
      type="button"
      className="sort-btn"
      data-active={active ? '1' : undefined}
      aria-label={`Sort by ${label.toLowerCase()}${active ? `, ${words}` : ''}`}
      onClick={() => onSort(k)}
    >
      {label}
      <span aria-hidden="true" className="sort-arrow">
        {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  );
}
