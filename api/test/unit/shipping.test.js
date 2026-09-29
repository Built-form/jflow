'use strict';

// services/shipping.js (docs/PHASE2.md §3, §4.1) against a stub HTTP server — never
// the real shipping API. Pinned here:
//   · configuration is read per call, and an unconfigured client makes NO request;
//   · the key travels only in X-Api-Key (never the URL, never an error message);
//   · every failure is one `unavailable(reason)` with reason in
//     unconfigured | timeout | unreachable | http_401 | http_<status> | bad_response;
//   · the whole exchange (headers AND body) is bounded by the timeout;
//   · validateFeed counts and rejects bad rows and normalises the good ones.

const http = require('http');
const shipping = require('../../src/services/shipping');
const { startShippingStub, feedItem, feedBody } = require('../helpers/shippingStub');

const KEY = 'unit-test-key-0123456789abcdef';

let stub;
let warnSpy;

beforeAll(async () => { stub = await startShippingStub(); });
afterAll(async () => { if (stub) await stub.close(); });

beforeEach(() => {
    stub.reset();
    process.env.SHIPPING_API_BASE = stub.url;
    process.env.SHIPPING_API_KEY = KEY;
    // The client logs every failure with log.warn; keep the run quiet.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.SHIPPING_API_BASE;
    delete process.env.SHIPPING_API_KEY;
});

/** The thrown error of `promise`, or a failure when it resolves. */
async function rejectionOf(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected a rejection');
}

describe('configuration', () => {
    test('SHIPPING_TIMEOUT_MS is 5 seconds', () => {
        expect(shipping.SHIPPING_TIMEOUT_MS).toBe(5000);
    });

    test('isConfigured reads both keys per call, and blanks count as unset', () => {
        expect(shipping.isConfigured()).toBe(true);
        process.env.SHIPPING_API_KEY = '   ';
        expect(shipping.isConfigured()).toBe(false);
        process.env.SHIPPING_API_KEY = KEY;
        delete process.env.SHIPPING_API_BASE;
        expect(shipping.isConfigured()).toBe(false);
        process.env.SHIPPING_API_BASE = stub.url;
        expect(shipping.isConfigured()).toBe(true);
    });

    test.each([
        ['no key', () => { delete process.env.SHIPPING_API_KEY; }],
        ['no base', () => { delete process.env.SHIPPING_API_BASE; }],
        ['a blank key', () => { process.env.SHIPPING_API_KEY = ''; }],
    ])('unconfigured (%s) → reason unconfigured, and no request is made', async (_label, unset) => {
        unset();
        stub.respondJson(200, feedBody([]));
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29', paidSince: '2026-08-01' }));
        expect(shipping.isUnavailable(err)).toBe(true);
        expect(err.reason).toBe('unconfigured');
        expect(stub.requests).toHaveLength(0);
    });
});

describe('fetchPaymentsForecast', () => {
    test('GETs the internal path with the key in X-Api-Key only, and returns the body', async () => {
        const body = feedBody([feedItem('bal-812-s311')]);
        stub.respondJson(200, body);
        process.env.SHIPPING_API_BASE = `${stub.url}//`;   // trailing slashes are trimmed
        const got = await shipping.fetchPaymentsForecast({ today: '2026-09-29', paidSince: '2026-08-01' });
        expect(got).toEqual(body);
        expect(stub.requests).toHaveLength(1);
        const [req] = stub.requests;
        expect(req).toMatchObject({
            method: 'GET',
            path: '/api/internal/payments-forecast',
            query: { today: '2026-09-29', paidSince: '2026-08-01' },
        });
        expect(req.headers['x-api-key']).toBe(KEY);
        expect(req.headers.accept).toBe('application/json');
        expect(req.headers.authorization).toBeUndefined();
        expect(JSON.stringify(req.query)).not.toContain(KEY);
    });

    test('a 401 → http_401', async () => {
        stub.respondJson(401, { error: 'Unauthorized' });
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }));
        expect(shipping.isUnavailable(err)).toBe(true);
        expect(err.reason).toBe('http_401');
        expect(err.message).not.toContain(KEY);
    });

    test.each([[500], [503], [404]])('a %i → http_<status>', async (status) => {
        stub.respondJson(status, { error: 'An internal error occurred.' });
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }));
        expect(err.reason).toBe(`http_${status}`);
    });

    test('a 200 that is not JSON → bad_response', async () => {
        stub.respondText(200, '<html>gateway says hello</html>');
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }));
        expect(shipping.isUnavailable(err)).toBe(true);
        expect(err.reason).toBe('bad_response');
    });

    test.each([
        ['an array', []],
        ['no items', { meta: {}, companies: [] }],
        ['items not an array', { items: { id: 'x' } }],
        ['null', null],
    ])('JSON of the wrong shape (%s) → bad_response', async (_label, body) => {
        stub.respondJson(200, body);
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }));
        expect(err.reason).toBe('bad_response');
    });

    test('no answer within the timeout → timeout (the default is 5s; the test injects 150ms)', async () => {
        stub.stall();
        const started = Date.now();
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }, { timeoutMs: 150 }));
        expect(err.reason).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(3000);
    });

    test('headers on time but a body that stalls → timeout (the body read is bounded too)', async () => {
        stub.stallBody();
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }, { timeoutMs: 150 }));
        expect(err.reason).toBe('timeout');
    });

    test('nothing listening → unreachable', async () => {
        // A port that was free a moment ago and is closed now.
        const tmp = http.createServer();
        await new Promise((resolve) => tmp.listen(0, '127.0.0.1', resolve));
        const { port } = tmp.address();
        await new Promise((resolve) => tmp.close(resolve));
        process.env.SHIPPING_API_BASE = `http://127.0.0.1:${port}`;
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }));
        expect(err.reason).toBe('unreachable');
    });

    test('no failure message or log line carries the key', async () => {
        stub.respondJson(401, { error: 'Unauthorized' });
        const err = await rejectionOf(shipping.fetchPaymentsForecast({ today: '2026-09-29' }));
        expect(err.message).not.toContain(KEY);
        for (const call of warnSpy.mock.calls) expect(call.join(' ')).not.toContain(KEY);
    });
});

describe('validateFeed', () => {
    test('a clean feed: every row kept, normalised, nothing rejected', () => {
        const out = shipping.validateFeed(feedBody([
            feedItem('bal-812-s311', { amount: '12.5', flags: ['projected', 'estimated'], dateBasis: 'estimated' }),
            feedItem('dep-900', { kind: 'deposit', dueDate: null, dateBasis: 'undated', shipmentId: null, containerRef: null }),
            feedItem('pay-17-bal812', {
                status: 'paid', dueDate: null, paidOn: '2026-09-20', settles: 'bal-812-s311', amount: '100.00',
            }),
        ]));
        expect(out.rejected).toBe(0);
        expect(out.items).toHaveLength(3);
        expect(out.items[0]).toEqual({
            id: 'bal-812-s311', kind: 'balance', status: 'open', supplier: 'Acme Textiles', companyId: 1,
            poId: 812, poNumber: 'PO-812', shipmentId: 311, containerRef: 'MSKU1234567', currency: 'USD',
            amount: '12.50', dueDate: '2026-10-15', paidOn: null, settles: null, dateBasis: 'estimated',
            amountBasis: 'stated', blocked: null, flags: ['estimated', 'projected'],
        });
        expect(out.items[1]).toMatchObject({ id: 'dep-900', dueDate: null, dateBasis: 'undated', flags: [] });
        expect(out.items[2]).toMatchObject({ status: 'paid', paidOn: '2026-09-20', settles: 'bal-812-s311' });
        expect(out.companies).toEqual([{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }]);
    });

    test('bad rows are counted and rejected; the good ones survive', () => {
        const bad = [
            'not an object',
            null,
            feedItem('derived:dep:812'),                        // id grammar: ':' (finding 3)
            feedItem('x'.repeat(65)),                           // id grammar: too long
            feedItem(''),                                       // id grammar: empty
            feedItem(812),                                      // id not a string
            feedItem('a1', { amount: 12.5 }),                   // amount must be a DECIMAL string
            feedItem('a2', { amount: '1.234' }),                // parseMinor: 3 decimals
            feedItem('a3', { amount: '0.00' }),                 // must be > 0
            feedItem('a4', { amount: '-5.00' }),
            feedItem('d1', { dueDate: '2026-02-30' }),          // not a real date
            feedItem('d2', { dueDate: '29/09/2026' }),
            feedItem('d3', { dueDate: null, dateBasis: 'firm' }),            // undated needs dateBasis undated
            feedItem('d4', { dateBasis: 'undated' }),                        // …and dated must not say undated
            feedItem('p1', { status: 'paid', paidOn: null, dueDate: null }), // a paid row needs paidOn
            feedItem('p2', { paidOn: '2026-09-01' }),                        // an open row has no paidOn
            feedItem('c1', { currency: 'usd' }),
            feedItem('c2', { currency: 'US' }),
            feedItem('k1', { kind: 'refund' }),
            feedItem('s1', { status: 'closed' }),
            feedItem('b1', { dateBasis: 'guess' }),
            feedItem('b2', { amountBasis: 'quoted' }),
            feedItem('b3', { blocked: 'customs' }),
            feedItem('f1', { flags: 'estimated' }),
            feedItem('f2', { flags: [1] }),
            feedItem('i1', { companyId: 0 }),
            feedItem('i2', { poId: -3 }),
            feedItem('i3', { shipmentId: 1.5 }),
            feedItem('t1', { supplier: 'x'.repeat(256) }),
            feedItem('t2', { poNumber: 'x'.repeat(65) }),
            feedItem('t3', { containerRef: 'x'.repeat(101) }),
            feedItem('t4', { settles: 'derived:bal:1' }),
        ];
        const good = [feedItem('ok-1'), feedItem('ok-2', { companyId: null, blocked: 'pi_signed' })];
        const out = shipping.validateFeed(feedBody([...good.slice(0, 1), ...bad, ...good.slice(1)]));
        expect(out.rejected).toBe(bad.length);
        expect(out.items.map((i) => i.id)).toEqual(['ok-1', 'ok-2']);
        expect(out.problems.length).toBeGreaterThan(0);
        expect(out.problems[0]).toEqual(expect.objectContaining({ index: 1, reason: expect.any(String) }));
    });

    test('a repeated id is rejected after its first appearance (ids compare as the DB compares them)', () => {
        const out = shipping.validateFeed(feedBody([
            feedItem('bal-1-n', { amount: '10.00' }),
            feedItem('bal-1-n', { amount: '20.00' }),
            feedItem('BAL-1-N', { amount: '30.00' }),
        ]));
        expect(out.rejected).toBe(2);
        expect(out.items).toHaveLength(1);
        expect(out.items[0].amount).toBe('10.00');
    });

    test('numeric ids may arrive as canonical decimal strings; optional fields may be absent', () => {
        const item = feedItem('bal-9-n', { companyId: '2', poId: '9', shipmentId: undefined });
        delete item.supplier;
        delete item.flags;
        delete item.settles;
        const out = shipping.validateFeed(feedBody([item]));
        expect(out.rejected).toBe(0);
        expect(out.items[0]).toMatchObject({ companyId: 2, poId: 9, shipmentId: null, supplier: null, flags: [], settles: null });
    });

    test('companies: bad entries are dropped (not counted as rejected rows); absent → []', () => {
        const out = shipping.validateFeed(feedBody([], {
            companies: [{ id: 1, name: 'JFA Medical Ltd' }, { id: 'x', name: 'Bad' }, { id: 3 }, null],
        }));
        expect(out.companies).toEqual([{ id: 1, name: 'JFA Medical Ltd' }]);
        expect(out.rejected).toBe(0);
        const bare = shipping.validateFeed({ items: [] });
        expect(bare.companies).toEqual([]);
    });

    test('a body with no items array is a bad_response, not an empty feed', () => {
        for (const body of [null, [], {}, { items: 'x' }]) {
            let err;
            try { shipping.validateFeed(body); } catch (e) { err = e; }
            expect(shipping.isUnavailable(err)).toBe(true);
            expect(err.reason).toBe('bad_response');
        }
    });
});
