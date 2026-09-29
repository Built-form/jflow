import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { Scenario, ScenarioStatus } from '../../api/scenarios';
import { scenarios } from '../../api/scenarios';
import { useScenario } from '../../app/ScenarioContext';
import { COMPANY_PARAM, sortCompanies, useCompanyFilter } from '../../app/companyFilter';
import { useQuery } from '../../app/useQuery';
import { PageHeader, openDetail } from '../../components/PageHeader';
import { Empty, ErrorNote, InfoText, Loading, Pill, Segmented } from '../../components/ui';
import { calendarDay, shortEmail } from '../../lib/format';
import { removeById, updateList } from '../../lib/rows';
import { toneOfScenarioStatus } from '../../lib/tone';
import { RemoveDialog } from '../settings/RemoveDialog';
import { CreateScenarioDialog, DuplicateScenarioDialog } from './dialogs';
import { SCENARIO_STATUS_LABEL } from './stale';

export const STATUS_PARAM = 'status';
type StatusFilter = ScenarioStatus | 'all';
const STATUS_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Drafts' },
  { id: 'applied', label: 'Applied' },
  { id: 'archived', label: 'Archived' },
];

export function parseStatusFilter(raw: string | null): StatusFilter {
  return raw === 'draft' || raw === 'applied' || raw === 'archived' ? raw : 'all';
}

const COLUMNS = 'minmax(0, 1.6fr) 90px 110px 100px 150px 250px';

/** Where "Open" lands: the Forecast, keeping the company filter the person is on. */
export function forecastLink(companyId: number | null, scenarioCompanyId: number | null): string {
  const company = companyId ?? scenarioCompanyId;
  return company === null ? '/forecast' : `/forecast?${COMPANY_PARAM}=${company}`;
}

/**
 * Named what-ifs. Opening one puts it in `ScenarioContext`: every screen shows the banner,
 * and the Forecast's edits write adjustments to it instead of the real plan.
 */
export function ScenariosScreen() {
  const [params, setParams] = useSearchParams();
  const status = parseStatusFilter(params.get(STATUS_PARAM));
  const [companyId] = useCompanyFilter();
  const navigate = useNavigate();
  const location = useLocation();
  const { active, open, close } = useScenario();

  const list = useQuery(() => scenarios.list({ status: status === 'all' ? undefined : [status] }), [status]);
  const companies = useQuery(() => api.companies.list(), []);
  const companyRows = sortCompanies(companies.data?.data ?? []);
  const codeOf = (id: number | null) => (id === null ? 'ALL' : companyRows.find((c) => c.id === id)?.code ?? `#${id}`);

  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<Scenario | null>(null);
  const [removing, setRemoving] = useState<Scenario | null>(null);

  const setStatus = (next: StatusFilter) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === 'all') out.delete(STATUS_PARAM);
        else out.set(STATUS_PARAM, next);
        return out;
      },
      { replace: true },
    );

  const openScenario = (s: Scenario) => {
    open({ id: s.id, name: s.name });
    navigate(forecastLink(companyId, s.companyId));
  };

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <PageHeader
        title="Scenarios"
        actions={
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            New scenario
          </button>
        }
      >
        <InfoText className="explainer">
          Named what-ifs. Open one and the Forecast's changes are written to it, not to the real
          plan. Apply it to make them real, or discard it.
        </InfoText>
      </PageHeader>

      <Segmented ariaLabel="Status" options={STATUS_OPTIONS} value={status} onChange={setStatus} />

      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {!list.data ? (
        !list.error && <Loading what="Scenarios" />
      ) : (
        <div className="card-table">
          <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
            <div>NAME</div>
            <div>COMPANY</div>
            <div>STATUS</div>
            <div>CHANGES</div>
            <div>CREATED</div>
            <div />
          </div>
          {list.data.data.length === 0 && (
            <Empty>{status === 'all' ? 'No scenarios yet.' : `No ${STATUS_OPTIONS.find((o) => o.id === status)?.label.toLowerCase()}.`}</Empty>
          )}
          {list.data.data.map((s) => {
            const isOpen = active?.id === s.id;
            return (
              <div
                key={s.id}
                className="table-row"
                style={{ gridTemplateColumns: COLUMNS, background: isOpen ? 'var(--waivedBg)' : undefined }}
                data-testid={`scenario-${s.id}`}
              >
                <div style={{ minWidth: 0 }}>
                  <button
                    type="button"
                    className="link-btn"
                    style={{ fontSize: 14.5, textAlign: 'left' }}
                    onClick={() => navigate(...openDetail(`/scenarios/${s.id}`, location))}
                  >
                    {s.name}
                  </button>
                  {s.description && (
                    <div style={{ fontSize: 12.5, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.description}
                    </div>
                  )}
                </div>
                <div className="mono" style={{ fontSize: 12.5 }}>
                  {codeOf(s.companyId)}
                </div>
                <div>
                  <Pill tone={toneOfScenarioStatus(s.status)}>{SCENARIO_STATUS_LABEL[s.status] ?? s.status}</Pill>
                </div>
                <div className="mono" style={{ fontSize: 13 }}>
                  {s.adjustmentCount}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                  {calendarDay(s.createdAt)}
                  <br />
                  <span style={{ color: 'var(--dim)' }}>{shortEmail(s.createdBy)}</span>
                </div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  {isOpen ? (
                    <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={close}>
                      close
                    </button>
                  ) : (
                    <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => openScenario(s)}>
                      open
                    </button>
                  )}
                  <button type="button" className="btn-quiet" style={{ color: 'var(--acc)' }} onClick={() => setDuplicating(s)}>
                    duplicate
                  </button>
                  <button type="button" className="btn-quiet" style={{ color: 'var(--fail)' }} onClick={() => setRemoving(s)}>
                    delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <CreateScenarioDialog
          companies={companies.data?.data ?? []}
          defaultCompanyId={companyId}
          onClose={() => setCreating(false)}
          onCreated={(row) => {
            updateList(list, (rows) => [row, ...rows]);
            setCreating(false);
            navigate(...openDetail(`/scenarios/${row.id}`, location));
          }}
        />
      )}
      {duplicating && (
        <DuplicateScenarioDialog
          source={duplicating}
          onClose={() => setDuplicating(null)}
          onDuplicated={(row) => {
            // Newest first (D28): the copy goes to the top, unless this filter hides drafts.
            if (status === 'all' || status === 'draft') updateList(list, (rows) => [row, ...removeById(rows, row.id)]);
            setDuplicating(null);
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          kicker="SCENARIOS"
          title={`Delete ${removing.name}?`}
          confirmLabel="Delete it"
          warning="Nothing it applied is undone. The scenario and its adjustments leave every list; the audit log keeps them."
          remove={() => scenarios.remove(removing.id, removing.rowVersion)}
          onRemoved={() => {
            if (active?.id === removing.id) close();
            updateList(list, (rows) => removeById(rows, removing.id));
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

