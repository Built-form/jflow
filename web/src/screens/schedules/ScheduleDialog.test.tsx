// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import type { Schedule } from '../../api/schedules';
import { account, category, schedule } from '../items/testFixtures';
import { ScheduleDialog } from './ScheduleDialog';

afterEach(cleanup);

function renderEdit(s: Schedule, onSplit = vi.fn(), onSaved = vi.fn()) {
  render(
    <ScheduleDialog
      schedule={s}
      accounts={[account(1, 'Barclays')]}
      categories={[category(2, 'Suppliers', 'out'), category(3, 'Premises', 'out')]}
      today="2026-09-29"
      defaultAccount={null}
      onSaved={onSaved}
      onSplit={onSplit}
      onClose={() => undefined}
    />,
  );
  return { onSplit, onSaved };
}

const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('editing a schedule whose structure is locked', () => {
  it('says so before the click and offers "Split from…" carrying the change', () => {
    const { onSplit } = renderEdit(schedule(7, { structureLocked: true }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1050' } });
    const lock = screen.getByTestId('structure-lock');
    expect(lock.textContent).toMatch(/^The amount cannot change in place: this schedule is already in use/);
    expect(save().disabled).toBe(true);
    fireEvent.click(within(lock).getByRole('button', { name: 'Split from…' }));
    expect(onSplit).toHaveBeenCalledWith({ amount: '1050.00' });
  });

  it('still edits descriptive fields in place, sending only those', async () => {
    const sent: unknown[] = [];
    __setTestTransport(<T,>(method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      return Promise.resolve(schedule(7, { name: 'Office rent' }) as T);
    });
    const { onSaved } = renderEdit(schedule(7, { structureLocked: true }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Office rent' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '3' } });
    expect(screen.queryByTestId('structure-lock')).toBeNull();
    fireEvent.click(save());
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toEqual([
      { method: 'PUT', path: '/schedules/7', body: { name: 'Office rent', categoryId: 3, baseVersion: 5 } },
    ]);
  });

  it("shows the server's SCHEDULE_STRUCTURE_LOCKED with its reason and the same call to action", async () => {
    __setTestTransport(() =>
      Promise.reject(
        new ApiError(409, {
          error: 'This schedule has been used; split it instead.',
          code: 'SCHEDULE_STRUCTURE_LOCKED',
          details: { fields: ['frequency'], reason: 'has_overrides', split: '/schedules/7/split' },
        }),
      ),
    );
    // The flag said unlocked (read before someone tuned an instance); the server knows better.
    const { onSplit } = renderEdit(schedule(7, { structureLocked: false, startDate: '2026-12-01' }));
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'quarterly' } });
    expect(screen.queryByTestId('structure-lock')).toBeNull();
    fireEvent.click(save());
    const lock = await screen.findByTestId('structure-lock');
    expect(lock.textContent).toMatch(/^The frequency cannot change in place: some of its instances have been tuned or paid\./);
    expect(save().disabled).toBe(true);
    fireEvent.click(within(lock).getByRole('button', { name: 'Split from…' }));
    expect(onSplit).toHaveBeenCalledWith({ frequency: 'quarterly' });
  });
});
