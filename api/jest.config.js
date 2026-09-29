// Copied from workflows/api/jest.config.js — changes: none
'use strict';

// Kept deliberately close to the defaults the suite has always run on.
// Coverage is VISIBILITY, not a gate: no thresholds yet — the point of
// `npm run test:coverage` is to make the untested surface measurable
// (routes/products, routes/processes were invisible gaps for 13 chunks).
// Ratchet thresholds only once the number is worth defending.
module.exports = {
    testEnvironment: 'node',
    // The terminal as always, plus the record the web app's About page shows. It writes
    // only when the run was the whole unit suite — see tools/test-report.js.
    reporters: ['default', ['<rootDir>/tools/test-report.js', { scope: 'test/unit' }]],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/db/migrations/**',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text-summary', 'text'],
};
