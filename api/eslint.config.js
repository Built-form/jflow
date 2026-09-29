// Copied from workflows/api/eslint.config.js — changes: none
'use strict';

// Minimal on purpose: the recommended set plus the rules that would have
// caught this codebase's actual defect classes (unused imports/params survived
// 13 chunks; == vs === never bit but is cheap to hold). No formatting rules —
// a repo-wide reformat destroys blame for zero behavioural value.
const js = require('@eslint/js');

module.exports = [
    js.configs.recommended,
    {
        files: ['src/**/*.js', 'tools/**/*.js', 'test/**/*.js', '*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'writable', process: 'readonly',
                console: 'readonly', __dirname: 'readonly', Buffer: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly',
                fetch: 'readonly', AbortController: 'readonly',
                // jest
                describe: 'readonly', test: 'readonly', it: 'readonly',
                expect: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
                beforeEach: 'readonly', afterEach: 'readonly', jest: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            eqeqeq: ['error', 'smart'],   // == null stays idiomatic
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    { ignores: ['node_modules/', 'coverage/', '.serverless/', '.deploy-tools/'] },
];
