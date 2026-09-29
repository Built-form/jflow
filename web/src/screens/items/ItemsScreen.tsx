import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { items } from '../../api/items';
import type { Item } from '../../api/items';
import type { Account } from '../../api/types';
import { useQuery } from '../../app/useQuery';
import { useSubmit } from '../../app/useSubmit';
import { CompanyPicker, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { PageHeader } from '../../components/PageHeader';
import { PayDialog, PaymentsList, UnpayDialog } from '../../components/PayDialog';
import { Empty, ErrorNote, InfoText, Loading, Segmented, Tag } from '../../components/ui';
import { addDays, formatDay, londonToday } from '../../lib/dates';
import { formatDecimal } from '../../lib/money';
import { removeById, updateList, upsertById } from '../../lib/rows';
import { RemoveDialog } from '../settings/RemoveDialog';
import { ASSUMED_SETTLED, derivedStatusLabel, groupByDerivedStatus } from './grouping';
import { DidntHappenDialog, GroupFilter, GroupSection, RowAction, useShowFilter } from './groups';
import { ITEMS_KICKER, ItemDialog } from './ItemDialog';

export const DAYS_PARAM = 'days';
const WINDOWS = ['30', '90', '365', 'all'] as const;
type Window = (typeof WINDOWS)[number];

/** `?days=` as a window back from today; 90 for anything else. */
export function parseItemsWindow(raw: string | null): Window {
  return (WINDOWS as readonly string[]).includes(raw ?? '') ? (raw as Window) : '90';
}

const COLUMNS = '118px minmax(0, 1.5fr) minmax(0, 1fr) 150px minmax(0, 1.1fr)';

/** Server date order (D28), kept after a row is replaced or added. */
function byDue(a: Item, b: Item): number {
  return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id;
}

type Paying = { item: Item; confirming: boolean };

/**
 * Income & outgoings: one-off money in and out, grouped by the server's `derivedStatus`.
 *
 * Every group, and which one a row sits in, comes from the server (CONTRACT D10, §9.6).
 * The "Assumed settled" group is what a recorded balance quietly swallowed: automatic
 * items dated before it that nobody confirmed. Each offers Confirm paid, or Didn't happen
 * — which makes it settled-by-hand so it reappears as overdue. That is where a bounced
 * payment gets noticed.
 */
export function ItemsScreen() {
  const [today] = useState(() => londonToday());
  const [params, setParams] = useSearchParams();
  const [companyId, setCompanyId] = useCompanyFilter();
  const [show, setShow] = useShowFilter();
  const windowDays = parseItemsWindow(params.get(DAYS_PARAM));
  const from = windowDays === 'all' ? undefined : addDays(today, -Number(windowDays));

  const companies = useQuery(() => api.companies.list(), []);
  const accounts = useQuery(() => api.accounts.list({ companyId }), [companyId]);
  const categories = useQuery(() => api.categories.list(), []);
  const list = useQuery(() => items.listAll({ companyId, from }), [companyId, from]);

  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [paying, setPaying] = useState<Paying | null>(null);
  const [unpaying, setUnpaying] = useState<Item | null>(null);
  const [didntHappen, setDidntHappen] = useState<Item | null>(null);
  const [removing, setRemoving] = useState<Item | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useSubmit();

  const companyRows = sortCompanies(companies.data?.data ?? []);
  const accountRows = accounts.data?.data ?? [];
  const categoryRows = categories.data?.data ?? [];
  const accountOf = (id: number) => accountRows.find((a) => a.id === id);
  const categoryOf = (id: number) => categoryRows.find((c) => c.id === id);
  const pickable: Account[] = accountRows.filter((a) => a.isActive && !a.deletedAt);

  const groups = useMemo(() => groupByDerivedStatus(list.data?.data ?? []), [list.data]);
  const visible = show === null ? groups : groups.filter((g) => g.id === show);

  /** Replace-from-response: the row as the server now holds it. */
  const replace = (row: Item) => {
    if (companyId !== null && row.companyId !== companyId) {
      updateList(list, (rows) => removeById(rows, row.id));
      return;
    }
    updateList(list, (rows) => upsertById(rows, row).sort(byDue));
  };

  const setWindow = (next: Window) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === '90') out.delete(DAYS_PARAM);
        else out.set(DAYS_PARAM, next);
        return out;
      },
      { replace: true },
    );

  const skip = (item: Item, skipped: boolean) => {
    setNotice(null);
    void action.run(async () => {
      replace(await items.update(item.id, { status: skipped ? 'skipped' : 'expected' }, item.rowVersion));
    });
  };

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <PageHeader
        title="Income & outgoings"
        actions={
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <CompanyPicker companies={companyRows} value={companyId} onChange={setCompanyId} />
            <button type="button" className="btn-primary" disabled={pickable.length === 0} onClick={() => setEditing('new')}>
              Add a one-off
            </button>
          </div>
        }
      >
        <InfoText className="explainer">
          One-off money in and out. Mark each paid or part-paid as it happens. Items settled
          automatically are assumed to be in the bank once a later balance is recorded — check
          those under Assumed settled.
        </InfoText>
      </PageHeader>

      {companies.error && <ErrorNote error={companies.error} onRetry={companies.reload} />}
      {accounts.error && <ErrorNote error={accounts.error} onRetry={accounts.reload} />}
      {categories.error && <ErrorNote error={categories.error} onRetry={categories.reload} />}
      {action.error && <ErrorNote error={action.error} />}
      {notice && (
        <div role="status" className="note-panel">
          {notice}
        </div>
      )}

      <div className="head-row" style={{ alignItems: 'center' }}>
        <GroupFilter groups={groups} value={show} onChange={setShow} />
        <Segmented<Window>
          ariaLabel="Due from"
          compact
          options={[
            { id: '30', label: '30 days back' },
            { id: '90', label: '90 days back' },
            { id: '365', label: '1 year back' },
            { id: 'all', label: 'All' },
          ]}
          value={windowDays}
          onChange={setWindow}
        />
      </div>
      {from && (
        <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>
          Due from {formatDay(from)} onwards. Pick a longer window for anything older.
        </div>
      )}

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? (
        !list.error && <Loading what="Income & outgoings" />
      ) : groups.length === 0 ? (
        <Empty>
          Nothing {from ? `due since ${formatDay(from)}` : 'yet'}.{' '}
          {pickable.length === 0 && (
            <>
              Add a bank account in <Link to="/settings?tab=accounts">Settings</Link> first.
            </>
          )}
        </Empty>
      ) : visible.length === 0 ? (
        <Empty>Nothing in that group now.</Empty>
      ) : (
        visible.map((group) => (
          <GroupSection key={group.id} group={group}>
            <div className="card-table">
              <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
                <div>DUE</div>
                <div>ITEM</div>
                <div>ACCOUNT · CATEGORY</div>
                <div style={{ textAlign: 'right' }}>AMOUNT</div>
                <div />
              </div>
              {group.rows.map((item) => {
                const account = accountOf(item.accountId);
                const category = categoryOf(item.categoryId);
                const partPaid = item.status === 'part_paid';
                const owed = item.status === 'expected' || partPaid;
                return (
                  <div
                    key={item.id}
                    className="table-row"
                    data-testid={`item-${item.id}`}
                    style={{ gridTemplateColumns: COLUMNS, alignItems: 'start' }}
                  >
                    <div className="mono" style={{ fontSize: 12.5, paddingTop: 2 }}>
                      {formatDay(item.dueDate)}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      <span style={{ fontSize: 14.5 }}>{item.name}</span>
                      {item.counterparty && (
                        <span style={{ fontSize: 12.5, color: 'var(--mut)' }}>{item.counterparty}</span>
                      )}
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {partPaid && <Tag tone="warn">PART PAID</Tag>}
                        {item.settleMode === 'manual' && <Tag>BY HAND</Tag>}
                        {item.sourceScenarioId !== null && <Tag>FROM SCENARIO</Tag>}
                      </span>
                      <PaymentsList payments={item.payments} currency={item.currency} />
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--mut)', lineHeight: 1.5 }}>
                      {account?.name ?? `Account ${item.accountId}`}
                      <br />
                      <span style={{ color: 'var(--dim)' }}>{category?.name ?? `Category ${item.categoryId}`}</span>
                    </div>
                    <div className="mono" style={{ fontSize: 13.5, textAlign: 'right' }}>
                      {item.direction === 'in' ? '+' : '−'}
                      {formatDecimal(item.amount, item.currency)}
                      {partPaid && (
                        <div style={{ fontSize: 12, color: 'var(--mut)' }}>
                          {formatDecimal(item.remainingAmount, item.currency)} left
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      {group.id === ASSUMED_SETTLED ? (
                        <>
                          <RowAction label={`Confirm paid, ${item.name}`} onClick={() => setPaying({ item, confirming: true })}>
                            Confirm paid
                          </RowAction>
                          <RowAction label={`Didn't happen, ${item.name}`} tone="fail" onClick={() => setDidntHappen(item)}>
                            Didn't happen
                          </RowAction>
                        </>
                      ) : (
                        owed && (
                          <RowAction label={`Pay, ${item.name}`} onClick={() => setPaying({ item, confirming: false })}>
                            {partPaid ? 'pay the rest' : 'pay'}
                          </RowAction>
                        )
                      )}
                      {item.payments.length > 0 && (
                        <RowAction label={`Unpay, ${item.name}`} tone="mut" onClick={() => setUnpaying(item)}>
                          unpay
                        </RowAction>
                      )}
                      {item.status === 'expected' && (
                        <RowAction label={`Skip, ${item.name}`} tone="mut" onClick={() => skip(item, true)}>
                          skip
                        </RowAction>
                      )}
                      {item.status === 'skipped' && (
                        <RowAction label={`Unskip, ${item.name}`} tone="mut" onClick={() => skip(item, false)}>
                          unskip
                        </RowAction>
                      )}
                      <RowAction label={`Edit, ${item.name}`} onClick={() => setEditing(item)}>
                        edit
                      </RowAction>
                      <RowAction label={`Remove, ${item.name}`} tone="fail" onClick={() => setRemoving(item)}>
                        remove
                      </RowAction>
                    </div>
                  </div>
                );
              })}
            </div>
          </GroupSection>
        ))
      )}

      {editing && (
        <ItemDialog
          item={editing === 'new' ? null : editing}
          accounts={
            editing !== 'new' && !pickable.some((a) => a.id === editing.accountId)
              ? [...pickable, ...accountRows.filter((a) => a.id === editing.accountId)]
              : pickable
          }
          categories={categoryRows}
          today={today}
          defaultAccount={pickable.find((a) => a.isDefault) ?? (pickable.length === 1 ? pickable[0] : null)}
          onSaved={(row) => {
            replace(row);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {paying && (
        <PayDialog
          kicker={ITEMS_KICKER}
          title={paying.confirming ? `Confirm ${paying.item.name} was paid` : `Pay ${paying.item.name}`}
          target={{
            amount: paying.item.amount,
            remaining: paying.item.remainingAmount,
            currency: paying.item.currency,
            effectiveDate: paying.item.dueDate,
            payments: paying.item.payments,
          }}
          today={today}
          defaultPaidOn={paying.confirming ? paying.item.dueDate : undefined}
          intro={
            paying.confirming
              ? 'The pay date starts at its due date, which the recorded balance is assumed to include. Change it if the money moved on another day.'
              : undefined
          }
          pay={async (body) => replace(await items.pay(paying.item.id, body, paying.item.rowVersion))}
          onPaid={() => setPaying(null)}
          onClose={() => setPaying(null)}
        />
      )}

      {unpaying && (
        <UnpayDialog
          kicker={ITEMS_KICKER}
          title={`Unpay ${unpaying.name}?`}
          payments={unpaying.payments}
          currency={unpaying.currency}
          unpay={async () => replace(await items.unpay(unpaying.id, unpaying.rowVersion))}
          onDone={() => setUnpaying(null)}
          onClose={() => setUnpaying(null)}
        />
      )}

      {didntHappen && (
        <DidntHappenDialog
          kicker={ITEMS_KICKER}
          title={`${didntHappen.name} didn't happen?`}
          detail={`${formatDecimal(didntHappen.amount, didntHappen.currency)}, due ${formatDay(didntHappen.dueDate)}.`}
          confirm={async () => {
            const row = await items.update(didntHappen.id, { settleMode: 'manual' }, didntHappen.rowVersion);
            replace(row);
            setNotice(
              `${row.name} is now settled by hand. It shows under ${derivedStatusLabel(row.derivedStatus)} until it is paid, re-dated or skipped.`,
            );
          }}
          onDone={() => setDidntHappen(null)}
          onClose={() => setDidntHappen(null)}
        />
      )}

      {removing && (
        <RemoveDialog
          kicker={ITEMS_KICKER}
          title={`Remove ${removing.name}?`}
          warning="It leaves the forecast and this list. A scenario that adjusts it will show the adjustment as stale."
          remove={() => items.remove(removing.id, removing.rowVersion)}
          onRemoved={() => {
            updateList(list, (rows) => removeById(rows, removing.id));
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        >
          {formatDecimal(removing.amount, removing.currency)}, due {formatDay(removing.dueDate)}.
        </RemoveDialog>
      )}
    </div>
  );
}
