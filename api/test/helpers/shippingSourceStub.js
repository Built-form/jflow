'use strict';

// An in-process stand-in for services/shippingSource.js readPaymentsForecast — the one
// call the refresh makes to read shipping's data (docs/PLAN.md "Phase 2"). The suites that
// need exact feed rows (the refresh diff, /forecast's ship lines, the overlay routes)
// serve them through this; the real source runs against a shadow schema in
// test/e2e/shipping-source.test.js. Nothing here touches a database.
//
// It swaps the function on the module object, which services/shipping.js looks up per
// call, so it must be required in the same jest module registry as the app (the suite
// file) and `restore()`d in afterAll. Every call is recorded as {today, paidSince}. The
// answer is the current handler: `respond(body)` (optionally late), `fail(reason)`,
// `respondWith(fn)`, or `passThrough()` to the real source; an empty feed by default.

const source = require('../../src/services/shippingSource');
const shipping = require('../../src/services/shipping');

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

/** A whole feed body, as readPaymentsForecast returns it. */
function feedBody(items, { today = '2026-09-29', paidSince = '2026-07-31', companies } = {}) {
    return {
        meta: { today, paidSince, generatedAt: '2026-09-29T09:00:00.000Z', model: 'stub', schema: 'stub', outstanding: {} },
        companies: companies || [{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }],
        items,
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Replace readPaymentsForecast until `restore()`. */
function stubShippingSource() {
    const original = source.readPaymentsForecast;
    const requests = [];
    let handler = null;

    source.readPaymentsForecast = async (args = {}) => {
        requests.push({ today: args.today, paidSince: args.paidSince });
        if (handler) return handler(args);
        return feedBody([]);
    };

    return {
        requests,
        /** Answer every call with (a copy of) `body`, optionally after `delayMs`. */
        respond(body, { delayMs = 0 } = {}) {
            handler = async () => {
                if (delayMs > 0) await sleep(delayMs);
                return clone(body);
            };
        },
        /** Fail every call as the source does: unavailable(reason). */
        fail(reason = 'source_error', message = `The stub source failed (${reason}).`) {
            handler = async () => { throw shipping.unavailable(reason, message); };
        },
        /** Any `(args) => body | Promise<body>`; it may throw. */
        respondWith(fn) {
            handler = fn;
        },
        /** The real readPaymentsForecast (it reads SHIPPING_DB_SCHEMA). */
        passThrough() {
            handler = (args) => original(args);
        },
        reset() {
            requests.length = 0;
            handler = null;
        },
        restore() {
            source.readPaymentsForecast = original;
        },
    };
}

module.exports = { stubShippingSource, feedItem, feedBody };
