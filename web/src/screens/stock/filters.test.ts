import { describe, expect, it } from 'vitest';
import type { ExternalItem } from '../../api/external';
import { externalRow } from '../forecast/fixtures';
import type { StockFilters, StockSort } from './filters';
import {
  DEFAULT_SORT,
  NO_FILTERS,
  applyStockFilters,
  filterOptions,
  hasActiveFilters,
  parseStockParams,
  sortStockRows,
  totalsByCurrency,
  writeStockParams,
} from './filters';

const NAMES = new Map([
  [1, 'Barclays USD'],
  [2, 'HSBC GBP'],
]);
const accountName = (id: number | null) => (id == null ? null : (NAMES.get(id) ?? `Account ${id}`));

// 31: Acme Textiles · PO-812 · balance, MSCU1234567, $1,500.00 on Tue 13 Oct 2026, Barclays USD, blocked (artwork).
const acme = externalRow();
const deposit = externalRow({
  id: 32, key: 'ship.dep-900', extId: 'dep-900', feedKind: 'deposit', supplier: 'Ningbo Brightway', poNumber: 'PO-900',
  shipmentId: null, containerRef: null, currency: 'GBP', amount: '250.50', effectiveAmount: '250.50', dueDate: '2026-09-20',
  effectiveDate: '2026-09-20', accountId: 2, blocked: null, dateBasis: 'estimated', derivedStatus: 'overdue',
});
const freight = externalRow({
  id: 33, key: 'ship.x-33', extId: 'x-33', feedKind: 'extra', supplier: 'Fast Forwarders', poNumber: null, poId: null,
  containerRef: 'TGHU7654321', label: 'Freight', amount: '12000.00', effectiveAmount: '12000.00', dueDate: null,
  effectiveDate: null, dateBasis: 'undated', accountId: null, blocked: null, derivedStatus: null,
});
const planned = externalRow({
  id: 34, key: 'ship.bal-1000-s5', extId: 'bal-1000-s5', supplier: 'acme textiles', poNumber: 'PO-1000', poId: 1000,
  dueDate: '2026-11-01', plannedDate: '2026-11-08', effectiveDate: '2026-11-08', plannedNote: 'Factory holiday',
  amount: '900.00', effectiveAmount: '900.00', blocked: null, flags: ['due_set'],
  dueSet: { by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-10-30', scope: 'item', note: 'agreed with the supplier' },
});
const paid = externalRow({
  id: 35, key: 'ship.pay-3-77', extId: 'pay-3-77', supplier: 'Zhejiang Homeware', poNumber: 'PO-77', poId: 77,
  containerRef: null, feedStatus: 'paid', paidOn: '2026-09-25', dueDate: null, effectiveDate: '2026-09-25',
  amount: '300.00', effectiveAmount: '300.00', blocked: null, derivedStatus: 'paid',
});
const ROWS = [acme, deposit, freight, planned, paid];

const ids = (rows: ExternalItem[]) => rows.map((r) => r.id);
const only = (f: Partial<StockFilters>) => ids(applyStockFilters(ROWS, { ...NO_FILTERS, ...f }, accountName));
const sorted = (sort: StockSort) => ids(sortStockRows(ROWS, sort, accountName));

describe('searching stock payments', () => {
  it('needs every word to match, in any field, any case', () => {
    expect(only({ q: 'acme' })).toEqual([31, 34]);
    expect(only({ q: 'ACME 1000' })).toEqual([34]);
    expect(only({ q: 'acme nothing-like-this' })).toEqual([]);
  });

  it('finds a supplier, a PO, a container and what the row is', () => {
    expect(only({ q: 'ningbo' })).toEqual([32]);
    expect(only({ q: 'po-900' })).toEqual([32]);
    expect(only({ q: 'tghu765' })).toEqual([33]);
    expect(only({ q: 'mscu1234567' })).toEqual([31, 34]);
    expect(only({ q: 'freight' })).toEqual([33]);
    expect(only({ q: 'deposit' })).toEqual([32]);
  });

  it('finds the account, JFlow’s note and shipping’s note', () => {
    expect(only({ q: 'hsbc' })).toEqual([32]);
    expect(only({ q: 'factory holiday' })).toEqual([34]);
    expect(only({ q: 'agreed with' })).toEqual([34]);
  });

  it('finds an amount as stored or as shown', () => {
    expect(only({ q: '1500' })).toEqual([31]);
    expect(only({ q: '1,500' })).toEqual([31]);
    expect(only({ q: '$12,000.00' })).toEqual([33]);
    expect(only({ q: '250.5' })).toEqual([32]);
  });

  it('finds a date as stored or as shown, the paid date for a paid row', () => {
    expect(only({ q: '2026-10-13' })).toEqual([31]);
    expect(only({ q: 'sep 2026' })).toEqual([32, 35]);
    // A planned row is found by shipping's own date too (its shown date is 2026-11-08).
    expect(only({ q: '2026-11-01' })).toEqual([34]);
    expect(only({ q: 'sun 1 nov' })).toEqual([34]);
  });

  it('a blank search keeps every row', () => {
    expect(only({ q: '   ' })).toEqual([31, 32, 33, 34, 35]);
    expect(hasActiveFilters({ ...NO_FILTERS, q: '  ' })).toBe(false);
  });
});

describe('filtering stock payments', () => {
  it('bounds the shown date, both ends inclusive, and drops undated rows once a bound is set', () => {
    expect(only({ from: '2026-09-25', to: '2026-10-13' })).toEqual([31, 35]);
    expect(only({ from: '2026-11-01' })).toEqual([34]);
    expect(only({ to: '2026-09-20' })).toEqual([32]);
  });

  it('keeps one kind, currency, account or mark', () => {
    expect(only({ kind: 'extra' })).toEqual([33]);
    expect(only({ currency: 'GBP' })).toEqual([32]);
    expect(only({ account: 2 })).toEqual([32]);
    expect(only({ account: 'none' })).toEqual([33]);
    expect(only({ mark: 'planned' })).toEqual([34]);
    expect(only({ mark: 'due_set' })).toEqual([34]);
    expect(only({ mark: 'estimated' })).toEqual([32]);
    expect(only({ mark: 'blocked' })).toEqual([31]);
  });

  it('combines every filter with the search', () => {
    expect(only({ q: 'acme', currency: 'USD', mark: 'blocked' })).toEqual([31]);
    expect(only({ q: 'acme', kind: 'deposit' })).toEqual([]);
    expect(hasActiveFilters({ ...NO_FILTERS, account: 'none' })).toBe(true);
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
  });

  it('offers only the options the rows have', () => {
    const options = filterOptions(ROWS, accountName);
    expect(options.kinds).toEqual([
      { value: 'deposit', label: 'Deposits' },
      { value: 'balance', label: 'Balances' },
      { value: 'extra', label: 'Extras' },
    ]);
    expect(options.currencies).toEqual([
      { value: 'GBP', label: 'GBP' },
      { value: 'USD', label: 'USD' },
    ]);
    expect(options.accounts).toEqual([
      { value: 1, label: 'Barclays USD' },
      { value: 2, label: 'HSBC GBP' },
      { value: 'none', label: 'No account' },
    ]);
    expect(options.marks.map((m) => m.value)).toEqual(['planned', 'due_set', 'blocked', 'estimated']);
  });
});

describe('sorting stock payments', () => {
  it('defaults to the shown date, oldest first, undated last — the server’s order', () => {
    expect(sorted(DEFAULT_SORT)).toEqual([32, 35, 31, 34, 33]);
    expect(sorted({ key: 'date', dir: 'desc' })).toEqual([34, 31, 35, 32, 33]);
  });

  it('sorts amounts by face value, with no exchange rate', () => {
    expect(sorted({ key: 'amount', dir: 'desc' })).toEqual([33, 31, 34, 35, 32]);
    expect(sorted({ key: 'amount', dir: 'asc' })).toEqual([32, 35, 34, 31, 33]);
  });

  it('sorts suppliers without case, ties by date', () => {
    expect(sorted({ key: 'supplier', dir: 'asc' })).toEqual([31, 34, 33, 32, 35]);
  });

  it('sorts PO numbers as numbers, and a row with none last either way', () => {
    expect(sorted({ key: 'po', dir: 'asc' })).toEqual([35, 31, 32, 34, 33]);
    expect(sorted({ key: 'po', dir: 'desc' })).toEqual([34, 32, 31, 35, 33]);
  });

  it('sorts containers and accounts, rows with none last', () => {
    expect(sorted({ key: 'container', dir: 'asc' })).toEqual([31, 34, 33, 32, 35]);
    expect(sorted({ key: 'account', dir: 'asc' })).toEqual([35, 31, 34, 32, 33]);
    expect(sorted({ key: 'account', dir: 'desc' })).toEqual([32, 35, 31, 34, 33]);
  });

  it('leaves the rows it was given alone', () => {
    const rows = [...ROWS];
    sortStockRows(rows, { key: 'amount', dir: 'desc' }, accountName);
    expect(ids(rows)).toEqual([31, 32, 33, 34, 35]);
  });
});

describe('totals by currency', () => {
  it('adds what each row shows, per currency, in minor units', () => {
    expect(totalsByCurrency(ROWS)).toEqual([
      { currency: 'GBP', minor: 25050n },
      { currency: 'USD', minor: 1470000n },
    ]);
  });

  it('counts a plan’s amount, not shipping’s', () => {
    const plan = externalRow({ amount: '1500.00', plannedAmount: '1000.00', effectiveAmount: '1000.00' });
    expect(totalsByCurrency([plan])).toEqual([{ currency: 'USD', minor: 100000n }]);
  });
});

describe('the view in the URL', () => {
  it('reads every filter and the sort, and ignores what is not valid', () => {
    expect(
      parseStockParams(new URLSearchParams('q=acme&from=2026-10-01&to=bad&kind=extra&ccy=usd&account=none&mark=planned&sort=-amount')),
    ).toEqual({
      filters: { q: 'acme', from: '2026-10-01', to: null, kind: 'extra', currency: 'USD', account: 'none', mark: 'planned' },
      sort: { key: 'amount', dir: 'desc' },
    });
    expect(parseStockParams(new URLSearchParams('account=0&mark=shiny&sort=colour&ccy=dollars'))).toEqual({
      filters: NO_FILTERS,
      sort: DEFAULT_SORT,
    });
    expect(parseStockParams(new URLSearchParams('account=7&sort=po')).filters.account).toBe(7);
  });

  it('writes only what differs from the default, and keeps every other parameter', () => {
    const prev = new URLSearchParams('company=3&show=overdue&q=old&sort=-amount');
    expect(writeStockParams(prev, NO_FILTERS, DEFAULT_SORT).toString()).toBe('company=3&show=overdue');
    const next = writeStockParams(prev, { ...NO_FILTERS, q: 'po-900', account: 2, from: '2026-10-01' }, { key: 'supplier', dir: 'asc' });
    expect(Object.fromEntries(next)).toEqual({ company: '3', show: 'overdue', q: 'po-900', account: '2', from: '2026-10-01', sort: 'supplier' });
    expect(prev.toString()).toBe('company=3&show=overdue&q=old&sort=-amount');
  });
});
