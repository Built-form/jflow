'use strict';

// A stub of shipping's GET /api/internal/payments-forecast (docs/PHASE2.md §3) on a
// Node `http` server bound to 127.0.0.1 and a free port. The unit suite for
// services/shipping.js and the e2e suite for the refresh both point
// SHIPPING_API_BASE at it; nothing in the test run ever calls the real shipping API.
//
// Every request is recorded ({method, path, query, headers}). The answer is whatever
// the current handler does: `respondJson(status, body)` by default, or any
// `(req, res) => …` passed to `respond`. `stall()` never answers (the timeout
// tests); `stallBody()` sends headers and half a body, then stops.

const http = require('http');

/** A feed row with every §3 field, open and dated unless `over` says otherwise. */
function feedItem(id, over = {}) {
    return {
        id,
        kind: 'balance',
        status: 'open',
        supplier: 'Acme Textiles',
        companyId: 1,
        poId: 812,
        poNumber: 'PO-812',
        shipmentId: 311,
        containerRef: 'MSKU1234567',
        currency: 'USD',
        amount: '12345.67',
        dueDate: '2026-10-15',
        dateBasis: 'firm',
        amountBasis: 'stated',
        blocked: null,
        arranged: false,
        paidOn: null,
        settles: null,
        flags: [],
        ...over,
    };
}

/** A whole feed body. */
function feedBody(items, { today = '2026-09-29', paidSince = '2026-07-31', companies } = {}) {
    return {
        meta: { today, paidSince, generatedAt: '2026-09-29T09:00:00.000Z', model: 'stub' },
        companies: companies || [{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }],
        items,
    };
}

async function startShippingStub() {
    const requests = [];
    let handler = null;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://stub');
        requests.push({
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: { ...req.headers },
        });
        // Drain the (empty) request body before answering.
        req.resume();
        req.on('end', () => {
            if (handler) handler(req, res);
            else sendJson(res, 200, feedBody([]));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    function sendJson(res, status, body, delayMs = 0) {
        const send = () => {
            const text = typeof body === 'string' ? body : JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(text);
        };
        if (delayMs > 0) setTimeout(send, delayMs);
        else send();
    }

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        /** Answer every request with `status` and `body` (an object, or raw text), optionally late. */
        respondJson(status, body, { delayMs = 0 } = {}) {
            handler = (_req, res) => sendJson(res, status, body, delayMs);
        },
        /** Answer with a raw body and content type. */
        respondText(status, text, contentType = 'text/html') {
            handler = (_req, res) => {
                res.writeHead(status, { 'Content-Type': contentType });
                res.end(text);
            };
        },
        /** Never answer: the request hangs until the client gives up. */
        stall() {
            handler = () => {};
        },
        /** Headers and part of a body, then nothing. */
        stallBody() {
            handler = (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write('{"items": [');
            };
        },
        respond(fn) {
            handler = fn;
        },
        reset() {
            requests.length = 0;
            handler = null;
        },
        async close() {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

module.exports = { startShippingStub, feedItem, feedBody };
