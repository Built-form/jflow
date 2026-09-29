import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { InfoText, Segmented } from '../../components/ui';
import type { SegmentOption } from '../../components/ui';
import { CompaniesSection } from './CompaniesSection';
import { AccountsSection } from './AccountsSection';
import { CategoriesSection } from './CategoriesSection';
import { FxRatesSection } from './FxRatesSection';

type Tab = 'companies' | 'accounts' | 'categories' | 'fx';

const TABS: SegmentOption<Tab>[] = [
  { id: 'companies', label: 'Companies' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'categories', label: 'Categories' },
  { id: 'fx', label: 'FX rates' },
];

export const SETTINGS_TAB_PARAM = 'tab';

/** `?tab=` as a tab, defaulting to companies for anything unknown. */
export function parseSettingsTab(raw: string | null): Tab {
  return TABS.find((t) => t.id === raw)?.id ?? 'companies';
}

/**
 * The reference data everything else hangs off: companies, their bank accounts, the
 * categories items are grouped by, and the hand-kept FX table. The tab is in the URL, so a
 * link can open the right one.
 */
export function SettingsScreen() {
  const [params, setParams] = useSearchParams();
  const tab = parseSettingsTab(params.get(SETTINGS_TAB_PARAM));
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.set(SETTINGS_TAB_PARAM, next);
        return out;
      },
      { replace: true },
    );

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <PageHeader title="Settings">
        <InfoText className="explainer">
          Companies and their bank accounts, the categories income and outgoings are grouped
          under, and the FX rates that turn every other currency into pounds for the combined
          forecast. Every change is recorded with who made it.
        </InfoText>
      </PageHeader>

      <div>
        <Segmented ariaLabel="Settings section" options={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === 'companies' && <CompaniesSection />}
      {tab === 'accounts' && <AccountsSection />}
      {tab === 'categories' && <CategoriesSection />}
      {tab === 'fx' && <FxRatesSection />}
    </div>
  );
}
