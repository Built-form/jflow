// Copied from workflows/web/tools/test-report.mjs — changes: none
// Vitest reporter: writes the whole result of a web unit-test run as JSON where the About
// page can read it — `public/test-results/web.json`. Vite serves `public/` as-is, so the
// file is a page of the app as soon as it exists, in dev and in a build.
//
// The record's shape is `src/lib/testRun.ts` (format 1). The jest twin is
// `api/tools/test-report.js`; the three are kept in step by hand. This one is plain JS
// outside `src/` because it needs node's fs and the app's tsconfig has no node types —
// and should not grow them for one file that never ships.
//
// Wired in vite.config.ts, so every full `npm test` rewrites it. A filtered run (one file,
// one name pattern, a watch-mode rerun of what changed) leaves it alone: the page promises
// the last result of the whole suite. The page fetches the file at runtime rather than
// importing it, so a rerun writing it does not itself trigger another rerun.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';

const OUTPUT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'public', 'test-results', 'web.json');

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text) => String(text).replace(ANSI, '');

function git(args) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

function runnerVersion() {
  try {
    return `vitest ${createRequire(import.meta.url)('vitest/package.json').version}`;
  } catch {
    return 'vitest';
  }
}

/** The text of one error as vitest carries it: the diff when there is one, else the stack. */
function errorText(error) {
  if (!error) return 'Unknown error';
  const parts = [error.message ?? String(error)];
  if (error.diff) parts.push(plain(error.diff));
  if (error.stack) parts.push(plain(error.stack));
  return parts.filter(Boolean).join('\n');
}

/** Walks a file's suites down to its tests, keeping the describe titles as the trail. */
function collect(task, ancestors, out) {
  if (task.type === 'suite') {
    for (const child of task.tasks) collect(child, task.name ? [...ancestors, task.name] : ancestors, out);
    return;
  }
  const state = task.result?.state;
  const status =
    state === 'pass' ? 'passed' : state === 'fail' ? 'failed' : task.mode === 'todo' ? 'todo' : 'skipped';
  out.push({
    ancestors,
    name: task.name,
    status,
    durationMs: task.result?.duration == null ? null : Math.round(task.result.duration),
    messages: (task.result?.errors ?? []).map(errorText),
  });
}

function fileStatus(file, tests) {
  if (file.result?.state === 'fail' || tests.some((t) => t.status === 'failed')) return 'failed';
  if (tests.length === 0 || tests.every((t) => t.status !== 'passed')) return 'skipped';
  return 'passed';
}

export default class TestReport {
  constructor() {
    this.root = process.cwd();
    this.started = Date.now();
  }

  onInit(ctx) {
    this.ctx = ctx;
    this.root = ctx.config.root;
    this.started = Date.now();
  }

  onWatcherRerun() {
    this.started = Date.now();
  }

  async onFinished(files = [], errors = []) {
    // A filtered run — `vitest run About`, `-t "the gate"`, a watch-mode rerun of the one
    // file that changed — is not the last result of the SUITE. Leave the record as it was.
    if (this.ctx?.config.testNamePattern) return;
    if (this.ctx && files.length < (await this.ctx.globTestSpecs()).length) return;

    const started = this.started;
    const records = files.map((file) => {
      const tests = [];
      // The file is itself a suite whose name is its path; the trail starts below it.
      for (const task of file.tasks) collect(task, [], tests);
      const loadErrors = file.result?.state === 'fail' ? (file.result.errors ?? []).map(errorText) : [];
      return {
        path: relative(this.root, file.filepath).split(sep).join('/'),
        status: fileStatus(file, tests),
        durationMs: Math.max(0, Math.round((file.result?.duration ?? 0) + (file.collectDuration ?? 0))),
        // A file that failed OUTSIDE its tests (an import that threw) has nothing else to say.
        error: loadErrors.length > 0 && tests.every((t) => t.status !== 'failed') ? loadErrors.join('\n\n') : null,
        tests,
      };
    });
    const all = records.flatMap((f) => f.tests);

    const record = {
      format: 1,
      suite: 'Web unit tests',
      command: 'npm test (in web/)',
      runner: runnerVersion(),
      commit: git('rev-parse --short HEAD'),
      branch: git('rev-parse --abbrev-ref HEAD'),
      ranAt: new Date(started).toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      totals: {
        files: records.length,
        tests: all.length,
        passed: all.filter((t) => t.status === 'passed').length,
        failed: all.filter((t) => t.status === 'failed').length,
        skipped: all.filter((t) => t.status === 'skipped' || t.status === 'todo').length,
      },
      errors: errors.map(errorText),
      files: records,
    };

    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(record, null, 2)}\n`);
  }
}
