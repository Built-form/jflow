'use strict';

// lib/payments-flow/sampleRule — does the payments model JFlow runs know the
// sample-order rule? Asked of the model itself, by what it answers, not read
// from the commit named in its header: the health route reports it, and
// shipping's tools/check-sample-orders.js will not switch sample orders on for
// a stage whose JFlow says no (a sample would be forecast on the supplier's
// terms, as stock).

const { sampleRuleKnown, PROBE } = require('../../src/lib/payments-flow/sampleRule');
const model = require('../../src/lib/payments-flow/model');

const item = (over = {}) => ({ id: 'derived:dep:1', kind: 'deposit', amount: 10, flags: ['sample'], ...over });

describe('sampleRuleKnown', () => {
    test('the probe is one sample order, sent and unpaid, on a supplier with deposit terms', () => {
        expect(PROBE.bundle.kind).toBe('sample');
        expect(PROBE.lines).toHaveLength(1);
        expect(PROBE.lines[0]).toMatchObject({ quantity: 1, unitPrice: 10, status: 'ON_AIR' });
        expect(PROBE.supplierTerms).toBe('30D/70B BOL');
        expect(PROBE.payments).toEqual([]);
    });

    test('a model that owes the whole order, flagged as a sample, knows the rule', () => {
        const seen = [];
        const known = sampleRuleKnown({ summarizePo: (args) => { seen.push(args); return { items: [item()] }; } });
        expect(known).toBe(true);
        // It is asked with the probe, and with its own list for issues.
        expect(seen[0].bundle).toEqual(PROBE.bundle);
        expect(seen[0].issues).toEqual([]);
    });

    test('a model that reads it as stock does not: nothing owed (treated as paid, it shipped), the terms\' deposit, or no sample flag', () => {
        expect(sampleRuleKnown({ summarizePo: () => ({ items: [] }) })).toBe(false);
        expect(sampleRuleKnown({ summarizePo: () => ({ items: [item({ amount: 3 })] }) })).toBe(false);
        expect(sampleRuleKnown({ summarizePo: () => ({ items: [item({ flags: ['assumed_paid'] })] }) })).toBe(false);
        expect(sampleRuleKnown({ summarizePo: () => ({ items: [item(), item({ id: 'derived:bal:1', kind: 'balance' })] }) })).toBe(false);
        expect(sampleRuleKnown({ summarizePo: () => null })).toBe(false);
    });

    test('a model that throws, or has no summarizePo, is a no — never an error', () => {
        expect(sampleRuleKnown({ summarizePo: () => { throw new Error('boom'); } })).toBe(false);
        expect(sampleRuleKnown({})).toBe(false);
        expect(sampleRuleKnown(null)).toBe(false);
    });

    test('the model JFlow ships knows the rule (since the re-pin to ShipLine 6ae3867), and says so every time', () => {
        expect(sampleRuleKnown(model)).toBe(true);
        expect(sampleRuleKnown(model)).toBe(true);
        expect(sampleRuleKnown()).toBe(true);   // the default is the shipped model
    });

    test('the shipped model on the probe: the whole order, due on its PO date, nothing assumed paid', () => {
        const issues = [];
        const s = model.summarizePo({ bundle: { ...PROBE.bundle }, lines: PROBE.lines.map((l) => ({ ...l })), payments: [], supplierTerms: PROBE.supplierTerms, today: PROBE.today, issues });
        expect(s.items).toHaveLength(1);
        expect(s.items[0]).toMatchObject({ id: 'derived:dep:1', kind: 'deposit', amount: 10, dueDate: '2026-01-01' });
        expect(s.assumedPaid).toBe(0);
        expect(issues).toEqual([]);
        // The same order as a stock PO is read on the supplier's terms: no sample flag.
        const stock = model.summarizePo({ bundle: { ...PROBE.bundle, kind: 'stock' }, lines: PROBE.lines.map((l) => ({ ...l })), payments: [], supplierTerms: PROBE.supplierTerms, today: PROBE.today, issues: [] });
        expect((stock.items || []).some((i) => i.flags.includes('sample'))).toBe(false);
    });
});
