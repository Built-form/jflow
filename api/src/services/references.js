'use strict';

// CONTRACT §10.1's one exception to the standing lock order, shared by the item and
// schedule writes: a write that sets or changes `account_id` / `category_id` (create,
// structural edit, split) takes FOR SHARE on the account and the category FIRST —
// before any standing-order lock — and re-checks that both are live (and the account
// active). Account deactivation / delete and category delete take FOR UPDATE on the
// same rows, so an item or schedule can never slip onto an account or category that
// is being switched off. Reference rows are never locked after a standing-order row.

const { apiError } = require('../lib/shape');

/**
 * FOR SHARE on the account and / or category named (a falsy id is skipped). Returns
 * the live rows, null when not live; requireAccount / requireCategory are the re-check.
 */
async function shareReferences(conn, { accountId, categoryId }) {
    let account = null;
    let category = null;
    if (accountId) {
        const [rows] = await conn.query(
            'SELECT id, currency, is_active FROM bank_accounts WHERE id = ? AND deleted_at IS NULL FOR SHARE',
            [accountId]
        );
        account = rows[0] || null;
    }
    if (categoryId) {
        const [rows] = await conn.query(
            'SELECT id, direction FROM categories WHERE id = ? AND deleted_at IS NULL FOR SHARE', [categoryId]
        );
        category = rows[0] || null;
    }
    return { account, category };
}

function requireAccount(account) {
    if (!account) throw apiError(400, undefined, 'accountId is not a live account.');
    if (!Number(account.is_active)) throw apiError(400, undefined, 'accountId is an inactive account.');
    return account;
}

function requireCategory(category) {
    if (!category) throw apiError(400, undefined, 'categoryId is not a live category.');
    return category;
}

/** D14: a sent `direction` must be the category's. */
function assertDirection(direction, category) {
    if (direction !== undefined && direction !== category.direction) {
        throw apiError(400, undefined,
            `direction must be the category's (${category.direction}); omit it to follow the category.`,
            { direction, categoryDirection: category.direction });
    }
}

module.exports = { shareReferences, requireAccount, requireCategory, assertDirection };
