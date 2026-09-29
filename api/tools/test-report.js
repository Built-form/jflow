// Copied from workflows/api/tools/test-report.js — changes: none
'use strict';

// Jest reporter: writes the whole result of a unit-test run as JSON where the web app's
// About page can read it — `web/public/test-results/api.json`. Vite serves `public/`
// as-is, so the file is a page of the app as soon as it exists, in dev and in a build.
//
// The record's shape is `web/src/lib/testRun.ts` (format 1). The vitest twin is
// `web/tools/test-report.mjs`; the three are kept in step by hand.
//
// Wired in jest.config.js with `{ scope: 'test/unit' }`. The page promises the last
// result of the WHOLE unit suite, so the record is written only when this run was exactly
// that: every file under the scope and nothing outside it. `npm run test:e2e`, `npm test`
// (unit + e2e together), `jest gate`, `-t "..."`, `--onlyChanged` all leave it standing.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_OUTPUT = path.resolve(__dirname, '..', '..', 'web', 'public', 'test-results', 'api.json');

// Jest colours its failure messages for the terminal; the page has its own colours.
// eslint-disable-next-line no-control-regex
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
        return `jest ${require('jest/package.json').version}`;
    } catch {
        return 'jest';
    }
}

/** Jest's five statuses folded to the record's four. */
function testStatus(status) {
    switch (status) {
        case 'passed':
        case 'failed':
        case 'todo':
            return status;
        default:
            // pending, skipped, disabled, focused-out — did not run, for whatever reason.
            return 'skipped';
    }
}

function fileStatus(file) {
    if (file.testExecError || file.numFailingTests > 0) return 'failed';
    if (file.testResults.length === 0 || file.testResults.every((t) => t.status !== 'passed')) return 'skipped';
    return 'passed';
}

/** Every test file under `dir`, by jest's default naming: `*.test.js` / `*.spec.js`. */
function testFilesUnder(dir) {
    let count = 0;
    const walk = (at) => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(at, entry.name));
            else if (/\.(test|spec)\.[cm]?jsx?$/.test(entry.name)) count += 1;
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return count;
}

class TestReport {
    constructor(globalConfig, options = {}) {
        this.rootDir = globalConfig.rootDir;
        this.globalConfig = globalConfig;
        this.scope = path.resolve(this.rootDir, options.scope || 'test/unit');
        this.outputPath = options.outputPath ? path.resolve(this.rootDir, options.outputPath) : DEFAULT_OUTPUT;
    }

    /** True when this run was the whole scoped suite and nothing else. */
    isWholeSuite(results) {
        const g = this.globalConfig;
        if (g.testNamePattern || g.onlyChanged || g.onlyFailures || g.findRelatedTests) return false;
        const inScope = (file) => !path.relative(this.scope, file.testFilePath).startsWith('..');
        if (!results.testResults.every(inScope)) return false;
        return results.testResults.length === testFilesUnder(this.scope);
    }

    onRunComplete(_contexts, results) {
        // A Ctrl-C mid-run is not "the last result"; leave the previous record standing.
        if (results.wasInterrupted) return;
        if (!this.isWholeSuite(results)) return;

        const files = results.testResults.map((file) => ({
            path: path.relative(this.rootDir, file.testFilePath).split(path.sep).join('/'),
            status: fileStatus(file),
            durationMs: Math.max(0, (file.perfStats?.end ?? 0) - (file.perfStats?.start ?? 0)),
            error: file.testExecError ? plain(file.failureMessage || file.testExecError.message || 'Failed to run') : null,
            tests: file.testResults.map((t) => ({
                ancestors: t.ancestorTitles,
                name: t.title,
                status: testStatus(t.status),
                durationMs: t.duration == null ? null : t.duration,
                messages: t.failureMessages.map(plain),
            })),
        }));

        const record = {
            format: 1,
            suite: 'API unit tests',
            command: 'npm run test:unit (in api/)',
            runner: runnerVersion(),
            commit: git('rev-parse --short HEAD'),
            branch: git('rev-parse --abbrev-ref HEAD'),
            ranAt: new Date(results.startTime).toISOString(),
            durationMs: Math.max(0, Date.now() - results.startTime),
            totals: {
                files: results.numTotalTestSuites,
                tests: results.numTotalTests,
                passed: results.numPassedTests,
                failed: results.numFailedTests,
                skipped: results.numPendingTests + results.numTodoTests,
            },
            // A file that could not even load is not counted in numFailedTests; say so here
            // so the page's "all passing" can never be true over a broken file.
            errors: results.runExecError ? [plain(results.runExecError.message)] : [],
            files,
        };

        fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
        fs.writeFileSync(this.outputPath, `${JSON.stringify(record, null, 2)}\n`);
    }
}

module.exports = TestReport;
