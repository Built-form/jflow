'use strict';

// Company routes (CONTRACT §6.2, §10.2).
//
// A company owns bank accounts; items and schedules reach it through their
// account. Soft delete, refused with 409 COMPANY_IN_USE while any live account
// belongs to the company (D15). `code` is upper-cased and trimmed on write and
// unique among LIVE companies — enforced here, not by a UNIQUE key, so a deleted
// company's code can be reused (D15, 409 COMPANY_CODE_TAKEN).
//
// Uniqueness without gap locks (§10.1): a write that sets a code first locks
// every live company row ascending by id. A concurrent writer blocks on those
// row locks and, once through, its locking read sees the first writer's commit.

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, parseSortOrder, companyToJson,
} = require('../lib/shape');

const CODE_RE = /^[A-Z0-9_]{1,16}$/;

/** Trimmed, upper-cased code matching the grammar, else null. */
function parseCode(value) {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    return CODE_RE.test(code) ? code : null;
}

/** Trimmed non-blank name of at most 255 characters, else null. */
function parseName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= 255 ? name : null;
}

async function readCompany(conn, id, { includeDeleted = false } = {}) {
    const [rows] = await conn.query(
        `SELECT * FROM companies WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`, [id]
    );
    return rows.length ? rows[0] : null;
}

/** Every live company, locked ascending by id — the code-uniqueness serialiser. */
async function lockLiveCompanies(conn) {
    const [rows] = await conn.query(
        'SELECT * FROM companies WHERE deleted_at IS NULL ORDER BY id ASC FOR UPDATE'
    );
    return rows;
}

function codeTaken(code, holderId) {
    return apiError(409, 'COMPANY_CODE_TAKEN',
        `Company code ${code} is already used by another company.`, { companyId: Number(holderId) });
}

module.exports = ({ schemaReady, fail, serverError }) => {
    const router = express.Router();

    router.get('/companies', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            if (req.query.includeDeleted !== '1') where.push('deleted_at IS NULL');
            if (req.query.q) {
                where.push('(code LIKE ? OR name LIKE ?)');
                const like = `%${String(req.query.q)}%`;
                params.push(like, like);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(`SELECT COUNT(*) AS total FROM companies ${whereSql}`, params);
                const [rows] = await c.query(
                    `SELECT * FROM companies ${whereSql}
                      ORDER BY sort_order ASC, name ASC, id ASC
                      LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, rows };
            });
            res.json(listResponse(out.rows.map(companyToJson), { page, limit, total: Number(out.total) }));
        } catch (err) {
            serverError(res, 'companies-list', err);
        }
    });

    router.post('/companies', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            const code = parseCode(body.code);
            if (!code) return fail(res, 400, 'code is required: 1-16 characters, A-Z, 0-9 or _.');
            const name = parseName(body.name);
            if (!name) return fail(res, 400, 'name is required (at most 255 characters).');
            const sortOrder = parseSortOrder(body.sortOrder);
            if (Number.isNaN(sortOrder)) return fail(res, 400, 'sortOrder must be an integer.');

            const created = await withTransaction(async (conn) => {
                const live = await lockLiveCompanies(conn);
                const holder = live.find((c) => c.code === code);
                if (holder) throw codeTaken(code, holder.id);
                const [ins] = await conn.query(
                    'INSERT INTO companies (code, name, sort_order, created_by) VALUES (?, ?, ?, ?)',
                    [code, name, sortOrder, req.userEmail]
                );
                const after = companyToJson(await readCompany(conn, ins.insertId));
                await recordAudit(conn, {
                    entityType: 'company', entityId: ins.insertId, action: 'create',
                    before: null, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'companies-create', err);
        }
    });

    router.get('/companies/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Company not found.');
            const row = await withConnection((c) =>
                readCompany(c, id, { includeDeleted: req.query.includeDeleted === '1' }));
            if (!row) return fail(res, 404, 'Company not found.');
            res.json(companyToJson(row));
        } catch (err) {
            serverError(res, 'companies-get', err);
        }
    });

    router.put('/companies/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Company not found.');
            const body = req.body || {};
            const hasCode = body.code !== undefined;
            const hasName = body.name !== undefined;
            const hasSortOrder = body.sortOrder !== undefined;
            if (!hasCode && !hasName && !hasSortOrder) {
                return fail(res, 400, 'Nothing to update: send code, name and/or sortOrder.');
            }
            const code = hasCode ? parseCode(body.code) : null;
            if (hasCode && !code) return fail(res, 400, 'code must be 1-16 characters, A-Z, 0-9 or _.');
            const name = hasName ? parseName(body.name) : null;
            if (hasName && !name) return fail(res, 400, 'name cannot be blank (at most 255 characters).');
            const sortOrder = hasSortOrder ? parseSortOrder(body.sortOrder) : null;
            if (hasSortOrder && Number.isNaN(sortOrder)) return fail(res, 400, 'sortOrder must be an integer.');
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            const updated = await withTransaction(async (conn) => {
                // A code write locks every live company (ascending, the target
                // among them); any other write locks the target alone.
                let row;
                let live = null;
                if (hasCode) {
                    live = await lockLiveCompanies(conn);
                    row = live.find((c) => Number(c.id) === id) || null;
                } else {
                    const [rows] = await conn.query(
                        'SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
                    );
                    row = rows[0] || null;
                }
                if (!row) throw apiError(404, undefined, 'Company not found.');
                assertBaseVersion(row, baseVersion);

                const next = {
                    code: hasCode ? code : row.code,
                    name: hasName ? name : row.name,
                    sortOrder: hasSortOrder ? sortOrder : row.sort_order,
                };
                if (next.code !== row.code) {
                    const holder = live.find((c) => c.code === next.code && Number(c.id) !== id);
                    if (holder) throw codeTaken(next.code, holder.id);
                }
                const before = companyToJson(row);
                if (next.code === row.code && next.name === row.name && next.sortOrder === row.sort_order) {
                    return before; // nothing changed: no write, no version bump, no audit
                }
                await conn.query(
                    `UPDATE companies SET code = ?, name = ?, sort_order = ?, row_version = row_version + 1
                      WHERE id = ?`,
                    [next.code, next.name, next.sortOrder, id]
                );
                const after = companyToJson(await readCompany(conn, id));
                await recordAudit(conn, {
                    entityType: 'company', entityId: id, action: 'update', before, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.json(updated);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'companies-update', err);
        }
    });

    router.delete('/companies/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Company not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            await withTransaction(async (conn) => {
                const [rows] = await conn.query(
                    'SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
                );
                if (!rows.length) throw apiError(404, undefined, 'Company not found.');
                assertBaseVersion(rows[0], baseVersion);
                // Read under the company lock: account create locks the company
                // row first, so no account can appear for it until this commits.
                const [accounts] = await conn.query(
                    'SELECT id FROM bank_accounts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id ASC', [id]
                );
                if (accounts.length) {
                    throw apiError(409, 'COMPANY_IN_USE',
                        'This company still has live bank accounts. Delete or move them first.',
                        { accountIds: accounts.map((a) => Number(a.id)) });
                }
                await conn.query(
                    'UPDATE companies SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?', [id]
                );
                await recordAudit(conn, {
                    entityType: 'company', entityId: id, action: 'delete',
                    before: companyToJson(rows[0]),
                    after: companyToJson(await readCompany(conn, id, { includeDeleted: true })),
                    userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'companies-delete', err);
        }
    });

    return router;
};
