// Copied from workflows/api/test/unit/roles.test.js — changes: rewritten for two types (`standard | admin`, CONTRACT D5): the vocabulary and `isAdmin` tests kept in shape; dropped the manager tier, reviewer-flag, answer-only whitelist, standard gate and admin-delete blacklist tests (those functions no longer exist); added `requireAdmin` tests on the same express + supertest harness
'use strict';

// Account types (CONTRACT D5): standard | admin. standard is trust-the-team
// (everything but user management); admin adds user management. Pinned here:
//
//  - the vocabulary and the admin test;
//  - requireAdmin: an admin passes; anyone else — standard, a hand-set value,
//    no type at all — is 403 ADMIN_REQUIRED and the route stops there.

const express = require('express');
const request = require('supertest');

const roles = require('../../src/lib/roles');

describe('the vocabulary', () => {
    test('two types, in the order the People page lists them', () => {
        expect(roles.USER_TYPES).toEqual(['standard', 'admin']);
    });

    test('admin is the one admin; every other value is not', () => {
        expect(roles.isAdmin('admin')).toBe(true);
        expect(roles.isAdmin('standard')).toBe(false);
        // No manager tier in JFlow, and a hand-set value never gains admin.
        expect(roles.isAdmin('manager')).toBe(false);
        expect(roles.isAdmin('ADMIN')).toBe(false);
        expect(roles.isAdmin(undefined)).toBe(false);
        expect(roles.isAdmin('')).toBe(false);
    });

    test('the module exports only the two-type surface', () => {
        expect(Object.keys(roles).sort()).toEqual(['USER_TYPES', 'isAdmin', 'requireAdmin']);
    });
});

/**
 * A route guarded the way the handler guards POST/PATCH/DELETE /users: auth
 * (here a stub that stamps the caller's type), then `if (!requireAdmin) return`.
 */
function appAs(type) {
    const app = express();
    app.use((req, _res, next) => { req.userEmail = 'someone@example.test'; req.userType = type; next(); });
    app.post('/api/v1/users', (req, res) => {
        if (!roles.requireAdmin(req, res)) return;
        res.status(201).json({ through: true });
    });
    return app;
}

describe('requireAdmin', () => {
    test('an admin passes', async () => {
        const res = await request(appAs('admin')).post('/api/v1/users').expect(201);
        expect(res.body).toEqual({ through: true });
    });

    test.each([['standard'], ['manager'], ['warehouse'], [undefined]])(
        'type %p is 403 ADMIN_REQUIRED and the route body never runs',
        async (type) => {
            const res = await request(appAs(type)).post('/api/v1/users').expect(403);
            expect(res.body).toEqual({ error: 'This action requires an admin account.', code: 'ADMIN_REQUIRED' });
        }
    );
});
