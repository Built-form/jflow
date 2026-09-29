// Copied from workflows/web/src/screens/AboutScreen.tsx — changes: the app's name in the explainer
import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useQuery } from '../app/useQuery';
import { PageHeader } from '../components/PageHeader';
import { ErrorNote, InfoText, Loading, Pill, Tag } from '../components/ui';
import { BUILD, shortCommit, versionLabel } from '../config/build';
import type { BuildInfo } from '../config/build';
import { API_BASE, APP_ENV } from '../config/env';
import { shortStamp } from '../lib/format';
import { duration, isTestRun, orderFiles, runPassed } from '../lib/testRun';
import type { TestCase, TestFile, TestRun, TestStatus } from '../lib/testRun';
import type { Tone } from '../lib/tone';

/**
 * The record of the last unit-test run of each package, in full: every file, every test,
 * every failure message. The runners write it themselves (`api/tools/test-report.js`,
 * `web/tools/test-report.mjs`) into `public/test-results/`, so what this page shows is what
 * the last `npm run test:unit` / `npm test` actually saw — the page has no opinion of its
 * own and no way to be more optimistic than the runner was.
 */

/** Where each record is served from. Vite serves `public/` at the site root. */
export const RUN_URLS = {
  api: '/test-results/api.json',
  web: '/test-results/web.json',
} as const;

/**
 * Fetches one record. `null` means "no run recorded yet" — the file is not there, or
 * the deploy's rewrite answered the request with index.html instead, which is the same
 * thing from here. Anything else that is not a record is an error worth showing.
 */
export async function loadRun(url: string): Promise<TestRun | null> {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, { error: `${url} answered ${res.status}` });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isTestRun(parsed)) {
    throw new ApiError(0, { error: `${url} is not a test record this page can read` });
  }
  return parsed;
}

export function AboutScreen({ build = BUILD }: { build?: BuildInfo }) {
  const api = useQuery(() => loadRun(RUN_URLS.api), []);
  const web = useQuery(() => loadRun(RUN_URLS.web), []);

  return (
    <div className="page">
      <PageHeader title="About">
        <div className="explainer">
          JFlow{' '}
          <span className="mono" style={{ fontSize: 13 }} data-testid="version">
            {versionLabel(build)}
          </span>
          , the {APP_ENV} environment, talking to{' '}
          <span className="mono" style={{ fontSize: 13 }}>
            {API_BASE || 'no API (not configured)'}
          </span>
          .
        </div>
      </PageHeader>

      <BuildSection build={build} />

      <InfoText className="explainer">
        Below is the full result of the last unit-test run of each package. The test runners
        write these records themselves, every time they run, so a deploy carries the result
        its code was last tested with.
      </InfoText>

      <RunSection title="API unit tests" state={api} />
      <RunSection title="Web unit tests" state={web} />
    </div>
  );
}

/**
 * Which build of the frontend this is. Stamped in by `vite.config.ts` from Vercel's
 * build variables (or git, for a local build), so what it shows is what was deployed —
 * not what the browser thinks, and not whatever branch a developer happens to be on.
 */
function BuildSection({ build }: { build: BuildInfo }) {
  const commit = shortCommit(build.commit);
  return (
    <section className="panel" aria-label="This build">
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="report-title">This build</h2>
          <Pill tone={build.target === 'production' ? 'done' : 'idle'}>
            {build.target.toUpperCase()}
          </Pill>
        </div>
        <div className="kicker">frontend {versionLabel(build)}</div>
      </div>

      <div className="report-facts">
        <Fact label="Version">
          <span className="mono">{build.version}</span>
        </Fact>
        <Fact label="Code">
          {commit ? (
            <span className="mono" title={build.commit ?? undefined}>
              {commit}
              {build.branch ? ` on ${build.branch}` : ''}
            </span>
          ) : (
            'unknown'
          )}
        </Fact>
        {build.message && <Fact label="Commit">{build.message}</Fact>}
        <Fact label="Built">{shortStamp(build.builtAt)}</Fact>
        {build.deploymentId && (
          <Fact label="Vercel deployment">
            <span className="mono">{build.deploymentId}</span>
          </Fact>
        )}
      </div>
    </section>
  );
}

function RunSection({
  title,
  state,
}: {
  title: string;
  state: { data: TestRun | null; error: ApiError | null; loading: boolean; reload: () => void };
}) {
  return (
    <section className="panel" aria-label={title}>
      {state.loading ? (
        <Loading what={title} />
      ) : state.error ? (
        <ErrorNote error={state.error} onRetry={state.reload} />
      ) : state.data ? (
        <RunReport run={state.data} title={title} />
      ) : (
        <>
          <h2 className="report-title">{title}</h2>
          <div className="empty" style={{ padding: '10px 0 4px' }}>
            No run recorded yet. Run the suite once and the record appears here.
          </div>
        </>
      )}
    </section>
  );
}

function RunReport({ run, title }: { run: TestRun; title: string }) {
  const passed = runPassed(run);
  const { totals } = run;
  return (
    <>
      <div className="head-row" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="report-title">{run.suite || title}</h2>
          <Pill tone={passed ? 'done' : 'fail'}>
            {passed ? 'ALL PASSING' : `${totals.failed || run.errors.length || 'SOME'} FAILING`}
          </Pill>
        </div>
        <div className="kicker">
          {totals.passed} passed · {totals.failed} failed · {totals.skipped} skipped ·{' '}
          {totals.tests} tests in {totals.files} files
        </div>
      </div>

      <div className="report-facts">
        <Fact label="Ran">{shortStamp(run.ranAt)}</Fact>
        <Fact label="Took">{duration(run.durationMs)}</Fact>
        <Fact label="Code">
          {run.commit ? (
            <span className="mono">
              {run.commit}
              {run.branch ? ` on ${run.branch}` : ''}
            </span>
          ) : (
            'unknown'
          )}
        </Fact>
        <Fact label="Command">
          <span className="mono">{run.command}</span>
        </Fact>
        <Fact label="Runner">
          <span className="mono">{run.runner}</span>
        </Fact>
      </div>

      {run.errors.length > 0 && (
        <div className="report-file" data-status="failed">
          <div className="report-file-head">
            <StatusTag status="failed" />
            <span className="mono report-path">Outside any test file</span>
          </div>
          {run.errors.map((message, i) => (
            <pre className="report-message" key={i}>
              {message}
            </pre>
          ))}
        </div>
      )}

      <div className="report-files">
        {orderFiles(run.files).map((file) => (
          <FileReport key={file.path} file={file} />
        ))}
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="report-fact">
      <span className="kicker">{label.toUpperCase()}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * One test file, folded shut when it passed and open when it did not: on a green run
 * the list of files IS the report, and on a red one the failures must be on screen
 * without a click.
 */
function FileReport({ file }: { file: TestFile }) {
  const [open, setOpen] = useState(file.status === 'failed');
  const counts = tally(file.tests);
  return (
    <div className="report-file" data-status={file.status}>
      <button
        type="button"
        className="report-file-head pressable"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusTag status={file.status} />
        <span className="mono report-path">{file.path}</span>
        <span className="kicker report-counts">
          {counts.failed > 0 ? `${counts.failed} failed · ` : ''}
          {counts.passed} passed{counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''} ·{' '}
          {duration(file.durationMs)}
        </span>
        <span className="disclosure" data-open={open} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="report-tests">
          {file.error && <pre className="report-message">{file.error}</pre>}
          {file.tests.map((test, i) => (
            <TestRow key={i} test={test} />
          ))}
        </div>
      )}
    </div>
  );
}

function TestRow({ test }: { test: TestCase }) {
  return (
    <div className="report-test" data-status={test.status}>
      <div className="report-test-line">
        <StatusTag status={test.status} />
        <span className="report-test-name">
          {test.ancestors.length > 0 && (
            <span className="report-ancestors">{test.ancestors.join(' › ')} › </span>
          )}
          {test.name}
        </span>
        <span className="kicker">{duration(test.durationMs)}</span>
      </div>
      {test.messages.map((message, i) => (
        <pre className="report-message" key={i}>
          {message}
        </pre>
      ))}
    </div>
  );
}

function StatusTag({ status }: { status: TestStatus | TestFile['status'] }) {
  const tone: Tone = status === 'passed' ? 'done' : status === 'failed' ? 'fail' : 'idle';
  const word = status === 'todo' ? 'TODO' : status === 'skipped' ? 'SKIP' : status === 'failed' ? 'FAIL' : 'PASS';
  return <Tag tone={tone}>{word}</Tag>;
}

function tally(tests: TestCase[]) {
  return {
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    skipped: tests.filter((t) => t.status === 'skipped' || t.status === 'todo').length,
  };
}
