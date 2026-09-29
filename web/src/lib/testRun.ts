// Copied from workflows/web/src/lib/testRun.ts — changes: none
/**
 * The record a test run leaves behind, and the little arithmetic the About page does on it.
 *
 * Both runners write this shape — jest through `api/tools/test-report.js`, vitest through
 * `web/tools/test-report.mjs` — into `web/public/test-results/<suite>.json`, so the page
 * that shows them is one component, not one per runner. The shape is deliberately plain
 * JSON with no runner vocabulary in it: a reader of the page should never have to know
 * what a "pending" test is to jest or a "todo" to vitest, only that it did not run.
 *
 * Keep the two reporters in step with this file by hand; the JS ones cannot import it.
 */

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'todo';
export type FileStatus = 'passed' | 'failed' | 'skipped';

export interface TestCase {
  /** The `describe` titles above the test, outermost first. */
  ancestors: string[];
  /** The `it` title. */
  name: string;
  status: TestStatus;
  durationMs: number | null;
  /** Failure text, ANSI stripped, one entry per assertion that failed. Empty on a pass. */
  messages: string[];
}

export interface TestFile {
  /** Relative to the package root, forward slashes. */
  path: string;
  status: FileStatus;
  durationMs: number;
  /** Set when the file itself failed to load, so it has no tests to show. */
  error: string | null;
  tests: TestCase[];
}

export interface TestRun {
  /** The record's own version, so a stale file from an older reporter is refused, not misread. */
  format: 1;
  /** What the page calls this suite: "API unit tests". */
  suite: string;
  /** How to reproduce it, with the package it runs in. */
  command: string;
  /** "jest 29.7.0" — which program produced the record. */
  runner: string;
  /** Short hash of HEAD when it ran, null when git was not there to ask. */
  commit: string | null;
  branch: string | null;
  /** ISO 8601, UTC. */
  ranAt: string;
  durationMs: number;
  totals: {
    files: number;
    tests: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  /** Errors outside any file — an unhandled rejection, a setup file that threw. */
  errors: string[];
  files: TestFile[];
}

/** True when this is a record this page knows how to read. */
export function isTestRun(value: unknown): value is TestRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<TestRun>;
  return run.format === 1 && Array.isArray(run.files) && typeof run.totals === 'object';
}

/** A run is clean when nothing failed anywhere — not a test, not a file, not the harness. */
export function runPassed(run: TestRun): boolean {
  return run.totals.failed === 0 && run.errors.length === 0 && run.files.every((f) => f.status !== 'failed');
}

/** Failed files first, then the rest in the order they ran — a red one should never need scrolling for. */
export function orderFiles(files: TestFile[]): TestFile[] {
  return [...files].sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'));
}

/** `1.2s` / `340ms` — a duration for reading, not measuring. */
export function duration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
