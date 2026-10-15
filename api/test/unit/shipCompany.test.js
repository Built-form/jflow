'use strict';

// services/externalItems.js assignCompany — a company chosen in JFlow for a stock payment
// shipping gives none (Dev, 2026-10-15; CONTRACT §10.11a), without a database: a scripted
// connection answers the row lock, the company check, the UPDATE and the audit INSERT. The
// SQL itself (resolution through shipResolvedSelect, the migration) is pinned by
// test/e2e/ship-company.test.js.

const { assignCompany } = require('../../src/services/externalItems');

const ROW = {
    id: 41, source: 'ship', ext_id: 'bal-900-s12', shipping_company_id: null, gone_at: null, feed_status: 'open',
    assigned_company_id: null, company_set_by: null, company_set_at: null, row_version: 3,
};

/**
 * A connection over one external_items row and a set of live company ids. The UPDATE is
 * applied to the row, so the second lock reads what was written; every statement is kept.
 */
function scriptedConn(row, liveCompanies = [1, 2]) {
    let current = row ? { ...row } : null;
    const statements = [];
    const conn = {
        statements,
        async query(sql, params = []) {
            statements.push({ sql, params });
            if (/FROM external_items .*FOR UPDATE/s.test(sql)) return [current ? [{ ...current }] : []];
            if (/FROM companies/.test(sql)) return [liveCompanies.includes(params[0]) ? [{ id: params[0] }] : []];
            if (/^\s*UPDATE external_items/.test(sql)) {
                const [companyId, by] = params;
                current = {
                    ...current, assigned_company_id: companyId, company_set_by: by,
                    company_set_at: companyId == null ? null : '2026-10-15 09:00:00', row_version: current.row_version + 1,
                };
                return [{ affectedRows: 1 }];
            }
            if (/INSERT INTO audit_log/.test(sql)) return [{ insertId: 1 }];
            throw new Error(`unexpected SQL: ${sql}`);
        },
    };
    return conn;
}

const updates = (conn) => conn.statements.filter((s) => /^\s*UPDATE external_items/.test(s.sql));
const audits = (conn) => conn.statements.filter((s) => /INSERT INTO audit_log/.test(s.sql));

const refusal = async (promise) => {
    try {
        await promise;
    } catch (err) {
        return { status: err.status, code: err.code, details: err.details };
    }
    throw new Error('expected a refusal');
};

describe('assignCompany: a company chosen in JFlow, only while shipping gives none', () => {
    test('sets the company with its stamps, bumps row_version and writes one audit row', async () => {
        const conn = scriptedConn(ROW);
        const out = await assignCompany(conn, { extId: ROW.ext_id, companyId: 2, userEmail: 'dev@x.y' });
        expect(out.changed).toBe(true);
        expect(out.row).toMatchObject({ assigned_company_id: 2, company_set_by: 'dev@x.y', row_version: 4 });
        expect(updates(conn)).toHaveLength(1);
        expect(updates(conn)[0].params).toEqual([2, 'dev@x.y', 41]);
        expect(audits(conn)).toHaveLength(1);
        const params = audits(conn)[0].params;
        expect(params).toEqual(expect.arrayContaining(['external_item', 41, 'assign_company']));
        expect(JSON.parse(params.find((p) => typeof p === 'string' && p.includes('"key"')))).toEqual({
            key: 'ship.bal-900-s12', assignedCompanyId: 2,
        });
    });

    test('null clears it, stamps included; clearing works even after shipping gave the row a company', async () => {
        const conn = scriptedConn({ ...ROW, shipping_company_id: 7, assigned_company_id: 2, company_set_by: 'dev@x.y' });
        const out = await assignCompany(conn, { extId: ROW.ext_id, companyId: null, userEmail: 'dev@x.y' });
        expect(out.changed).toBe(true);
        expect(updates(conn)[0].params).toEqual([null, null, 41]);
        expect(out.row).toMatchObject({ assigned_company_id: null, company_set_by: null, company_set_at: null });
        expect(audits(conn)).toHaveLength(1);
    });

    test('the same company again writes nothing', async () => {
        const conn = scriptedConn({ ...ROW, assigned_company_id: 2 });
        const out = await assignCompany(conn, { extId: ROW.ext_id, companyId: 2, userEmail: 'dev@x.y' });
        expect(out.changed).toBe(false);
        expect(updates(conn)).toHaveLength(0);
        expect(audits(conn)).toHaveLength(0);
    });

    test('refused, writing nothing: shipping has a company, a gone row, no row, a dead company, a stale version', async () => {
        const cases = [
            [scriptedConn({ ...ROW, shipping_company_id: 7 }), { companyId: 1 },
                { status: 409, code: 'SHIP_COMPANY_IN_SHIPPING', details: { key: 'ship.bal-900-s12', shippingCompanyId: 7 } }],
            [scriptedConn({ ...ROW, gone_at: '2026-10-14 10:00:00' }), { companyId: 1 },
                { status: 404, code: 'TARGET_MISSING', details: { key: 'ship.bal-900-s12' } }],
            [scriptedConn(null), { companyId: 1 }, { status: 404, code: undefined, details: undefined }],
            [scriptedConn(ROW), { companyId: 9 }, { status: 400, code: undefined, details: undefined }],
            [scriptedConn(ROW), { companyId: 1, baseVersion: 2 }, { status: 409, code: 'STALE_WRITE', details: { currentVersion: 3 } }],
        ];
        for (const [conn, args, expected] of cases) {
            expect(await refusal(assignCompany(conn, { extId: ROW.ext_id, userEmail: 'dev@x.y', ...args }))).toEqual(expected);
            expect(updates(conn)).toHaveLength(0);
            expect(audits(conn)).toHaveLength(0);
        }
    });

    test('a paid row can take a company: its money left one of that company\'s accounts', async () => {
        const conn = scriptedConn({ ...ROW, feed_status: 'paid' });
        const out = await assignCompany(conn, { extId: ROW.ext_id, companyId: 1, userEmail: 'dev@x.y' });
        expect(out.changed).toBe(true);
    });
});
