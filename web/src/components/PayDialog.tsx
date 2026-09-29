import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../api/client';
import type { PayBody, Payment } from '../api/items';
import type { Decimal, IsoDate } from '../api/types';
import { useSubmit } from '../app/useSubmit';
import { Dialog, DialogBody } from './Dialog';
import { FormField, inputStyle } from './FormField';
import { ErrorNote } from './ui';
import { formatDay, isValidDate } from '../lib/dates';
import { formatDecimal, formatMoney, parseMinor, parseMoneyInput } from '../lib/money';

/**
 * Pay or part-pay one item or one schedule instance — the same dialog for both, because the
 * API's pay body and refusals are the same (CONTRACT §6.7, §6.9, §10.3–10.4).
 *
 * What it checks before the click mirrors the server's refusals, so they are visible while
 * the form is open: the pay date is today or earlier (`PAID_ON_IN_FUTURE`), the amount is
 * above zero and no more than what remains (`PAID_AMOUNT_INVALID`), and a part-payment on
 * something already due says when the rest is due (`REMAINDER_DATE_REQUIRED`). The server
 * still decides; when it answers `REMAINDER_DATE_REQUIRED` anyway (its today differs from
 * this browser's, or the row moved), the remainder date appears and is required.
 *
 * Money never passes through a float: the typed amount is parsed to bigint minor units
 * and sent as the DECIMAL string it round-trips to.
 */

/** What is being paid, as the server last described it. */
export interface PayTarget {
  /** The effective amount (DECIMAL string). */
  amount: Decimal;
  /** What is left to pay: `amount − paidAmount`, as the server holds it. */
  remaining: Decimal;
  currency: string;
  /** The effective due date — for an instance, the tuned date when there is one. */
  effectiveDate: IsoDate;
  payments: Payment[];
}

export interface PayForm {
  paidOn: string;
  amount: string;
  note: string;
  remainderDueDate: string;
}

type PayField = keyof PayForm;

export interface PayCheck {
  ok: boolean;
  body: PayBody | null;
  errors: Partial<Record<PayField, string>>;
  /** The amount parsed and below what remains. */
  partial: boolean;
  /** The remainder date is on the form, and required. */
  remainderRequired: boolean;
  /** Minor units left after this payment, when the amount parses. */
  leftMinor: bigint | null;
}

export const NOTE_MAX = 500;

/**
 * The one line that says why a remainder date is asked for. A part-payment on something
 * already due must say when the rest is due: otherwise what is still owed would sit on a
 * date that has passed, with nowhere in the forecast to go.
 */
export function remainderExplanation(left: string): string {
  return `It was already due, so say when the rest (${left}) is due — the forecast places what is still owed on this date.`;
}

/** The form as it opens: paid today (or `defaultPaidOn`), the whole remainder, rest due today. */
export function initialPayForm(target: PayTarget, today: IsoDate, defaultPaidOn?: IsoDate): PayForm {
  const minor = parseMinor(target.remaining);
  return {
    paidOn: defaultPaidOn && isValidDate(defaultPaidOn) && defaultPaidOn <= today ? defaultPaidOn : today,
    amount: minor !== null && minor > 0n ? target.remaining : '',
    note: '',
    // Pre-filled with today: the earliest date the server accepts, and the honest default
    // for money that is already late.
    remainderDueDate: today,
  };
}

/**
 * The form as typed → the body to send, or the problem with each field.
 *
 * `serverAskedForRemainder` is set once the server has answered `REMAINDER_DATE_REQUIRED`;
 * it makes the remainder date required whatever this browser thinks of the dates.
 */
export function validatePay(
  form: PayForm,
  ctx: { target: PayTarget; today: IsoDate; serverAskedForRemainder?: boolean },
): PayCheck {
  const errors: Partial<Record<PayField, string>> = {};
  const { target, today } = ctx;
  const remainingMinor = parseMinor(target.remaining) ?? 0n;

  const paidOn = form.paidOn.trim();
  if (!isValidDate(paidOn)) errors.paidOn = 'Pick the day it was paid.';
  else if (paidOn > today) errors.paidOn = 'Cannot be in the future — record a payment once it has happened.';

  let amountMinor: bigint | null = null;
  let decimal: string | null = null;
  const typed = parseMoneyInput(form.amount, { allowZero: false });
  if (remainingMinor <= 0n) errors.amount = 'Nothing remains to pay.';
  else if (typed.kind === 'blank') errors.amount = 'Enter the amount paid.';
  else if (typed.kind === 'error') errors.amount = typed.error;
  else if (typed.minor > remainingMinor) {
    errors.amount = `At most ${formatMoney(remainingMinor, target.currency)} — that is all that remains.`;
  } else {
    amountMinor = typed.minor;
    decimal = typed.decimal;
  }

  const partial = amountMinor !== null && amountMinor < remainingMinor;
  const leftMinor = amountMinor === null ? null : remainingMinor - amountMinor;
  // Pre-emptively when the effective date is already behind today (string compare of two
  // YYYY-MM-DD dates); always once the server has said so.
  const pastDue = isValidDate(target.effectiveDate) && target.effectiveDate < today;
  const remainderRequired = partial && (pastDue || !!ctx.serverAskedForRemainder);

  const remainderDueDate = form.remainderDueDate.trim();
  if (remainderRequired) {
    if (!isValidDate(remainderDueDate)) errors.remainderDueDate = 'Say when the rest is due.';
    else if (remainderDueDate < today) errors.remainderDueDate = 'Today or later — the rest cannot be due in the past.';
  }

  const note = form.note.trim();
  if (note.length > NOTE_MAX) errors.note = `At most ${NOTE_MAX} characters.`;

  if (Object.keys(errors).length > 0 || decimal === null) {
    return { ok: false, body: null, errors, partial, remainderRequired, leftMinor };
  }
  const body: PayBody = { paidOn, paidAmount: decimal };
  if (note) body.note = note;
  if (remainderRequired) body.remainderDueDate = remainderDueDate;
  return { ok: true, body, errors, partial, remainderRequired, leftMinor };
}

/** The lines a pay refusal adds under the server's own message. */
function payRefusalLine(error: ApiError, currency: string): string | null {
  const d = error.details ?? {};
  if (error.code === 'PAID_AMOUNT_INVALID' && typeof d.remainingAmount === 'string') {
    return `The server holds ${formatDecimal(d.remainingAmount, currency)} as remaining. Close and reopen to see the latest.`;
  }
  if (error.code === 'PAID_ON_IN_FUTURE' && typeof d.today === 'string') {
    return `The server's today is ${formatDay(d.today)}.`;
  }
  if (error.code === 'REMAINDER_DATE_REQUIRED') {
    const due = typeof d.dueDate === 'string' ? ` It was due ${formatDay(d.dueDate)}.` : '';
    return `Say when the rest is due, below, and pay again.${due}`;
  }
  return null;
}

/** Recorded payments, oldest first — the rows behind the paid figure (D23). */
export function PaymentsList({ payments, currency }: { payments: Payment[]; currency: string }) {
  if (payments.length === 0) return null;
  return (
    <ul
      aria-label="Payments"
      style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      {payments.map((p) => (
        <li key={p.id} className="mono" style={{ fontSize: 12.5, color: 'var(--mut)', display: 'flex', gap: 10 }}>
          <span>{formatDay(p.paidOn)}</span>
          <span style={{ color: 'var(--text)' }}>{formatDecimal(p.amount, currency)}</span>
          {p.note && <span style={{ fontFamily: 'inherit' }}>{p.note}</span>}
        </li>
      ))}
    </ul>
  );
}

export function PayDialog({
  kicker,
  title,
  target,
  today,
  defaultPaidOn,
  intro,
  pay,
  onPaid,
  onClose,
}: {
  kicker: ReactNode;
  title: string;
  target: PayTarget;
  /** The Europe/London date this screen was opened on. */
  today: IsoDate;
  /** Where the pay date starts (Confirm paid starts at the due date); today otherwise. */
  defaultPaidOn?: IsoDate;
  /** A line above the fields — why this dialog opened, when it is not obvious. */
  intro?: ReactNode;
  /** Sends the pay and replaces the row from the response; rejects with the refusal. */
  pay: (body: PayBody) => Promise<void>;
  onPaid: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<PayForm>(() => initialPayForm(target, today, defaultPaidOn));
  const [serverAsked, setServerAsked] = useState(false);
  const submit = useSubmit();
  const check = validatePay(form, { target, today, serverAskedForRemainder: serverAsked });
  const set = (key: PayField) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const confirm = () => {
    if (!check.body) return;
    const body = check.body;
    void submit
      .run(async () => {
        try {
          await pay(body);
        } catch (e) {
          if ((e as ApiError)?.code === 'REMAINDER_DATE_REQUIRED') setServerAsked(true);
          throw e;
        }
      })
      .then((ok) => {
        if (ok) onPaid();
      });
  };

  const remainingMinor = parseMinor(target.remaining) ?? 0n;
  const left = check.leftMinor === null ? null : formatMoney(check.leftMinor, target.currency);
  const extra = submit.error ? payRefusalLine(submit.error, target.currency) : null;

  return (
    <Dialog
      kicker={kicker}
      title={title}
      confirmLabel={check.partial ? 'Record part-payment' : 'Record payment'}
      confirmDisabled={!check.ok}
      busy={submit.busy}
      onConfirm={confirm}
      onClose={onClose}
    >
      {intro && <DialogBody>{intro}</DialogBody>}
      <div className="kv" data-testid="pay-remaining">
        <span>Remaining</span>
        <span className="mono">
          {formatMoney(remainingMinor, target.currency)}
          {parseMinor(target.amount) !== remainingMinor && (
            <span style={{ color: 'var(--dim)' }}> of {formatDecimal(target.amount, target.currency)}</span>
          )}
        </span>
      </div>
      <div className="kv">
        <span>Due</span>
        <span className="mono">{formatDay(target.effectiveDate)}</span>
      </div>
      {target.payments.length > 0 && (
        <FormField label="PAID SO FAR">
          <PaymentsList payments={target.payments} currency={target.currency} />
        </FormField>
      )}

      <FormField label="PAID ON" note="Today or earlier." error={check.errors.paidOn}>
        <input
          type="date"
          className="input mono"
          aria-label="Paid on"
          max={today}
          style={inputStyle}
          value={form.paidOn}
          onChange={set('paidOn')}
        />
      </FormField>
      <FormField
        label={`AMOUNT · ${target.currency}`}
        note={check.partial ? undefined : 'The whole remainder. Enter less for a part-payment.'}
        error={check.errors.amount}
      >
        <input
          className="input mono"
          aria-label="Amount paid"
          inputMode="decimal"
          style={inputStyle}
          value={form.amount}
          onChange={set('amount')}
        />
      </FormField>

      {check.remainderRequired ? (
        <FormField label="REST DUE ON" error={check.errors.remainderDueDate}>
          <input
            type="date"
            className="input mono"
            aria-label="Rest due on"
            min={today}
            style={inputStyle}
            value={form.remainderDueDate}
            onChange={set('remainderDueDate')}
          />
          <div data-testid="remainder-why" style={{ fontSize: 12.5, color: 'var(--mut)', lineHeight: 1.5 }}>
            {remainderExplanation(left ?? 'what is left')}
          </div>
        </FormField>
      ) : (
        check.partial &&
        left && (
          <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.5 }} data-testid="remainder-stays">
            The remaining {left} stays due on {formatDay(target.effectiveDate)}.
          </div>
        )
      )}

      <FormField label="NOTE" error={check.errors.note}>
        <input className="input" aria-label="Payment note" style={inputStyle} value={form.note} onChange={set('note')} />
      </FormField>

      {submit.error && <ErrorNote error={submit.error} />}
      {extra && (
        <div role="status" style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.5 }}>
          {extra}
        </div>
      )}
    </Dialog>
  );
}

/**
 * Unpay removes EVERY payment of the row (§6.7, §6.9) — not the last one — so it is
 * confirmed with the payments listed. The due date is not put back (D23).
 */
export function UnpayDialog({
  kicker,
  title,
  payments,
  currency,
  unpay,
  onDone,
  onClose,
}: {
  kicker: ReactNode;
  title: string;
  payments: Payment[];
  currency: string;
  unpay: () => Promise<void>;
  onDone: () => void;
  onClose: () => void;
}) {
  const submit = useSubmit();
  return (
    <Dialog
      kicker={kicker}
      title={title}
      confirmLabel={payments.length === 1 ? 'Remove the payment' : `Remove all ${payments.length} payments`}
      busy={submit.busy}
      warnTone="warn"
      warning="Every payment recorded against it is removed, not just the last one, and it goes back to expected. A due date moved by a part-payment stays where it is."
      onConfirm={() =>
        void submit
          .run(async () => {
            await unpay();
          })
          .then((ok) => {
            if (ok) onDone();
          })
      }
      onClose={onClose}
    >
      <PaymentsList payments={payments} currency={currency} />
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
