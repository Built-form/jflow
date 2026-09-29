// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, __setTestTransport } from '../../api/client';
import { account, category, schedule } from '../items/testFixtures';
import { EndWizard, SplitWizard } from './SplitWizard';

afterEach(cleanup);

const TODAY = '2026-09-29';
const DATES = ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30'];
const s = schedule(7, { startDate: '2026-01-31' });

const refusal = (code: string, details: Record<string, unknown>) =>
  new ApiError(409, { error: `Refused: ${code}`, code, details });

const successResult = {
  ended: schedule(7, { status: 'ended', endDate: '2026-09-29' }),
  successor: schedule(8, { predecessorId: 7, activeFrom: '2026-09-30', amount: '1050.00' }),
  deletedOverrides: ['2026-10-31'],
  rekeyedAdjustments: [],
  droppedAdjustments: [{ scenarioId: 3, itemKey: 'sched.7.2026-11-30' }],
};

/** POSTs answer from `replies` in order; each is a value or a thrown refusal. */
function stubSequence(replies: unknown[]) {
  const sent: { path: string; body: unknown }[] = [];
  __setTestTransport(<T,>(method: string, path: string, body?: unknown): Promise<T> => {
    sent.push({ path, body });
    const reply = replies[sent.length - 1];
    if (reply === undefined) return Promise.reject(new Error(`unexpected ${method} ${path}`));
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply as T);
  });
  return sent;
}

function renderSplit(onDone = vi.fn()) {
  render(
    <SplitWizard
      schedule={s}
      naturalDates={DATES}
      today={TODAY}
      accounts={[account(1, 'Barclays')]}
      categories={[category(2, 'Suppliers', 'out')]}
      onDone={onDone}
      onClose={() => undefined}
    />,
  );
  return onDone;
}

const confirm = () => screen.getByRole('dialog').querySelector('.btn-primary') as HTMLButtonElement;

describe('the split wizard', () => {
  it('offers only natural dates after the first active one, starting at the next one', () => {
    stubSequence([]);
    renderSplit();
    const select = screen.getByLabelText('Split from') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(DATES);
    expect(select.value).toBe('2026-09-30');
    // Nothing changed yet: a split with nothing different is refused before the click.
    expect(confirm().disabled).toBe(true);
  });

  it('turns SCHEDULE_HAS_OVERRIDES, then SCHEDULE_HAS_ADJUSTMENTS, into confirmations and resends with both flags', async () => {
    const sent = stubSequence([
      refusal('SCHEDULE_HAS_OVERRIDES', { naturalDates: ['2026-10-31'] }),
      refusal('SCHEDULE_HAS_ADJUSTMENTS', {
        adjustments: [{ scenarioId: 3, scenarioName: 'Hire in November', itemKey: 'sched.7.2026-11-30', naturalDate: '2026-11-30' }],
      }),
      successResult,
    ]);
    const onDone = renderSplit();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1050' } });
    expect(screen.getByTestId('split-summary').textContent).toMatch(/amount £1,000.00 → £1,050.00/);
    expect(confirm().textContent).toBe('Split');
    fireEvent.click(confirm());

    const overrides = await screen.findByTestId('conflict');
    expect(overrides.getAttribute('data-kind')).toBe('overrides');
    expect(within(overrides).getByTestId('conflict-dates').textContent).toContain('Sat 31 Oct 2026');
    expect(confirm().textContent).toBe('Drop the tuned instance and split');
    fireEvent.click(confirm());

    await vi.waitFor(() => expect(screen.getByTestId('conflict').getAttribute('data-kind')).toBe('adjustments'));
    expect(screen.getByTestId('conflict-adjustments').textContent).toMatch(/Hire in November — Mon 30 Nov 2026/);
    expect(confirm().textContent).toBe('Drop the scenario adjustment and split');
    fireEvent.click(confirm());

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(successResult));
    const base = { fromNaturalDate: '2026-09-30', changes: { amount: '1050.00' }, baseVersion: 5 };
    expect(sent).toEqual([
      { path: '/schedules/7/split', body: base },
      { path: '/schedules/7/split', body: { ...base, dropOverrides: true } },
      { path: '/schedules/7/split', body: { ...base, dropOverrides: true, dropAdjustments: true } },
    ]);
  });

  it('turns SCHEDULE_HAS_PAYMENTS into a refusal listing the dates, with nothing to resend', async () => {
    const sent = stubSequence([refusal('SCHEDULE_HAS_PAYMENTS', { naturalDates: ['2026-10-31', '2026-11-30'] })]);
    renderSplit();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1050' } });
    fireEvent.click(confirm());

    const panel = await screen.findByTestId('conflict');
    expect(panel.getAttribute('data-kind')).toBe('payments');
    expect(panel.textContent).toMatch(/payments recorded.*Unpay them first, or pick a later date/);
    expect(within(panel).getByTestId('conflict-dates').textContent).toBe('Sat 31 Oct 2026Mon 30 Nov 2026');
    expect(confirm().disabled).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('forgets a confirmation once the request changes', async () => {
    const sent = stubSequence([refusal('SCHEDULE_HAS_OVERRIDES', { naturalDates: ['2026-10-31'] }), successResult]);
    renderSplit();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1050' } });
    fireEvent.click(confirm());
    await screen.findByTestId('conflict');
    fireEvent.change(screen.getByLabelText('Split from'), { target: { value: '2026-11-30' } });
    expect(screen.queryByTestId('conflict')).toBeNull();
    fireEvent.click(confirm());
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].body).toEqual({ fromNaturalDate: '2026-11-30', changes: { amount: '1050.00' }, baseVersion: 5 });
  });

  it('carries structural changes over from the edit dialog', () => {
    stubSequence([]);
    render(
      <SplitWizard
        schedule={s}
        naturalDates={DATES}
        today={TODAY}
        accounts={[account(1, 'Barclays')]}
        categories={[category(2, 'Suppliers', 'out')]}
        initialChanges={{ amount: '1050.00', frequency: 'quarterly' }}
        onDone={vi.fn()}
        onClose={() => undefined}
      />,
    );
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('1050.00');
    expect(screen.getByTestId('split-summary').textContent).toMatch(/amount .* → £1,050.00; frequency every month → every quarter/);
    expect(confirm().disabled).toBe(false);
  });
});

describe('the end wizard', () => {
  it('ends after the chosen instance, confirming adjustments with dropAdjustments', async () => {
    const ended = { ended: schedule(7, { status: 'ended', endDate: '2026-10-30' }), deletedOverrides: [], droppedAdjustments: [] };
    const sent = stubSequence([
      refusal('SCHEDULE_HAS_ADJUSTMENTS', {
        adjustments: [{ scenarioId: 4, scenarioName: 'Move out', itemKey: 'sched.7.2026-11-30', naturalDate: '2026-11-30' }],
      }),
      ended,
    ]);
    const onDone = vi.fn();
    render(<EndWizard schedule={s} naturalDates={DATES} today={TODAY} onDone={onDone} onClose={() => undefined} />);
    // Defaults to the latest instance on or before today.
    expect((screen.getByLabelText('Last instance') as HTMLSelectElement).value).toBe('2026-08-31');
    fireEvent.change(screen.getByLabelText('Last instance'), { target: { value: '2026-10-31' } });
    fireEvent.click(confirm());
    const panel = await screen.findByTestId('conflict');
    expect(panel.textContent).toMatch(/Move out — Mon 30 Nov 2026/);
    expect(confirm().textContent).toBe('Drop the scenario adjustment and end');
    fireEvent.click(confirm());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(ended));
    expect(sent.map((c) => c.body)).toEqual([
      { lastNaturalDate: '2026-10-31', baseVersion: 5 },
      { lastNaturalDate: '2026-10-31', dropAdjustments: true, baseVersion: 5 },
    ]);
  });
});
