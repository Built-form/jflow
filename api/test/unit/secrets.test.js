// Copied from workflows/api/test/unit/secrets.test.js — changes: the empty-value test uses LOG_LEVEL instead of UPLOADS_PUBLIC_BASE_URL (JFlow has no uploads); added a withTimeout block for lib/timeout.js, which secrets.js now imports
'use strict';

// src/lib/secrets.js — the runtime replacement for baking DB_PASSWORD into the
// CloudFormation template. The network fetch is deploy-only; what a unit test
// CAN pin is the overlay contract (template wins, empties skipped) and the
// local no-op (SECRET_ID unset must never touch the network or the env).

const { loadRuntimeSecrets, applySecretEnv } = require('../../src/lib/secrets');
const { withTimeout } = require('../../src/lib/timeout');

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('applySecretEnv', () => {
    test('sets only ABSENT keys — template-baked config wins over the fetched copy', () => {
        process.env.DB_HOST = 'baked-host';
        delete process.env.DB_PASSWORD;
        const applied = applySecretEnv({ DB_HOST: 'secret-host', DB_PASSWORD: 'hunter2' });
        expect(process.env.DB_HOST).toBe('baked-host');
        expect(process.env.DB_PASSWORD).toBe('hunter2');
        expect(applied).toEqual(['DB_PASSWORD']);
    });

    test('empty and null values are skipped — an empty string must not beat a fallback', () => {
        delete process.env.DB_PROXY_HOST;
        delete process.env.LOG_LEVEL;
        const applied = applySecretEnv({ DB_PROXY_HOST: '', LOG_LEVEL: null });
        expect(process.env.DB_PROXY_HOST).toBeUndefined();
        expect(process.env.LOG_LEVEL).toBeUndefined();
        expect(applied).toEqual([]);
    });

    test('non-string values are stringified; empty/absent json is a no-op', () => {
        delete process.env.DB_PORT;
        applySecretEnv({ DB_PORT: 3306 });
        expect(process.env.DB_PORT).toBe('3306');
        expect(applySecretEnv(null)).toEqual([]);
        expect(applySecretEnv({})).toEqual([]);
    });
});

describe('loadRuntimeSecrets', () => {
    test('without SECRET_ID it resolves immediately and touches nothing', async () => {
        delete process.env.SECRET_ID;
        const before = { ...process.env };
        await expect(loadRuntimeSecrets()).resolves.toBeUndefined();
        expect(process.env).toEqual(before);
    });
});

describe('withTimeout (lib/timeout.js)', () => {
    test('a promise that settles in time passes its value through', async () => {
        await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    });

    test('a promise that rejects in time passes its error through', async () => {
        await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
    });

    test('a slow promise rejects with the given message', async () => {
        const never = new Promise(() => {});
        await expect(withTimeout(never, 10, 'Secrets Manager did not answer')).rejects.toThrow('Secrets Manager did not answer');
    });

    test('without a message the rejection names the budget', async () => {
        await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow('timed out after 10ms');
    });
});
