import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

/**
 * A screen PLAN names but BUILD_PLAN builds later. It has a route and a nav entry now so
 * the frame is the finished app's; the page says when it arrives rather than 404ing.
 */
export function ComingSoonScreen({ title, what }: { title: string; what: string }) {
  return (
    <div className="page">
      <PageHeader title={title}>
        <div className="explainer">{what}</div>
      </PageHeader>
      <div className="panel" style={{ maxWidth: 640 }}>
        <div className="kicker">COMING IN STEP 9</div>
        <div style={{ fontSize: 14.5, color: 'var(--mut)', lineHeight: 1.6 }}>
          This screen arrives in step 9. Until then, record start-of-day balances on{' '}
          <Link to="/cash">Cash at bank</Link> and keep companies, accounts, categories and FX
          rates up to date in <Link to="/settings">Settings</Link>.
        </div>
      </div>
    </div>
  );
}
