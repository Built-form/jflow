'use strict';

// lib/keys.js (CONTRACT §4): the only builder and parser of forecast-line keys.
// Pinned here:
//
//  - the four grammars, exactly: item.<id>, sched.<id>.<YYYY-MM-DD>, ship.<id> and, since
//    2026-10-07 (D39), new.<adjustment id> — an `add` adjustment's own key;
//  - parseKey → {targetKind, targetId, targetDate} or null, never a throw;
//  - formatKey is parseKey's exact inverse, and every builder round-trips;
//  - rejection of everything outside the unreserved set (#, :, /, spaces,
//    percent-encoding), impossible dates, leading zeros, signs, empty ids,
//    missing and extra segments, over-long ids;
//  - the module imports nothing from src/db.

const fs = require('fs');
const path = require('path');

const keys = require('../../src/lib/keys');
const {
    buildItemKey, buildSchedKey, buildShipKey, buildNewKey, parseKey, isValidKey, formatKey, TARGET_KINDS,
} = keys;

describe('builders', () => {
    test.each([
        [123, 'item.123'],
        ['123', 'item.123'],
        [123n, 'item.123'],
        [1, 'item.1'],
        ['999999999999999999', 'item.999999999999999999'],   // 18 digits, the grammar's maximum
        [Number.MAX_SAFE_INTEGER, 'item.9007199254740991'],
    ])('buildItemKey(%p) = %s', (id, want) => {
        expect(buildItemKey(id)).toBe(want);
    });

    test('buildSchedKey(scheduleId, naturalDate)', () => {
        expect(buildSchedKey(45, '2026-06-01')).toBe('sched.45.2026-06-01');
        expect(buildSchedKey('45', '2028-02-29')).toBe('sched.45.2028-02-29');
        expect(buildSchedKey(45n, '2026-12-31')).toBe('sched.45.2026-12-31');
    });

    test.each([
        ['PO-778', 'ship.PO-778'],
        ['po_778', 'ship.po_778'],
        ['7', 'ship.7'],
        ['007', 'ship.007'],          // ship ids are raw strings: leading zeros allowed
        ['-_-', 'ship.-_-'],
        ['A'.repeat(64), `ship.${'A'.repeat(64)}`],
    ])('buildShipKey(%s) = %s', (id, want) => {
        expect(buildShipKey(id)).toBe(want);
    });

    test.each([
        ['zero', 0], ['a negative', -1], ['a fraction', 1.5], ['NaN', NaN],
        ['an unsafe integer', 2 ** 53], ['a leading zero', '0123'], ['"0"', '0'],
        ['a signed string', '+1'], ['a spaced string', ' 1'], ['19 digits', '1000000000000000000'],
        ['the empty string', ''], ['null', null], ['undefined', undefined], ['a zero bigint', 0n],
        ['a negative bigint', -1n], ['an object', {}],
    ])('numeric builders reject %s', (_label, id) => {
        expect(() => buildItemKey(id)).toThrow(TypeError);
        expect(() => buildSchedKey(id, '2026-06-01')).toThrow(TypeError);
    });

    test.each([
        '2026-02-30', '2026-2-1', '2026-06-01T00:00:00Z', '', null, undefined,
    ])('buildSchedKey rejects the date %p', (d) => {
        expect(() => buildSchedKey(45, d)).toThrow(TypeError);
    });

    test.each([
        ['the empty string', ''], ['a dot', 'PO.778'], ['a space', 'PO 778'], ['a hash', 'PO#778'],
        ['a colon', 'PO:778'], ['a slash', 'PO/778'], ['a tilde', 'PO~778'], ['percent-encoding', 'PO%20778'],
        ['a non-ASCII letter', 'PÖ-778'], ['65 characters', 'A'.repeat(65)], ['a number', 778], ['null', null],
    ])('buildShipKey rejects %s', (_label, id) => {
        expect(() => buildShipKey(id)).toThrow(TypeError);
    });

    test.each([
        [77, 'new.77'],
        ['77', 'new.77'],
        [77n, 'new.77'],
        [1, 'new.1'],
        ['999999999999999999', 'new.999999999999999999'],
    ])('buildNewKey(%p) = %s (D39: the adjustment row id)', (id, want) => {
        expect(buildNewKey(id)).toBe(want);
    });

    test.each([
        ['zero', 0], ['a negative', -1], ['a fraction', 1.5], ['a leading zero', '077'], ['19 digits', '1000000000000000000'],
        ['the empty string', ''], ['null', null], ['undefined', undefined], ['a ship-style id', 'PO-1'],
    ])('buildNewKey rejects %s', (_label, id) => {
        expect(() => buildNewKey(id)).toThrow(TypeError);
    });
});

describe('parseKey', () => {
    test.each([
        ['item.123', { targetKind: 'item', targetId: '123', targetDate: null }],
        ['item.1', { targetKind: 'item', targetId: '1', targetDate: null }],
        ['item.999999999999999999', { targetKind: 'item', targetId: '999999999999999999', targetDate: null }],
        ['sched.45.2026-06-01', { targetKind: 'sched', targetId: '45', targetDate: '2026-06-01' }],
        ['sched.45.2028-02-29', { targetKind: 'sched', targetId: '45', targetDate: '2028-02-29' }],
        ['ship.PO-778', { targetKind: 'ship', targetId: 'PO-778', targetDate: null }],
        ['ship.007', { targetKind: 'ship', targetId: '007', targetDate: null }],
        ['ship.a_B-9', { targetKind: 'ship', targetId: 'a_B-9', targetDate: null }],
        ['new.77', { targetKind: 'new', targetId: '77', targetDate: null }],
        ['new.1', { targetKind: 'new', targetId: '1', targetDate: null }],
        ['new.999999999999999999', { targetKind: 'new', targetId: '999999999999999999', targetDate: null }],
    ])('%s', (key, want) => {
        expect(parseKey(key)).toEqual(want);
        expect(isValidKey(key)).toBe(true);
    });

    test.each([
        // outside the unreserved set
        ['a hash', 'item#123'],
        ['a hash in the id', 'item.12#3'],
        ['a colon', 'item:123'],
        ['a colon in a date', 'sched.45.2026:06:01'],
        ['a slash', 'item/123'],
        ['a slash in a ship id', 'ship.PO/778'],
        ['a space', 'item. 123'],
        ['a trailing space', 'item.123 '],
        ['a leading space', ' item.123'],
        ['a trailing newline', 'item.123\n'],
        ['percent-encoding of the dot', 'item%2E123'],
        ['percent-encoding in a ship id', 'ship.PO%2D778'],
        ['a tilde in a ship id', 'ship.PO~778'],
        ['a dot in a ship id', 'ship.PO.778'],
        ['a non-ASCII ship id', 'ship.PÖ-778'],
        ['full-width digits', 'item.１２３'],
        // numeric ids: no leading zeros, no sign, not zero, at most 18 digits
        ['a leading zero', 'item.0123'],
        ['id zero', 'item.0'],
        ['a leading zero on a schedule', 'sched.045.2026-06-01'],
        ['a negative id', 'item.-1'],
        ['a plus sign', 'item.+1'],
        ['a hex id', 'item.0x1F'],
        ['a fractional id', 'item.1.5'],
        ['19 digits', 'item.1000000000000000000'],
        ['a letter in a numeric id', 'item.12a'],
        // dates
        ['30 February', 'sched.4.2026-02-30'],
        ['29 February in a common year', 'sched.4.2026-02-29'],
        ['month 13', 'sched.4.2026-13-01'],
        ['a short date', 'sched.4.2026-6-1'],
        ['a compact date', 'sched.4.20260601'],
        ['a date with a time', 'sched.4.2026-06-01T00:00'],
        // empty ids and segments
        ['an empty item id', 'item.'],
        ['an empty ship id', 'ship.'],
        ['an empty schedule id', 'sched..2026-06-01'],
        ['a double dot', 'item..1'],
        ['no dot at all', 'item123'],
        ['a bare kind', 'item'],
        ['the empty string', ''],
        // missing and extra segments
        ['a schedule with no date', 'sched.45'],
        ['a schedule with a trailing dot', 'sched.45.'],
        ['an item with a date', 'item.123.2026-06-01'],
        ['an extra segment on an item', 'item.1.2'],
        ['a trailing dot on an item', 'item.1.'],
        ['an extra segment on a schedule', 'sched.45.2026-06-01.x'],
        ['an extra segment on a ship', 'ship.PO.778.x'],
        // kinds
        ['an unknown kind', 'order.123'],
        ['an upper-case kind', 'ITEM.123'],
        ['a capitalised kind', 'Sched.45.2026-06-01'],
        ['a prefix before the kind', 'xitem.123'],
        // length
        ['a 65-character ship id', `ship.${'A'.repeat(65)}`],
        // new.<adjustment id> (D39): a numeric id as item., nothing else
        ['an empty new id', 'new.'],
        ['a leading zero on a new id', 'new.077'],
        ['new id zero', 'new.0'],
        ['a negative new id', 'new.-1'],
        ['a ship-style new id', 'new.PO-1'],
        ['a new key with a date', 'new.7.2026-06-01'],
        ['the placeholder of an add being created', 'new.pending.123e4567-e89b-12d3-a456-426614174000'],
        ['19 digits on a new id', 'new.1000000000000000000'],
        ['an upper-case new kind', 'NEW.7'],
    ])('rejects %s (%j)', (_label, key) => {
        expect(parseKey(key)).toBeNull();
        expect(isValidKey(key)).toBe(false);
    });

    test.each([
        ['null', null], ['undefined', undefined], ['a number', 123], ['an object', { key: 'item.1' }],
        ['a String object', Object('item.1')],
    ])('answers null, not a throw, for %s', (_label, v) => {
        expect(parseKey(v)).toBeNull();
        expect(isValidKey(v)).toBe(false);
    });

    test('every valid key is at most 80 characters (item_key VARCHAR(80))', () => {
        const longest = [
            buildItemKey('999999999999999999'),
            buildSchedKey('999999999999999999', '2026-06-01'),
            buildShipKey('A'.repeat(64)),
            buildNewKey('999999999999999999'),
        ];
        for (const k of longest) expect(k.length).toBeLessThanOrEqual(80);
    });

    test('returns a fresh object each call', () => {
        const a = parseKey('item.1');
        a.targetId = '2';
        expect(parseKey('item.1').targetId).toBe('1');
    });
});

describe('formatKey (inverse of parseKey)', () => {
    const valid = [
        'item.123', 'item.1', 'item.999999999999999999',
        'sched.45.2026-06-01', 'sched.1.2028-02-29',
        'ship.PO-778', 'ship.007', `ship.${'z'.repeat(64)}`,
        'new.77', 'new.1',
    ];

    test.each(valid)('formatKey(parseKey(%s)) round-trips exactly', (key) => {
        expect(formatKey(parseKey(key))).toBe(key);
    });

    test.each([
        { targetKind: 'item', targetId: '123', targetDate: null },
        { targetKind: 'sched', targetId: '45', targetDate: '2026-06-01' },
        { targetKind: 'ship', targetId: 'PO-778', targetDate: null },
        { targetKind: 'new', targetId: '77', targetDate: null },
    ])('parseKey(formatKey(%j)) round-trips exactly', (parsed) => {
        expect(parseKey(formatKey(parsed))).toEqual(parsed);
    });

    test('every builder round-trips through parseKey and formatKey', () => {
        const built = [buildItemKey(7), buildSchedKey(7, '2026-01-31'), buildShipKey('PO-1'), buildNewKey(7)];
        for (const k of built) {
            expect(isValidKey(k)).toBe(true);
            expect(formatKey(parseKey(k))).toBe(k);
        }
    });

    test('accepts an omitted targetDate on item and ship', () => {
        expect(formatKey({ targetKind: 'item', targetId: '5' })).toBe('item.5');
        expect(formatKey({ targetKind: 'ship', targetId: 'X' })).toBe('ship.X');
        expect(formatKey({ targetKind: 'new', targetId: '9' })).toBe('new.9');
    });

    test.each([
        ['an unknown kind', { targetKind: 'order', targetId: '1', targetDate: null }],
        ['a leading-zero item id', { targetKind: 'item', targetId: '01', targetDate: null }],
        ['an item carrying a date', { targetKind: 'item', targetId: '1', targetDate: '2026-06-01' }],
        ['a ship carrying a date', { targetKind: 'ship', targetId: 'X', targetDate: '2026-06-01' }],
        ['a new carrying a date', { targetKind: 'new', targetId: '7', targetDate: '2026-06-01' }],
        ['a non-numeric new id', { targetKind: 'new', targetId: 'PO-1', targetDate: null }],
        ['a schedule with no date', { targetKind: 'sched', targetId: '45', targetDate: null }],
        ['a schedule with an impossible date', { targetKind: 'sched', targetId: '45', targetDate: '2026-02-30' }],
        ['a ship id with a slash', { targetKind: 'ship', targetId: 'a/b', targetDate: null }],
        ['an empty id', { targetKind: 'item', targetId: '', targetDate: null }],
        ['null', null],
        ['a string', 'item.1'],
    ])('throws on %s', (_label, parsed) => {
        expect(() => formatKey(parsed)).toThrow(TypeError);
    });
});

describe('the module', () => {
    test('TARGET_KINDS is the vocabulary /meta/enums serves', () => {
        expect(TARGET_KINDS).toEqual(['item', 'sched', 'ship', 'new']);
    });

    test('exports the §4 surface plus TARGET_KINDS', () => {
        expect(Object.keys(keys).sort()).toEqual([
            'TARGET_KINDS', 'buildItemKey', 'buildNewKey', 'buildSchedKey', 'buildShipKey', 'formatKey',
            'isValidKey', 'parseKey',
        ]);
    });

    test('imports nothing from src/db', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/lib/keys.js'), 'utf8');
        expect(src).not.toMatch(/require\(\s*['"][^'"]*\bdb\b/);
    });
});
