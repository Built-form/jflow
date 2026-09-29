'use strict';

// Category routes (CONTRACT §6.4, §10.2).
//
// A category is a grid row group with a direction (`in` | `out`). Items and
// schedules carry the same direction as their category (D14), so the direction
// is editable only while no live item or schedule uses the category, and a
// category in use cannot be deleted (409 CATEGORY_IN_USE {itemCount,
// scheduleCount}, D15). Soft delete.

const express = require('express');

const { withConnection, withTransaction } = require('../db');
const { recordAudit } = require('../lib/audit');
const {
    apiError, isApiError, sendApiError, listResponse, parseId, parseListParams,
    parseBaseVersion, assertBaseVersion, parseSortOrder, categoryToJson,
} = require('../lib/shape');

function parseName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name && name.length <= 255 ? name : null;
}

async function readCategory(conn, id, { includeDeleted = false } = {}) {
    const [rows] = await conn.query(
        `SELECT * FROM categories WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`, [id]
    );
    return rows.length ? rows[0] : null;
}

/** Live items and schedules using the category — read under the category lock. */
async function usage(conn, id) {
    const [[items]] = await conn.query(
        'SELECT COUNT(*) AS n FROM cash_items WHERE category_id = ? AND deleted_at IS NULL', [id]
    );
    const [[schedules]] = await conn.query(
        'SELECT COUNT(*) AS n FROM schedules WHERE category_id = ? AND deleted_at IS NULL', [id]
    );
    return { itemCount: Number(items.n), scheduleCount: Number(schedules.n) };
}

module.exports = ({ schemaReady, fail, serverError, enums }) => {
    const router = express.Router();
    const DIRECTIONS = enums.directions;

    router.get('/categories', async (req, res) => {
        try {
            await schemaReady;
            const { page, limit, offset } = parseListParams(req.query);
            const where = [];
            const params = [];
            if (req.query.includeDeleted !== '1') where.push('deleted_at IS NULL');
            if (req.query.direction !== undefined) {
                const direction = String(req.query.direction);
                if (!DIRECTIONS.includes(direction)) {
                    return fail(res, 400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
                }
                where.push('direction = ?');
                params.push(direction);
            }
            if (req.query.q) {
                where.push('name LIKE ?');
                params.push(`%${String(req.query.q)}%`);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            const out = await withConnection(async (c) => {
                const [[{ total }]] = await c.query(`SELECT COUNT(*) AS total FROM categories ${whereSql}`, params);
                const [rows] = await c.query(
                    `SELECT * FROM categories ${whereSql}
                      ORDER BY direction ASC, sort_order ASC, name ASC, id ASC
                      LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                );
                return { total, rows };
            });
            res.json(listResponse(out.rows.map(categoryToJson), { page, limit, total: Number(out.total) }));
        } catch (err) {
            serverError(res, 'categories-list', err);
        }
    });

    router.post('/categories', async (req, res) => {
        try {
            await schemaReady;
            const body = req.body || {};
            const name = parseName(body.name);
            if (!name) return fail(res, 400, 'name is required (at most 255 characters).');
            if (!DIRECTIONS.includes(body.direction)) {
                return fail(res, 400, `direction is required: one of ${DIRECTIONS.join(', ')}.`);
            }
            const sortOrder = parseSortOrder(body.sortOrder);
            if (Number.isNaN(sortOrder)) return fail(res, 400, 'sortOrder must be an integer.');

            const created = await withTransaction(async (conn) => {
                const [ins] = await conn.query(
                    'INSERT INTO categories (name, direction, sort_order, created_by) VALUES (?, ?, ?, ?)',
                    [name, body.direction, sortOrder, req.userEmail]
                );
                const after = categoryToJson(await readCategory(conn, ins.insertId));
                await recordAudit(conn, {
                    entityType: 'category', entityId: ins.insertId, action: 'create',
                    before: null, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.status(201).json(created);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'categories-create', err);
        }
    });

    router.get('/categories/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Category not found.');
            const row = await withConnection((c) =>
                readCategory(c, id, { includeDeleted: req.query.includeDeleted === '1' }));
            if (!row) return fail(res, 404, 'Category not found.');
            res.json(categoryToJson(row));
        } catch (err) {
            serverError(res, 'categories-get', err);
        }
    });

    router.put('/categories/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Category not found.');
            const body = req.body || {};
            const hasName = body.name !== undefined;
            const hasDirection = body.direction !== undefined;
            const hasSortOrder = body.sortOrder !== undefined;
            if (!hasName && !hasDirection && !hasSortOrder) {
                return fail(res, 400, 'Nothing to update: send name, direction and/or sortOrder.');
            }
            const name = hasName ? parseName(body.name) : null;
            if (hasName && !name) return fail(res, 400, 'name cannot be blank (at most 255 characters).');
            if (hasDirection && !DIRECTIONS.includes(body.direction)) {
                return fail(res, 400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
            }
            const sortOrder = hasSortOrder ? parseSortOrder(body.sortOrder) : null;
            if (hasSortOrder && Number.isNaN(sortOrder)) return fail(res, 400, 'sortOrder must be an integer.');
            const baseVersion = parseBaseVersion(body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            const updated = await withTransaction(async (conn) => {
                const [rows] = await conn.query(
                    'SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
                );
                if (!rows.length) throw apiError(404, undefined, 'Category not found.');
                const row = rows[0];
                assertBaseVersion(row, baseVersion);
                const next = {
                    name: hasName ? name : row.name,
                    direction: hasDirection ? body.direction : row.direction,
                    sortOrder: hasSortOrder ? sortOrder : row.sort_order,
                };
                if (next.direction !== row.direction) {
                    const used = await usage(conn, id);
                    if (used.itemCount || used.scheduleCount) {
                        throw apiError(409, 'CATEGORY_IN_USE',
                            'Live items or schedules use this category, so its direction cannot change.', used);
                    }
                }
                const before = categoryToJson(row);
                if (next.name === row.name && next.direction === row.direction && next.sortOrder === row.sort_order) {
                    return before;
                }
                await conn.query(
                    `UPDATE categories SET name = ?, direction = ?, sort_order = ?, row_version = row_version + 1
                      WHERE id = ?`,
                    [next.name, next.direction, next.sortOrder, id]
                );
                const after = categoryToJson(await readCategory(conn, id));
                await recordAudit(conn, {
                    entityType: 'category', entityId: id, action: 'update', before, after, userEmail: req.userEmail,
                });
                return after;
            });
            res.json(updated);
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'categories-update', err);
        }
    });

    router.delete('/categories/:id', async (req, res) => {
        try {
            await schemaReady;
            const id = parseId(req.params.id);
            if (!id) return fail(res, 404, 'Category not found.');
            const baseVersion = parseBaseVersion(req.body);
            if (Number.isNaN(baseVersion)) return fail(res, 400, 'baseVersion must be a non-negative integer.');

            await withTransaction(async (conn) => {
                const [rows] = await conn.query(
                    'SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]
                );
                if (!rows.length) throw apiError(404, undefined, 'Category not found.');
                assertBaseVersion(rows[0], baseVersion);
                const used = await usage(conn, id);
                if (used.itemCount || used.scheduleCount) {
                    throw apiError(409, 'CATEGORY_IN_USE',
                        'Live items or schedules use this category. Move or delete them first.', used);
                }
                await conn.query(
                    'UPDATE categories SET deleted_at = UTC_TIMESTAMP(), row_version = row_version + 1 WHERE id = ?', [id]
                );
                await recordAudit(conn, {
                    entityType: 'category', entityId: id, action: 'delete',
                    before: categoryToJson(rows[0]),
                    after: categoryToJson(await readCategory(conn, id, { includeDeleted: true })),
                    userEmail: req.userEmail,
                });
            });
            res.status(204).end();
        } catch (err) {
            if (isApiError(err)) return sendApiError(res, err);
            serverError(res, 'categories-delete', err);
        }
    });

    return router;
};
