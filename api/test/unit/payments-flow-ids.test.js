// Copied from shipping/tools/test-payments-ids-lib.js — changes: node:test → jest; paths (test/helpers/paymentsFlow.js, src/lib/payments-flow)
'use strict';

// Unit tests for src/lib/payments-flow/ids.js — the stable feed ids of
// JFlow PHASE2 §3 "Ids (P2)" / CONTRACT §1.1 P2. No database.
//   npx jest test/unit/payments-flow-ids.test.js
//
// Grammar [A-Za-z0-9_-]{1,64}; open rows dep-<po>, pi-<ip>[-<g>], bal-<po>-<g>,
// inv-<sp>-<po>-a|s; paid rows pay-<sp>-pi|dep<target>, pay-<sp>-bal<target>[-<po>],
// spd-<sp>[-<po>]; <g> = s<shipmentId> (ref spelt as the shipment's) |
// r<10 hex of sha256(trimmed ref, case kept)> | n. (Step 18 made <g> keep case,
// as the model's grouping does, and added the -<po> of a split paid balance.)

const assert = require('node:assert/strict');
const crypto = require('crypto');
const lib = require('../../src/lib/payments-flow');
const H = require('../helpers/paymentsFlow');

const { feedId, groupToken, itemFeedId, isFeedId, FEED_ID_RE } = lib;
const GRAMMAR = /^[A-Za-z0-9_-]{1,64}$/;
const rHash = (ref) => 'r' + crypto.createHash('sha256').update(ref.trim(), 'utf8').digest('hex').slice(0, 10);

function flowOf(fixture) {
    return lib.buildPaymentsFlow(H.buildInput(fixture, lib));
}
function openIds(fixture) {
    const flow = flowOf(fixture);
    const ctx = { shipmentIdByRef: H.shipmentIdByRef(fixture) };
    return flow.currencies.flatMap(c => c.items).map(it => itemFeedId(it, ctx));
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── Grammar ──────────────────────────────────────────────────────────────

test('the grammar is [A-Za-z0-9_-]{1,64}', () => {
    assert.equal(String(FEED_ID_RE), String(GRAMMAR));
    for (const ok of ['dep-1', 'bal-812-s311', 'a', 'x'.repeat(64)]) assert.equal(isFeedId(ok), true, ok);
    for (const bad of ['', 'x'.repeat(65), 'bal-812-s311 ', 'stated:55', 'derived:bal:812:268', 'bal.812', null, 812]) assert.equal(isFeedId(bad), false, String(bad));
});

test('every form', () => {
    assert.equal(feedId({ form: 'dep', poId: 812 }), 'dep-812');
    assert.equal(feedId({ form: 'pi', invoicePaymentId: 55 }), 'pi-55');
    assert.equal(feedId({ form: 'pi', invoicePaymentId: 55, group: null }), 'pi-55');
    assert.equal(feedId({ form: 'pi', invoicePaymentId: 55, group: 's311' }), 'pi-55-s311');
    assert.equal(feedId({ form: 'pi', invoicePaymentId: 55, group: 'n' }), 'pi-55-n');
    assert.equal(feedId({ form: 'bal', poId: 812, group: 's311' }), 'bal-812-s311');
    assert.equal(feedId({ form: 'bal', poId: 812, group: 'n' }), 'bal-812-n');
    assert.equal(feedId({ form: 'bal', poId: 812, group: 'r0123456789' }), 'bal-812-r0123456789');
    assert.equal(feedId({ form: 'inv', shipmentPaymentId: 7, poId: 812, source: 'allocated' }), 'inv-7-812-a');
    assert.equal(feedId({ form: 'inv', shipmentPaymentId: 7, poId: 812, source: 'share' }), 'inv-7-812-s');
    assert.equal(feedId({ form: 'pay', supplierPaymentId: 9, lineKind: 'balance', targetId: 7 }), 'pay-9-bal7');
    assert.equal(feedId({ form: 'pay', supplierPaymentId: 9, lineKind: 'pi', targetId: 55 }), 'pay-9-pi55');
    assert.equal(feedId({ form: 'pay', supplierPaymentId: 9, lineKind: 'po_deposit', targetId: 812 }), 'pay-9-dep812');
    assert.equal(feedId({ form: 'pay', supplierPaymentId: 9, lineKind: 'balance', targetId: 7, poId: 812 }), 'pay-9-bal7-812');
    assert.equal(feedId({ form: 'pay', supplierPaymentId: 9, lineKind: 'balance', targetId: 7, poId: null }), 'pay-9-bal7');
    assert.equal(feedId({ form: 'spd', shipmentPaymentId: 7, poId: 812 }), 'spd-7-812');
    assert.equal(feedId({ form: 'spd', shipmentPaymentId: 7 }), 'spd-7');
});

test('the longest ids still fit the grammar', () => {
    const big = Number.MAX_SAFE_INTEGER;
    for (const parts of [
        { form: 'inv', shipmentPaymentId: big, poId: big, source: 'share' },
        { form: 'pay', supplierPaymentId: big, lineKind: 'po_deposit', targetId: big },
        { form: 'pay', supplierPaymentId: big, lineKind: 'balance', targetId: big, poId: big },
        { form: 'pi', invoicePaymentId: big, group: `s${big}` },
        { form: 'bal', poId: big, group: 'rffffffffff' },
    ]) assert.match(feedId(parts), GRAMMAR);
});

test('bad parts are refused, never turned into an id', () => {
    for (const parts of [
        null, {}, { form: 'derived', poId: 1 },
        { form: 'dep', poId: 0 }, { form: 'dep', poId: -3 }, { form: 'dep', poId: 1.5 }, { form: 'dep', poId: '812' }, { form: 'dep', poId: NaN },
        { form: 'dep', poId: Number.MAX_SAFE_INTEGER + 1 },
        { form: 'pi', invoicePaymentId: 55, group: 'x' }, { form: 'pi', invoicePaymentId: 55, group: 's' }, { form: 'pi', invoicePaymentId: 55, group: 'rABCDEF0123' },
        { form: 'bal', poId: 812 }, { form: 'bal', poId: 812, group: '268' },
        { form: 'inv', shipmentPaymentId: 7, poId: 812 }, { form: 'inv', shipmentPaymentId: 7, poId: 812, source: 'manual' },
        { form: 'pay', supplierPaymentId: 9, lineKind: 'deposit', targetId: 1 }, { form: 'pay', supplierPaymentId: 9, lineKind: 'pi' },
        { form: 'pay', supplierPaymentId: 9, lineKind: 'pi', targetId: 55, poId: 812 },
        { form: 'pay', supplierPaymentId: 9, lineKind: 'po_deposit', targetId: 812, poId: 812 },
        { form: 'pay', supplierPaymentId: 9, lineKind: 'balance', targetId: 7, poId: 0 },
        { form: 'spd', shipmentPaymentId: 7, poId: -1 }, { form: 'spd', shipmentPaymentId: 7, poId: '812' }, { form: 'spd' },
    ]) assert.throws(() => feedId(parts), TypeError, JSON.stringify(parts));
});

// ── <g> ──────────────────────────────────────────────────────────────────

test('<g>: the shipment id when the ref is spelt as the shipment\'s, else a hash of the ref as spelt, else n', () => {
    const map = new Map([['268', 311], ['104. Air Freight', 44], ['ABC-1', 9]]);
    assert.equal(groupToken('268', map), 's311');
    assert.equal(groupToken(' 268 ', map), 's311');
    assert.equal(groupToken('104. Air Freight', map), 's44');
    assert.equal(groupToken('ABC-1', map), 's9');
    // The model keeps "abc-1" and "ABC-1" apart (summarizePo groups by the ref
    // as spelt), so the variant is a group of its own, never s9.
    assert.equal(groupToken('abc-1', map), rHash('abc-1'));
    assert.equal(groupToken('999', map), rHash('999'));
    assert.equal(groupToken('DRAFT-SEA-260917-110203 - 268', null), rHash('DRAFT-SEA-260917-110203 - 268'));
    assert.equal(groupToken('MSKU1234567'), groupToken(' MSKU1234567 '), 'trimmed, like the model');
    assert.notEqual(groupToken('msku1234567'), groupToken('MSKU1234567'), 'case kept, like the model');
    assert.match(groupToken('msku1234567'), /^r[0-9a-f]{10}$/);
    for (const none of [null, undefined, '', '   ']) assert.equal(groupToken(none, map), 'n');
});

// ── Whole outputs ────────────────────────────────────────────────────────

// The TS id each open item carries, parsed: the form must agree with the feed id.
function tsForm(it, map) {
    let m;
    if ((m = /^derived:dep:(\d+)$/.exec(it.id))) return `dep-${m[1]}`;
    if ((m = /^derived:bal:(\d+):(.*)$/.exec(it.id))) return `bal-${m[1]}-${groupToken(m[2] === 'none' ? null : m[2], map)}`;
    if ((m = /^stated:(\d+):(.*)$/.exec(it.id))) return `pi-${m[1]}-${groupToken(m[2] === 'none' ? null : m[2], map)}`;
    if ((m = /^stated:(\d+)$/.exec(it.id))) return `pi-${m[1]}`;
    throw new Error(`unexpected TS id ${it.id}`);
}

for (const name of H.listFixtures()) {
    test(`${name}: every open item has a unique, valid feed id that matches its TS id`, () => {
        const fixture = H.readFixture(name);
        const flow = flowOf(fixture);
        const map = H.shipmentIdByRef(fixture);
        const items = flow.currencies.flatMap(c => c.items);
        // The per-currency lists hold every PO's items, once.
        assert.equal(items.length, flow.currencies.flatMap(c => c.pos.flatMap(p => p.items)).length);
        const ids = items.map(it => itemFeedId(it, { shipmentIdByRef: map }));
        for (const id of ids) assert.match(id, GRAMMAR);
        assert.equal(new Set(ids).size, ids.length, `duplicate feed ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
        assert.equal(new Set(items.map(it => it.id)).size, items.length, 'duplicate TS ids');
        items.forEach((it, i) => assert.equal(ids[i], tsForm(it, map), it.id));
    });
}

test('a fixture with items: ids are not all trivially the same form', () => {
    const all = H.listFixtures().flatMap(n => openIds(H.readFixture(n)));
    for (const prefix of ['dep-', 'pi-', 'bal-']) assert.ok(all.some(id => id.startsWith(prefix)), prefix);
    assert.ok(all.some(id => /^pi-\d+-(s\d+|r[0-9a-f]{10}|n)$/.test(id)), 'a PI split over containers');
    assert.ok(all.some(id => /-s\d+$/.test(id)) && all.some(id => /-r[0-9a-f]{10}$/.test(id)) && all.some(id => /-n$/.test(id)), 'every <g> kind');
});

// ── Allocated + shared ───────────────────────────────────────────────────

test('allocated + shared invoice: two distinct claim ids, and one open row per PO and box', () => {
    // The claim-level forms differ, so a claim can never collide with its sibling.
    assert.notEqual(
        feedId({ form: 'inv', shipmentPaymentId: 7001, poId: 901, source: 'allocated' }),
        feedId({ form: 'inv', shipmentPaymentId: 7001, poId: 901, source: 'share' }),
    );
    // The fixture really is the case: invoice 7001 on box 280 names PO 901 for part
    // and leaves a remainder that is shared between 901 and 902 by value.
    const fixture = H.readFixture('allocated-shared-invoice');
    const sp = fixture.input.shipmentPayments.find(p => p.id === 7001);
    assert.equal(sp.shipmentReference, '280');
    assert.deepEqual(sp.allocations.map(a => a.purchaseOrderId), [901]);
    assert.ok(sp.amount > sp.allocations[0].amount);
    const onBox = (po) => fixture.input.orders.some(o => o.purchaseOrderId === po && o.containerNumber === '280');
    assert.ok(onBox(901) && onBox(902));
    // At f9499bc an open record never sets what is owed (the terms do), so the
    // TS emits no per-invoice item — and hence no repeated `shipment:` id. PO 901
    // has exactly one derived balance for box 280, carrying the record; its
    // PO-level balance PI split onto the same box is a different row.
    const map = H.shipmentIdByRef(fixture);
    const g = `s${map.get('280')}`;
    const onBox280 = flowOf(fixture).currencies.flatMap(c => c.items).filter(it => it.poId === 901 && it.containerNumber === '280');
    const balances = onBox280.filter(it => it.basis === 'derived' && it.kind === 'balance');
    assert.equal(balances.length, 1);
    assert.equal(balances[0].shipmentPaymentId, 7001);
    assert.deepEqual(onBox280.map(it => itemFeedId(it, { shipmentIdByRef: map })).sort(), [`bal-901-${g}`, `pi-102-${g}`]);
});

// ── Stability ────────────────────────────────────────────────────────────

const ESTIMATE_FIELDS = ['estimatedDepartureDate', 'eta', 'estimatedReadyDate', 'shippedDate', 'poDate', 'arrivedDate', 'deliveryDate'];

function driftDates(fixture, days) {
    const f = clone(fixture);
    for (const o of f.input.orders) for (const k of ESTIMATE_FIELDS) if (o[k]) o[k] = lib.addDays(o[k].slice(0, 10), days);
    for (const p of f.input.invoicePayments ?? []) if (p.dueDate) p.dueDate = lib.addDays(p.dueDate, days);
    return f;
}
function driftAmounts(fixture) {
    const f = clone(fixture);
    for (const o of f.input.orders) {
        if (o.unitPrice != null) o.unitPrice = Math.round(o.unitPrice * 1.07 * 10000) / 10000;
        o.quantity = (o.quantity || 0) + 10;
    }
    // A PI a transfer pays is left alone: raising it past the transfer would
    // rightly bring a new row, which is not what this checks.
    const paidByTransfer = new Set((f.input.supplierPayments ?? []).flatMap(sp => sp.lines.filter(l => l.kind === 'pi').map(l => l.targetId)));
    for (const p of f.input.invoicePayments ?? []) {
        if (p.paymentStatus !== 'paid' && p.amountDue != null && !paidByTransfer.has(p.id)) p.amountDue = Math.round(p.amountDue * 104) / 100;
    }
    for (const sp of f.input.shipmentPayments ?? []) sp.amount = Math.round(sp.amount * 103) / 100;
    return f;
}

for (const name of ['multi-container', 'allocated-shared-invoice', 'draft-container', 'part-paid-transfer']) {
    test(`${name}: ids survive date drift, amount changes and a new day`, () => {
        const fixture = H.readFixture(name);
        const base = openIds(fixture).sort();
        assert.ok(base.length >= 3, `${name} has too few items to say much`);
        assert.deepEqual(openIds(driftDates(fixture, 9)).sort(), base, 'dates +9');
        assert.deepEqual(openIds(driftDates(fixture, -4)).sort(), base, 'dates −4');
        assert.deepEqual(openIds(driftAmounts(fixture)).sort(), base, 'amounts');
        const nextDay = clone(fixture);
        nextDay.input.today = lib.addDays(fixture.input.today, 1);
        assert.deepEqual(openIds(nextDay).sort(), base, 'today +1');
    });
}

test('ids survive a part payment', () => {
    const fixture = H.readFixture('multi-container');
    const base = openIds(fixture).sort();
    const f = clone(fixture);
    const pi = f.input.invoicePayments.find(p => p.paymentStatus === 'pending');
    f.input.supplierPayments = [...(f.input.supplierPayments ?? []), {
        id: 99001, supplierName: 'Suzhou Sunmed Co.,Ltd.', amount: 250, currency: 'USD', paidOn: f.input.today,
        lines: [{ id: 1, kind: 'pi', targetId: pi.id, amount: 250, purchaseOrderId: pi.purchaseOrderId }],
    }];
    const flow = flowOf(f);
    assert.ok(flow.currencies.flatMap(c => c.items).some(it => it.paymentId === pi.id && it.flags.includes('partly_paid')));
    assert.deepEqual(openIds(f).sort(), base);
});

test('ids survive a draft becoming real (same shipment, new reference)', () => {
    const fixture = H.readFixture('draft-container');
    const draft = fixture.shipments.find(s => /^DRAFT-/.test(s.reference));
    const base = openIds(fixture).sort();
    assert.ok(base.some(id => id.endsWith(`-s${draft.id}`)), 'the draft box has an item');
    const f = clone(fixture);
    const real = '268';
    for (const o of f.input.orders) if (o.containerNumber === draft.reference) o.containerNumber = real;
    const s = f.shipments.find(x => x.id === draft.id);
    s.reference = real;
    s.stage = 'BOOKED';
    assert.deepEqual(openIds(f).sort(), base);
});

test('a stage change mints a new id: a PI replaces the derived deposit; lines get booked', () => {
    const fixture = H.readFixture('multi-container');
    const base = openIds(fixture);
    const dep = base.find(id => id.startsWith('dep-'));
    assert.ok(dep, 'multi-container has a derived deposit');
    const poId = Number(dep.slice(4));
    const depItem = flowOf(fixture).currencies.flatMap(c => c.items).find(it => it.basis === 'derived' && it.kind === 'deposit' && it.poId === poId);
    // A deposit PI for the whole deposit arrives for that PO.
    const f = clone(fixture);
    const bundle = f.input.poBundles[String(poId)];
    bundle.invoices.push({ id: 99100, purchaseOrderId: poId, filename: 'PI-new.pdf', uploadedAt: f.input.today, latestCheck: { status: 'succeeded' } });
    f.input.invoicePayments.push({
        id: 99101, invoiceId: 99100, purchaseOrderId: poId, paymentType: 'deposit', amountDue: depItem.amount, currency: bundle.currency,
        depositPercentage: 30, invoiceTotal: null, dueDate: null, dueTerms: null, rawTermsText: null, paymentStatus: 'pending', updatedAt: f.input.today,
    });
    const after = openIds(f);
    assert.ok(!after.includes(dep));
    assert.ok(after.includes('pi-99101'));
    // The unbooked lines get booked into a shipment.
    const unbooked = base.find(id => /^bal-\d+-n$/.test(id));
    assert.ok(unbooked, 'multi-container has unbooked lines');
    const g = clone(fixture);
    const po = Number(unbooked.split('-')[1]);
    for (const o of g.input.orders) if (o.purchaseOrderId === po && !o.containerNumber) o.containerNumber = '275';
    g.shipments.push({ id: 377, reference: '275', stage: 'BOOKED', mode: 'SEA', ata: null, departedAt: null, arrivedAt: null, blNumber: null });
    const booked = openIds(g);
    assert.ok(!booked.includes(unbooked));
    assert.ok(booked.includes(`bal-${po}-s377`));
});
