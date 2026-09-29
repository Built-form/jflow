'use strict';

// services/forecastLoad.js loadShipRows — the SHIP_UNMAPPED counts (CONTRACT §6.10, §8 rule
// 11), without a database: the resolved rows come from a stub connection, as
// shipResolvedSelect would return them. Resolution itself (P5) runs in SQL and is pinned by
// test/e2e/forecast-ship.test.js.

const { loadShipRows } = require('../../src/services/forecastLoad');

const stubConn = (rows) => ({ query: async () => [rows] });

/** An unmapped resolved row: no account; `company` = the JFlow company that matched, or null. */
const row = (extId, shippingCompanyId, company, currency, over = {}) => ({
    id: extId.length, ext_id: extId, source: 'ship', feed_status: 'open', gone_at: null,
    shipping_company_id: shippingCompanyId, resolved_company_id: company, resolved_account_id: null,
    currency, amount: '1.00', due_date: '2026-10-01', ...over,
});

const ROWS = [
    row('bal-1', 7, null, 'USD'),
    row('bal-2', 2, 20, 'USD'),
    row('bal-3', null, null, 'GBP'),
    row('bal-4', 2, 20, 'EUR'),
    row('bal-5', 2, 20, 'USD'),
    row('bal-6', 7, null, 'EUR'),
    row('bal-7', 5, 50, 'CNY'),
    row('bal-8', 2, 20, 'EUR', { gone_at: '2026-09-28 10:00:00' }),   // gone: never counted
];

describe('loadShipRows: SHIP_UNMAPPED counts by shipping company and reason', () => {
    test("'company' when nothing links the shipping company (null included); 'account' with the company and failed currencies", async () => {
        const { rows, unmappedCounts } = await loadShipRows(stubConn(ROWS), { accountIds: [], minA: '2026-09-20', companyId: 'all' });
        expect(rows).toEqual([]);
        expect(unmappedCounts).toEqual([
            { shippingCompanyId: null, count: 1, reason: 'company' },
            { shippingCompanyId: 2, count: 3, reason: 'account', companyId: 20, currencies: ['EUR', 'USD'] },
            { shippingCompanyId: 5, count: 1, reason: 'account', companyId: 50, currencies: ['CNY'] },
            { shippingCompanyId: 7, count: 2, reason: 'company' },
        ]);
    });

    test("a company's scope counts its own 'account' rows and every 'company' row", async () => {
        const { unmappedCounts } = await loadShipRows(stubConn(ROWS), { accountIds: [], minA: '2026-09-20', companyId: 20 });
        expect(unmappedCounts).toEqual([
            { shippingCompanyId: null, count: 1, reason: 'company' },
            { shippingCompanyId: 2, count: 3, reason: 'account', companyId: 20, currencies: ['EUR', 'USD'] },
            { shippingCompanyId: 7, count: 2, reason: 'company' },
        ]);
        const other = await loadShipRows(stubConn(ROWS), { accountIds: [], minA: '2026-09-20', companyId: 99 });
        expect(other.unmappedCounts.map((u) => [u.shippingCompanyId, u.reason])).toEqual([[null, 'company'], [7, 'company']]);
    });

    test('a row that resolves to an account is not counted', async () => {
        const { unmappedCounts } = await loadShipRows(
            stubConn([row('bal-9', 2, 20, 'USD', { resolved_account_id: 3 })]),
            { accountIds: [], minA: '2026-09-20', companyId: 'all' },
        );
        expect(unmappedCounts).toEqual([]);
    });
});
