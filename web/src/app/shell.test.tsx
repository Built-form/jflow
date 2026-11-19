// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { __setTestTransport } from '../api/client';
import { SessionProvider } from './session';

afterEach(cleanup);

const list = (rows: unknown[]) => ({ data: rows, page: 1, limit: 500, total: rows.length });

beforeEach(() => {
  __setTestTransport(<T,>(method: string, path: string): Promise<T> => {
    const answer = (value: unknown) => Promise.resolve(value as T);
    if (path === '/me') return answer({ email: 'dev@built-form.co.uk', displayName: 'Dev', type: 'standard' });
    if (path === '/meta/enums') return answer({ directions: ['in', 'out'], userTypes: ['standard', 'admin'] });
    if (path === '/users') return answer([{ email: 'dev@built-form.co.uk', type: 'admin', displayName: 'Dev' }]);
    if (method === 'GET') return answer(list([]));
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('the shell', () => {
  it("lists JFlow's screens, in PLAN's order", async () => {
    renderAt('/cash');
    const nav = await screen.findAllByRole('link');
    const labels = nav.map((a) => within(a).queryByText(/./, { selector: '.label' })?.textContent).filter(Boolean);
    expect(labels).toEqual([
      'Forecast',
      'Cash at bank',
      'Income & outgoings',
      'Schedules',
      'Stock payments',
      'Scenarios',
      'Settings',
      'People',
      'About',
    ]);
  });

  it.each([
    ['/items', 'Income & outgoings'],
    ['/schedules', 'Schedules'],
  ])('%s is built (step 9), not a placeholder', async (path, title) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    expect(screen.queryByText('COMING IN STEP 9')).toBeNull();
  });

  it('offers the stock payments search in the sidebar on the Forecast only, under its nav entry (Dev, 2026-11-19)', async () => {
    renderAt('/forecast?ship=PO-812');
    const box = (await screen.findByRole('searchbox', { name: 'Find stock payments' })) as HTMLInputElement;
    expect(box.value).toBe('PO-812');
    // In the sidebar, which never scrolls, right after the Forecast entry.
    const forecast = screen.getByRole('link', { name: /Forecast/ });
    expect(forecast.nextElementSibling?.contains(box)).toBe(true);
    // A link elsewhere sets the search; the box follows it — here the nav's own, which has none.
    fireEvent.click(forecast);
    await waitFor(() => expect(box.value).toBe(''));
    cleanup();
    renderAt('/cash');
    await screen.findByRole('heading', { name: 'Cash at bank' });
    expect(screen.queryByRole('searchbox', { name: 'Find stock payments' })).toBeNull();
  });

  it('carries the company filter from screen to screen', async () => {
    renderAt('/cash?company=2');
    const settings = await screen.findByRole('link', { name: /Settings/ });
    expect(settings.getAttribute('href')).toBe('/settings?company=2');
    expect(screen.getByRole('link', { name: /About/ }).getAttribute('href')).toBe('/about');
  });

  it('lands on Forecast, and says so for an unknown address', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Forecast' })).toBeTruthy();
    cleanup();
    renderAt('/nowhere');
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
});
