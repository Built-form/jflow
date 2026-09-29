import { useState } from 'react';
import type { ExternalItem } from '../../api/external';
import { external } from '../../api/external';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { FormField, inputStyle } from '../../components/FormField';
import { ErrorNote, Loading, Tag, Toggle } from '../../components/ui';
import { formatDay, isValidDate } from '../../lib/dates';
import { flagTags, shortDay } from '../../lib/grid';
import { formatMinor, formatMoney } from '../../lib/money';
import { PLAN_STALE_TAG, shipFlagNotes } from '../../lib/ship';
import { QUICK_SHIFTS, shiftedDate } from './edit';
import type { PlanAction, PlanForm } from './shipPlan';
import {
  NOTE_MAX,
  checkPlan,
  followFeedDate,
  initialPlanForm,
  isStaleWrite,
  pickDate,
  refusalNeedsReload,
  revertAction,
  shipRefusalLines,
  targetFromRow,
} from './shipPlan';

export const SHIP_PLAN_KICKER = 'STOCK PAYMENT · PLAN';

/** Send what `checkPlan` (or Revert) decided. Both answer the row as the server now holds it. */
export async function sendPlan(action: PlanAction): Promise<ExternalItem | null> {
  if (action.kind === 'plan') return external.plan(action.key, action.body, action.baseVersion);
  return (await external.unplan(action.key, action.baseVersion)) ?? null;
}

/**
 * Plan one stock payment with no scenario open: JFlow's own date, amount, skip or note on
 * top of what shipping says (the overlay, CONTRACT §6.12). The dialog reads the row itself
 * (`GET /external-items/:key`) unless the screen already holds it, so it edits exactly what
 * is stored and sends that `rowVersion` as `baseVersion`; a 409 `STALE_WRITE` offers to
 * read the row again.
 *
 * `onSaved` gets the row a write answered, or null after a refusal that means the screen
 * is out of date. The Forecast re-reads itself either way; a list replaces the row.
 */
export function ShipPlanDialog({
  itemKey,
  row,
  title,
  today,
  onClose,
  onSaved,
}: {
  itemKey: string;
  /** The row, when the screen already read it (Stock payments); else it is read here. */
  row?: ExternalItem;
  /** Shown while the row loads. */
  title?: string;
  /** The server's today (`meta.today`), or the Europe/London date on a list screen. */
  today: string;
  onClose: () => void;
  onSaved: (row: ExternalItem | null) => void;
}) {
  const [reads, setReads] = useState(0);
  const loaded = useQuery(
    () => (row && reads === 0 ? Promise.resolve(row) : external.get(itemKey)),
    [itemKey, reads],
  );

  // A row the screen handed over is shown at once; a re-read (after STALE_WRITE) waits.
  const given = reads === 0 ? row ?? null : null;
  const current = loaded.loading ? given : loaded.data ?? given;

  if (!current) {
    const lines = loaded.error ? shipRefusalLines(loaded.error, today) : [];
    return (
      <Dialog
        kicker={SHIP_PLAN_KICKER}
        title={title ?? itemKey}
        width={560}
        confirmLabel="Save the plan"
        confirmDisabled
        onConfirm={() => undefined}
        onClose={onClose}
      >
        {loaded.error && !loaded.loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="ship-load-error">
            <ErrorNote error={loaded.error} onRetry={loaded.reload} />
            {lines.map((l) => (
              <div key={l.key} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                {l.message}
              </div>
            ))}
            {refusalNeedsReload(loaded.error) && (
              <div>
                <button type="button" className="btn" onClick={() => onSaved(null)}>
                  Close and reload
                </button>
              </div>
            )}
          </div>
        ) : (
          <Loading what="Stock payment" />
        )}
      </Dialog>
    );
  }

  return (
    <PlanFormDialog
      // A fresh read is a fresh form: the values, the note and the version are the server's.
      key={`${current.rowVersion}:${reads}`}
      row={current}
      today={today}
      onClose={onClose}
      onSaved={onSaved}
      onReread={() => setReads((n) => n + 1)}
    />
  );
}

function PlanFormDialog({
  row,
  today,
  onClose,
  onSaved,
  onReread,
}: {
  row: ExternalItem;
  today: string;
  onClose: () => void;
  onSaved: (row: ExternalItem | null) => void;
  onReread: () => void;
}) {
  const target = targetFromRow(row);
  const [form, setForm] = useState<PlanForm>(() => initialPlanForm(target));
  const submit = useSubmit();
  const check = checkPlan(target, form, today);
  const revert = revertAction(target);
  const notes = shipFlagNotes(target.flags, { blocked: target.blocked });
  const tags = flagTags(target.flags);
  if (target.planStale) tags.push(PLAN_STALE_TAG);

  const save = (action: PlanAction | null) => {
    if (!action) return;
    void submit.run(async () => {
      onSaved(await sendPlan(action));
    });
  };

  const feedAmount = formatMoney(target.feedAmountMinor, target.currency);
  const feedDate = target.feedDate ? formatDay(target.feedDate) : 'no date yet';
  const lines = submit.error ? shipRefusalLines(submit.error, today) : [];
  const editable = !target.gone && !target.paid;

  return (
    <Dialog
      kicker={SHIP_PLAN_KICKER}
      title={target.name}
      width={560}
      confirmLabel="Save the plan"
      confirmDisabled={!check.action}
      busy={submit.busy}
      warnTone="warn"
      warning="This plans the real stock payment in JFlow. Shipping is not changed: JFlow uses your date and amount until you revert to the feed. To try it out first, open a scenario."
      onConfirm={() => save(check.action)}
      onClose={onClose}
    >
      <DialogBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div data-testid="ship-feed">
            Shipping says <span className="mono" style={{ color: 'var(--text)' }}>{feedAmount}</span> on {feedDate}.
          </div>
          {target.planned && (
            <div data-testid="ship-planned">
              JFlow uses{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {formatMoney(target.amountMinor, target.currency)}
              </span>{' '}
              on {target.date ? formatDay(target.date) : 'no date'}
              {target.plannedDate ? ' (pinned)' : ''}
              {target.skipped ? ', and skips it' : ''}.
            </div>
          )}
          {notes.map((n) => (
            <div key={n} style={{ fontSize: 13 }}>
              {n}
            </div>
          ))}
          {target.planStale && (
            <div role="note" style={{ fontSize: 13, color: 'var(--warn)' }} data-testid="ship-plan-stale">
              A planned amount was set against a different shipping amount, so it is ignored and shipping's amount is
              used. Enter an amount to plan it again, or revert to the feed.
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
              {target.key}
            </span>
            {tags.map((t) => (
              <Tag key={t.flag} tone={t.tone}>
                {t.label}
              </Tag>
            ))}
          </div>
        </div>
      </DialogBody>

      {editable && (
        <Toggle
          on={form.skipped}
          label="Skip it"
          detail="Leave it out of the forecast until you unskip it or revert to the feed."
          onChange={(next) => setForm((f) => ({ ...f, skipped: next }))}
        />
      )}

      {editable && !form.skipped && (
        <>
          <FormField label={`AMOUNT · ${target.currency}`} error={check.errors.amount}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input mono"
                aria-label="Amount"
                inputMode="decimal"
                style={{ ...inputStyle, flex: '1 1 160px', width: 'auto' }}
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
              {form.amount !== formatMinor(target.feedAmountMinor) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setForm((f) => ({ ...f, amount: formatMinor(target.feedAmountMinor) }))}
                >
                  Use shipping's ({feedAmount})
                </button>
              )}
            </div>
          </FormField>
          <FormField label="DATE" error={check.errors.date}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="date"
                className="input mono"
                aria-label="Date"
                min={today}
                value={form.date}
                onChange={(e) => setForm((f) => pickDate(f, e.target.value))}
              />
              {QUICK_SHIFTS.map((n) => {
                const from = form.date && isValidDate(form.date) ? form.date : today;
                const next = shiftedDate(from, n, today);
                return (
                  <button
                    key={n}
                    type="button"
                    className="btn"
                    aria-label={`Move to ${formatDay(next)} (+${n} days)`}
                    title={formatDay(next)}
                    onClick={() => setForm((f) => pickDate(f, next))}
                  >
                    +{n}
                  </button>
                );
              })}
              {target.feedDate && !form.dateFollowsFeed && (
                <button type="button" className="btn" onClick={() => setForm((f) => followFeedDate(f, target))}>
                  Use shipping's ({shortDay(target.feedDate)})
                </button>
              )}
              {/* Pinning the very date shipping gives means something once the row has a plan:
                  it stops the line moving when shipping's estimate does. */}
              {form.dateFollowsFeed && target.planned && isValidDate(form.date) && (
                <button type="button" className="btn" onClick={() => setForm((f) => pickDate(f, f.date))}>
                  Pin {shortDay(form.date)}
                </button>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--mut)' }} data-testid="ship-date-mode">
              {form.dateFollowsFeed
                ? target.feedDate
                  ? "Follows shipping's date: it moves when shipping's does."
                  : 'Shipping has no date yet; pick one to plan it.'
                : "Pinned: it stays on this date whatever shipping says. Today or later."}
            </div>
            {isValidDate(form.date) && target.date && form.date !== target.date && (
              <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                From {shortDay(target.date)} to {shortDay(form.date)}.
              </div>
            )}
          </FormField>
        </>
      )}

      {editable && (
        <FormField label="NOTE" note="Optional. Clear it to remove it." error={check.errors.note}>
          <input
            className="input"
            aria-label="Note"
            maxLength={NOTE_MAX + 50}
            style={inputStyle}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </FormField>
      )}

      {revert && (
        <div>
          <button type="button" className="btn" disabled={submit.busy} onClick={() => save(revert)}>
            Revert to feed
          </button>
        </div>
      )}

      {check.errors.form && (
        <div role="alert" style={{ fontSize: 13.5, color: 'var(--fail)' }}>
          {check.errors.form}
        </div>
      )}
      {check.unchanged && <div style={{ fontSize: 13, color: 'var(--dim)' }}>Nothing changed yet.</div>}
      {submit.error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="ship-refusal">
          <ErrorNote error={submit.error} />
          {lines.map((l) => (
            <div key={l.key} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {l.message}
            </div>
          ))}
          {isStaleWrite(submit.error) && (
            <div>
              <button type="button" className="btn" onClick={onReread}>
                Load the latest
              </button>
            </div>
          )}
          {refusalNeedsReload(submit.error) && (
            <div>
              <button type="button" className="btn" onClick={() => onSaved(null)}>
                Close and reload
              </button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
