// Copied from shipping/tools/payments-flow-oracle.mjs (phase2-payments-flow export) — changes: helpers from ../test/helpers/paymentsFlow.js (fixtures in test/fixtures/payments-flow/); run from jflow/api/; eslint globals directive; header comment points at JFlow's paths
// Golden A oracle — runs the FROZEN ShipLine TypeScript on every payments-flow
// fixture and writes what it returns, so the port in src/lib/payments-flow can
// be proven identical to it (test/unit/payments-flow-golden.test.js,
// test/unit/payments-flow-terms.test.js). The expected files
// (test/fixtures/payments-flow/*.expected.json) are committed; this only needs
// re-running when a fixture changes, or to re-sync the port with a newer
// ShipLine commit.
//
// Source of truth: ShipLine commit f9499bc (JFlow PHASE2 step 13 sign-off),
// src/components/payments/paymentsFlowMath.ts (2,786 lines) and its one runtime
// import, src/components/shared/containerHelpers.ts. They are frozen until the
// cut-over (PHASE2 step 17); the oracle refuses any other content (hashes
// below, taken with CRLF folded to LF) unless --allow-other-source.
//
// Regenerate, from jflow/api/, with a ShipLine checkout (or a
// `git archive f9499bc` export) at <dir>. It must run under Europe/London with
// the fixture's own `today` (the page's setting); the script checks both.
//   PowerShell:  $env:TZ='Europe/London'; npx -y tsx@4.21.0 tools/payments-flow-oracle.mjs --shipline <dir>
//   bash/zsh:    TZ=Europe/London npx -y tsx@4.21.0 tools/payments-flow-oracle.mjs --shipline <dir>
//   (Git Bash on Windows drops TZ=Europe/London before Node sees it — use PowerShell there.)
// Or from a ShipLine checkout beside jflow/, which has tsx as a devDependency:
//   TZ=Europe/London npx tsx ../jflow/api/tools/payments-flow-oracle.mjs --shipline .
// Options: --check  compare with the committed files instead of writing (exit 1 if stale)
//          --only <fixture>   one fixture
// tsx is not a JFlow dependency; npx fetches it.

/* global process, console */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const H = require('../test/helpers/paymentsFlow.js');

const SOURCE = {
    commit: 'f9499bc',
    files: {
        'src/components/payments/paymentsFlowMath.ts': { lines: 2786, sha256: '4eba847c6bda6cca56ad1545be0273a937fcabe297290a18c7502f407af07aab' },
        'src/components/shared/containerHelpers.ts': { lines: 340, sha256: '50065005de3aca01d1c93ffe552fae542b6ca51b68bcd30724cf2c6681ad6f98' },
    },
};
const ZONE = 'Europe/London';

function fail(msg) {
    console.error(`payments-flow-oracle: ${msg}`);
    process.exit(1);
}

const argv = process.argv.slice(2);
const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] ?? fail(`${name} needs a value`));
};
const shipline = opt('--shipline') ?? process.env.SHIPLINE_DIR ?? fail('--shipline <path to a ShipLine checkout at f9499bc> is required');
const only = opt('--only');
const check = argv.includes('--check');
const allowOther = argv.includes('--allow-other-source');

// The page runs in the UK; so does the oracle.
if (process.env.TZ !== ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone !== ZONE) {
    fail(`run under TZ=${ZONE} (TZ is ${process.env.TZ ?? 'unset'}, Node resolved ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
}
if (new Date('2026-07-01T12:00:00Z').getTimezoneOffset() !== -60) fail('Europe/London is not on BST in July — ICU time zone data looks wrong');

// Provenance: which source produced these files.
const source = { commit: SOURCE.commit, files: {} };
for (const [rel, want] of Object.entries(SOURCE.files)) {
    const file = path.join(shipline, rel);
    if (!fs.existsSync(file)) fail(`${file} not found`);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const got = { lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
    if ((got.sha256 !== want.sha256 || got.lines !== want.lines) && !allowOther) {
        fail(`${rel} is not the frozen f9499bc copy (${got.lines} lines, sha256 ${got.sha256}); pass --allow-other-source to run it anyway`);
    }
    source.files[rel] = got;
}

const math = await import(pathToFileURL(path.join(shipline, 'src/components/payments/paymentsFlowMath.ts')).href);

const write = (file, value) => {
    const text = JSON.stringify(value, null, 1) + '\n';
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (check) {
        if (old !== text) { console.error(`STALE ${path.relative(process.cwd(), file)}`); process.exitCode = 1; }
        return;
    }
    if (old !== text) fs.writeFileSync(file, text);
    console.log(`${old === text ? 'same ' : 'wrote'} ${path.relative(process.cwd(), file)}`);
};

// ── Payments-flow fixtures ──────────────────────────────────────────────
for (const name of H.listFixtures()) {
    if (only && name !== only) continue;
    const fixture = H.readFixture(name);
    if (!fixture.input?.today) fail(`${name}: input.today is required`);
    const input = H.buildInput(fixture, math);
    const flow = math.buildPaymentsFlow(input);
    const expected = { fixture: name, source, tz: ZONE, today: input.today, output: H.toGolden(flow) };
    if (fixture.instants) expected.instants = fixture.instants.map(s => [s, math.dateOfInstant(s)]);
    write(H.expectedPath(name), expected);
    const summary = flow.currencies.map(c => `${c.currency}: ${c.items.length} items, ${c.pos.length} POs, ${c.dataQuality.length} issues`).join(' · ');
    console.log(`      ${name}: poCount ${flow.poCount} · ${summary || 'no currencies'}`);
}

// ── Parser vectors ──────────────────────────────────────────────────────
if (!only) {
    const inputs = [...H.TERMS_VECTORS.map(v => v.text), ...H.TERMS_EXTRA];
    write(path.join(H.FIXTURE_DIR, H.TERMS_EXPECTED), {
        source, tz: ZONE,
        parse: inputs.map(text => {
            const rule = math.parsePaymentTerms(text);
            return [text, H.toGolden(rule), math.describeRule(rule)];
        }),
        resolve: H.TERMS_RESOLVE_CASES.map(({ payments, supplierTerms }) => ({
            payments, supplierTerms, rule: H.toGolden(math.resolveTermsRule(payments, supplierTerms)),
        })),
    });
}
