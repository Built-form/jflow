import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import type { ForecastItem } from '../../api/forecast';
import { TODAY, line } from './fixtures';
import { MAX_SHIFT_DAYS, checkMove, initialMove, movePayments, runMoves } from './moveContainer';
import type { MoveAction, MoveForm, MoveStep } from './moveContainer';

/** One stock payment of the container: $1,500.00 on `date`, as the scenario read sends it. */
const pay = (id: string, date: string, over: Partial<ForecastItem> = {}): ForecastItem =>
  line({
    key: `ship.${id}`,
    kind: 'ship',
    id,
    name: `Acme Textiles · ${id}`,
    counterparty: 'Acme Textiles',
    currency: 'USD',
    amountMinor: 150000,
    accountMinor: 150000,
    gbpMinor: 111000,
    date,
    settleMode: 'manual',
    baseline: { date, amountMinor: 150000, gbpMinor: 111000, flags: [] },
    splitGroup: null,
    ...over,
  });

const inScenario = { scenario: { id: 9 }, today: TODAY };
const shift = (days: string, skip: string[] = []): MoveForm => ({ ...initialMove(), mode: 'shift', days, skip });
const sameDate = (date: string, skip: string[] = []): MoveForm => ({ ...initialMove(), mode: 'date', date, skip });
const moveTo = (itemKey: string, newDate: string): MoveAction => ({ kind: 'adjustment', itemKey, body: { kind: 'adjust', newDate } });

const first = pay('dep-812', '2026-10-06');
const second = pay('bal-812-s311', '2026-10-13');

describe("a container's payments", () => {
  it('are one per key, in date order, and say which cannot move', () => {
    const paid = pay('pay-3-814', TODAY, { status: 'paid', flags: ['paid'], editable: false });
    const leftOut = pay('bal-815-s311', '2026-10-20', { flags: ['excluded'] });
    const locked = pay('bal-816-s311', '2026-10-27', { editable: false });
    expect(movePayments([second, locked, leftOut, first, paid]).map((p) => [p.key, p.fixed])).toEqual([
      ['ship.pay-3-814', 'Paid'],
      ['ship.dep-812', null],
      ['ship.bal-812-s311', null],
      ['ship.bal-815-s311', 'Left out of this scenario'],
      ['ship.bal-816-s311', 'Cannot be changed'],
    ]);
  });

  it('take the line that can be edited when one key owns two lines', () => {
    const made = pay('bal-812-s311', TODAY, { flags: ['paid', 'partial'], editable: false, paymentId: 5 });
    const rest = pay('bal-812-s311', '2026-10-13', { flags: ['remainder'] });
    const out = movePayments([made, rest]);
    expect(out).toHaveLength(1);
    expect(out[0].item).toBe(rest);
    expect(out[0].fixed).toBeNull();
  });
});

describe('shifting by days', () => {
  it('opens on a shift of 7 days with every payment ticked', () => {
    expect(initialMove()).toEqual({ mode: 'shift', days: '7', date: '', skip: [] });
  });

  it('moves every ticked payment by the same number of days, each from its own date', () => {
    const check = checkMove(movePayments([first, second]), shift('14'), inScenario);
    expect(check.rows.map((r) => r.to)).toEqual(['2026-10-20', '2026-10-27']);
    expect(check.errors).toEqual({});
    expect(check.steps).toEqual([
      { key: 'ship.dep-812', name: 'Acme Textiles · dep-812', action: moveTo('ship.dep-812', '2026-10-20') },
      { key: 'ship.bal-812-s311', name: 'Acme Textiles · bal-812-s311', action: moveTo('ship.bal-812-s311', '2026-10-27') },
    ]);
  });

  it('counts an overdue payment from today, as the +7 button does', () => {
    const overdue = pay('bal-700-s300', TODAY, { dueDate: '2026-09-10', flags: ['overdue'] });
    expect(checkMove(movePayments([overdue]), shift('7'), inScenario).steps?.map((s) => s.action)).toEqual([
      moveTo('ship.bal-700-s300', '2026-10-06'),
    ]);
  });

  it('moves them earlier with a minus number', () => {
    const check = checkMove(movePayments([first, second]), shift('-3'), inScenario);
    expect(check.steps?.map((s) => s.action)).toEqual([moveTo('ship.dep-812', '2026-10-03'), moveTo('ship.bal-812-s311', '2026-10-10')]);
  });

  it('holds the whole move back while a ticked payment would land before today', () => {
    // 6 Oct − 10 days is 26 Sep; today is 29 Sep.
    const check = checkMove(movePayments([first, second]), shift('-10'), inScenario);
    expect(check.rows.map((r) => r.error)).toEqual(['A scenario cannot move a line to before today.', null]);
    expect(check.steps).toBeNull();
    expect(check.errors.form).toBe('A ticked payment cannot make this move. Untick it, or change the move.');
    // Unticked, the rest go.
    expect(checkMove(movePayments([first, second]), shift('-10', [first.key]), inScenario).steps?.map((s) => s.action)).toEqual([
      moveTo('ship.bal-812-s311', '2026-10-03'),
    ]);
  });

  it.each([
    ['', 'Enter a number of days.'],
    ['   ', 'Enter a number of days.'],
    ['0', 'Enter a number of days other than 0.'],
    ['1.5', 'Enter a whole number of days, like 14 or -7.'],
    ['soon', 'Enter a whole number of days, like 14 or -7.'],
    [String(MAX_SHIFT_DAYS + 1), `At most ${MAX_SHIFT_DAYS} days either way.`],
    [String(-MAX_SHIFT_DAYS - 1), `At most ${MAX_SHIFT_DAYS} days either way.`],
  ])('refuses %j days', (days, message) => {
    const check = checkMove(movePayments([first, second]), shift(days), inScenario);
    expect(check.errors.days).toBe(message);
    expect(check.steps).toBeNull();
    expect(check.rows.map((r) => r.to)).toEqual([null, null]);
  });

  it('reads "+14", " 14 " and a typographic minus', () => {
    const to = (days: string) => checkMove(movePayments([first]), shift(days), inScenario).rows[0].to;
    expect(to('+14')).toBe('2026-10-20');
    expect(to(' 14 ')).toBe('2026-10-20');
    expect(to('−3')).toBe('2026-10-03');
    expect(to(String(MAX_SHIFT_DAYS))).not.toBeNull();
  });

  it("removes the adjustment when a payment lands back on the real plan's date", () => {
    const moved = pay('bal-812-s311', '2026-10-20', {
      flags: ['adjusted'],
      baseline: { date: '2026-10-13', amountMinor: 150000, gbpMinor: 111000, flags: [] },
    });
    expect(checkMove(movePayments([moved]), shift('-7'), inScenario).steps?.map((s) => s.action)).toEqual([
      { kind: 'unadjust', itemKey: 'ship.bal-812-s311' },
    ]);
  });

  it('keeps an amount the scenario has already changed', () => {
    const resized = pay('bal-812-s311', '2026-10-13', {
      amountMinor: 120000,
      flags: ['adjusted'],
      baseline: { date: '2026-10-13', amountMinor: 150000, gbpMinor: 111000, flags: [] },
    });
    expect(checkMove(movePayments([resized]), shift('7'), inScenario).steps?.map((s) => s.action)).toEqual([
      { kind: 'adjustment', itemKey: 'ship.bal-812-s311', body: { kind: 'adjust', newDate: '2026-10-20', newAmount: '1200.00' } },
    ]);
  });
});

describe('the same date for all', () => {
  it('puts every ticked payment on that date; one already there is not sent', () => {
    const check = checkMove(movePayments([first, second]), sameDate('2026-10-13'), inScenario);
    expect(check.rows.map((r) => [r.to, r.same])).toEqual([
      ['2026-10-13', false],
      ['2026-10-13', true],
    ]);
    expect(check.steps?.map((s) => s.action)).toEqual([moveTo('ship.dep-812', '2026-10-13')]);
  });

  it('has nothing to send when every ticked payment is already there', () => {
    const check = checkMove(movePayments([second]), sameDate('2026-10-13'), inScenario);
    expect(check.steps).toBeNull();
    expect(check.errors.form).toBe('Every ticked payment is already on that date.');
  });

  it.each([
    ['', 'Pick a date.'],
    ['2026-02-30', 'Pick a date.'],
    ['2026-09-28', 'Today or later.'],
  ])('refuses the date %j', (date, message) => {
    const check = checkMove(movePayments([first, second]), sameDate(date), inScenario);
    expect(check.errors.date).toBe(message);
    expect(check.steps).toBeNull();
    expect(check.rows.map((r) => r.to)).toEqual([null, null]);
  });

  it('takes today', () => {
    expect(checkMove(movePayments([first]), sameDate(TODAY), inScenario).steps?.map((s) => s.action)).toEqual([moveTo('ship.dep-812', TODAY)]);
  });

  it('ignores what was typed for the other way of moving', () => {
    expect(checkMove(movePayments([first]), { mode: 'date', days: 'soon', date: '2026-10-20', skip: [] }, inScenario).errors).toEqual({});
    expect(checkMove(movePayments([first]), { mode: 'shift', days: '7', date: '2026-02-30', skip: [] }, inScenario).errors).toEqual({});
  });
});

describe('leaving payments out of the move', () => {
  it('sends only the ticked ones', () => {
    const check = checkMove(movePayments([first, second]), shift('7', [second.key]), inScenario);
    expect(check.rows.map((r) => r.ticked)).toEqual([true, false]);
    expect(check.steps?.map((s) => s.key)).toEqual(['ship.dep-812']);
  });

  it('needs at least one ticked', () => {
    const check = checkMove(movePayments([first, second]), shift('7', [first.key, second.key]), inScenario);
    expect(check.steps).toBeNull();
    expect(check.errors.form).toBe('Tick at least one payment.');
  });

  it('never sends a payment that cannot move, ticked or not', () => {
    const paid = pay('pay-3-814', TODAY, { status: 'paid', flags: ['paid'], editable: false });
    const leftOut = pay('bal-815-s311', '2026-10-20', { flags: ['excluded'] });
    const check = checkMove(movePayments([first, paid, leftOut]), shift('7'), inScenario);
    expect(check.rows.map((r) => [r.key, r.ticked, r.to])).toEqual([
      ['ship.pay-3-814', false, null],
      ['ship.dep-812', true, '2026-10-13'],
      ['ship.bal-815-s311', false, null],
    ]);
    expect(check.steps?.map((s) => s.key)).toEqual(['ship.dep-812']);
  });

  it('says so when no payment in the container can move', () => {
    const paid = pay('pay-3-814', TODAY, { status: 'paid', flags: ['paid'], editable: false });
    const check = checkMove(movePayments([paid]), shift('7'), inScenario);
    expect(check.steps).toBeNull();
    expect(check.errors.form).toBe('None of these payments can be moved.');
  });
});

describe('sending the moves', () => {
  const steps: MoveStep[] = ['a', 'b', 'c'].map((id) => ({ key: `ship.${id}`, name: id, action: moveTo(`ship.${id}`, '2026-10-20') }));
  const refusal = (status: number, code: string) => new ApiError(status, { error: code, code });

  it('goes one after another, in order, and reports each as it finishes', async () => {
    const log: string[] = [];
    const progress: number[] = [];
    const out = await runMoves(
      steps,
      async (action) => {
        log.push(`start ${action.itemKey}`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        log.push(`end ${action.itemKey}`);
      },
      (sent) => progress.push(sent),
    );
    expect(log).toEqual(['start ship.a', 'end ship.a', 'start ship.b', 'end ship.b', 'start ship.c', 'end ship.c']);
    expect(progress).toEqual([1, 2, 3]);
    expect(out).toEqual({ moved: steps, failed: [], unsent: [] });
  });

  it.each(['TARGET_SETTLED', 'TARGET_MISSING', 'ADJUSTMENT_DATE_IN_PAST'])(
    'carries on past a refusal about the one payment (%s), and says which',
    async (code) => {
      const error = refusal(409, code);
      const out = await runMoves(steps, async (action) => {
        if (action.itemKey === 'ship.b') throw error;
      });
      expect(out.moved).toEqual([steps[0], steps[2]]);
      expect(out.failed).toEqual([{ step: steps[1], error }]);
      expect(out.unsent).toEqual([]);
    },
  );

  it('stops at a refusal that is not about one payment, and sends nothing more', async () => {
    const error = refusal(409, 'SCENARIO_NOT_DRAFT');
    const sent: string[] = [];
    const out = await runMoves(steps, async (action) => {
      sent.push(action.itemKey);
      if (action.itemKey === 'ship.b') throw error;
    });
    expect(sent).toEqual(['ship.a', 'ship.b']);
    expect(out).toEqual({ moved: [steps[0]], failed: [{ step: steps[1], error }], unsent: [steps[2]] });
  });

  it('stops when the server cannot be reached, keeping what went wrong', async () => {
    const out = await runMoves(steps, async () => {
      throw new Error('offline');
    });
    expect(out.moved).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].step).toBe(steps[0]);
    expect(out.failed[0].error).toBeInstanceOf(ApiError);
    expect(out.failed[0].error.message).toContain('offline');
    expect(out.unsent).toEqual([steps[1], steps[2]]);
  });
});
