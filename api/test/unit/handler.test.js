'use strict';

// src/handlers/jflow.js — the step-1 skeleton, loaded through the LOCAL auth
// bypass against a stub database (no MySQL, no .env: dotenv is mocked out).
// Pinned here: the shared middleware (request id, no-store, X-User-Type), the
// routes CONTRACT §6.1 names, the admin-only doors (D5), and the fallbacks.

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/lib/schema', () => ({ ensureSchema: jest.fn(async () => {}) }));
jest.mock('../../src/db', () => ({
    getPool: jest.fn(() => ({})),
    withConnection: jest.fn(),
    withTransaction: jest.fn(),
}));

delete process.env.AWS_LAMBDA_FUNCTION_NAME;
process.env.IS_OFFLINE = '1';

const request = require('supertest');
const db = require('../../src/db');
const { app, ENUMS } = require('../../src/handlers/jflow');

/**
 * Stub the database: the local bypass reads the caller's type from
 * allowed_emails; every other query answers `rows`. Returns the SQL log.
 */
function asType(type, rows = []) {
    const calls = [];
    const conn = {
        query: async (sql, params) => {
            const flat = sql.replace(/\s+/g, ' ').trim();
            calls.push({ sql: flat, params });
            if (/^SELECT type FROM allowed_emails WHERE email = \?$/.test(flat)) return [[{ type }]];
            return [rows];
        },
    };
    db.withConnection.mockImplementation(async (fn) => fn(conn));
    db.withTransaction.mockImplementation(async (fn) => fn(conn));
    return calls;
}

beforeEach(() => jest.clearAllMocks());

describe('shared middleware', () => {
    test('every response carries X-Request-Id, X-User-Type and Cache-Control: no-store', async () => {
        asType('admin');
        const res = await request(app).get('/api/v1/me').expect(200);
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers['x-user-type']).toBe('admin');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    test("a caller's x-request-id is echoed back, sanitised", async () => {
        asType('standard');
        const res = await request(app).get('/api/v1/me').set('x-request-id', 'abc-123').expect(200);
        expect(res.headers['x-request-id']).toBe('abc-123');
    });

    test('the local bypass is local@dev with the type read from its row', async () => {
        asType('standard');
        const res = await request(app).get('/api/v1/me').expect(200);
        expect(res.body).toEqual({ email: 'local@dev', displayName: null, type: 'standard' });
    });
});

describe('health', () => {
    test('200 with the database probe and service name', async () => {
        const calls = asType('admin');
        const res = await request(app).get('/api/v1/health').expect(200);
        expect(res.body).toMatchObject({ status: 'ok', service: 'jflow', database: 'up', schema: 'ready' });
        expect(calls.map((c) => c.sql)).toEqual(['SELECT 1']);   // no allowlist lookup
    });

    test('a dead database is a 200 saying so, not a failed probe', async () => {
        db.withConnection.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const res = await request(app).get('/api/v1/health').expect(200);
            expect(res.body).toMatchObject({ database: 'down', schema: 'pending' });
        } finally {
            spy.mockRestore();
        }
    });
});

describe('meta/enums', () => {
    test('answers the ENUMS object with every key CONTRACT §6.1 names', async () => {
        asType('standard');
        const res = await request(app).get('/api/v1/meta/enums').expect(200);
        expect(res.body).toEqual(ENUMS);
        expect(Object.keys(res.body).sort()).toEqual([
            'adjustmentKinds', 'amountBases', 'buckets', 'dateBases', 'derivedStatuses', 'directions', 'errorCodes',
            'feedKinds', 'feedStatuses', 'frequencies', 'includeModes', 'itemStatuses', 'overrideStatuses',
            'scenarioStatuses', 'scheduleStatuses', 'settleModes', 'shippingReasons', 'staleReasons', 'targetKinds',
            'userTypes', 'warningCodes', 'weekendRules',
        ]);
        expect(res.body.userTypes).toEqual(['standard', 'admin']);
    });

    test('Phase 2 vocabularies (CONTRACT §7) come from services/shipping.js, which enforces them', () => {
        expect(ENUMS.feedKinds).toEqual(['deposit', 'balance']);
        expect(ENUMS.feedStatuses).toEqual(['open', 'paid']);
        expect(ENUMS.dateBases).toEqual(['firm', 'estimated', 'undated']);
        expect(ENUMS.amountBases).toEqual(['stated', 'derived']);
        expect(ENUMS.shippingReasons).toEqual(['unconfigured', 'timeout', 'unreachable', 'http_401', 'http_<status>', 'bad_response']);
        expect(ENUMS.errorCodes).toEqual(expect.arrayContaining(['SHIPPING_COMPANY_TAKEN', 'PLANNED_DATE_IN_PAST', 'SHIPPING_UNAVAILABLE']));
        expect(ENUMS.warningCodes).toEqual(expect.arrayContaining(['SHIPPING_UNAVAILABLE', 'SHIP_UNMAPPED', 'SHIP_PLAN_ORPHANED', 'SHIP_PLAN_STALE']));
    });

    test('every list is non-empty and duplicate-free', () => {
        for (const [key, list] of Object.entries(ENUMS)) {
            expect({ key, empty: list.length === 0 }).toEqual({ key, empty: false });
            expect({ key, size: new Set(list).size }).toEqual({ key, size: list.length });
        }
    });

    test('warnings and stale reasons are not refusal codes (TARGET_* are both a refusal and a reason)', () => {
        // SHIPPING_UNAVAILABLE alone is both (CONTRACT §7): a 503 on POST /external/refresh,
        // a 200 warning on /forecast.
        for (const w of ENUMS.warningCodes.filter((c) => c !== 'SHIPPING_UNAVAILABLE')) {
            expect(ENUMS.errorCodes).not.toContain(w);
        }
        expect(ENUMS.errorCodes).not.toContain('BASE_CHANGED');
        expect(ENUMS.errorCodes).toEqual(expect.arrayContaining(['ADMIN_REQUIRED', 'STALE_WRITE', 'TARGET_SETTLED', 'TARGET_MISSING']));
    });
});

describe('users (D5: writes are admin-only)', () => {
    test('GET /users is open to a standard account and answers a bare array', async () => {
        asType('standard', [{ email: 'a@b.test', type: 'admin', display_name: 'A', created_at: 'x' }]);
        const res = await request(app).get('/api/v1/users').expect(200);
        expect(res.body).toEqual([{ email: 'a@b.test', type: 'admin', displayName: 'A', createdAt: 'x' }]);
    });

    test.each([
        ['post', '/api/v1/users'],
        ['patch', '/api/v1/users/x@y.test'],
        ['delete', '/api/v1/users/x@y.test'],
    ])('%s %s by a standard account is 403 ADMIN_REQUIRED before any write', async (method, path) => {
        asType('standard');
        const res = await request(app)[method](path).send({ email: 'x@y.test', type: 'admin' }).expect(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
        expect(db.withTransaction).not.toHaveBeenCalled();
    });

    test('POST /users by an admin inserts, audits allowed_email/create, answers 201', async () => {
        const calls = asType('admin');
        const res = await request(app).post('/api/v1/users').send({ email: ' New@B.test ', displayName: 'N' }).expect(201);
        expect(res.body).toEqual({ email: 'new@b.test', type: 'standard', displayName: 'N' });
        const sqls = calls.map((c) => c.sql);
        expect(sqls).toContain('INSERT INTO allowed_emails (email, type, display_name) VALUES (?, ?, ?)');
        expect(sqls.some((s) => s.startsWith('INSERT INTO audit_log'))).toBe(true);
    });

    test('POST /users refuses a type outside standard | admin', async () => {
        asType('admin');
        const res = await request(app).post('/api/v1/users').send({ email: 'x@y.test', type: 'manager' }).expect(400);
        expect(res.body.error).toBe('type must be one of: standard, admin.');
    });

    test('an admin may not remove their own access', async () => {
        asType('admin');
        await request(app).delete('/api/v1/users/local@dev').expect(400);
        await request(app).patch('/api/v1/users/local@dev').send({ type: 'standard' }).expect(400);
    });
});

describe('audit', () => {
    test('a standard account never sees allowed_email rows, and asking for them is 403', async () => {
        const calls = asType('standard');
        await request(app).get('/api/v1/audit').expect(200);
        const read = calls.find((c) => c.sql.includes('FROM audit_log'));
        expect(read.sql).toMatch(/entity_type <> \?/);
        expect(read.params).toEqual(['allowed_email', 100]);
        const res = await request(app).get('/api/v1/audit?entityType=allowed_email').expect(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });

    test('keyset envelope, newest first', async () => {
        asType('admin', [{ id: 9, entity_type: 'company', entity_id: 1, action: 'create' }]);
        const res = await request(app).get('/api/v1/audit?limit=1').expect(200);
        expect(res.body).toMatchObject({ limit: 1, nextCursor: 9 });
        expect(res.body.data[0]).toMatchObject({ id: 9, entityType: 'company' });
    });
});

describe('fallbacks', () => {
    test('an unknown route is a 404 {error}', async () => {
        asType('admin');
        const res = await request(app).get('/api/v1/no-such-route').expect(404);
        expect(res.body).toEqual({ error: 'No route for GET /api/v1/no-such-route.' });
    });

    test('malformed JSON is a 400, with a request id', async () => {
        asType('admin');
        const res = await request(app).post('/api/v1/users')
            .set('content-type', 'application/json').send('{"email": ').expect(400);
        expect(res.body).toEqual({ error: 'Request body is not valid JSON.' });
        expect(res.headers['x-request-id']).toBeTruthy();
    });

    test('a body over 1mb is a 413', async () => {
        asType('admin');
        const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
        const res = await request(app).post('/api/v1/users').set('content-type', 'application/json').send(big).expect(413);
        expect(res.body.error).toMatch(/limit 1mb/);
    });
});
