'use strict';

// Child process of test/unit/payments-flow-golden.test.js, "the host time zone
// does not matter". Jest gives each test file its own copy of process.env, so
// setting TZ inside a test never reaches ICU; a fresh Node started with TZ=<zone>
// does. Run with TZ set, this builds every payments-flow fixture through the
// port and prints one JSON object on stdout:
//   { tz, zone, julyOffset, fixtures: { <name>: { output, instants } } }
// zone is what Node resolved (Intl), julyOffset the minutes getTimezoneOffset
// gives for 2026-07-01T12:00Z, output the fixture's toGolden output, instants
// [s, toGolden(dateOfInstant(s))] for the instants in its expected file.
// The parent does every assertion.
//   PowerShell: $env:TZ='Asia/Shanghai'; node test/helpers/paymentsFlowGoldenChild.js

const flowLib = require('../../src/lib/payments-flow');
const H = require('./paymentsFlow');

const fixtures = {};
for (const name of H.listFixtures()) {
    const expected = H.readExpected(name);
    fixtures[name] = {
        output: H.toGolden(flowLib.buildPaymentsFlow(H.buildInput(H.readFixture(name), flowLib))),
        instants: (expected?.instants ?? []).map(([s]) => [s, H.toGolden(flowLib.dateOfInstant(s))]),
    };
}

process.stdout.write(JSON.stringify({
    tz: process.env.TZ ?? null,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    julyOffset: new Date('2026-07-01T12:00:00Z').getTimezoneOffset(),
    fixtures,
}));
