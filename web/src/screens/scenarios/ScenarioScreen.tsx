import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { ApiError } from '../../api/client';
import type { BucketKind, ForecastResponse } from '../../api/forecast';
import { forecast } from '../../api/forecast';
import type { Adjustment, Scenario, ScenarioDetail } from '../../api/scenarios';
import { scenarios } from '../../api/scenarios';
import { useScenario } from '../../app/ScenarioContext';
import { useCompanyFilter } from '../../app/companyFilter';
import { useQuery } from '../../app/useQuery';
import { PageHeader, openDetail } from '../../components/PageHeader';
import { Empty, ErrorNote, Loading, Pill, Segmented, Tag } from '../../components/ui';
import { formatDay } from '../../lib/dates';
import { calendarDay, plural, shortEmail, shortStamp } from '../../lib/format';
import { BUCKET_OPTIONS, bucketLabel, parseBucket, signedMoney } from '../../lib/grid';
import { formatDecimal, formatMinor, formatMoney, parseMinor, toMinor } from '../../lib/money';
import { toneOfScenarioStatus } from '../../lib/tone';
import { RemoveDialog } from '../settings/RemoveDialog';
import { ApplyDialog, DiscardDialog, DuplicateScenarioDialog, RebaseDialog, UnapplyDialog } from './dialogs';
import { forecastLink } from './ScenariosScreen';
import { SCENARIO_STATUS_LABEL, staleReason } from './stale';

type DialogName = 'rebase' | 'apply' | 'unapply' | 'discard' | 'duplicate' | 'delete' | null;

/** A split's anchor carries its own id as `splitGroup`; its parts carry the anchor's (D40). */
const isSplitAnchor = (a: Adjustment) => a.splitGroup !== null && a.splitGroup === a.id;

/** `:id` as a positive integer, else null (a malformed id is a 404, as on the API — §2.3). */
export function parseScenarioId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  return Number(raw);
}

/** A DECIMAL amount in the target's currency when the screen knows it, else as the plain figure. */
function amountText(value: string | null | undefined, currency: string | null): string {
  if (value == null) return '—';
  if (currency) return formatDecimal(value, currency);
  const minor = parseMinor(value);
  return minor === null ? value : formatMinor(minor);
}

/**
 * One scenario: its adjustments with their stale markers, what it does to the forecast
 * (`scenario.deltaByBucket`), and the draft's three ways forward — rebase, apply, discard.
 * Applied and archived scenarios are read-only; the server answers `SCENARIO_NOT_DRAFT` to
 * any change, and the screen says so before anyone tries. An applied scenario can be
 * un-applied (2026-10-07, D41): the real plan goes back and the scenario is a draft again.
 *
 * Its one-offs (`add`, D39) are listed with the rest, by their own name; a split (D40) shows
 * on its anchor, and its parts are one-offs marked as parts.
 */
export function ScenarioScreen() {
  const id = parseScenarioId(useParams().id);
  if (id === null) return <NoSuchScenario />;
  return <ScenarioDetailView id={id} />;
}

function NoSuchScenario() {
  return (
    <div className="page">
      <PageHeader fallback={{ to: '/scenarios', label: 'Scenarios' }} title="No such scenario">
        <div className="explainer">It may have been deleted, or the link is wrong.</div>
      </PageHeader>
    </div>
  );
}

function ScenarioDetailView({ id }: { id: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [companyFilter] = useCompanyFilter();
  const bucket = parseBucket(params.get('bucket'));
  const { active, open, close } = useScenario();

  const detail = useQuery(() => scenarios.get(id), [id]);
  const companies = useQuery(() => api.companies.list(), []);
  const s = detail.data;
  const isDraft = s?.status === 'draft';
  const viewCompany = companyFilter ?? s?.companyId ?? null;

  // What the scenario does to the forecast — only for a draft: an applied scenario's
  // adjustments are history, not a live comparison (§6.11).
  const effect = useQuery<ForecastResponse | null>(
    () => (isDraft ? forecast.get({ companyId: viewCompany, scenarioId: id, bucket, include: 'grid' }) : Promise.resolve(null)),
    [id, isDraft, viewCompany, bucket],
  );

  const lines = useMemo(() => {
    const map = new Map<string, { name: string; currency: string }>();
    for (const row of effect.data?.rows ?? []) {
      for (const item of row.items) map.set(item.key, { name: item.name, currency: item.currency });
    }
    return map;
  }, [effect.data]);
  // The forecast's line names while it is open; otherwise what the adjustments themselves
  // carry — an add's own name, a target's `current` name (null once applied).
  const ownNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of s?.adjustments ?? []) {
      const name = a.kind === 'add' ? a.name : a.current?.name;
      if (name) map.set(a.itemKey, name);
    }
    return map;
  }, [s]);
  const nameOf = (key: string) => lines.get(key)?.name ?? ownNames.get(key) ?? null;

  // Keep the open scenario's banner name in step with the server's.
  useEffect(() => {
    if (active && s && s.id === active.id && s.name !== active.name) open({ id: s.id, name: s.name });
  }, [active, s, open]);

  const [dialog, setDialog] = useState<DialogName>(null);
  const [removingAdjustment, setRemovingAdjustment] = useState<Adjustment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!s) {
    if (detail.error?.status === 404) return <NoSuchScenario />;
    return (
      <div className="page">
        {detail.error ? <ErrorNote error={detail.error} onRetry={detail.reload} /> : <Loading what="Scenario" />}
      </div>
    );
  }

  const adjustments = s.adjustments;
  const staleCount = adjustments.filter((a) => a.stale).length;
  const isOpen = active?.id === s.id;
  const company = s.companyId === null ? 'All companies' : companies.data?.data.find((c) => c.id === s.companyId)?.name ?? `Company ${s.companyId}`;

  /** Replace the row from a mutation response, keeping the adjustments it does not carry. */
  const replaceRow = (row: Scenario) => detail.set({ ...s, ...row, adjustments: s.adjustments } as ScenarioDetail);

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <PageHeader
        fallback={{ to: '/scenarios', label: 'Scenarios' }}
        kicker={`SCENARIO #${s.id}`}
        title={s.name}
        actions={
          <>
            {isOpen ? (
              <button type="button" className="btn" onClick={close}>
                Close scenario
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  open({ id: s.id, name: s.name });
                  navigate(forecastLink(companyFilter, s.companyId));
                }}
              >
                Open in forecast
              </button>
            )}
            {isDraft && (
              <>
                <button type="button" className="btn" onClick={() => setDialog('rebase')}>
                  Rebase…
                </button>
                <button type="button" className="btn-primary" onClick={() => setDialog('apply')}>
                  Apply…
                </button>
              </>
            )}
            {s.status === 'applied' && (
              <button type="button" className="btn" onClick={() => setDialog('unapply')}>
                Un-apply…
              </button>
            )}
            {s.status !== 'archived' && (
              <button type="button" className="btn" onClick={() => setDialog('discard')}>
                {isDraft ? 'Discard…' : 'Archive…'}
              </button>
            )}
            <button type="button" className="btn" onClick={() => setDialog('duplicate')}>
              Duplicate…
            </button>
            <button type="button" className="btn" style={{ color: 'var(--fail)' }} onClick={() => setDialog('delete')}>
              Delete…
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pill tone={toneOfScenarioStatus(s.status)}>{SCENARIO_STATUS_LABEL[s.status] ?? s.status}</Pill>
          {isOpen && <Tag tone="waived">OPEN</Tag>}
          <span style={{ fontSize: 13.5, color: 'var(--mut)' }}>
            {company} · created {calendarDay(s.createdAt)} by {shortEmail(s.createdBy)}
          </span>
        </div>
        {s.description && <div className="explainer">{s.description}</div>}
      </PageHeader>

      {!isDraft && (
        <div className="panel" data-testid="not-draft" style={{ borderColor: 'var(--line2)' }}>
          <div className="kicker">{s.status === 'applied' ? 'APPLIED' : 'READ ONLY'}</div>
          <div style={{ fontSize: 14, color: 'var(--mut)', lineHeight: 1.6 }}>
            {s.status === 'applied'
              ? `Applied ${shortStamp(s.appliedAt)} by ${shortEmail(s.appliedBy)}. Its adjustments are the record of what was written to the real plan, and can no longer change.`
              : 'This scenario is archived. It can be read and duplicated, never changed or applied.'}{' '}
            Only a draft takes adjustments, a rebase or an apply — duplicate it to keep working.
            {s.status === 'applied' && ' Un-apply puts the real plan back and makes it a draft again.'}
          </div>
        </div>
      )}

      {notice && (
        <div className="panel" role="status" style={{ borderColor: 'var(--passBd)' }}>
          <span style={{ fontSize: 14 }}>{notice}</span>
        </div>
      )}
      {detail.error && <ErrorNote error={detail.error} onRetry={detail.reload} />}

      <section aria-label="Adjustments" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="head-row" style={{ alignItems: 'center' }}>
          <h2 className="report-title" style={{ margin: 0 }}>
            {plural(adjustments.length, 'adjustment')}
          </h2>
          {staleCount > 0 && (
            <span style={{ fontSize: 13.5, color: 'var(--fail)' }} data-testid="stale-count">
              {plural(staleCount, 'stale adjustment')} — apply is refused until {staleCount === 1 ? 'it is' : 'they are'} rebased or removed.
            </span>
          )}
        </div>
        {adjustments.length === 0 ? (
          <Empty>
            No adjustments yet.{' '}
            {isDraft ? 'Open the scenario, then change amounts and dates, split lines or add one-offs on the Forecast.' : ''}
          </Empty>
        ) : (
          <div className="card-table">
            <div className="table-head" style={{ gridTemplateColumns: ADJ_COLUMNS }}>
              <div>ITEM</div>
              <div>CHANGE</div>
              <div>REAL PLAN NOW</div>
              <div>STATE</div>
              <div />
            </div>
            {adjustments.map((a) => (
              <AdjustmentRow
                key={a.id}
                adjustment={a}
                name={a.kind === 'add' ? a.name : a.current?.name ?? nameOf(a.itemKey)}
                currency={a.kind === 'add' ? a.currency : a.current?.currency ?? lines.get(a.itemKey)?.currency ?? null}
                draft={isDraft}
                onRemove={() => setRemovingAdjustment(a)}
              />
            ))}
          </div>
        )}
      </section>

      {isDraft && (
        <EffectPanel
          effect={effect.data}
          loading={effect.loading}
          error={effect.error}
          onRetry={effect.reload}
          bucket={bucket}
          onBucket={(next) =>
            setParams(
              (prev) => {
                const out = new URLSearchParams(prev);
                if (next === 'week') out.delete('bucket');
                else out.set('bucket', next);
                return out;
              },
              { replace: true },
            )
          }
        />
      )}

      {dialog === 'rebase' && (
        <RebaseDialog
          scenario={s}
          staleCount={staleCount}
          onClose={() => setDialog(null)}
          onRebased={(res) => {
            const kept = res.adjustments.filter((a) => !a.dropped);
            detail.set({ ...s, ...res.scenario, adjustments: kept });
            const rebased = res.adjustments.filter((a) => a.rebased && !a.dropped).length;
            const dropped = res.adjustments.length - kept.length;
            const still = kept.filter((a) => a.stale).length;
            setNotice(
              `Rebased ${plural(rebased, 'adjustment')}${dropped ? `, dropped ${dropped}` : ''}.${still ? ` ${plural(still, 'adjustment')} still stale.` : ''}`,
            );
            setDialog(null);
            effect.reload();
          }}
        />
      )}
      {dialog === 'apply' && (
        <ApplyDialog
          scenario={s}
          staleCount={staleCount}
          nameOf={nameOf}
          onClose={() => setDialog(null)}
          onApplied={(res) => {
            replaceRow(res.scenario);
            if (isOpen) close();
            const items = res.applied.filter((x) => x.wrote === 'cash_item').length;
            const instances = res.applied.length - items;
            setNotice(
              `Applied: ${plural(res.applied.length, 'change')} written to the real plan (${plural(items, 'item')}, ${plural(instances, 'instance')}).`,
            );
            setDialog(null);
            // The stale markers and current values are null on an applied scenario (§6.11).
            detail.reload();
          }}
          onRefused={() => detail.reload()}
        />
      )}
      {dialog === 'unapply' && (
        <UnapplyDialog
          scenario={s}
          nameOf={nameOf}
          onClose={() => setDialog(null)}
          onUnapplied={(res) => {
            replaceRow(res.scenario);
            setNotice(`Un-applied: ${plural(res.unapplied.length, 'change')} reverted. The scenario is a draft again.`);
            setDialog(null);
            // A draft again: its adjustments' stale markers and current values are live once more.
            detail.reload();
          }}
          onRefused={() => detail.reload()}
        />
      )}
      {dialog === 'discard' && (
        <DiscardDialog
          scenario={s}
          onClose={() => setDialog(null)}
          onDiscarded={(row) => {
            replaceRow(row);
            if (isOpen) close();
            setNotice(isDraft ? 'Discarded. Nothing was written to the real plan.' : 'Archived.');
            setDialog(null);
          }}
        />
      )}
      {dialog === 'duplicate' && (
        <DuplicateScenarioDialog
          source={s}
          onClose={() => setDialog(null)}
          onDuplicated={(row) => {
            setDialog(null);
            setNotice(null);
            navigate(...openDetail(`/scenarios/${row.id}`, location));
          }}
        />
      )}
      {dialog === 'delete' && (
        <RemoveDialog
          kicker={`SCENARIO · ${s.name.toUpperCase()}`}
          title={`Delete ${s.name}?`}
          confirmLabel="Delete it"
          warning="Nothing it applied is undone. The scenario leaves every list; the audit log keeps it."
          remove={() => scenarios.remove(s.id, s.rowVersion)}
          onRemoved={() => {
            if (isOpen) close();
            navigate('/scenarios');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {removingAdjustment && (
        <RemoveDialog
          kicker={`SCENARIO · ${s.name.toUpperCase()}`}
          title={
            removingAdjustment.kind === 'add'
              ? `Remove ${removingAdjustment.name ?? removingAdjustment.itemKey} from this scenario?`
              : `Remove the adjustment to ${nameOf(removingAdjustment.itemKey) ?? removingAdjustment.itemKey}?`
          }
          warning={
            isSplitAnchor(removingAdjustment)
              ? "This undoes the split: its parts go too. The line goes back to the real plan's values in this scenario."
              : removingAdjustment.kind === 'add'
                ? removingAdjustment.splitGroup !== null
                  ? 'This part of a split goes; the line and the other parts stay as they are.'
                  : 'The one-off goes from this scenario. The real plan never had it.'
                : "The line goes back to the real plan's values in this scenario."
          }
          remove={() => scenarios.removeAdjustment(s.id, removingAdjustment.itemKey, removingAdjustment.rowVersion)}
          onRemoved={() => {
            // Deleting a split's anchor deletes its group on the server (D40); the list follows.
            const gone = (a: Adjustment) =>
              a.id === removingAdjustment.id || (isSplitAnchor(removingAdjustment) && a.splitGroup === removingAdjustment.id);
            detail.set({ ...s, adjustments: s.adjustments.filter((a) => !gone(a)) });
            setRemovingAdjustment(null);
            effect.reload();
          }}
          onClose={() => setRemovingAdjustment(null)}
        />
      )}
    </div>
  );
}

const ADJ_COLUMNS = 'minmax(0, 1.3fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1.4fr) 70px';

/**
 * A stale marker: the reason's word, and what happened in a sentence. `kind` is the
 * adjustment's: an `add` has no target, so its MISSING means its account or category went.
 */
export function StaleMarker({ reason, kind }: { reason: string; kind?: Adjustment['kind'] }) {
  const r = staleReason(reason, kind);
  if (!r) return null;
  return (
    <div data-testid="stale-marker" data-reason={reason} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>
        <Tag tone="fail">STALE · {r.label}</Tag>
      </span>
      <span style={{ fontSize: 12.5, color: 'var(--mut)', lineHeight: 1.5 }}>{r.text}</span>
      <span style={{ fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 }}>{r.fix}</span>
    </div>
  );
}

function AdjustmentRow({
  adjustment: a,
  name,
  currency,
  draft,
  onRemove,
}: {
  adjustment: Adjustment;
  name: string | null;
  currency: string | null;
  draft: boolean;
  onRemove: () => void;
}) {
  const add = a.kind === 'add';
  const anchor = isSplitAnchor(a);
  const part = add && a.splitGroup !== null && a.splitGroup !== a.id;
  return (
    <div className="table-row" style={{ gridTemplateColumns: ADJ_COLUMNS, alignItems: 'start' }} data-testid={`adjustment-${a.itemKey}`}>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontSize: 14 }}>{name ?? (add ? 'One-off' : a.targetKind === 'sched' ? 'Schedule instance' : 'Item')}</div>
        {(add || anchor) && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {add && <Tag tone="live">NEW ONE-OFF</Tag>}
            {part && <Tag>SPLIT PART</Tag>}
            {anchor && (
              <>
                <Tag>SPLIT</Tag>
                <span style={{ fontSize: 12, color: 'var(--dim)' }}>split into parts</span>
              </>
            )}
          </div>
        )}
        <div className="mono" style={{ fontSize: 11.5, color: 'var(--dim)' }}>
          {a.itemKey}
        </div>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {add ? (
          // A one-off of the scenario's own: what it is, not a change from anything (D39).
          <div data-testid="add-change">
            <span className="mono">{amountText(a.newAmount, currency)}</span> on{' '}
            <span className="mono">{formatDay(a.newDate)}</span>
          </div>
        ) : a.kind === 'exclude' ? (
          <Tag>LEFT OUT</Tag>
        ) : (
          <>
            {a.newDate && (
              <div>
                <span className="mono">{formatDay(a.baseDate)}</span> → <span className="mono">{formatDay(a.newDate)}</span>
              </div>
            )}
            {a.newAmount && (
              <div>
                <span className="mono">{amountText(a.baseAmount, currency)}</span> →{' '}
                <span className="mono">{amountText(a.newAmount, currency)}</span>
              </div>
            )}
          </>
        )}
        {a.note && <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>{a.note}</div>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--mut)', lineHeight: 1.6 }}>
        {add ? (
          // `current` is always null on an add: there is no real line, which is not "gone".
          <span style={{ color: 'var(--dim)' }}>not in the real plan</span>
        ) : a.current ? (
          <>
            <div className="mono">{formatDay(a.current.date)}</div>
            <div className="mono">{amountText(a.current.amount, currency)}</div>
            <div>{a.current.status}</div>
          </>
        ) : (
          <span style={{ color: 'var(--dim)' }}>{draft ? 'gone' : '—'}</span>
        )}
      </div>
      <div>
        {a.stale ? (
          <StaleMarker reason={a.stale} kind={a.kind} />
        ) : draft ? (
          <Tag tone="done">UP TO DATE</Tag>
        ) : (
          <span style={{ color: 'var(--dim)', fontSize: 12.5 }}>history</span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {draft && (
          <button type="button" className="btn-quiet" style={{ color: 'var(--fail)' }} onClick={onRemove} aria-label={`Remove the adjustment to ${a.itemKey}`}>
            remove
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What the scenario changes, from the forecast's own comparison: the summary against the
 * baseline's (`scenario.baselineSummary`) and each bucket's difference
 * (`scenario.deltaByBucket`, scenario − baseline). Buckets it does not change are folded.
 */
function EffectPanel({
  effect,
  loading,
  error,
  onRetry,
  bucket,
  onBucket,
}: {
  effect: ForecastResponse | null;
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  bucket: BucketKind;
  onBucket: (next: BucketKind) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const scenario = effect?.scenario ?? null;
  const deltas = scenario?.deltaByBucket ?? [];
  const changed = deltas.filter(
    (d) => toMinor(d.inflow) !== 0n || toMinor(d.outflow) !== 0n || toMinor(d.net) !== 0n || toMinor(d.closing) !== 0n,
  );
  const shown = showAll ? deltas : changed;
  const kind = effect?.meta.bucket ?? bucket;

  return (
    <section className="panel" aria-label="Effect on the forecast" style={{ gap: 12 }}>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2 className="report-title" style={{ margin: 0 }}>
            Against the real plan
          </h2>
          <div style={{ fontSize: 13, color: 'var(--mut)' }}>
            This scenario minus the real plan, all accounts in GBP{effect ? `, ${formatDay(effect.meta.from)} – ${formatDay(effect.meta.to)}` : ''}.
          </div>
        </div>
        <Segmented ariaLabel="Delta bucket" compact options={BUCKET_OPTIONS} value={bucket} onChange={onBucket} />
      </div>
      {error && <ErrorNote error={error} onRetry={onRetry} />}
      {!effect || !scenario ? (
        !error && (loading ? <Loading what="Comparison" /> : null)
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }} data-testid="effect-summary">
            {(
              [
                ['END OF WINDOW', scenario.baselineSummary.closing, effect.summary.closing],
                ['LOWEST POINT', scenario.baselineSummary.minClosing, effect.summary.minClosing],
                ['MONEY IN', scenario.baselineSummary.inflow, effect.summary.inflow],
                ['MONEY OUT', scenario.baselineSummary.outflow, effect.summary.outflow],
              ] as const
            ).map(([label, base, now]) => (
              <div key={label} className="panel" style={{ flex: '1 1 170px', gap: 3 }}>
                <div className="kicker">{label}</div>
                <div className="mono" style={{ fontSize: 17, color: toMinor(now) < 0n ? 'var(--fail)' : undefined }}>
                  {formatMoney(toMinor(now), 'GBP')}
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
                  real plan {formatMoney(toMinor(base), 'GBP')} · {signedMoney(toMinor(now) - toMinor(base))}
                </div>
              </div>
            ))}
          </div>
          {deltas.length === 0 ? null : changed.length === 0 && !showAll ? (
            <Empty>This scenario changes nothing in the window.</Empty>
          ) : (
            <div className="card-table" data-testid="delta-table">
              <div className="table-head" style={{ gridTemplateColumns: DELTA_COLUMNS }}>
                <div>PERIOD</div>
                <div style={{ textAlign: 'right' }}>IN</div>
                <div style={{ textAlign: 'right' }}>OUT</div>
                <div style={{ textAlign: 'right' }}>NET</div>
                <div style={{ textAlign: 'right' }}>CLOSING</div>
              </div>
              {shown.map((d) => (
                <div key={d.start} className="table-row" style={{ gridTemplateColumns: DELTA_COLUMNS }}>
                  <div className="mono" style={{ fontSize: 12.5 }}>
                    {bucketLabel(d, kind)}
                  </div>
                  {[d.inflow, d.outflow, d.net, d.closing].map((v, i) => {
                    const minor = toMinor(v);
                    return (
                      <div
                        key={i}
                        className="mono"
                        style={{ fontSize: 12.5, textAlign: 'right', color: minor === 0n ? 'var(--dim)' : undefined }}
                      >
                        {minor === 0n ? '—' : signedMoney(minor)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {deltas.length > changed.length && (
            <div>
              <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Only the periods it changes' : `Show all ${deltas.length} periods`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const DELTA_COLUMNS = 'minmax(0, 1.2fr) repeat(4, minmax(0, 1fr))';
