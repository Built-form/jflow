// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
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
