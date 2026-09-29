import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { isApiError } from '../../api/client';
import { schedules } from '../../api/schedules';
import type { EndResult, Instance, Schedule, ScheduleStructure, SplitResult } from '../../api/schedules';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { Dialog, DialogBody } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { PayDialog, PaymentsList, UnpayDialog } from '../../components/PayDialog';
import { Empty, ErrorNote, Loading, Pill, Tag } from '../../components/ui';
import { addDays, diffDays, formatDay, isValidDate, londonToday } from '../../lib/dates';
import { formatDecimal } from '../../lib/money';
import { RemoveDialog } from '../settings/RemoveDialog';
import { ASSUMED_SETTLED, derivedStatusLabel, groupByDerivedStatus } from '../items/grouping';
import { DidntHappenDialog, GroupFilter, GroupSection, RowAction, useShowFilter } from '../items/groups';
import { SCHEDULES_KICKER, ScheduleDialog } from './ScheduleDialog';
import { EndWizard, SplitWizard } from './SplitWizard';
import { TuneDialog } from './TuneDialog';
import { WEEKEND_RULE_LABEL, cadenceLabel, endLabel, hasPaymentState, instanceRemaining } from './scheduleForm';

/** The widest window `/instances` serves (D35). */
export const MAX_SPAN_DAYS = 730;

const COLUMNS = '128px 150px 170px minmax(0, 1fr) minmax(0, 1.2fr)';

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

type Paying = { instance: Instance; confirming: boolean };

/**
 * One schedule: what it is, where it came from and went, and its instances — predicted
 * and tuned — grouped by the server's `derivedStatus`, with the same "Assumed settled"
 * group and actions as Income & outgoings. Instances are virtual (§6.9): each is its
 * natural date; tuning one writes an override and leaves the series alone.
 */
export function ScheduleScreen() {
  const { id: rawId } = useParams();
  const id = parseId(rawId);
  const [today] = useState(() => londonToday());
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [show, setShow] = useShowFilter();

  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const from = rawFrom && isValidDate(rawFrom) ? rawFrom : addDays(today, -90);
  const to = rawTo && isValidDate(rawTo) ? rawTo : addDays(today, 365);
  const windowError =
    to < from
      ? 'The window ends before it starts.'
      : diffDays(to, from) > MAX_SPAN_DAYS
        ? `At most ${MAX_SPAN_DAYS} days at a time.`
        : null;

  const schedule = useQuery(() => (id === null ? Promise.resolve(null) : schedules.get(id)), [id]);
  const instances = useQuery(
    () => (id === null || windowError ? Promise.resolve(null) : schedules.instances(id, { from, to })),
    [id, from, to, windowError],
  );
  const accounts = useQuery(() => api.accounts.list(), []);
  const categories = useQuery(() => api.categories.list(), []);
  const s = schedule.data;
  const predecessorId = s?.predecessorId ?? null;
  const successorId = s?.successorId ?? null;
  const predecessor = useQuery(
    () => (predecessorId === null ? Promise.resolve(null) : schedules.get(predecessorId).catch(() => null)),
    [predecessorId],
  );
  const successor = useQuery(
    () => (successorId === null ? Promise.resolve(null) : schedules.get(successorId).catch(() => null)),
    [successorId],
  );

  const [editing, setEditing] = useState(false);
  const [splitting, setSplitting] = useState<{ changes?: Partial<ScheduleStructure> } | null>(null);
  const [ending, setEnding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [tuning, setTuning] = useState<Instance | null>(null);
  const [paying, setPaying] = useState<Paying | null>(null);
  const [unpaying, setUnpaying] = useState<Instance | null>(null);
  const [didntHappen, setDidntHappen] = useState<Instance | null>(null);
  const [reverting, setReverting] = useState<Instance | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const action = useSubmit();

  const rows = instances.data?.data ?? [];
  const groups = useMemo(() => groupByDerivedStatus(rows), [rows]);
  const visible = show === null ? groups : groups.filter((g) => g.id === show);
  const accountRows = accounts.data?.data ?? [];
  const categoryRows = categories.data?.data ?? [];

  if (id === null || schedule.error?.status === 404) {
    return (
      <div className="page">
        <PageHeader fallback={{ to: '/schedules', label: 'Schedules' }} title="No such schedule">
          <div className="explainer">It may have been removed, or the link is wrong.</div>
        </PageHeader>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="page">
        {schedule.error ? <ErrorNote error={schedule.error} onRetry={schedule.reload} /> : <Loading what="Schedule" />}
      </div>
    );
  }

  const account = accountRows.find((a) => a.id === s.accountId);
  const category = categoryRows.find((c) => c.id === s.categoryId);
  const kicker = `${SCHEDULES_KICKER} · ${s.name.toUpperCase()}`;

  /** Replace-from-response. The schedule's lock may flip when an override appears or goes. */
  const replaceInstance = (next: Instance) => {
    const data = instances.data;
    if (!data) return;
    const prev = data.data.find((i) => i.naturalDate === next.naturalDate);
    instances.set({ ...data, data: data.data.map((i) => (i.naturalDate === next.naturalDate ? next : i)) });
    if (!prev || prev.tuned !== next.tuned) schedule.reload();
  };

  const setWindow = (key: 'from' | 'to', value: string) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (isValidDate(value)) out.set(key, value);
        else out.delete(key);
        return out;
      },
      { replace: true },
    );

  const skip = (i: Instance, skipped: boolean) => {
    setNotice(null);
    const o = i.override;
    // Unskipping an instance whose only tune was the skip leaves nothing tuned, which the
    // server refuses as a tune ("DELETE reverts") — so that one is a revert.
    const onlySkip = !!o && o.amount == null && o.dueDate == null && !o.note && o.settleMode == null;
    void action.run(async () => {
      if (!skipped && onlySkip && !hasPaymentState(i)) {
        await schedules.revert(s.id, i.naturalDate, o?.rowVersion);
        instances.reload();
        schedule.reload();
        return;
      }
      replaceInstance(
        await schedules.tune(s.id, i.naturalDate, { status: skipped ? 'skipped' : null }, o?.rowVersion),
      );
    });
  };

  const afterSplit = (result: SplitResult) => {
    setSplitting(null);
    schedule.set(result.ended);
    instances.reload();
    setNotice(
      <>
        Split. This schedule now ends {result.ended.endDate ? formatDay(result.ended.endDate) : 'before the split'};{' '}
        <Link to={`/schedules/${result.successor.id}`}>{result.successor.name}</Link> carries on from{' '}
        {formatDay(result.successor.activeFrom ?? result.successor.startDate)}.
        {result.deletedOverrides.length > 0 && ` ${result.deletedOverrides.length} tuned instance(s) dropped.`}
        {result.rekeyedAdjustments.length > 0 &&
          ` ${result.rekeyedAdjustments.length} scenario adjustment(s) moved to the new schedule — rebase them if the amount changed.`}
        {result.droppedAdjustments.length > 0 && ` ${result.droppedAdjustments.length} scenario adjustment(s) dropped.`}
      </>,
    );
  };

  const afterEnd = (result: EndResult) => {
    setEnding(false);
    schedule.set(result.ended);
    instances.reload();
    setNotice(
      <>
        Ended. {endLabel(result.ended)}.
        {result.deletedOverrides.length > 0 && ` ${result.deletedOverrides.length} tuned instance(s) dropped.`}
        {result.droppedAdjustments.length > 0 && ` ${result.droppedAdjustments.length} scenario adjustment(s) dropped.`}
      </>,
    );
  };

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <PageHeader
        fallback={{ to: '/schedules', label: 'Schedules' }}
        title={s.name}
        actions={
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn" onClick={() => setSplitting({})}>
              Split from…
            </button>
            <button type="button" className="btn" onClick={() => setEnding(true)}>
              End…
            </button>
            <button type="button" className="btn" style={{ color: 'var(--fail)' }} onClick={() => setRemoving(true)}>
              Remove
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Pill tone={s.status === 'ended' ? 'idle' : 'live'}>{s.status.toUpperCase()}</Pill>
          {s.structureLocked && <Tag>IN USE · CHANGES ARE SPLITS</Tag>}
          {s.settleMode === 'manual' && <Tag>BY HAND</Tag>}
        </div>
        <Lineage schedule={s} predecessor={predecessor.data ?? null} successor={successor.data ?? null} />
      </PageHeader>

      {action.error && <ErrorNote error={action.error} />}
      {notice && (
        <div role="status" className="note-panel">
          {notice}
        </div>
      )}

      <section className="panel" aria-label="Schedule" style={{ gap: 8 }}>
        <Fact label="Amount">
          {s.direction === 'in' ? 'Money in · ' : 'Money out · '}
          {formatDecimal(s.amount, s.currency)}
        </Fact>
        <Fact label="Account">{account?.name ?? `Account ${s.accountId}`}</Fact>
        <Fact label="Category">{category?.name ?? `Category ${s.categoryId}`}</Fact>
        {s.counterparty && <Fact label="Counterparty">{s.counterparty}</Fact>}
        <Fact label="Cadence">
          {cadenceLabel(s.frequency, s.intervalCount)} from {formatDay(s.startDate)}
        </Fact>
        {s.activeFrom && (
          <Fact label="Active from">
            {formatDay(s.activeFrom)} — earlier dates belong to the schedule it was split from
          </Fact>
        )}
        <Fact label="Ends">{endLabel(s)}</Fact>
        <Fact label="On a weekend">{WEEKEND_RULE_LABEL[s.weekendRule] ?? s.weekendRule}</Fact>
        <Fact label="Settles">{s.settleMode === 'auto' ? 'Automatically' : 'By hand'}</Fact>
        {s.notes && <Fact label="Notes">{s.notes}</Fact>}
      </section>

      <section aria-label="Instances" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="head-row" style={{ alignItems: 'center' }}>
          <h2 className="report-title" style={{ margin: 0 }}>
            Instances
          </h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="date"
              className="input mono"
              aria-label="Instances from"
              value={from}
              onChange={(e) => setWindow('from', e.target.value)}
            />
            <span style={{ color: 'var(--dim)' }}>to</span>
            <input
              type="date"
              className="input mono"
              aria-label="Instances to"
              value={to}
              onChange={(e) => setWindow('to', e.target.value)}
            />
          </div>
        </div>
        {windowError && (
          <div className="error-banner" role="alert">
            {windowError}
          </div>
        )}
        <GroupFilter groups={groups} value={show} onChange={setShow} />

        {(instances.data?.orphans.length ?? 0) > 0 && (
          <div className="note-panel" data-testid="orphans">
            Tuned instances on dates this schedule no longer produces are not shown or forecast:{' '}
            {instances.data!.orphans.map((o) => formatDay(o.naturalDate)).join(', ')}.
          </div>
        )}

        {instances.error && <ErrorNote error={instances.error} onRetry={instances.reload} />}
        {!instances.data ? (
          !instances.error && !windowError && <Loading what="Instances" />
        ) : groups.length === 0 ? (
          <Empty>No instances between {formatDay(from)} and {formatDay(to)}.</Empty>
        ) : visible.length === 0 ? (
          <Empty>Nothing in that group now.</Empty>
        ) : (
          visible.map((group) => (
            <GroupSection key={group.id} group={group}>
              <div className="card-table">
                <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
                  <div>NATURAL DATE</div>
                  <div>DUE</div>
                  <div style={{ textAlign: 'right' }}>AMOUNT</div>
                  <div>TUNED</div>
                  <div />
                </div>
                {group.rows.map((i) => (
                  <InstanceRow
                    key={i.naturalDate}
                    schedule={s}
                    instance={i}
                    assumedSettled={group.id === ASSUMED_SETTLED}
                    onPay={(confirming) => setPaying({ instance: i, confirming })}
                    onDidntHappen={() => setDidntHappen(i)}
                    onUnpay={() => setUnpaying(i)}
                    onTune={() => setTuning(i)}
                    onRevert={() => setReverting(i)}
                    onSkip={(skipped) => skip(i, skipped)}
                  />
                ))}
              </div>
            </GroupSection>
          ))
        )}
      </section>

      {editing && (
        <ScheduleDialog
          schedule={s}
          accounts={accountRows.filter((a) => (a.isActive && !a.deletedAt) || a.id === s.accountId)}
          categories={categoryRows}
          today={today}
          defaultAccount={null}
          onSaved={(row) => {
            schedule.set(row);
            setEditing(false);
            instances.reload();
          }}
          onSplit={(changes) => {
            setEditing(false);
            setSplitting({ changes });
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {splitting && (
        <SplitWizard
          schedule={s}
          naturalDates={rows.map((i) => i.naturalDate)}
          today={today}
          accounts={accountRows.filter((a) => (a.isActive && !a.deletedAt) || a.id === s.accountId)}
          categories={categoryRows}
          initialChanges={splitting.changes}
          onDone={afterSplit}
          onClose={() => setSplitting(null)}
        />
      )}

      {ending && (
        <EndWizard
          schedule={s}
          naturalDates={rows.map((i) => i.naturalDate)}
          today={today}
          onDone={afterEnd}
          onClose={() => setEnding(false)}
        />
      )}

      {removing && (
        <RemoveDialog
          kicker={SCHEDULES_KICKER}
          title={`Remove ${s.name}?`}
          warning="Every instance leaves the forecast. A scenario that adjusts one will show the adjustment as stale."
          remove={() => schedules.remove(s.id, s.rowVersion)}
          onRemoved={() => navigate('/schedules')}
          onClose={() => setRemoving(false)}
        />
      )}

      {tuning && (
        <TuneDialog
          schedule={s}
          instance={tuning}
          onSaved={(next) => {
            replaceInstance(next);
            setTuning(null);
          }}
          onClose={() => setTuning(null)}
        />
      )}

      {paying && (
        <PayDialog
          kicker={kicker}
          title={
            paying.confirming
              ? `Confirm ${formatDay(paying.instance.naturalDate)} was paid`
              : `Pay ${formatDay(paying.instance.naturalDate)}`
          }
          target={{
            amount: paying.instance.amount,
            remaining: instanceRemaining(paying.instance),
            currency: paying.instance.currency,
            effectiveDate: paying.instance.dueDate,
            payments: paying.instance.payments,
          }}
          today={today}
          defaultPaidOn={paying.confirming ? paying.instance.dueDate : undefined}
          intro={
            paying.confirming
              ? 'The pay date starts at its due date, which the recorded balance is assumed to include. Change it if the money moved on another day.'
              : undefined
          }
          pay={async (body) =>
            replaceInstance(
              await schedules.pay(s.id, paying.instance.naturalDate, body, paying.instance.override?.rowVersion),
            )
          }
          onPaid={() => setPaying(null)}
          onClose={() => setPaying(null)}
        />
      )}

      {unpaying && (
        <UnpayDialog
          kicker={kicker}
          title={`Unpay ${formatDay(unpaying.naturalDate)}?`}
          payments={unpaying.payments}
          currency={unpaying.currency}
          unpay={async () =>
            replaceInstance(await schedules.unpay(s.id, unpaying.naturalDate, unpaying.override?.rowVersion))
          }
          onDone={() => setUnpaying(null)}
          onClose={() => setUnpaying(null)}
        />
      )}

      {didntHappen && (
        <DidntHappenDialog
          kicker={kicker}
          title={`${formatDay(didntHappen.naturalDate)} didn't happen?`}
          detail={`${formatDecimal(didntHappen.amount, didntHappen.currency)}, due ${formatDay(didntHappen.dueDate)}. Only this instance changes; the schedule keeps settling automatically.`}
          confirm={async () => {
            const next = await schedules.tune(
              s.id,
              didntHappen.naturalDate,
              { settleMode: 'manual' },
              didntHappen.override?.rowVersion,
            );
            replaceInstance(next);
            setNotice(
              `${formatDay(next.naturalDate)} is now settled by hand. It shows under ${derivedStatusLabel(next.derivedStatus)} until it is paid, re-dated or skipped.`,
            );
          }}
          onDone={() => setDidntHappen(null)}
          onClose={() => setDidntHappen(null)}
        />
      )}

      {reverting && (
        <RevertDialog
          kicker={kicker}
          instance={reverting}
          revert={async () => {
            await schedules.revert(s.id, reverting.naturalDate, reverting.override?.rowVersion);
            // 204: nothing to replace from, so the predicted instance is read back.
            instances.reload();
            schedule.reload();
          }}
          onDone={() => setReverting(null)}
          onClose={() => setReverting(null)}
        />
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

/** Where this schedule came from and where it went: the split chain, both ways. */
function Lineage({
  schedule,
  predecessor,
  successor,
}: {
  schedule: Schedule;
  predecessor: Schedule | null;
  successor: Schedule | null;
}) {
  if (schedule.predecessorId === null && schedule.successorId === null) return null;
  return (
    <div data-testid="lineage" style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 1.6 }}>
      {schedule.predecessorId !== null && (
        <div>
          Split from{' '}
          <Link to={`/schedules/${schedule.predecessorId}`}>
            {predecessor?.name ?? `schedule #${schedule.predecessorId}`}
          </Link>
          {schedule.activeFrom && <> — takes over from {formatDay(schedule.activeFrom)}</>}.
        </div>
      )}
      {schedule.successorId !== null && (
        <div>
          Continues as{' '}
          <Link to={`/schedules/${schedule.successorId}`}>{successor?.name ?? `schedule #${schedule.successorId}`}</Link>
          {successor && <> from {formatDay(successor.activeFrom ?? successor.startDate)}</>}.
        </div>
      )}
    </div>
  );
}

/**
 * One instance: its natural date (its identity), the date and amount in force, and what
 * the schedule predicted when a tune changed them.
 */
function InstanceRow({
  schedule,
  instance: i,
  assumedSettled,
  onPay,
  onDidntHappen,
  onUnpay,
  onTune,
  onRevert,
  onSkip,
}: {
  schedule: Schedule;
  instance: Instance;
  assumedSettled: boolean;
  onPay: (confirming: boolean) => void;
  onDidntHappen: () => void;
  onUnpay: () => void;
  onTune: () => void;
  onRevert: () => void;
  onSkip: (skipped: boolean) => void;
}) {
  const o = i.override;
  const partPaid = i.status === 'part_paid';
  const owed = i.status === 'expected' || partPaid;
  const when = formatDay(i.naturalDate);
  return (
    <div
      className="table-row"
      data-testid={`instance-${i.naturalDate}`}
      style={{ gridTemplateColumns: COLUMNS, alignItems: 'start' }}
    >
      <div className="mono" style={{ fontSize: 12.5 }}>
        {when}
      </div>
      <div className="mono" style={{ fontSize: 12.5 }}>
        {formatDay(i.dueDate)}
        {o?.dueDate && (
          <div style={{ fontSize: 11.5, color: 'var(--dim)', fontFamily: 'inherit' }}>moved by a tune</div>
        )}
      </div>
      <div className="mono" style={{ fontSize: 13.5, textAlign: 'right' }}>
        {i.direction === 'in' ? '+' : '−'}
        {formatDecimal(i.amount, i.currency)}
        {o?.amount != null && (
          <div style={{ fontSize: 12, color: 'var(--dim)' }} title="The schedule's amount">
            predicted <s>{formatDecimal(schedule.amount, schedule.currency)}</s>
          </div>
        )}
        {partPaid && (
          <div style={{ fontSize: 12, color: 'var(--mut)' }}>{formatDecimal(instanceRemaining(i), i.currency)} left</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {i.tuned ? <Tag tone="live">TUNED</Tag> : <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>as predicted</span>}
          {partPaid && <Tag tone="warn">PART PAID</Tag>}
          {o?.settleMode === 'manual' && <Tag>BY HAND</Tag>}
          {o?.sourceScenarioId != null && <Tag>FROM SCENARIO</Tag>}
        </span>
        {o?.note && <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>{o.note}</span>}
        <PaymentsList payments={i.payments} currency={i.currency} />
      </div>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {assumedSettled ? (
          <>
            <RowAction label={`Confirm paid, ${when}`} onClick={() => onPay(true)}>
              Confirm paid
            </RowAction>
            <RowAction label={`Didn't happen, ${when}`} tone="fail" onClick={onDidntHappen}>
              Didn't happen
            </RowAction>
          </>
        ) : (
          owed && (
            <RowAction label={`Pay, ${when}`} onClick={() => onPay(false)}>
              {partPaid ? 'pay the rest' : 'pay'}
            </RowAction>
          )
        )}
        {i.payments.length > 0 && (
          <RowAction label={`Unpay, ${when}`} tone="mut" onClick={onUnpay}>
            unpay
          </RowAction>
        )}
        {!hasPaymentState(i) && i.status !== 'skipped' && (
          <RowAction label={`Skip, ${when}`} tone="mut" onClick={() => onSkip(true)}>
            skip
          </RowAction>
        )}
        {i.status === 'skipped' && (
          <RowAction label={`Unskip, ${when}`} tone="mut" onClick={() => onSkip(false)}>
            unskip
          </RowAction>
        )}
        <RowAction label={`Tune, ${when}`} onClick={onTune}>
          tune
        </RowAction>
        {i.tuned && (
          <RowAction label={`Revert, ${when}`} tone="fail" onClick={onRevert}>
            revert
          </RowAction>
        )}
      </div>
    </div>
  );
}

/**
 * Revert = delete the override, back to the prediction (§6.9). Refused while the override
 * carries a payment (`OVERRIDE_HAS_PAYMENT`) — the payment would lose its parent — so the
 * refusal says to unpay first.
 */
export function RevertDialog({
  kicker,
  instance,
  revert,
  onDone,
  onClose,
}: {
  kicker: ReactNode;
  instance: Instance;
  revert: () => Promise<void>;
  onDone: () => void;
  onClose: () => void;
}) {
  const submit = useSubmit();
  const hasPayment = isApiError(submit.error) && submit.error.code === 'OVERRIDE_HAS_PAYMENT';
  const d = submit.error?.details ?? {};
  return (
    <Dialog
      kicker={kicker}
      title={`Revert ${formatDay(instance.naturalDate)} to predicted?`}
      confirmLabel="Revert"
      confirmDisabled={hasPayment}
      busy={submit.busy}
      warnTone={hasPayment ? 'fail' : 'idle'}
      warning={
        hasPayment ? (
          <div data-testid="revert-has-payment">
            It has a payment recorded
            {typeof d.paidAmount === 'string' ? ` (${formatDecimal(d.paidAmount, instance.currency)}` : ''}
            {typeof d.paidOn === 'string' ? ` on ${formatDay(d.paidOn)})` : typeof d.paidAmount === 'string' ? ')' : ''}, so
            its tune cannot be removed — the payment belongs to it. Unpay it first, then revert.
          </div>
        ) : undefined
      }
      onConfirm={() =>
        void submit.run(revert).then((ok) => {
          if (ok) onDone();
        })
      }
      onClose={onClose}
    >
      <DialogBody>
        Its amount, date, note and settle mode go back to what the schedule predicts.
      </DialogBody>
      {submit.error && !hasPayment && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
