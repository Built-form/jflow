// Copied from shipping/tools/payments-flow-test-helpers.js — changes: FIXTURE_DIR is test/fixtures/payments-flow; comments point at JFlow's paths
'use strict';

// Shared by the Golden A oracle (tools/payments-flow-oracle.mjs, which runs the
// frozen ShipLine TypeScript) and the payments-flow tests
// (test/unit/payments-flow-*.test.js, which run the port in
// src/lib/payments-flow). Both sides turn a fixture into a PaymentsFlowInput the
// same way, and encode the output the same way, so a difference can only come
// from the model. No database, no clock.
//
// Fixtures: test/fixtures/payments-flow/<name>.input.json
//   { description, input: <PaymentsFlowInput as JSON>, shipments?: [...], instants?: [...] }
//   - input.containerIndex / input.containerEvents are plain objects keyed like
//     the TS Maps (the model only ever calls .get on them).
//   - shipments: shipment entities as GET /shipments returns them. When given,
//     containerEvents are built from them exactly as PaymentsFlowView does
//     (ShipLine f9499bc, "Model" section), with that side's dateOf /
//     dateOfInstant — so an instant near midnight goes through the real path.
//   - instants: extra strings for dateOfInstant alone.
// Expected: test/fixtures/payments-flow/<name>.expected.json (oracle output).

const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'payments-flow');
const INPUT_SUFFIX = '.input.json';
const EXPECTED_SUFFIX = '.expected.json';
const TERMS_EXPECTED = 'terms.expected.json';

function listFixtures() {
    return fs.readdirSync(FIXTURE_DIR)
        .filter(f => f.endsWith(INPUT_SUFFIX))
        .map(f => f.slice(0, -INPUT_SUFFIX.length))
        .sort();
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readFixture(name) {
    return readJson(path.join(FIXTURE_DIR, name + INPUT_SUFFIX));
}

function expectedPath(name) {
    return path.join(FIXTURE_DIR, name + EXPECTED_SUFFIX);
}

function readExpected(name) {
    const p = expectedPath(name);
    return fs.existsSync(p) ? readJson(p) : null;
}

const toMap = (obj) => new Map(Object.entries(obj || {}));

// PaymentsFlowView's containerEvents memo, on plain data.
function eventsFromShipments(shipments, { dateOf, dateOfInstant }) {
    const map = new Map();
    for (const s of shipments) {
        const ref = s.reference?.trim();
        if (!ref) continue;
        map.set(ref, {
            stage: s.stage,
            mode: s.mode,
            ata: dateOf(s.ata),
            departedAt: dateOfInstant(s.departedAt),
            arrivedAt: dateOfInstant(s.arrivedAt),
            blNumber: s.blNumber,
            telexReleasedAt: null,
            documents: s.documents ?? [],
        });
    }
    return map;
}

// PaymentsFlowView's shipmentIdByRef, on plain data (reference as trimmed → id).
function shipmentIdByRef(fixture) {
    const map = new Map();
    for (const s of fixture.shipments ?? []) if (s.reference && !map.has(s.reference.trim())) map.set(s.reference.trim(), s.id);
    return map;
}

// A fresh PaymentsFlowInput (with Maps) from a fixture. `lib` supplies dateOf
// and dateOfInstant: the TS module in the oracle, the port in the tests.
function buildInput(fixture, lib) {
    const input = JSON.parse(JSON.stringify(fixture.input));
    if (input.containerIndex != null) input.containerIndex = toMap(input.containerIndex);
    if (fixture.shipments) {
        if (input.containerEvents != null) throw new Error('fixture gives both shipments and input.containerEvents');
        input.containerEvents = eventsFromShipments(fixture.shipments, lib);
    } else if (input.containerEvents != null) {
        input.containerEvents = toMap(input.containerEvents);
    }
    return input;
}

// Canonical, lossless JSON form of a model value, so the golden comparison is
// stricter than JSON.stringify: undefined values, -0, NaN and ±Infinity are
// kept distinct, and Maps / Sets are encoded instead of silently becoming {}.
// Key order is insertion order, so comparing the serialised strings also
// checks that the port builds its objects in the TS's key order.
function toGolden(value, seen = new Set()) {
    if (value === undefined) return { $undefined: true };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (Object.is(value, -0)) return { $num: '-0' };
        if (!Number.isFinite(value)) return { $num: String(value) };
        return value;
    }
    if (typeof value !== 'object') throw new TypeError(`toGolden: cannot encode ${typeof value}`);
    if (seen.has(value)) throw new TypeError('toGolden: cycle');
    seen.add(value);
    let out;
    if (Array.isArray(value)) out = value.map(v => toGolden(v, seen));
    else if (value instanceof Map) out = { $map: [...value].map(([k, v]) => [toGolden(k, seen), toGolden(v, seen)]) };
    else if (value instanceof Set) out = { $set: [...value].map(v => toGolden(v, seen)) };
    else if (value instanceof Date) out = { $date: Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString() };
    else {
        out = {};
        for (const k of Object.keys(value)) out[k] = toGolden(value[k], seen);
    }
    seen.delete(value);
    return out;
}

// The parser vectors from the comment in paymentsFlowMath.ts at f9499bc
// (L44–69): input → { depositPct, trigger, offset, confidence }. 28 inputs
// ("" and "As per contract" share a line; the shorthand lines carry several).
const TERMS_VECTORS = [
    ['30% deposit on order confirmation, 70% balance before shipment', 30, 'before_dispatch', 0, 'parsed'],
    ['30% T/T in advance, 70% B/L copy.', 30, 'bl', 0, 'parsed'],
    ['50% deposit, 50% before shipment', 50, 'before_dispatch', 0, 'parsed'],
    ['100% before dispatch', 0, 'before_dispatch', 0, 'parsed'],
    ['30% deposit, balance 30 days after B/L', 30, 'bl', 30, 'parsed'],
    ['net 30', 0, 'bl', 30, 'partial'],
    ['T/T 60 days from BL date', 0, 'bl', 60, 'parsed'],
    ['100% T/T 30 days after delivery', 0, 'delivery', 30, 'parsed'],
    ['payment before dispatch', 0, 'before_dispatch', 0, 'parsed'],
    ['Deposit 30% paid', 30, 'unknown', 0, 'partial'],
    ['', null, 'unknown', 0, 'none'],
    ['As per contract', null, 'unknown', 0, 'none'],
    ['L/C at sight', null, 'unknown', 0, 'none'],
    ['30% deposit, 70% against copy of B/L within 5 days', 30, 'bl', 5, 'parsed'],
    ['40% deposit, 60% before delivery', 40, 'before_dispatch', 0, 'parsed'],
    ['30% deposit, 70% 45 days after arrival at destination port', 30, 'arrival', 45, 'parsed'],
    ['50% deposit 50% balance 7 days before shipment', 50, 'before_dispatch', -7, 'parsed'],
    ['30% deposit, 40% before shipment, 30% 30 days after delivery', 30, 'before_dispatch', 0, 'partial'],
    ['100% in advance', 100, 'order', 0, 'parsed'],
    ['30% deposit; balance after receiving B/L copy', 30, 'bl', 0, 'parsed'],
    ['30% deposit, 70% before shipment. Deposit paid on 12/03', 30, 'before_dispatch', 0, 'parsed'],
    ['30% deposit, balance thirty days after B/L', 30, 'bl', 30, 'parsed'],
    ['30% deposit, 70% B/L copy, 30 days', 30, 'bl', 30, 'parsed'],
    // JFPRO shorthand
    ['30D/70B BOL', 30, 'bl', 0, 'parsed'],
    ['100D', 100, 'order', 0, 'parsed'],
    ['100B BOL', 0, 'bl', 0, 'parsed'],
    ['30D/70B 30 Days before BOL', 30, 'bl', -30, 'parsed'],
    ['50D/50B Before dispatch', 50, 'before_dispatch', 0, 'parsed'],
].map(([text, depositPct, trigger, offset, confidence]) => ({ text, depositPct, trigger, offset, confidence }));

// More parser inputs, compared whole (notes, raw, source) with the frozen TS:
// odd spellings, number words, shorthand edge cases, null.
const TERMS_EXTRA = [
    null,
    '   ',
    'T/T 30% before and 70% against B/L copy',
    '30% advanced payment, 70% within 7 days after the date of B/L',
    '30% deposit, 70% before loading',
    '100% payment before shipment',
    'Balance 70% upon receipt of goods',
    '30% down payment, remaining 70% 2 weeks after ETA',
    '20% deposit + 80% against documents',
    'net30',
    'Net 60 days',
    '30% deposit, balance when goods are ready',
    '30D/70B',
    '70B',
    '0D/100B BOL',
    'D/P at sight',
    'CAD',
    '50% deposit, 50% 1 month after invoice date',
    'Prepayment 100%',
    '30% TT deposit, 60% before shipment, 10% after arrival',
    '150% deposit',
    '30% deposit with order, 70% fourteen days after B/L',
    '30 percent deposit, 70 per cent before shipment',
    'Payment: 30% deposit\n70% on telex release',
    '30% deposit, 70% 90 days after arrival',
    '预付30%，出货前付清',
    '30% deposit, 70% at shipment',
    '20% deposit, 10% prepayment, 70% against B/L copy',
    '30% deposit, 60% B/L copy',
];

// resolveTermsRule inputs (newest PI first, then the JFPRO supplier's terms):
// which source wins, and when the PI's extracted deposit % is back-filled.
const TERMS_RESOLVE_CASES = [
    { payments: [], supplierTerms: '30% deposit, 70% before shipment' },
    { payments: [{ dueTerms: '50% deposit, 50% before shipment', rawTermsText: null, depositPercentage: 50 }], supplierTerms: '30D/70B BOL' },
    { payments: [{ dueTerms: 'As per contract', rawTermsText: 'T/T 30% deposit, balance against copy of B/L', depositPercentage: 30 }], supplierTerms: null },
    { payments: [{ dueTerms: 'Deposit 30% paid', rawTermsText: null, depositPercentage: 30 }], supplierTerms: '30% deposit, 70% B/L copy.' },
    { payments: [{ dueTerms: null, rawTermsText: null, depositPercentage: 40 }], supplierTerms: 'L/C at sight' },
    { payments: [{ dueTerms: 'net 30', rawTermsText: null, depositPercentage: 30 }], supplierTerms: null },
    { payments: [{ dueTerms: 'balance before shipment', rawTermsText: null, depositPercentage: 25 }], supplierTerms: null },
    { payments: [{ dueTerms: 'payment against documents', rawTermsText: null, depositPercentage: 150 }], supplierTerms: '' },
    { payments: [{ dueTerms: '', rawTermsText: '', depositPercentage: null }, { dueTerms: '30% deposit, 70% before shipment', rawTermsText: null, depositPercentage: 30 }], supplierTerms: 'As per contract' },
    { payments: [], supplierTerms: null },
];

module.exports = {
    FIXTURE_DIR, INPUT_SUFFIX, EXPECTED_SUFFIX, TERMS_EXPECTED,
    listFixtures, readFixture, readExpected, expectedPath, readJson,
    eventsFromShipments, shipmentIdByRef, buildInput, toGolden,
    TERMS_VECTORS, TERMS_EXTRA, TERMS_RESOLVE_CASES,
};
