// Copied from workflows/api/src/lib/roles.js — changes: two types, `standard | admin` (the pre-2026-09-16 workflows model, CONTRACT D5); dropped the `manager` tier (`canManage`), the reviewer flag (`effectiveReviewer`), the answer-only whitelist (`standardRoute`, `isAssignedTo`, `standardGate`) and the admin-only delete blacklist (`adminOnlyRoute`, `adminGate`); `requireAdmin` moved here from handlers/workflows.js (CONTRACT §12)
'use strict';

// ── Account types ───────────────────────────────────────────────────────────
//
// `allowed_emails.type` is one of two (CONTRACT D5, §2.1):
//
//   standard — trust-the-team: everything except user management;
//   admin    — standard, plus user management.
//
// Admin-only is exactly POST/PATCH/DELETE /users and
// GET /audit?entityType=allowed_email (403 ADMIN_REQUIRED). Each of those routes
// calls requireAdmin itself; there is no gate middleware and no whitelist.
//
// Any value other than 'admin' — including a row set by hand to something the
// API would not accept — is treated as standard: it keeps every power except
// user management.
//
// The vocabulary is app-side (the column is VARCHAR(32), DispatchLine idiom),
// so adding a type is a deploy rather than an ALTER on the shared DB.

const { fail } = require('./shape');

const USER_TYPES = ['standard', 'admin'];

function isAdmin(type) {
    return type === 'admin';
}

/**
 * Route-side gate for the admin-only doors. Answers 403 ADMIN_REQUIRED and
 * returns false when the caller is not an admin, so a route reads
 * `if (!requireAdmin(req, res)) return;`.
 */
function requireAdmin(req, res) {
    if (isAdmin(req.userType)) return true;
    fail(res, 403, 'This action requires an admin account.', 'ADMIN_REQUIRED');
    return false;
}

module.exports = { USER_TYPES, isAdmin, requireAdmin };
