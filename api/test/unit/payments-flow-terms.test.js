// Copied from shipping/tools/test-payments-terms-lib.js — changes: node:test → jest; paths (test/helpers/paymentsFlow.js, src/lib/payments-flow)
'use strict';

// Unit tests for src/lib/payments-flow/terms.js — the free-text payment terms
// parser, ported from ShipLine's paymentsFlowMath.ts at f9499bc. No database.
//   npx jest test/unit/payments-flow-terms.test.js
//
// 1. The 28 parser vectors from the comment in the TS (L44–69), each asserted.
// 2. Every vector plus some extra inputs, compared whole (notes, raw, source)
//    with what the frozen TS returned (test/fixtures/payments-flow/terms.expected.json,
//    written by tools/payments-flow-oracle.mjs).

const assert = require('node:assert/strict');
const path = require('path');
const { parsePaymentTerms, resolveTermsRule, describeRule } = require('../../src/lib/payments-flow');
const { TERMS_VECTORS, TERMS_EXTRA, TERMS_RESOLVE_CASES, FIXTURE_DIR, TERMS_EXPECTED, readJson, toGolden } = require('../helpers/paymentsFlow');

test('the vector table has the 28 inputs of the f9499bc comment', () => {
    assert.equal(TERMS_VECTORS.length, 28);
    assert.equal(new Set(TERMS_VECTORS.map(v => v.text)).size, 28);
});

for (const v of TERMS_VECTORS) {
    test(`vector: ${JSON.stringify(v.text)} → ${v.depositPct}, ${v.trigger}, ${v.offset}, ${v.confidence}`, () => {
        const r = parsePaymentTerms(v.text);
        assert.deepEqual(
            { depositPct: r.depositPct, trigger: r.balanceTrigger, offset: r.balanceOffsetDays, confidence: r.confidence },
            { depositPct: v.depositPct, trigger: v.trigger, offset: v.offset, confidence: v.confidence },
        );
        assert.equal(r.source, 'none');
    });
}

test('every vector and extra input equals the frozen TS, whole rule and its wording', () => {
    const expected = readJson(path.join(FIXTURE_DIR, TERMS_EXPECTED));
    const inputs = [...TERMS_VECTORS.map(v => v.text), ...TERMS_EXTRA];
    assert.deepStrictEqual(expected.parse.map(([text]) => text), inputs, 'terms.expected.json is stale — re-run the oracle');
    for (const [text, rule, words] of expected.parse) {
        const r = parsePaymentTerms(text);
        assert.deepStrictEqual(toGolden(r), rule, JSON.stringify(text));
        assert.equal(describeRule(r), words, JSON.stringify(text));
    }
});

test('resolveTermsRule equals the frozen TS: PI terms, supplier default, back-filled deposit %', () => {
    const expected = readJson(path.join(FIXTURE_DIR, TERMS_EXPECTED));
    assert.deepStrictEqual(expected.resolve.map(({ payments, supplierTerms }) => ({ payments, supplierTerms })), TERMS_RESOLVE_CASES, 'terms.expected.json is stale — re-run the oracle');
    for (const { payments, supplierTerms, rule } of expected.resolve) {
        assert.deepStrictEqual(toGolden(resolveTermsRule(payments, supplierTerms)), rule, JSON.stringify({ payments, supplierTerms }));
    }
});

test('the parser does not mutate a shared empty rule', () => {
    const a = parsePaymentTerms('');
    const b = parsePaymentTerms(null);
    assert.equal(a.raw, null);
    assert.equal(b.raw, null);
    assert.deepEqual(a.notes, []);
});
