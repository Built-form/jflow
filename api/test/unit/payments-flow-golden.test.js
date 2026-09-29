// Copied from shipping/tools/test-payments-flow-golden.js — changes: node:test → jest; paths (test/helpers/paymentsFlow.js, src/lib/payments-flow); "the host time zone does not matter" runs each zone in a child process (test/helpers/paymentsFlowGoldenChild.js), one test per zone, and also checks the Date offset; the no-clock test swaps globalThis.Date and checks the swap reached the lib; new: buildPaymentsFlow(input, { claims: true }) tests
'use strict';

// Golden A — src/lib/payments-flow against the frozen ShipLine TypeScript
// (paymentsFlowMath.ts at f9499bc). No database, no clock.
//   npx jest test/unit/payments-flow-golden.test.js
//
// Every fixture in test/fixtures/payments-flow/*.input.json runs through the
// port and must deep-equal (and serialise identically to) the oracle's output
// in <name>.expected.json — written by tools/payments-flow-oracle.mjs under
// TZ=Europe/London (see its header to regenerate). The port pins dateOfInstant
// to Europe/London, so the host time zone must not matter: this file also runs
// every fixture under several zones itself, each in a child Node process (jest
// gives a test file its own copy of process.env, so setting TZ here would not
// reach ICU). Run it under TZ=UTC and TZ=Europe/London as well
// (PowerShell: $env:TZ='UTC'; npx jest test/unit/payments-flow).

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const flowLib = require('../../src/lib/payments-flow');
const H = require('../helpers/paymentsFlow');

const FIXTURES = H.listFixtures();
const LIB_DIR = path.join(__dirname, '..', '..', 'src', 'lib', 'payments-flow');
const CHILD = path.join(__dirname, '..', 'helpers', 'paymentsFlowGoldenChild.js');

function runPort(name) {
    return H.toGolden(flowLib.buildPaymentsFlow(H.buildInput(H.readFixture(name), flowLib)));
}

test('there are fixtures, each with an expected file from the oracle', () => {
    assert.ok(FIXTURES.length >= 9, `only ${FIXTURES.length} fixtures`);
    for (const name of FIXTURES) assert.ok(H.readExpected(name), `${name}: no expected file — run tools/payments-flow-oracle.mjs`);
});

for (const name of FIXTURES) {
    test(`${name}: the port equals the frozen TS`, () => {
        const expected = H.readExpected(name);
        assert.equal(expected.fixture, name);
        assert.equal(expected.tz, 'Europe/London');
        const actual = runPort(name);
        assert.deepStrictEqual(actual, expected.output);
        // Same keys in the same order, too.
        assert.equal(JSON.stringify(actual), JSON.stringify(expected.output));
        for (const [s, ymd] of expected.instants ?? []) assert.equal(flowLib.dateOfInstant(s), ymd, `dateOfInstant(${JSON.stringify(s)})`);
    });
}

// buildPaymentsFlow(input, { claims: true }) is the port's one addition to the
// output (JFlow PHASE2 step 18): everything else must still be the TS's.
for (const name of FIXTURES) {
    test(`${name}: with { claims: true }, the same output plus a balanceClaims array`, () => {
        const expected = H.readExpected(name);
        const flow = flowLib.buildPaymentsFlow(H.buildInput(H.readFixture(name), flowLib), { claims: true });
        assert.ok(Array.isArray(flow.balanceClaims), 'balanceClaims is an array');
        delete flow.balanceClaims;
        const actual = H.toGolden(flow);
        assert.deepStrictEqual(actual, expected.output);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected.output));
    });
}

test('with { claims: true }, some fixture resolves balance records to claims', () => {
    const counts = FIXTURES.map(name => flowLib.buildPaymentsFlow(H.buildInput(H.readFixture(name), flowLib), { claims: true }).balanceClaims.length);
    assert.ok(counts.some(n => n > 0), 'no fixture has a balance claim');
});

// Each zone in its own Node process, started with TZ=<zone>. The July offset
// shows the zone reached Date as well as Intl.
const JULY_OFFSET = {
    'UTC': 0,
    'Europe/London': -60,
    'America/Los_Angeles': 420,
    'Asia/Shanghai': -480,
    'Pacific/Kiritimati': -840,
};

describe('the host time zone does not matter', () => {
    for (const [zone, julyOffset] of Object.entries(JULY_OFFSET)) {
        test(`TZ=${zone}, in a child process`, () => {
            const stdout = execFileSync(process.execPath, [CHILD], {
                env: { ...process.env, TZ: zone },
                encoding: 'utf8',
                maxBuffer: 256 * 1024 * 1024,
            });
            const got = JSON.parse(stdout);
            assert.equal(got.tz, zone);
            assert.equal(got.zone, zone, 'the zone took effect (Intl)');
            assert.equal(got.julyOffset, julyOffset, 'the zone took effect (Date)');
            // FIXTURES comes from fs.readdirSync, an array of Node's own realm, not
            // the test's: copy it so the prototypes match.
            assert.deepStrictEqual(Object.keys(got.fixtures), [...FIXTURES]);
            for (const name of FIXTURES) {
                const expected = H.readExpected(name);
                const { output, instants } = got.fixtures[name];
                assert.deepStrictEqual(output, expected.output, `${name} under ${zone}`);
                assert.equal(JSON.stringify(output), JSON.stringify(expected.output), `${name} under ${zone}: key order`);
                const want = expected.instants ?? [];
                assert.equal(instants.length, want.length, `${name} under ${zone}: instants`);
                want.forEach(([s, ymd], i) => {
                    assert.equal(instants[i][0], s);
                    assert.equal(instants[i][1], ymd, `${s} under ${zone}`);
                });
            }
        }, 60000);
    }
});

test('today is required: no clock fallback', () => {
    const input = H.buildInput(H.readFixture(FIXTURES[0]), flowLib);
    for (const today of [undefined, null, '', 'not a date', '2026-13-01']) {
        assert.throws(() => flowLib.buildPaymentsFlow({ ...input, today }), /today/, String(today));
    }
    // A datetime is read as its calendar date, as in the TS.
    const out = flowLib.buildPaymentsFlow({ ...input, today: `${input.today}T23:59:00Z` });
    assert.equal(out.today, input.today);
});

test('a PO bundle with no id crashes, as the TS does (TS L2274; kept for identity)', () => {
    // byId falls back to the poBundles key, but lines are grouped under b.id
    // (undefined), so the PO loop finds no bundle. The frozen TS throws the
    // same TypeError; fixing it waits for the TS.
    const input = H.buildInput(H.readFixture('multi-container'), flowLib);
    const { id, ...noId } = input.poBundles['813'];
    assert.equal(id, 813);
    assert.throws(() => flowLib.buildPaymentsFlow({ ...input, poBundles: { ...input.poBundles, 813: noId } }), /Cannot read properties of undefined \(reading 'supplier'\)/);
});

test('the model reads no clock', () => {
    const RealDate = Date;
    let constructed = 0;
    class NoClockDate extends RealDate {
        constructor(...args) {
            if (!args.length) throw new Error('clock read: new Date()');
            super(...args);
            constructed++;
        }
        static now() { throw new Error('clock read: Date.now()'); }
    }
    globalThis.Date = NoClockDate;
    try {
        for (const name of FIXTURES) flowLib.buildPaymentsFlow(H.buildInput(H.readFixture(name), flowLib));
    } finally {
        globalThis.Date = RealDate;
    }
    // The lib shares this file's global (jest runs both in one context), so its
    // calendar math went through NoClockDate: the swap really intercepted.
    assert.ok(constructed > 0, 'the lib never saw the swapped Date');
});

test('the lib stays pure: no db, handlers or services, no clock, Node 18 APIs only', () => {
    const files = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.js'));
    assert.ok(files.includes('index.js'));
    for (const f of files) {
        // Code only: JSDoc says import('./types') and comments may name the clock.
        const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const [, spec] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            assert.ok(/^\.\/[a-z-]+$/.test(spec) || spec === 'crypto', `${f} requires ${spec}`);
        }
        assert.doesNotMatch(src, /\bimport\s*\(/, `${f}: dynamic import`);
        assert.doesNotMatch(src, /Date\.now\s*\(|new Date\(\s*\)|performance\.now|process\.hrtime|localTodayYmd/, `${f}: clock`);
        // Node 20+ only: change-array-by-copy, groupBy, Set methods, Array.fromAsync.
        assert.doesNotMatch(src, /\.toSorted\(|\.toReversed\(|\.toSpliced\(|\bObject\.groupBy|\bMap\.groupBy|\.union\(|\.intersection\(|\.symmetricDifference\(|\.isSubsetOf\(|Array\.fromAsync/, `${f}: API newer than Node 18`);
    }
});
