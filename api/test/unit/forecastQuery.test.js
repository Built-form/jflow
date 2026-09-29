'use strict';

// routes/forecast.js parseQuery — CONTRACT §6.10's query validation, D7 defaults and the
// D25 window cap, without a database. Every refusal is a message-only 400 (§7); the
// scenario's liveness (404) and the company's (400) need the DB and are pinned by
// test/e2e/forecast.test.js.

const { parseQuery } = require('../../src/routes/forecast');
const { isApiError } = require('../../src/lib/shape');

const TODAY = '2026-03-10';
const ENUMS = { buckets: ['day', 'week', 'month'], includeModes: ['summary', 'grid'] };
const parse = (query) => parseQuery(query, TODAY, ENUMS);

function refusal(query) {
    try {
        parse(query);
    } catch (err) {
        return err;
    }
    throw new Error(`expected a 400 for ${JSON.stringify(query)}`);
}

describe('parseQuery (§6.10)', () => {
    test('defaults: bucket week, include grid, from / to left to the engine (D7), no scenario', () => {
        expect(parse({ companyId: '3' })).toEqual({
            companyId: 3, from: undefined, to: undefined, bucket: 'week', include: 'grid', scenarioId: null,
        });
        expect(parse({ companyId: 'all', from: '2026-03-01', to: '2026-04-30', bucket: 'month', include: 'summary', scenarioId: '7' }))
            .toEqual({ companyId: 'all', from: '2026-03-01', to: '2026-04-30', bucket: 'month', include: 'summary', scenarioId: 7 });
    });

    test('a past from and a to beyond 730 days are accepted: the engine clamps them', () => {
        expect(parse({ companyId: 'all', from: '2020-01-01', to: '2030-01-01' })).toMatchObject({ from: '2020-01-01', to: '2030-01-01' });
        expect(parse({ companyId: 'all', to: TODAY })).toMatchObject({ to: TODAY });
    });

    test.each([
        [{}, /companyId is required/],
        [{ companyId: '' }, /companyId is required/],
        [{ companyId: 'ALL' }, /companyId/],
        [{ companyId: '0' }, /companyId/],
        [{ companyId: '-1' }, /companyId/],
        [{ companyId: '2.5' }, /companyId/],
        [{ companyId: ['1', '2'] }, /companyId/],
        [{ companyId: '1', from: '2026-02-30' }, /from must be a real date/],
        [{ companyId: '1', to: 'soon' }, /to must be a real date/],
        [{ companyId: '1', to: '2026-03-09' }, /to must be today/],
        [{ companyId: '1', from: '2026-01-01', to: '2026-03-09' }, /to must be today/],
        [{ companyId: '1', from: '2026-04-02', to: '2026-04-01' }, /from must be on or before to/],
        [{ companyId: '1', from: '2026-07-01' }, /from must be on or before to/],             // default to = today + 90
        [{ companyId: '1', from: '2028-06-01', to: '2028-07-01' }, /within 730 days/],
        [{ companyId: '1', bucket: 'year' }, /bucket must be one of/],
        [{ companyId: '1', include: 'all' }, /include must be one of/],
        [{ companyId: '1', scenarioId: 'abc' }, /scenarioId/],
        [{ companyId: '1', scenarioId: '0' }, /scenarioId/],
    ])('%j → 400', (query, message) => {
        const err = refusal(query);
        expect(isApiError(err)).toBe(true);
        expect(err.status).toBe(400);
        expect(err.code).toBeUndefined();
        expect(err.message).toMatch(message);
    });
});
