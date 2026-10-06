'use strict';

// lib/payments-flow/overrides.js — due dates set by hand in ShipLine (shipping table
// payment_due_dates; ShipLine applyDueOverrides + dueOverrideKeys at 6565188, ported
// ahead of the full re-pin — handover doc "Dates set by hand", 2026-10-06). Pinned here:
//   · the keys a row's date can be set under (its own row key, with any `@…` split
//     suffix stripped; its payment's key unless the row is blocked);
//   · a row key beats a payment key; the set date replaces dueDate and contractualDate,
//     the derived date is kept beside it, `due_set` replaces the derived-date flags;
//   · buildPaymentsFlow takes input.dueOverrides (optional: without it nothing changes,
//     which the golden suite proves) and the kpis follow the set date;
//   · the feed row carries `dueSet` {by, email, at, derivedDate, scope, note} and reads
//     firm; JFlow's validateFeed accepts it.

const lib = require('../../src/lib/payments-flow');
const O = require('../../src/lib/payments-flow/overrides');
const { validateFeed } = require('../../src/services/shipping');
const H = require('../helpers/paymentsFlow');

const item = (over = {}) => ({
    id: 'derived:bal:368:330', kind: 'balance', basis: 'derived', poId: 368, poNumber: 'PO-368',
    supplier: 'Suzhou SunMed Co.,Ltd.', currency: 'USD', amount: 1200, dueDate: '2026-11-01', contractualDate: '2026-11-01',
    trigger: 'bl', containerNumber: '330', containerShare: 1, status: 'projected', blocked: null, shipmentPaymentId: null,
    flags: ['estimated', 'grace_applied', 'multi_container'], invoiceId: null, paymentId: null, ...over,
});

const override = (over = {}) => ({
    id: 7, key: 'item:derived:bal:368:330', scope: 'item', dueDate: '2026-11-20', note: 'agreed with the supplier',
    setByEmail: 'ops@example.com', setByName: 'Ops', setAt: '2026-10-06T09:30:00.000Z', ...over,
});

const byKey = (...list) => new Map(list.map((d) => [d.key, d]));

describe('keys (ShipLine paymentReviews.ts)', () => {
    test('depositKey, balanceKey (container upper-cased, "-" when none; supplier lower-cased, spaces folded), itemKey', () => {
        expect(O.depositKey(368)).toBe('deposit:368');
        expect(O.balanceKey('usd', ' 330 ', 'Suzhou   SunMed Co.,Ltd. ')).toBe('balance:USD:330|suzhou sunmed co.,ltd.');
        expect(O.balanceKey('USD', null, 'Acme')).toBe('balance:USD:-|acme');
        expect(O.balanceKey('USD', '  ', 'Acme')).toBe('balance:USD:-|acme');
        expect(O.itemKey('derived:bal:368:330')).toBe('item:derived:bal:368:330');
    });

    test('dueOverrideKeys: the row key loses its @… split suffix; the payment key is the deposit\'s or the balance\'s', () => {
        expect(O.dueOverrideKeys(item())).toEqual({ item: 'item:derived:bal:368:330', payment: 'balance:USD:330|suzhou sunmed co.,ltd.' });
        expect(O.dueOverrideKeys(item({ id: 'derived:bal:368:none@open:12', containerNumber: null })))
            .toEqual({ item: 'item:derived:bal:368:none', payment: 'balance:USD:-|suzhou sunmed co.,ltd.' });
        expect(O.dueOverrideKeys(item({ id: 'derived:dep:368', kind: 'deposit' })))
            .toEqual({ item: 'item:derived:dep:368', payment: 'deposit:368' });
        expect(O.dueOverrideKeys(item({ supplier: null })).payment).toBe('balance:USD:330|(no supplier)');
    });

    test('a blocked row has no payment key: only its own', () => {
        expect(O.dueOverrideKeys(item({ blocked: 'artwork' }))).toEqual({ item: 'item:derived:bal:368:330', payment: null });
    });
});

describe('applyDueOverrides', () => {
    test('a row key: the set date replaces dueDate and contractualDate, the derived date is kept, due_set replaces the derived-date flags', () => {
        const it = item();
        O.applyDueOverrides([it], byKey(override()));
        expect(it.dueDate).toBe('2026-11-20');
        expect(it.contractualDate).toBe('2026-11-20');
        expect(it.flags).toEqual(['multi_container', 'due_set']);
        expect(it.dueOverride).toEqual({
            id: 7, key: 'item:derived:bal:368:330', scope: 'item', dueDate: '2026-11-20', derivedDueDate: '2026-11-01',
            setByEmail: 'ops@example.com', setByName: 'Ops', setAt: '2026-10-06T09:30:00.000Z', note: 'agreed with the supplier',
        });
        expect(it.blocked).toBeNull();
    });

    test('a payment key reaches every row of the payment; a row key beats it', () => {
        const a = item();
        const b = item({ id: 'derived:bal:369:330', poId: 369 });
        const payment = override({ id: 8, key: 'balance:USD:330|suzhou sunmed co.,ltd.', scope: 'payment', dueDate: '2026-12-01', note: null, setByName: null });
        O.applyDueOverrides([a, b], byKey(override(), payment));
        expect(a.dueDate).toBe('2026-11-20');
        expect(a.dueOverride.scope).toBe('item');
        expect(b.dueDate).toBe('2026-12-01');
        expect(b.dueOverride).toMatchObject({ id: 8, scope: 'payment', derivedDueDate: '2026-11-01', setByName: null, note: null });
    });

    test('a blocked row takes only its own key; payability is untouched', () => {
        const it = item({ blocked: 'artwork', dueDate: null, contractualDate: null, flags: ['no_container'] });
        O.applyDueOverrides([it], byKey(override({ key: 'balance:USD:330|suzhou sunmed co.,ltd.', scope: 'payment' })));
        expect(it.dueDate).toBeNull();
        expect(it.dueOverride).toBeUndefined();
        O.applyDueOverrides([it], byKey(override()));
        expect(it.dueDate).toBe('2026-11-20');
        expect(it.blocked).toBe('artwork');
        expect(it.dueOverride.derivedDueDate).toBeNull();
        expect(it.flags).toEqual(['no_container', 'due_set']);
    });

    test('no matching key, an unreal date, or an empty map: the row is untouched', () => {
        const a = item();
        O.applyDueOverrides([a], new Map());
        O.applyDueOverrides([a], byKey(override({ key: 'item:derived:bal:999:330' })));
        O.applyDueOverrides([a], byKey(override({ dueDate: '2026-13-45' })));
        expect(a).toEqual(item());
        expect(a.dueOverride).toBeUndefined();
    });

    test('DERIVED_DATE_FLAGS is exactly ShipLine\'s set', () => {
        expect([...O.DERIVED_DATE_FLAGS].sort()).toEqual(
            ['departed_no_date', 'estimate_passed', 'estimated', 'from_today', 'grace_applied', 'landed_fallback']
        );
    });
});

describe('buildPaymentsFlow with input.dueOverrides', () => {
    const base = () => H.buildInput(H.readFixture('multi-container'), lib);

    test('the set date reaches the item, the kpis follow it, every other item is unchanged', () => {
        const before = lib.buildPaymentsFlow(base());
        const target = before.currencies[0].items.find((it) => it.dueDate != null);
        const far = lib.addDays(before.today, 400);
        const key = O.dueOverrideKeys(target).item;
        const input = { ...base(), dueOverrides: [override({ key, dueDate: far })] };
        const after = lib.buildPaymentsFlow(input);

        const got = after.currencies[0].items.find((it) => it.id === target.id);
        expect(got.dueDate).toBe(far);
        expect(got.flags).toContain('due_set');
        expect(got.dueOverride).toMatchObject({ key, dueDate: far, derivedDueDate: target.dueDate, scope: 'item' });
        const others = (flow) => flow.currencies.flatMap((c) => c.items).filter((it) => it.id !== target.id).map((it) => {
            const copy = { ...it };
            delete copy.dueOverride;
            return copy;
        });
        expect(others(after)).toEqual(others(before));
        const kpi = (flow) => flow.currencies[0].kpis;
        expect(kpi(after).later).toBeCloseTo(kpi(before).later + target.amount, 6);
        expect(kpi(after).outstanding).toBeCloseTo(kpi(before).outstanding, 6);
    });

    test('absent, null or empty dueOverrides change nothing (the golden fixtures carry none)', () => {
        const plain = JSON.stringify(lib.buildPaymentsFlow(base()));
        expect(JSON.stringify(lib.buildPaymentsFlow({ ...base(), dueOverrides: null }))).toBe(plain);
        expect(JSON.stringify(lib.buildPaymentsFlow({ ...base(), dueOverrides: [] }))).toBe(plain);
    });
});

describe('the feed row of a date set by hand', () => {
    test('dueSet carries who, when, the derived date, the scope and the note; dateBasis reads firm; JFlow accepts it', () => {
        const input = H.buildInput(H.readFixture('multi-container'), lib);
        const flow0 = lib.buildPaymentsFlow(input, { claims: true });
        const target = flow0.currencies[0].items.find((it) => it.flags.includes('estimated')) ?? flow0.currencies[0].items[0];
        const key = O.dueOverrideKeys(target).item;
        const flow = lib.buildPaymentsFlow({ ...input, dueOverrides: [override({ key, dueDate: '2027-01-15' })] }, { claims: true });
        const rows = lib.toForecastRows(flow, [], { pos: lib.poDirectory(input.poBundles), shipmentIdByRef: new Map() });
        const row = rows.find((r) => r.id === lib.itemFeedId(target, { shipmentIdByRef: new Map() }));
        expect(row.dueDate).toBe('2027-01-15');
        expect(row.dateBasis).toBe('firm');
        expect(row.flags).toContain('due_set');
        expect(row.dueSet).toEqual({
            by: 'Ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: target.dueDate,
            scope: 'item', note: 'agreed with the supplier',
        });
        for (const other of rows.filter((r) => r !== row)) expect(other.dueSet).toBeNull();
        const checked = validateFeed({ items: rows, companies: [] });
        expect(checked.rejected).toBe(0);
        expect(checked.items.find((r) => r.id === row.id).dueSet).toEqual(row.dueSet);
    });

    test('no setByName: `by` falls back to the part of the email before @', () => {
        const it = item();
        O.applyDueOverrides([it], byKey(override({ setByName: null, note: null })));
        const rows = lib.toForecastRows({ today: '2026-10-06', currencies: [{ currency: 'USD', items: [it] }], balanceClaims: [] }, [], {});
        expect(rows[0].dueSet).toEqual({ by: 'ops', email: 'ops@example.com', at: '2026-10-06T09:30:00.000Z', derivedDate: '2026-11-01', scope: 'item', note: null });
    });
});
