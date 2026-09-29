// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setTestTransport } from '../../api/client';
import { CompanyDialog } from './CompaniesSection';
import { FxRateDialog } from './FxRatesSection';

afterEach(cleanup);

const confirm = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('the FX rate dialog', () => {
  it('refuses GBP — the base currency is always 1 and never entered (D3)', () => {
    render(<FxRateDialog rate={null} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'gbp' } });
    fireEvent.change(screen.getByLabelText('Rate to GBP'), { target: { value: '1' } });
    expect(screen.getByText(/GBP is the base currency/)).toBeTruthy();
    expect(confirm('Add it').disabled).toBe(true);
  });

  it('sends a valid rate at six decimals', async () => {
    const sent: unknown[] = [];
    __setTestTransport(<T,>(method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      return Promise.resolve({ id: 1, ...(body as object), note: null, rowVersion: 0 } as T);
    });
    const onSaved = vi.fn();
    render(<FxRateDialog rate={null} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'eur' } });
    fireEvent.change(screen.getByLabelText('Rate to GBP'), { target: { value: '0.85' } });
    fireEvent.change(screen.getByLabelText('Applies from'), { target: { value: '2026-09-01' } });
    expect(confirm('Add it').disabled).toBe(false);
    fireEvent.click(confirm('Add it'));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toEqual([
      { method: 'POST', path: '/fx-rates', body: { currency: 'EUR', rateToGbp: '0.850000', effectiveFrom: '2026-09-01' } },
    ]);
  });
});

describe('the company dialog', () => {
  it('stays disabled until the code and name are valid, and names the problem once typed', () => {
    render(<CompanyDialog company={null} onClose={() => undefined} onSaved={() => undefined} />);
    expect(confirm('Add it').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'j-fa' } });
    expect(screen.getByRole('alert').textContent).toMatch(/Letters, digits and _/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'jfa' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'JFA Ltd' } });
    expect(confirm('Add it').disabled).toBe(false);
  });

  it('on edit, sends only what changed, with the row version it read', async () => {
    const sent: unknown[] = [];
    __setTestTransport(<T,>(method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      return Promise.resolve({} as T);
    });
    const company = {
      id: 7, code: 'HW', name: 'Hangerworld', sortOrder: 2, rowVersion: 4, createdBy: null,
      createdAt: '', updatedAt: '', deletedAt: null,
    };
    const onSaved = vi.fn();
    render(<CompanyDialog company={company} onClose={() => undefined} onSaved={onSaved} />);
    expect(confirm('Save').disabled).toBe(true); // nothing changed yet
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hangerworld Ltd' } });
    fireEvent.click(confirm('Save'));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toEqual([{ method: 'PUT', path: '/companies/7', body: { name: 'Hangerworld Ltd', baseVersion: 4 } }]);
  });
});
