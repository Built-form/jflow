import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from '../../api/client';
import type { RefreshResult } from '../../api/external';
import { external } from '../../api/external';
import type { ForecastShipping } from '../../api/forecast';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { ErrorNote } from '../../components/ui';
import { lastSyncText, shippingReasonText, shippingStatusParts, unmappedNote } from '../../lib/ship';
import type { ShipWarnings } from '../../lib/ship';

/**
 * The shipping feed on the Forecast (Phase 2): a one-line status from the `shipping`
 * block with "Refresh now", the `SHIPPING_UNAVAILABLE` banner, and the notes for rows left
 * out (`SHIP_UNMAPPED`) and plans that no longer hold (`SHIP_PLAN_STALE`,
 * `SHIP_PLAN_ORPHANED`). Every figure is the server's.
 */

/** What a failed refresh (503 `SHIPPING_UNAVAILABLE`) says, in words. */
export function refreshFailureText(error: ApiError): string | null {
  if (error.code !== 'SHIPPING_UNAVAILABLE') return null;
  const d = (error.details ?? {}) as Record<string, unknown>;
  const reason = shippingReasonText(typeof d.reason === 'string' ? d.reason : null);
  const last = typeof d.lastSuccessAt === 'string' ? d.lastSuccessAt : null;
  return last
    ? `Not refreshed: ${reason}. The snapshot from ${lastSyncText(last)} is still in use.`
    : `Not refreshed: ${reason}. The feed has never synced, so there are no stock payments yet.`;
}

/**
 * "Refresh now": `POST /external/refresh` (the 10-minute wait is skipped, the 60-second
 * claim is not), then `onRefreshed` so the screen re-reads what it shows. A run another
 * tab already started answers `ran: false` — the screen still re-reads and says so.
 */
export function RefreshButton({
  onRefreshed,
  label = 'Refresh now',
}: {
  onRefreshed: (result: RefreshResult) => void;
  label?: string;
}) {
  const submit = useSubmit();
  const [note, setNote] = useState<string | null>(null);
  const run = () => {
    setNote(null);
    void submit.run(async () => {
      const result = await external.refresh();
      setNote(result.ran ? null : 'Another refresh was already running; this shows the latest snapshot.');
      onRefreshed(result);
    });
  };
  const failure = submit.error ? refreshFailureText(submit.error) : null;
  return (
    <>
      <button type="button" className="btn" disabled={submit.busy} onClick={run}>
        {submit.busy ? 'Refreshing…' : label}
      </button>
      {note && (
        <span role="status" style={{ fontSize: 12.5, color: 'var(--mut)', flexBasis: '100%' }}>
          {note}
        </span>
      )}
      {submit.error && (
        <div style={{ flexBasis: '100%' }} data-testid="refresh-error">
          {failure ? (
            <div className="error-banner" role="alert">
              <span>
                {failure}
                <span className="mono" style={{ color: 'var(--dim)', marginLeft: 8, fontSize: 12 }}>
                  SHIPPING_UNAVAILABLE
                </span>
              </span>
            </div>
          ) : (
            <ErrorNote error={submit.error} />
          )}
        </div>
      )}
    </>
  );
}

/** The `shipping` block as one line, and "Refresh now". */
export function ShippingStatus({
  shipping,
  onRefreshed,
}: {
  shipping: ForecastShipping | null | undefined;
  onRefreshed: () => void;
}) {
  const parts = shippingStatusParts(shipping);
  return (
    <div
      data-testid="shipping-status"
      style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, color: 'var(--mut)' }}
    >
      <span className="kicker">STOCK PAYMENTS FEED</span>
      <span className="mono" data-testid="shipping-status-line">
        {parts.join(' · ')}
      </span>
      <Link to="/stock-payments" style={{ fontSize: 12.5 }}>
        List them
      </Link>
      <RefreshButton onRefreshed={() => onRefreshed()} />
    </div>
  );
}

/** `SHIPPING_UNAVAILABLE` on a 200: the refresh that was due failed; the forecast uses the last snapshot. */
export function ShippingUnavailableBanner({ warning }: { warning: ShipWarnings['unavailable'] }) {
  if (!warning) return null;
  const reason = shippingReasonText(warning.reason);
  return (
    <div className="error-banner" role="alert" data-testid="shipping-unavailable" style={{ borderColor: 'var(--warnBd)', background: 'var(--warnBg)' }}>
      <span>
        Stock payments could not be refreshed: {reason}.{' '}
        {warning.lastSuccessAt
          ? `The forecast uses the snapshot from ${lastSyncText(warning.lastSuccessAt)}.`
          : 'The feed has never synced, so no stock payments are in the forecast.'}
        <span className="mono" style={{ color: 'var(--dim)', marginLeft: 8, fontSize: 12 }}>
          SHIPPING_UNAVAILABLE · {warning.reason}
        </span>
      </span>
    </div>
  );
}

/**
 * `SHIP_UNMAPPED`, `SHIP_PLAN_STALE` and `SHIP_PLAN_ORPHANED`, in words. Unmapped rows say
 * why — no JFlow company linked (→ Settings, Companies) or no account to land on (→ Settings,
 * Accounts); POs with no company are fixed in shipping. A stale plan is also
 * marked on its line; an orphaned one has no line (shipping no longer lists the row), so it
 * is listed here with a way to clear it.
 */
export function ShipNotes({
  warnings,
  lineName,
  companyName,
  onChanged,
}: {
  warnings: ShipWarnings;
  lineName: (key: string) => string | null;
  /** A JFlow company's name, from the companies the screen loaded. */
  companyName: (id: number) => string;
  /** After an orphaned plan is cleared: re-read the forecast. */
  onChanged: () => void;
}) {
  const { unmapped, stale, orphaned } = warnings;
  if (unmapped.length === 0 && stale.length === 0 && orphaned.length === 0) return null;
  return (
    <section
      aria-label="Stock payment notes"
      data-testid="ship-notes"
      style={{
        border: '1px solid var(--warnBd)',
        background: 'var(--warnBg)',
        borderRadius: 'var(--radius)',
        padding: '12px 15px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 13.5,
        lineHeight: 1.55,
      }}
    >
      {unmapped.length > 0 && <UnmappedNote unmapped={unmapped} companyName={companyName} />}
      {stale.map((key) => (
        <div key={`stale-${key}`} data-testid={`ship-stale-${key}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span className="mono" style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--warn)' }}>
            SHIP_PLAN_STALE
          </span>
          <span>
            {lineName(key) ?? key}: shipping's amount changed since its planned amount was set, so the planned amount is
            ignored. Open the line to plan it again.
          </span>
        </div>
      ))}
      {orphaned.map((key) => (
        <OrphanedPlan key={`orphan-${key}`} itemKey={key} onCleared={onChanged} />
      ))}
    </section>
  );
}

function UnmappedNote({ unmapped, companyName }: { unmapped: ShipWarnings['unmapped']; companyName: (id: number) => string }) {
  // Names for the shipping companies, read only when something is unmapped. A failed read
  // costs nothing but the name: the id is shown instead.
  const status = useQuery(() => external.status(), []);
  const shippingName = (id: number) => status.data?.companies.find((c) => c.id === id)?.name ?? `#${id}`;
  return (
    <>
      {unmapped.map((u) => {
        const note = unmappedNote(u, { shippingName, companyName });
        return (
          <div
            key={`unmapped-${u.shippingCompanyId ?? 'none'}-${u.reason}`}
            data-testid="ship-unmapped"
            data-reason={u.reason}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}
          >
            <span className="mono" style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--warn)' }}>
              SHIP_UNMAPPED
            </span>
            <span>
              {note.text}
              {note.fix && (
                <>
                  {' '}
                  <Link to={note.fix.to}>{note.fix.label}</Link>.
                </>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}

function OrphanedPlan({ itemKey, onCleared }: { itemKey: string; onCleared: () => void }) {
  const submit = useSubmit();
  return (
    <div data-testid={`ship-orphaned-${itemKey}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--warn)' }}>
          SHIP_PLAN_ORPHANED
        </span>
        <span>
          A plan is left on <span className="mono">{itemKey}</span>, which shipping no longer lists (its stage changed or
          the PO went away). It does nothing now; plan the payment that replaced it.
        </span>
        <button
          type="button"
          className="btn-quiet"
          style={{ color: 'var(--acc)' }}
          disabled={submit.busy}
          onClick={() =>
            void submit.run(async () => {
              await external.unplan(itemKey);
              onCleared();
            })
          }
        >
          {submit.busy ? 'Clearing…' : 'Clear the plan'}
        </button>
      </div>
      {submit.error && <ErrorNote error={submit.error} />}
    </div>
  );
}
