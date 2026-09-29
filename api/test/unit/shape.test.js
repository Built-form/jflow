// Copied from workflows/api/test/unit/shape.test.js — changes: trimmed to what lib/shape.js still holds — dropped the entity-shaper coercion, attachment-URL and add-on-family tests; the JSON-column tests and null-row safety now run through auditToJson; kept the envelope and parseCap tests verbatim; added tests for fail/apiError/sendApiError, parseId, parseListParams, normalizeEmail/isValidEmail and the trimmed export list
'use strict';

// lib/shape.js — the envelopes, the parsers and the one row shaper left after
// the trim (auditToJson). Pinned here: what a route test would NOT catch
// cheaply — the refusal envelope's exact keys, the clamps, and JSON columns
// that come back from the driver either parsed or as text.

const shape = require('../../src/lib/shape');

describe('what the trimmed module exports', () => {
    test('exactly the envelopes, parsers and auditToJson (CLAUDE.md copy table)', () => {
        expect(Object.keys(shape).sort()).toEqual([
            'accountToJson', 'apiError', 'assertBaseVersion', 'auditToJson', 'balanceToJson',
            'categoryToJson', 'companyToJson', 'fail', 'fxRateToJson', 'isApiError',
            'isValidEmail', 'keysetResponse', 'listResponse', 'normalizeEmail',
            'parseBaseVersion', 'parseCap', 'parseId', 'parseListParams', 'parseSortOrder',
            'sendApiError', 'serverError',
        ]);
    });
});

/** A stand-in for Express's res: records status and body. */
function fakeRes() {
    const res = { statusCode: null, body: undefined, headersSent: false };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; res.headersSent = true; return res; };
    return res;
}

describe('refusal envelope', () => {
    test('fail sends {error} alone when there is no code or details', () => {
        const res = fakeRes();
        shape.fail(res, 400, 'Bad input.');
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Bad input.' });
    });

    test('fail carries code and details when given', () => {
        const res = fakeRes();
        shape.fail(res, 409, 'Stale.', 'STALE_WRITE', { currentVersion: 3 });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: 'Stale.', code: 'STALE_WRITE', details: { currentVersion: 3 } });
    });

    test('apiError builds a throwable refusal that sendApiError answers identically', () => {
        const err = shape.apiError(422, 'BALANCE_DATE_IN_FUTURE', 'Too late.', { balanceDate: '2026-10-01' });
        expect(err).toBeInstanceOf(Error);
        expect(shape.isApiError(err)).toBe(true);
        expect(shape.isApiError(new Error('real bug'))).toBe(false);
        expect(shape.isApiError(null)).toBe(false);
        const res = fakeRes();
        shape.sendApiError(res, err);
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({
            error: 'Too late.', code: 'BALANCE_DATE_IN_FUTURE', details: { balanceDate: '2026-10-01' },
        });
    });

    test('sendApiError defaults to 409 when the error carries no status', () => {
        const res = fakeRes();
        shape.sendApiError(res, { message: 'Conflict.', code: 'X' });
        expect(res.statusCode).toBe(409);
    });

    test('serverError answers the generic 500 with the request id', () => {
        const res = fakeRes();
        res.req = { requestId: 'req-1' };
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            shape.serverError(res, 'test', new Error('boom'));
        } finally {
            spy.mockRestore();
        }
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'An internal error occurred.', requestId: 'req-1' });
    });
});

describe('auditToJson', () => {
    test('maps the row to camelCase', () => {
        expect(shape.auditToJson({
            id: 5, entity_type: 'company', entity_id: 2, action: 'update',
            before_json: { name: 'A' }, after_json: { name: 'B' }, reason: null,
            user_email: 'a@b.test', created_at: '2026-09-29T10:00:00.000Z',
        })).toEqual({
            id: 5, entityType: 'company', entityId: 2, action: 'update',
            before: { name: 'A' }, after: { name: 'B' }, reason: null,
            userEmail: 'a@b.test', createdAt: '2026-09-29T10:00:00.000Z',
        });
    });

    test('a JSON column already parsed by the driver passes through', () => {
        expect(shape.auditToJson({ id: 1, after_json: { unit: 'g' } }).after).toEqual({ unit: 'g' });
    });

    test('a JSON column handed back as text is parsed', () => {
        expect(shape.auditToJson({ id: 1, after_json: '{"unit":"g"}' }).after).toEqual({ unit: 'g' });
    });

    test('unparseable JSON degrades to null instead of throwing', () => {
        expect(shape.auditToJson({ id: 1, after_json: 'not json' }).after).toBeNull();
    });

    test('a NULL JSON column stays null', () => {
        expect(shape.auditToJson({ id: 1, before_json: null }).before).toBeNull();
    });
});

describe('null-row safety', () => {
    // Detail routes do `shape(rows[0])` on a possibly-empty result; returning
    // null lets the caller 404 instead of throwing on undefined.
    test.each(['auditToJson'])('%s(undefined) returns null', (fn) => {
        expect(shape[fn](undefined)).toBeNull();
        expect(shape[fn](null)).toBeNull();
    });
});

describe('envelopes', () => {
    test('listResponse carries the paging triple', () => {
        expect(shape.listResponse([{ id: 1 }], { page: 2, limit: 50, total: 120 }))
            .toEqual({ data: [{ id: 1 }], page: 2, limit: 50, total: 120 });
    });

    test('keysetResponse yields the last id when the page is full', () => {
        expect(shape.keysetResponse([{ id: 9 }, { id: 7 }], 2).nextCursor).toBe(7);
    });

    test('keysetResponse yields null when the page came back short', () => {
        expect(shape.keysetResponse([{ id: 9 }], 2).nextCursor).toBeNull();
    });

    test('keysetResponse yields null on an empty page', () => {
        expect(shape.keysetResponse([], 2).nextCursor).toBeNull();
    });
});

describe('parseId', () => {
    test.each([
        ['1', 1], ['42', 42], [7, 7],
        ['0', null], ['-3', null], ['2.5', null], ['abc', null], ['', null], [undefined, null], ['1e3', 1000],
    ])('%p -> %p', (raw, expected) => {
        expect(shape.parseId(raw)).toBe(expected);
    });
});

describe('parseListParams (CONTRACT §2.3)', () => {
    test('defaults: page 1, limit 100', () => {
        expect(shape.parseListParams({})).toEqual({ page: 1, limit: 100, offset: 0 });
        expect(shape.parseListParams()).toEqual({ page: 1, limit: 100, offset: 0 });
    });

    test('limit clamps to 1..500; page to >= 1; offset follows', () => {
        expect(shape.parseListParams({ limit: '0' }).limit).toBe(1);
        expect(shape.parseListParams({ limit: '9999' }).limit).toBe(500);
        expect(shape.parseListParams({ page: '-2' }).page).toBe(1);
        expect(shape.parseListParams({ page: '3', limit: '20' })).toEqual({ page: 3, limit: 20, offset: 40 });
    });
});

describe('parseCap', () => {
    // The bare-array ceiling (WP 2.2). Clamps rather than refuses — consistent
    // with parseListParams — so these pin the surprising-but-accepted cases.
    test.each([
        ['absent', undefined, 500],
        ['empty string', '', 500],
        ['non-numeric', 'abc', 500],
        ['zero clamps up', '0', 1],
        ['negative clamps up', '-5', 1],
        ['over the max clamps down', '501', 500],
        ['scientific notation parses as its mantissa', '1e9', 1],
        ['fractional truncates', '3.9', 3],
        ['in range passes through', '42', 42],
    ])('%s -> %i', (_label, raw, expected) => {
        expect(shape.parseCap(raw)).toBe(expected);
    });

    test('a custom default is honoured when the param is absent', () => {
        expect(shape.parseCap(undefined, 100)).toBe(100);
        expect(shape.parseCap('7', 100)).toBe(7);
    });
});

describe('emails', () => {
    test('normalizeEmail trims and lowercases; null-ish becomes empty', () => {
        expect(shape.normalizeEmail('  Dev@Built-Form.CO.UK ')).toBe('dev@built-form.co.uk');
        expect(shape.normalizeEmail(null)).toBe('');
        expect(shape.normalizeEmail(undefined)).toBe('');
    });

    test('isValidEmail accepts a plain address and refuses the obvious non-addresses', () => {
        expect(shape.isValidEmail('a@b.test')).toBe(true);
        expect(shape.isValidEmail('a@b')).toBe(false);
        expect(shape.isValidEmail('a b@c.test')).toBe(false);
        expect(shape.isValidEmail('')).toBe(false);
        expect(shape.isValidEmail(null)).toBe(false);
    });
});
