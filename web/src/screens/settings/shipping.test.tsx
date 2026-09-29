// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { ExternalStatus } from '../../api/external';
import type { Category, Company } from '../../api/types';
import { SessionProvider } from '../../app/session';
import { CategoriesSection, CategoryDialog } from './CategoriesSection';
import { CompaniesSection, shippingOptions, takenText } from './CompaniesSection';

afterEach(cleanup);

const stamp = '2026-09-29T08:00:00Z';
const list = (rows: unknown[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });

const company = (id: number, code: string, name: string, shippingCompanyId: number | null, rowVersion = 3): Company => ({
  id, code, name, sortOrder: id, shippingCompanyId, rowVersion, createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null,
});

const JFA = company(1, 'JFA', 'JFA', null);
const HW = company(2, 'HW', 'Hangerworld', 12);

const status = (over: Partial<ExternalStatus> = {}): ExternalStatus => ({
  source: 'ship',
  lastAttemptAt: '2026-09-29T12:00:00Z',
  lastSuccessAt: '2026-09-29T12:00:00Z',
  feedToday: '2026-09-29',
  lastError: null,
  itemCount: 14,
  rejectedCount: 0,
  companies: [
    { id: 11, name: 'JFA Medical Ltd' },
    { id: 12, name: 'Hangerworld Ltd' },
  ],
  configured: true,
  updatedAt: '2026-09-29T12:00:00Z',
  ...over,
});

type Call = { method: string; path: string; body: unknown };

function stubApi({
  feed = status(),
  put = (body: { shippingCompanyId: number | null }) => ({ ...JFA, shippingCompanyId: body.shippingCompanyId, rowVersion: 4 }) as unknown,
}: {
  feed?: ExternalStatus | ApiError;
  put?: (body: { shippingCompanyId: number | null }) => unknown;
} = {}) {
  const calls: Call[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    const reply = (v: unknown) => (v instanceof ApiError ? Promise.reject(v) : Promise.resolve(v as T));
    if (method === 'GET' && path.startsWith('/companies')) return reply(list([JFA, HW]));
    if (method === 'GET' && path === '/external/status') return reply(feed);
    if (method === 'PUT' && path.startsWith('/companies/')) return reply(put(body as { shippingCompanyId: number | null }));
    if (method === 'POST' && path === '/external/refresh') return reply({ ran: true, status: status() });
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return calls;
}

const renderCompanies = () =>
  render(
    <MemoryRouter>
      <CompaniesSection />
    </MemoryRouter>,
  );

const picker = (code: string) => screen.getByLabelText(`Shipping company for ${code}`) as HTMLSelectElement;

describe('Settings → Companies: the shipping company picker', () => {
  it("offers the feed's companies from GET /external/status, saying which is already mapped", async () => {
    stubApi();
    renderCompanies();
    await waitFor(() => expect(picker('JFA').options).toHaveLength(3));
    expect([...picker('JFA').options].map((o) => o.textContent)).toEqual(['Not mapped', 'JFA Medical Ltd', 'Hangerworld Ltd · mapped to HW']);
    expect(picker('JFA').value).toBe('');
    expect(picker('HW').value).toBe('12');
    expect([...picker('HW').options].map((o) => o.textContent)).toEqual(['Not mapped', 'JFA Medical Ltd', 'Hangerworld Ltd']);
    expect(screen.getByTestId('feed-note').textContent).toMatch(/as of the last sync, 29 Sep 2026/);
  });

  it('writes PUT /companies/:id {shippingCompanyId} with the row version, and shows the row the server answered', async () => {
    const calls = stubApi();
    renderCompanies();
    await waitFor(() => expect(picker('JFA').options).toHaveLength(3));
    fireEvent.change(picker('JFA'), { target: { value: '11' } });
    await waitFor(() => expect(picker('JFA').value).toBe('11'));
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/companies/1', body: { shippingCompanyId: 11, baseVersion: 3 } },
    ]);
  });

  it('unmaps with null', async () => {
    const calls = stubApi({ put: (body) => ({ ...HW, shippingCompanyId: body.shippingCompanyId, rowVersion: 4 }) });
    renderCompanies();
    await waitFor(() => expect(picker('HW').value).toBe('12'));
    fireEvent.change(picker('HW'), { target: { value: '' } });
    await waitFor(() => expect(picker('HW').value).toBe(''));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/companies/2', body: { shippingCompanyId: null, baseVersion: 3 } });
  });

  it('surfaces 409 SHIPPING_COMPANY_TAKEN, naming the company that holds it, and leaves the mapping as it was', async () => {
    stubApi({
      put: () =>
        new ApiError(409, {
          error: 'Shipping company 12 is already mapped to another company.',
          code: 'SHIPPING_COMPANY_TAKEN',
          details: { companyId: 2 },
        }),
    });
    renderCompanies();
    await waitFor(() => expect(picker('JFA').options).toHaveLength(3));
    fireEvent.change(picker('JFA'), { target: { value: '12' } });
    const error = await screen.findByTestId('shipping-map-error-1');
    expect(error.textContent).toContain('Shipping company 12 is already mapped to another company.');
    expect(error.textContent).toContain('SHIPPING_COMPANY_TAKEN');
    expect(error.textContent).toContain('HW · Hangerworld is already mapped to that shipping company. Unmap it there first.');
    expect(picker('JFA').value).toBe('');
  });

  it('notes a feed that has never synced, and refreshes it from here', async () => {
    const calls = stubApi({ feed: status({ lastSuccessAt: null, companies: [] }) });
    renderCompanies();
    const note = await screen.findByTestId('feed-note');
    expect(note.textContent).toContain('The shipping feed has never synced, so there are no shipping companies to pick from yet.');
    expect([...picker('JFA').options].map((o) => o.textContent)).toEqual(['Not mapped']);
    // HW's mapping survives a feed that does not list it.
    expect([...picker('HW').options].map((o) => o.textContent)).toEqual(['Not mapped', 'Shipping company #12 (not in the feed)']);
    fireEvent.click(within(note).getByRole('button', { name: 'Refresh the feed' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/external/status')).toHaveLength(2));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/external/refresh')).toBe(true);
  });

  it('says an unconfigured feed is not set up, with nothing to refresh', async () => {
    stubApi({ feed: status({ lastSuccessAt: null, companies: [], configured: false }) });
    renderCompanies();
    const note = await screen.findByTestId('feed-note');
    expect(note.textContent).toContain('not set up for this environment');
    expect(within(note).queryByRole('button')).toBeNull();
  });

  it('still lets a mapping be cleared when the status read fails', async () => {
    stubApi({ feed: new ApiError(500, { error: 'Status unavailable.' }) });
    renderCompanies();
    expect((await screen.findByRole('alert')).textContent).toContain('Status unavailable.');
    expect([...picker('HW').options].map((o) => o.textContent)).toEqual(['Not mapped', 'Shipping company #12 (not in the feed)']);
  });

  it('shippingOptions and takenText are plain helpers', () => {
    expect(shippingOptions(JFA, [JFA, HW, { ...company(3, 'OLD', 'Old', 11), deletedAt: stamp }], status().companies)).toEqual([
      { id: 11, label: 'JFA Medical Ltd' },
      { id: 12, label: 'Hangerworld Ltd · mapped to HW' },
    ]);
    expect(takenText(new ApiError(409, { error: 'x', code: 'STALE_WRITE' }), [JFA, HW])).toBeNull();
    expect(takenText(new ApiError(409, { error: 'x', code: 'SHIPPING_COMPANY_TAKEN', details: { companyId: 99 } }), [JFA, HW])).toBe(
      'Another company is already mapped to that shipping company. Unmap it there first.',
    );
  });
});

describe('Settings → Categories: the system category', () => {
  const category = (id: number, name: string, direction: 'in' | 'out', systemKey: string | null): Category => ({
    id, name, direction, sortOrder: id, systemKey, rowVersion: 0, createdBy: null, createdAt: stamp, updatedAt: stamp, deletedAt: null,
  });
  const stock = category(90, 'Stock payments', 'out', 'ship');
  const rent = category(2, 'Rent', 'out', null);

  it('is marked SYSTEM and offers no remove', async () => {
    __setTestTransport(<T,>(method: string, path: string): Promise<T> =>
      method === 'GET' && path.startsWith('/categories') ? Promise.resolve(list([rent, stock]) as T) : Promise.reject(new Error(path)),
    );
    render(<CategoriesSection />);
    const row = await screen.findByTestId('category-90');
    expect(row.textContent).toContain('SYSTEM');
    expect(row.textContent).toContain('Stock payments from the shipping feed land here.');
    expect(within(row).queryByRole('button', { name: 'remove' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'edit' })).toBeTruthy();
    expect(within(screen.getByTestId('category-2')).getByRole('button', { name: 'remove' })).toBeTruthy();
  });

  it('keeps its direction fixed in the edit dialog; the name still edits', async () => {
    const sent: Call[] = [];
    __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
      if (path === '/me') return Promise.resolve({ email: 'dev@built-form.co.uk', type: 'standard' } as T);
      if (path === '/meta/enums') return Promise.resolve({ directions: ['in', 'out'] } as T);
      if (path === '/users') return Promise.resolve([] as T);
      sent.push({ method, path, body });
      return Promise.resolve({ ...stock, ...(body as object) } as T);
    });
    render(
      <SessionProvider>
        <CategoryDialog category={stock} onClose={() => undefined} onSaved={() => undefined} />
      </SessionProvider>,
    );
    const moneyIn = screen.getByRole('button', { name: 'Money in' }) as HTMLButtonElement;
    expect(moneyIn.disabled).toBe(true);
    expect(screen.getByText('Fixed: this is a system category.')).toBeTruthy();
    fireEvent.click(moneyIn);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Supplier payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: 'PUT', path: '/categories/90', body: { name: 'Supplier payments', baseVersion: 0 } });
  });
});
