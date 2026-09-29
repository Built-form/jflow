'use strict';

// services/shippingSource.js against shipping's REAL table shapes (docs/PLAN.md "Phase 2":
// JFlow reads shipping's schema directly, read-only). A per-run shadow schema
// jflow_test_<runid>_jfa is built from jfa's own definitions (test/e2e/shippingShadow.js),
// filled with the scenario of test/e2e/shippingSourceFixture.js, and SHIPPING_DB_SCHEMA
// points at it; jfa itself is never read by this suite's source and never written.
//
// Pinned here:
//   · the feed rows (PHASE2 §3, CONTRACT §1.1 P2–P3): ids, 2-dp amounts, dateBasis, one
//     company per row, paid balances split per PO (spd-<sp>-<po>, pay-<sp>-bal<t>-<po>),
//     PI and PO-deposit transfer lines, paidSince, Σ open per currency = kpis.outstanding,
//     and validateFeed accepting every row;
//   · a "when document attached" rule reads the shipment's documents (merged ones too);
//   · case-variant container refs stay two rows with two ids;
//   · the source's session is READ ONLY: an INSERT, UPDATE or DELETE on it fails;
//   · a column the source reads that is gone → SHIPPING_UNAVAILABLE {reason: 'source_schema'}
//     (503 on a forced refresh, a warning on /forecast), and nothing changes;
//   · the refresh end to end: shadow → external_items, and /forecast's Stock payments row.

const { startHarness } = require('./harness');
const { createShadow, SHADOW_RE } = require('./shippingShadow');
const { TODAY, sourceTables } = require('./shippingSourceFixture');

jest.setTimeout(240000);

const PAID_SINCE = '2026-07-31';        // today − 60
const USD_RATE = '0.786543';

let h;
let shadow;
let source;
let shipping;
let logSpies;

beforeAll(async () => {
    h = await startHarness();
    shadow = await createShadow(h);
    const tables = sourceTables();
    for (const [table, rows] of Object.entries(tables)) await shadow.insert(table, rows);
    process.env.SHIPPING_DB_SCHEMA = shadow.schema;
    source = require('../../src/services/shippingSource');
    shipping = require('../../src/services/shipping');
});

afterAll(async () => {
    if (shadow) await shadow.drop();
    if (h) await h.stop();
});

beforeEach(() => {
    logSpies = ['log', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => { for (const spy of logSpies) spy.mockRestore(); });

const api = () => h.api();
const read = (paidSince = PAID_SINCE) => source.readPaymentsForecast({ today: TODAY, paidSince });
const byId = (body) => Object.fromEntries(body.items.map((r) => [r.id, r]));
const cents = (s) => Math.round(Number(s) * 100);
const T = (table) => `\`${shadow.schema}\`.\`${table}\``;

const FEED_KEYS = ['id', 'kind', 'status', 'supplier', 'companyId', 'poId', 'poNumber', 'shipmentId', 'containerRef',
    'currency', 'amount', 'dueDate', 'dateBasis', 'amountBasis', 'blocked', 'arranged', 'paidOn', 'settles', 'flags'];

describe('the shadow schema', () => {
    test('is jflow_test_<runid>_jfa, next to this run\'s schema, and holds every table the source reads', async () => {
        expect(shadow.schema).toBe(`${h.schema}_jfa`);
        expect(SHADOW_RE.test(shadow.schema)).toBe(true);
        const { SOURCE_COLUMNS } = require('../../src/services/shippingReads');
        const rows = await h.sql(
            'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [shadow.schema]
        );
        expect(rows.map((r) => r.t)).toEqual(Object.keys(SOURCE_COLUMNS).sort());
        await expect(source.checkSchema({ query: (sql, p) => h.sql(sql, p).then((r) => [r]) }, shadow.schema)).resolves.toBeUndefined();
    });
});

describe('the feed rows (PHASE2 §3; P2, P3)', () => {
    let body;
    beforeAll(async () => { body = await read(); });

    test('the body: meta, shipping\'s companies, rows JFlow accepts with 0 rejects', () => {
        expect(Object.keys(body)).toEqual(['meta', 'companies', 'items']);
        expect(body.meta).toMatchObject({ today: TODAY, paidSince: PAID_SINCE, model: 'ShipLine f9499bc', schema: shadow.schema });
        expect(body.meta.generatedAt).toEqual(expect.any(String));
        expect(body.companies).toEqual([{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }]);
        const feed = shipping.validateFeed(body);
        expect({ rejected: feed.rejected, problems: feed.problems }).toEqual({ rejected: 0, problems: [] });
        expect(feed.items).toHaveLength(body.items.length);
        for (const r of body.items) {
            expect(Object.keys(r)).toEqual(FEED_KEYS);
            expect(r.amount).toMatch(/^\d+\.\d{2}$/);
            expect(r.companyId === null || Number.isSafeInteger(r.companyId)).toBe(true);
        }
        expect(body.items.some((r) => r.status === 'open')).toBe(true);
        expect(body.items.some((r) => r.status === 'paid')).toBe(true);
    });

    test('Σ open amount per currency = the model\'s kpis.outstanding', () => {
        const sums = {};
        for (const r of body.items.filter((x) => x.status === 'open')) sums[r.currency] = (sums[r.currency] || 0) + cents(r.amount);
        const kpis = Object.fromEntries(Object.entries(body.meta.outstanding).map(([c, v]) => [c, cents(v)]));
        expect(sums).toEqual(Object.fromEntries(Object.entries(kpis).filter(([, v]) => v !== 0)));
        expect(Object.keys(kpis)).toContain('USD');
    });

    test('open rows: dateBasis follows the due date and the estimated flag; ids are the P2 forms', () => {
        for (const r of body.items.filter((x) => x.status === 'open')) {
            expect(r.dateBasis).toBe(r.dueDate == null ? 'undated' : r.flags.includes('estimated') ? 'estimated' : 'firm');
            expect(r.id).toMatch(/^(dep-\d+|pi-\d+(-(s\d+|r[0-9a-f]{10}|n))?|bal-\d+-(s\d+|r[0-9a-f]{10}|n))$/);
            expect(r.paidOn).toBeNull();
        }
        const ids = body.items.map((r) => r.id);
        expect(new Set(ids.map((x) => x.toLowerCase())).size).toBe(ids.length);
    });

    test('a balance marked paid with no transfer is split per PO by the model\'s claims (spd-<sp>-<po>)', () => {
        const rows = byId(body);
        // 6001: 1500 = 1000 named for 801 + 500 shared 801:802 by value (2500:1200).
        const a = rows['spd-6001-801'];
        const b = rows['spd-6001-802'];
        expect(a).toMatchObject({ amount: '1337.84', poId: 801, companyId: 1 });
        expect(b).toMatchObject({ amount: '162.16', poId: 802, companyId: 2 });
        expect(cents(a.amount) + cents(b.amount)).toBe(150000);
        for (const [r, po] of [[a, 801], [b, 802]]) {
            expect(r).toMatchObject({
                status: 'paid', kind: 'balance', paidOn: '2026-09-20', dueDate: null, dateBasis: 'firm', amountBasis: 'stated',
                shipmentId: 311, containerRef: '268', settles: `bal-${po}-s311`, currency: 'USD',
            });
        }
    });

    test('a transfer line on a shared balance gets -<po> per part; the parts keep every cent', () => {
        const rows = byId(body);
        // 300 on 6002 (800 shared 540.54 : 259.46) → 202.70 + 97.30.
        expect(rows['pay-8001-bal6002-801']).toMatchObject({ amount: '202.70', companyId: 1, paidOn: '2026-09-25' });
        expect(rows['pay-8001-bal6002-802']).toMatchObject({ amount: '97.30', companyId: 2, settles: 'bal-802-s311' });
        expect(rows['pay-8001-bal6002']).toBeUndefined();
    });

    test('transfer lines on a PI and on a PO deposit are one PO (and one company) each', () => {
        const rows = byId(body);
        expect(rows['pay-8001-pi7002']).toMatchObject({
            kind: 'deposit', poId: 802, companyId: 2, amount: '200.00', settles: 'pi-7002',
            supplier: 'Suzhou Sunmed Co., Ltd.', paidOn: '2026-09-25',
        });
        expect(rows['pay-8002-dep803']).toMatchObject({
            kind: 'deposit', poId: 803, poNumber: 'PO-803', companyId: 1, amount: '900.00', settles: 'dep-803',
            supplier: 'Ningbo Hangers Ltd', paidOn: '2026-09-10',
        });
        expect(rows['pay-8003-pi7001']).toBeUndefined();      // 1 June: before paidSince
    });

    test('a "packing list attached" rule reads the shipment\'s documents (a merged shipment\'s too)', async () => {
        // PO 805 on shipment 314; the packing list is on 315, merged into 314. Sunmed's rule:
        // balance 3 days after it (generated 2026-09-15T23:30Z, read as its UTC date, as the
        // page does), the default rule's 2 grace days on top. 70% of 500 (the deposit went
        // with the goods on the water).
        const rows = byId(body);
        expect(rows['bal-805-s314']).toMatchObject({
            status: 'open', amount: '350.00', dueDate: '2026-09-20', dateBasis: 'firm', shipmentId: 314, containerRef: '270',
            companyId: 1, poNumber: 'PO-805', amountBasis: 'derived',
        });
        expect(rows['bal-805-s314'].flags).toEqual(expect.arrayContaining(['policy_applied', 'grace_applied']));
        expect(rows['bal-805-s314'].flags).not.toContain('awaiting_document');
        // Lines not yet in a container wait for their document, undated.
        const unbooked = body.items.find((r) => r.poId === 801 && r.status === 'open');
        expect(unbooked).toMatchObject({ containerRef: 'MSKU1', dueDate: null, dateBasis: 'undated', shipmentId: null });

        // Without the document, the same balance waits for it.
        try {
            await shadow.sql(`UPDATE ${T('draft_container_documents')} SET deleted_at = '2026-09-28 09:00:00' WHERE id = 94`);
            const waiting = byId(await read())['bal-805-s314'];
            expect(waiting.flags).toContain('awaiting_document');
            expect(waiting.dueDate).not.toBe('2026-09-20');
        } finally {
            await shadow.sql(`UPDATE ${T('draft_container_documents')} SET deleted_at = NULL WHERE id = 94`);
        }
    });
});

describe('the same data, other days and other states', () => {
    test('paidSince bounds the paid rows; the open rows do not move', async () => {
        const base = await read();
        const wide = await read('2026-06-01');
        const narrow = await read('2026-09-21');
        expect(byId(wide)['pay-8003-pi7001']).toMatchObject({ poId: 801, companyId: 1, amount: '750.00' });
        expect(narrow.items.filter((r) => r.status === 'paid').map((r) => r.id))
            .toEqual(['pay-8001-bal6002-801', 'pay-8001-bal6002-802', 'pay-8001-pi7002']);
        const openIds = (b) => b.items.filter((r) => r.status === 'open').map((r) => r.id);
        expect(openIds(wide)).toEqual(openIds(base));
        expect(openIds(narrow)).toEqual(openIds(base));
    });

    test('a balance a transfer settled emits nothing of its own; one part paid then marked paid emits the rest', async () => {
        try {
            await shadow.sql(`UPDATE ${T('shipment_payments')} SET settled_by_payment_id = 8001 WHERE id = 6001`);
            expect((await read()).items.some((r) => r.id.startsWith('spd-6001'))).toBe(false);
            await shadow.sql(`UPDATE ${T('shipment_payments')} SET settled_by_payment_id = NULL WHERE id = 6001`);
            await shadow.sql(`UPDATE ${T('shipment_payments')} SET status = 'paid', paid_on = '2026-09-26' WHERE id = 6002`);
            const rows = byId(await read());
            // 800 − the 300 transfer = 500, split 540.54 : 259.46 → 337.84 + 162.16.
            expect(rows['spd-6002-801'].amount).toBe('337.84');
            expect(rows['spd-6002-802'].amount).toBe('162.16');
            expect(rows['pay-8001-bal6002-801'].amount).toBe('202.70');
        } finally {
            await shadow.sql(`UPDATE ${T('shipment_payments')} SET settled_by_payment_id = NULL WHERE id = 6001`);
            await shadow.sql(`UPDATE ${T('shipment_payments')} SET status = 'pending', paid_on = NULL WHERE id = 6002`);
        }
    });

    test('a paid balance no PO claims is one row with no PO and no company (spd-<sp>)', async () => {
        try {
            await shadow.insert('shipment_payments', [{
                id: 6003, shipment_id: 399, shipment_reference: 'NOBODY-1', supplier_name: 'Suzhou Sunmed Co., Ltd.',
                supplier_key: 'suzhou sunmed', kind: 'balance', amount: '75.50', currency: 'USD', status: 'paid',
                paid_on: '2026-09-22', source: 'manual',
            }]);
            const r = byId(await read())['spd-6003'];
            expect(r).toMatchObject({ poId: null, companyId: null, amount: '75.50', containerRef: 'NOBODY-1', settles: null });
        } finally {
            await shadow.sql(`DELETE FROM ${T('shipment_payments')} WHERE id = 6003`);
        }
    });

    test('case-variant container refs on one PO stay two rows with two ids', async () => {
        try {
            await shadow.insert('orders', [{
                id: 5006, jf_code: 'JF5006', purchase_order_id: 801, po_number: 'PO-801', supplier: 'Suzhou Sunmed Co., Ltd.',
                container_number: 'msku1', status: 'IN_PRODUCTION', quantity: 200, unit_price: '2.5000',
                created_at: new Date('2026-07-01T10:02:00Z'),
            }]);
            const body = await read();
            const ids = body.items.filter((r) => r.poId === 801 && /^msku1$/i.test(r.containerRef ?? '')).map((r) => r.id);
            expect(ids).toHaveLength(2);
            expect(new Set(ids.map((x) => x.toLowerCase())).size).toBe(2);
            for (const id of ids) expect(id).toMatch(/^(bal|pi)-801-r[0-9a-f]{10}$/);
            expect(shipping.validateFeed(body).rejected).toBe(0);
        } finally {
            await shadow.sql(`DELETE FROM ${T('orders')} WHERE id = 5006`);
        }
    });
});

describe('read-only', () => {
    test('the source\'s session refuses every write (1792), and nothing changed', async () => {
        const before = await shadow.sql(`SELECT id, name FROM ${T('companies')} ORDER BY id`);
        const conn = await source.openSourceConnection();
        try {
            const [[ro]] = await conn.query('SELECT @@SESSION.transaction_read_only AS ro');
            expect(Number(ro.ro)).toBe(1);
            for (const sql of [
                `INSERT INTO ${T('companies')} (id, name) VALUES (99, 'Written by JFlow')`,
                `UPDATE ${T('companies')} SET name = 'Renamed by JFlow' WHERE id = 1`,
                `DELETE FROM ${T('companies')} WHERE id = 2`,
            ]) {
                await expect(conn.query(sql)).rejects.toMatchObject({ errno: 1792, code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
            }
        } finally {
            await conn.end();
        }
        expect(await shadow.sql(`SELECT id, name FROM ${T('companies')} ORDER BY id`)).toEqual(before);
    });
});

describe('the refresh end to end, then a schema that no longer fits', () => {
    let co1;
    let co2;
    let usd1;
    let stock;
    const releaseClaim = () => h.sql("UPDATE external_sync SET last_attempt_at = NULL WHERE source = 'ship'");
    const forecast = (companyId) => api().get('/api/v1/forecast').query({ today: TODAY, companyId });

    beforeAll(async () => {
        const company = async (code, shippingCompanyId) => {
            const co = (await api().post('/api/v1/companies').send({ code, name: code }).expect(201)).body;
            return (await api().put(`/api/v1/companies/${co.id}`).send({ shippingCompanyId }).expect(200)).body;
        };
        co1 = await company('SRC1', 1);
        co2 = await company('SRC2', 2);
        const account = async (companyId, name, currency, isDefault) => {
            const acct = (await api().post('/api/v1/accounts').send({ companyId, name, currency, isDefault }).expect(201)).body;
            await api().put(`/api/v1/accounts/${acct.id}/balances/2026-09-20`).query({ today: TODAY })
                .send({ balance: '50000.00' }).expect(200);
            return acct;
        };
        usd1 = await account(co1.id, 'JFA Dollars', 'USD', true);
        await account(co2.id, 'HW Dollars', 'USD', true);
        await api().post('/api/v1/fx-rates').send({ currency: 'USD', rateToGbp: USD_RATE, effectiveFrom: '2026-09-01' }).expect(201);
        stock = (await api().get('/api/v1/categories').query({ q: 'Stock payments' }).expect(200)).body.data[0];
    });

    test('POST /external/refresh reads the shadow through the source into external_items', async () => {
        await releaseClaim();
        const res = await api().post('/api/v1/external/refresh').query({ today: TODAY }).expect(200);
        expect(res.body.ran).toBe(true);
        expect(res.body.status).toMatchObject({
            source: 'ship', feedToday: TODAY, lastError: null, rejectedCount: 0, configured: true,
            companies: [{ id: 1, name: 'JFA Medical Ltd' }, { id: 2, name: 'Hangerworld Ltd' }],
        });

        // paidSince = the earliest live active account's latest balance (2026-09-20).
        const expected = await source.readPaymentsForecast({ today: TODAY, paidSince: '2026-09-20' });
        const rows = await h.sql("SELECT * FROM external_items WHERE source = 'ship' ORDER BY ext_id");
        expect(rows.map((r) => r.ext_id)).toEqual(expected.items.map((r) => r.id).sort());
        expect(res.body.status.itemCount).toBe(expected.items.length);
        const spd = rows.find((r) => r.ext_id === 'spd-6001-801');
        expect(spd).toMatchObject({
            feed_kind: 'balance', feed_status: 'paid', shipping_company_id: 1, po_id: 801, amount: '1337.84',
            paid_on: '2026-09-20', settles: 'bal-801-s311', created_by: 'shipping-feed', gone_at: null,
        });
        for (const r of rows) {
            expect({ id: r.ext_id, planned: [r.planned_date, r.planned_amount, r.planned_skipped] })
                .toEqual({ id: r.ext_id, planned: [null, null, 0] });
        }
    });

    test('/forecast shows the Stock payments row from the shadow\'s data', async () => {
        const res = await forecast(co1.id);
        expect(res.status).toBe(200);
        expect(res.body.warnings.filter((w) => w.code === 'SHIPPING_UNAVAILABLE')).toEqual([]);
        const row = res.body.rows.find((r) => r.categoryId === stock.id);
        expect(row).toMatchObject({ categoryName: 'Stock payments', direction: 'out' });
        const items = row.items;
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((l) => l.kind === 'ship' && l.key === `ship.${l.id}` && l.accountId === usd1.id)).toBe(true);
        const ext = await h.sql("SELECT ext_id FROM external_items WHERE source = 'ship' AND shipping_company_id = 1");
        const known = new Set(ext.map((r) => r.ext_id));
        expect(items.every((l) => known.has(l.id))).toBe(true);
        expect(res.body.shipping).toMatchObject({ feedToday: TODAY });
        expect(res.body.shipping.openCount).toBeGreaterThan(0);
    });

    test('a column the source reads is gone → 503 / warning SHIPPING_UNAVAILABLE source_schema; the snapshot is kept', async () => {
        const syncBefore = (await h.sql("SELECT * FROM external_sync WHERE source = 'ship'"))[0];
        const itemsBefore = await h.sql("SELECT ext_id, feed_hash, gone_at FROM external_items WHERE source = 'ship' ORDER BY ext_id");
        await shadow.sql(`ALTER TABLE ${T('orders')} RENAME COLUMN unit_price TO unit_price_renamed`);
        try {
            await releaseClaim();
            const res = await api().post('/api/v1/external/refresh').query({ today: TODAY }).expect(503);
            expect(res.body).toMatchObject({
                code: 'SHIPPING_UNAVAILABLE',
                details: { reason: 'source_schema', lastSuccessAt: syncBefore.last_success_at.toISOString() },
            });
            const sync = (await h.sql("SELECT * FROM external_sync WHERE source = 'ship'"))[0];
            expect(sync.last_error).toMatch(/^source_schema: .*orders\.unit_price/);
            expect(sync.last_success_at).toEqual(syncBefore.last_success_at);
            expect(await h.sql("SELECT ext_id, feed_hash, gone_at FROM external_items WHERE source = 'ship' ORDER BY ext_id"))
                .toEqual(itemsBefore);

            // Due by the TTL: /forecast answers on the last snapshot and says why.
            await h.sql("UPDATE external_sync SET last_success_at = last_success_at - INTERVAL 11 MINUTE, last_attempt_at = NULL WHERE source = 'ship'");
            const aged = (await h.sql("SELECT last_success_at FROM external_sync WHERE source = 'ship'"))[0].last_success_at.toISOString();
            const body = (await forecast(co1.id).expect(200)).body;
            expect(body.warnings).toContainEqual({ code: 'SHIPPING_UNAVAILABLE', reason: 'source_schema', lastSuccessAt: aged });
            expect(body.rows.find((r) => r.categoryId === stock.id).items.length).toBeGreaterThan(0);
        } finally {
            await shadow.sql(`ALTER TABLE ${T('orders')} RENAME COLUMN unit_price_renamed TO unit_price`);
        }
        // Put back, the next forced run succeeds again.
        await releaseClaim();
        const ok = await api().post('/api/v1/external/refresh').query({ today: TODAY }).expect(200);
        expect(ok.body.status.lastError).toBeNull();
    });
});
