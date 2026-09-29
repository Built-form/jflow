// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { PayBody } from '../api/items';
import { PayDialog, initialPayForm, validatePay } from './PayDialog';
import type { PayTarget } from './PayDialog';

afterEach(cleanup);

const TODAY = '2026-09-29';

function target(over: Partial<PayTarget> = {}): PayTarget {
  return { amount: '100.00', remaining: '100.00', currency: 'GBP', effectiveDate: '2026-09-20', payments: [], ...over };
}

const form = (over: Partial<ReturnType<typeof initialPayForm>> = {}) => ({
  ...initialPayForm(target(), TODAY),
  ...over,
});

describe('validatePay', () => {
  it('opens paid today, for the whole remainder, with the rest due today', () => {
    expect(initialPayForm(target(), TODAY)).toEqual({ paidOn: TODAY, amount: '100.00', note: '', remainderDueDate: TODAY });
    // Confirm paid starts at the due date — but never after today.
    expect(initialPayForm(target(), TODAY, '2026-09-01').paidOn).toBe('2026-09-01');
    expect(initialPayForm(target(), TODAY, '2026-10-01').paidOn).toBe(TODAY);
  });

  it('refuses a pay date in the future', () => {
    const check = validatePay(form({ paidOn: '2026-09-30' }), { target: target(), today: TODAY });
    expect(check.ok).toBe(false);
    expect(check.errors.paidOn).toMatch(/future/);
    expect(validatePay(form({ paidOn: TODAY }), { target: target(), today: TODAY }).ok).toBe(true);
  });

  it.each([
    ['0', /more than zero/],
    ['0.00', /more than zero/],
    ['-5', /negative/],
    ['', /Enter the amount/],
    ['100.01', /At most £100.00/],
    ['12.345', /two decimal places/],
  ])('refuses the amount %s', (amount, message) => {
    const check = validatePay(form({ amount }), { target: target(), today: TODAY });
    expect(check.ok).toBe(false);
    expect(check.errors.amount).toMatch(message);
  });

  it('refuses any amount when nothing remains', () => {
    const check = validatePay(form({ amount: '1' }), { target: target({ remaining: '0.00' }), today: TODAY });
    expect(check.errors.amount).toMatch(/Nothing remains/);
  });

  it('requires the remainder date, pre-filled with today, for a part-payment on something past due', () => {
    const check = validatePay(form({ amount: '40' }), { target: target(), today: TODAY });
    expect(check.partial).toBe(true);
    expect(check.remainderRequired).toBe(true);
    expect(check.body).toEqual({ paidOn: TODAY, paidAmount: '40.00', remainderDueDate: TODAY });

    const past = validatePay(form({ amount: '40', remainderDueDate: '2026-09-28' }), { target: target(), today: TODAY });
    expect(past.ok).toBe(false);
    expect(past.errors.remainderDueDate).toMatch(/Today or later/);

    const blank = validatePay(form({ amount: '40', remainderDueDate: '' }), { target: target(), today: TODAY });
    expect(blank.errors.remainderDueDate).toMatch(/when the rest is due/);
  });

  it('does not ask for a remainder date when the item is not yet due, or the payment is whole', () => {
    const future = validatePay(form({ amount: '40' }), { target: target({ effectiveDate: '2026-10-10' }), today: TODAY });
    expect(future.partial).toBe(true);
    expect(future.remainderRequired).toBe(false);
    expect(future.body).toEqual({ paidOn: TODAY, paidAmount: '40.00' });

    const whole = validatePay(form(), { target: target(), today: TODAY });
    expect(whole.partial).toBe(false);
    expect(whole.body).toEqual({ paidOn: TODAY, paidAmount: '100.00' });
  });

  it("requires it once the server has answered REMAINDER_DATE_REQUIRED, whatever this browser thinks", () => {
    const check = validatePay(form({ amount: '40' }), {
      target: target({ effectiveDate: '2026-10-10' }),
      today: TODAY,
      serverAskedForRemainder: true,
    });
    expect(check.remainderRequired).toBe(true);
    expect(check.body?.remainderDueDate).toBe(TODAY);
  });

  it('compares money in minor units, never through floats', () => {
    // 1.15 × 100 is 114.99999999999999 as a float: a float compare would call this partial.
    const exact = validatePay(form({ amount: '1.15' }), { target: target({ amount: '1.15', remaining: '1.15' }), today: TODAY });
    expect(exact.partial).toBe(false);
    expect(exact.body?.paidAmount).toBe('1.15');
    // 0.30 − 0.10 is 0.19999999999999998 as a float.
    const part = validatePay(form({ amount: '0.1' }), { target: target({ amount: '0.30', remaining: '0.30' }), today: TODAY });
    expect(part.leftMinor).toBe(20n);
    expect(part.body?.paidAmount).toBe('0.10');
    // 4.35 × 100 is 434.99999999999994.
    const over = validatePay(form({ amount: '4.36' }), { target: target({ remaining: '4.35' }), today: TODAY });
    expect(over.errors.amount).toMatch(/At most £4.35/);
    expect(typeof validatePay(form({ amount: '4.35' }), { target: target({ remaining: '4.35' }), today: TODAY }).body?.paidAmount).toBe('string');
  });
});

describe('the pay dialog', () => {
  const confirmButton = () => screen.getByRole('button', { name: /Record/ }) as HTMLButtonElement;

  it('pre-fills the remainder date with today and says why, for a part-payment on something already due', async () => {
    const pay = vi.fn<(body: PayBody) => Promise<void>>().mockResolvedValue(undefined);
    const onPaid = vi.fn();
    render(<PayDialog kicker="K" title="Pay rent" target={target()} today={TODAY} pay={pay} onPaid={onPaid} onClose={() => undefined} />);

    expect(screen.queryByLabelText('Rest due on')).toBeNull();
    fireEvent.change(screen.getByLabelText('Amount paid'), { target: { value: '40' } });
    expect((screen.getByLabelText('Rest due on') as HTMLInputElement).value).toBe(TODAY);
    expect(screen.getByTestId('remainder-why').textContent).toMatch(/already due.*£60.00/);
    expect(confirmButton().textContent).toBe('Record part-payment');

    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(pay).toHaveBeenCalledWith({ paidOn: TODAY, paidAmount: '40.00', remainderDueDate: TODAY });
  });

  it('keeps the confirm disabled for a future pay date and an amount above what remains', () => {
    render(<PayDialog kicker="K" title="Pay" target={target()} today={TODAY} pay={vi.fn()} onPaid={vi.fn()} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Paid on'), { target: { value: '2026-10-01' } });
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/future/);
    fireEvent.change(screen.getByLabelText('Paid on'), { target: { value: TODAY } });
    fireEvent.change(screen.getByLabelText('Amount paid'), { target: { value: '150' } });
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/At most £100.00/);
  });

  it("shows the remainder date when the server answers REMAINDER_DATE_REQUIRED, and sends it on the retry", async () => {
    const sent: PayBody[] = [];
    const pay = vi.fn(async (body: PayBody) => {
      sent.push(body);
      if (sent.length === 1) {
        throw new ApiError(422, {
          error: 'A part payment on something already due must say when the rest is due.',
          code: 'REMAINDER_DATE_REQUIRED',
          details: { dueDate: '2026-09-28', today: TODAY },
        });
      }
    });
    const onPaid = vi.fn();
    // This browser believes it is not yet due; the server knows better.
    render(
      <PayDialog
        kicker="K"
        title="Pay"
        target={target({ effectiveDate: '2026-10-05' })}
        today={TODAY}
        pay={pay}
        onPaid={onPaid}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Amount paid'), { target: { value: '25.50' } });
    expect(screen.queryByLabelText('Rest due on')).toBeNull();
    expect(screen.getByTestId('remainder-stays').textContent).toMatch(/£74.50 stays due/);

    fireEvent.click(confirmButton());
    const field = (await screen.findByLabelText('Rest due on')) as HTMLInputElement;
    expect(field.value).toBe(TODAY);
    expect(screen.getByText(/REMAINDER_DATE_REQUIRED/)).toBeTruthy();
    expect(screen.getByTestId('remainder-why')).toBeTruthy();
    expect(onPaid).not.toHaveBeenCalled();

    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(sent).toEqual([
      { paidOn: TODAY, paidAmount: '25.50' },
      { paidOn: TODAY, paidAmount: '25.50', remainderDueDate: TODAY },
    ]);
  });
});
