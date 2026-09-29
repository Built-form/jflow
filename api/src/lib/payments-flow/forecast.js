// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London; new, not in the TS: JFlow feed rows (toForecastRows), taken from the shipping step-18 draft with its route-only filterForecastRows dropped
'use strict';

// The JFlow feed — the `items` of the body services/shippingSource.js returns
// (docs/PHASE2.md §3; CONTRACT §1.1 P2/P3), each accepted by services/shipping.js
// validateFeed. Not part of the ShipLine TS: this projects the model's output for
// JFlow, and adds the payments made.
//
//   open rows  the model's PaymentItems (flow.currencies[].items), one row each.
//   paid rows  what left the account since `paidSince`:
//              - each transfer line (supplier_payments + supplier_payment_lines);
//              - each balance record marked paid with no transfer
//                (settledByPaymentId null), for what no transfer covered.
//              A balance record can span several POs, so its payments are
//              split per PO by the model's claims (buildPaymentsFlow with
//              options.claims), and every row has one PO and so one company.
//              A PI marked paid with no transfer has no date: nothing is emitted.
//
// Ids come from ids.js. `amount` is a 2-dp string: toFixed(2) of the model's
// cent-rounded figure for open rows; exact cents for a split paid row (largest
// remainder, so the parts add up to the payment). `dateBasis` is undated with
// no due date, estimated when the item is flagged so, else firm; a paid row is
// dated by its payment, so firm. Pure: no database, no clock.

const { dateOf } = require('./dates');
const { money } = require('./money');
const { feedId, groupToken, itemFeedId } = require('./ids');

/** @typedef {import('./types').FeedRow} FeedRow */
/** @typedef {import('./types').PaidFact} PaidFact */
/** @typedef {import('./types').PaymentsFlow} PaymentsFlow */
/** @typedef {import('./types').PaymentItem} PaymentItem */
/** @typedef {{ poNumber: string, supplier: string|null, companyId: number|null }} PoEntry */
/** @typedef {{ pos?: Map<number, PoEntry>, shipmentIdByRef?: Map<string, number>|null }} FeedContext */

// JFlow's external_items widths (services/shipping.js TEXT_LIMITS,
// in characters): JFlow rejects a longer value, and with it the whole row, so
// display text is clipped to fit. No id depends on these fields.
const TEXT_LIMITS = { supplier: 255, poNumber: 64, containerRef: 100 };
const LINE_KINDS = new Set(['balance', 'pi', 'po_deposit']);

function clip(s, max) {
    if (s == null) return null;
    const chars = [...String(s)];
    return chars.length > max ? chars.slice(0, max).join('') : String(s);
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const currencyOf = (c) => String(c || 'USD').trim().toUpperCase();

/** Whole cents of a money figure (the model's figures are cent-rounded floats). */
const centsOf = (n) => Math.round((Number(n) || 0) * 100);

/** Whole cents → the feed's 2-dp string. */
function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    const a = Math.abs(cents);
    return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * The shipment a container ref belongs to, looked up as the model looks up
 * containerEvents: as spelt (trimmed), then upper-cased. Null when none.
 * @param {string|null|undefined} ref
 * @param {Map<string, number>|null|undefined} shipmentIdByRef
 * @returns {number|null}
 */
function shipmentIdOf(ref, shipmentIdByRef) {
    const r = ref == null ? '' : String(ref).trim();
    if (!r || !shipmentIdByRef) return null;
    const id = shipmentIdByRef.get(r) ?? shipmentIdByRef.get(r.toUpperCase());
    return isId(id) ? id : null;
}

/**
 * PO id → what a feed row says about the PO, from the model's poBundles.
 * poNumber as summarizePo names it (`PO <id>` when blank).
 * @param {Record<string, import('./types').PurchaseOrderBundle>|null|undefined} poBundles
 * @returns {Map<number, PoEntry>}
 */
function poDirectory(poBundles) {
    const out = new Map();
    for (const b of Object.values(poBundles ?? {})) {
        if (!b || !isId(b.id)) continue;
        out.set(b.id, { poNumber: b.poNumber || `PO ${b.id}`, supplier: b.supplier ?? null, companyId: isId(b.companyId) ? b.companyId : null });
    }
    return out;
}

/**
 * The payments made on or after `paidSince`, from the model's own input.
 * Transfer lines on the same obligation within one transfer are one payment.
 * A balance record marked paid with no transfer counts for what transfers
 * (of any date) did not already cover of it.
 * @param {import('./types').PaymentsFlowInput} input
 * @param {{ paidSince: string }} opts
 * @returns {PaidFact[]}
 */
function collectPaidRows(input, { paidSince }) {
    const since = dateOf(paidSince);
    if (since == null) throw new TypeError(`collectPaidRows: paidSince must be 'YYYY-MM-DD' (got ${JSON.stringify(paidSince)})`);
    const facts = [];
    const appliedToRecord = new Map();
    for (const sp of input.supplierPayments ?? []) {
        for (const l of sp.lines ?? []) {
            if (l.kind === 'balance') appliedToRecord.set(l.targetId, (appliedToRecord.get(l.targetId) ?? 0) + centsOf(l.amount));
        }
        const paidOn = dateOf(sp.paidOn);
        if (paidOn == null || paidOn < since || !isId(sp.id)) continue;
        const byTarget = new Map();
        for (const l of sp.lines ?? []) {
            if (!LINE_KINDS.has(l.kind) || !isId(l.targetId)) continue;
            const key = `${l.kind}:${l.targetId}`;
            const prev = byTarget.get(key);
            if (prev) {
                prev.amount = money(prev.amount + (Number(l.amount) || 0));
                continue;
            }
            byTarget.set(key, {
                source: 'transfer', supplierPaymentId: sp.id, lineKind: l.kind, targetId: l.targetId,
                amount: money(Number(l.amount) || 0), currency: currencyOf(sp.currency), paidOn,
                supplier: sp.supplierName ?? null,
                purchaseOrderId: isId(l.purchaseOrderId) ? l.purchaseOrderId : null, poNumber: l.poNumber ?? null,
                shipmentId: isId(l.shipmentId) ? l.shipmentId : null, shipmentReference: l.shipmentReference ?? null,
                paymentType: l.paymentType ?? null,
            });
        }
        facts.push(...byTarget.values());
    }
    for (const rec of input.shipmentPayments ?? []) {
        if (rec.status !== 'paid' || rec.settledByPaymentId != null || !isId(rec.id)) continue;
        const paidOn = dateOf(rec.paidOn);
        if (paidOn == null || paidOn < since) continue;
        const cents = centsOf(rec.amount) - (appliedToRecord.get(rec.id) ?? 0);
        if (cents <= 0) continue;
        facts.push({
            source: 'record', shipmentPaymentId: rec.id, amount: cents / 100, currency: currencyOf(rec.currency), paidOn,
            supplier: rec.supplierName ?? null, shipmentId: isId(rec.shipmentId) ? rec.shipmentId : null,
            shipmentReference: rec.shipmentReference ?? null,
        });
    }
    return facts;
}

/**
 * Split whole cents over weighted parts: floor of each exact share, then the
 * cents left over to the largest remainders (ties: the smaller key). Exact
 * (BigInt), so the parts always add up to `cents`.
 * @param {number} cents  ≥ 0
 * @param {{ key: number, weight: number }[]} parts  weights in cents, ≥ 0
 * @returns {{ key: number, cents: number }[]}  in key order
 */
function splitCents(cents, parts) {
    const sorted = [...parts].sort((a, b) => a.key - b.key);
    const total = sorted.reduce((a, p) => a + BigInt(p.weight), 0n);
    if (total <= 0n) throw new TypeError('splitCents: the weights add up to nothing');
    const c = BigInt(cents);
    const out = sorted.map(p => ({ key: p.key, cents: (c * BigInt(p.weight)) / total, rem: (c * BigInt(p.weight)) % total }));
    let left = c - out.reduce((a, p) => a + p.cents, 0n);
    const order = [...out].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.key - b.key));
    for (const p of order) {
        if (left <= 0n) break;
        p.cents += 1n;
        left -= 1n;
    }
    return out.map(p => ({ key: p.key, cents: Number(p.cents) }));
}

/**
 * @param {PaymentItem} item
 * @param {FeedContext} ctx
 * @returns {FeedRow}
 */
function openRow(item, ctx) {
    const po = ctx.pos?.get(item.poId) ?? null;
    return {
        id: itemFeedId(item, { shipmentIdByRef: ctx.shipmentIdByRef ?? null }),
        kind: item.kind,
        status: 'open',
        supplier: clip(item.supplier, TEXT_LIMITS.supplier),
        companyId: po?.companyId ?? null,
        poId: item.poId,
        poNumber: clip(item.poNumber, TEXT_LIMITS.poNumber),
        shipmentId: shipmentIdOf(item.containerNumber, ctx.shipmentIdByRef),
        containerRef: clip(item.containerNumber ?? null, TEXT_LIMITS.containerRef),
        currency: item.currency,
        amount: item.amount.toFixed(2),
        dueDate: item.dueDate ?? null,
        dateBasis: item.dueDate == null ? 'undated' : item.flags.includes('estimated') ? 'estimated' : 'firm',
        amountBasis: item.basis,
        blocked: item.blocked ?? null,
        arranged: item.status === 'arranged',
        paidOn: null,
        settles: null,
        flags: [...item.flags],
    };
}

function paidRow(fact, { id, kind, poId, cents, settles, containerRef, shipmentId }, ctx) {
    const po = poId != null ? ctx.pos?.get(poId) ?? null : null;
    return {
        id,
        kind,
        status: 'paid',
        supplier: clip(fact.supplier, TEXT_LIMITS.supplier),
        companyId: po?.companyId ?? null,
        poId: poId ?? null,
        poNumber: clip(po?.poNumber ?? fact.poNumber ?? null, TEXT_LIMITS.poNumber),
        shipmentId: shipmentId ?? null,
        containerRef: clip(containerRef ?? null, TEXT_LIMITS.containerRef),
        currency: fact.currency,
        amount: formatCents(cents),
        dueDate: null,
        dateBasis: 'firm',
        amountBasis: 'stated',
        blocked: null,
        arranged: false,
        paidOn: fact.paidOn,
        settles: settles ?? null,
        flags: [],
    };
}

/** A balance payment (a transfer line on a record, or a record paid by hand) → one row per PO claiming the record. */
function balanceRows(fact, recordId, claimsByRecord, ctx) {
    const cents = centsOf(fact.amount);
    if (cents <= 0) return [];
    const ref = fact.shipmentReference ?? null;
    const shipmentId = fact.shipmentId ?? shipmentIdOf(ref, ctx.shipmentIdByRef);
    const idOf = (poId) => (fact.source === 'transfer'
        ? feedId({ form: 'pay', supplierPaymentId: fact.supplierPaymentId, lineKind: 'balance', targetId: recordId, poId })
        : feedId({ form: 'spd', shipmentPaymentId: fact.shipmentPaymentId, poId }));
    const claims = claimsByRecord.get(recordId);
    if (!claims || !claims.size) {
        // No PO claims the record (its goods are not on any PO this model knows):
        // one row, with no PO and so no company.
        return [paidRow(fact, { id: idOf(null), kind: 'balance', poId: null, cents, settles: null, containerRef: ref, shipmentId }, ctx)];
    }
    const parts = splitCents(cents, [...claims].map(([poId, c]) => ({ key: poId, weight: c.weight })));
    return parts.filter(p => p.cents > 0).map(p => {
        const box = claims.get(p.key).containerNumber;
        return paidRow(fact, {
            id: idOf(p.key), kind: 'balance', poId: p.key, cents: p.cents,
            settles: feedId({ form: 'bal', poId: p.key, group: groupToken(box, ctx.shipmentIdByRef) }),
            containerRef: ref ?? box, shipmentId,
        }, ctx);
    });
}

/**
 * The feed rows: every open item of the model, then every payment made.
 * @param {PaymentsFlow} flow  buildPaymentsFlow(input, { claims: true })
 * @param {PaidFact[]} paidRows  collectPaidRows(input, { paidSince })
 * @param {FeedContext} [ctx]  pos: poDirectory(input.poBundles) (plus any PO a
 *   payment names that has no bundle); shipmentIdByRef: the page's map.
 * @returns {FeedRow[]}
 */
function toForecastRows(flow, paidRows, ctx = {}) {
    const rows = [];
    for (const c of flow.currencies ?? []) {
        for (const item of c.items) {
            // Never 0 in practice (the model emits nothing under a cent); JFlow refuses ≤ 0.
            if (centsOf(item.amount) > 0) rows.push(openRow(item, ctx));
        }
    }
    const needsClaims = (paidRows ?? []).some(f => f.source === 'record' || f.lineKind === 'balance');
    if (needsClaims && !Array.isArray(flow.balanceClaims)) {
        throw new TypeError('toForecastRows: flow.balanceClaims is missing — build the flow with buildPaymentsFlow(input, { claims: true })');
    }
    // Record → PO → { weight (cents): allocated + shared, the box it is on }.
    const claimsByRecord = new Map();
    for (const cl of flow.balanceClaims ?? []) {
        if (!claimsByRecord.has(cl.shipmentPaymentId)) claimsByRecord.set(cl.shipmentPaymentId, new Map());
        const byPo = claimsByRecord.get(cl.shipmentPaymentId);
        const prev = byPo.get(cl.poId);
        byPo.set(cl.poId, { weight: (prev?.weight ?? 0) + Math.max(0, centsOf(cl.amount)), containerNumber: prev?.containerNumber ?? cl.containerNumber });
    }
    for (const byPo of claimsByRecord.values()) {
        for (const [poId, c] of byPo) if (c.weight <= 0) byPo.delete(poId);
    }
    const paid = [];
    for (const f of paidRows ?? []) {
        if (f.source === 'record') {
            paid.push(...balanceRows(f, f.shipmentPaymentId, claimsByRecord, ctx));
            continue;
        }
        if (f.lineKind === 'balance') {
            paid.push(...balanceRows(f, f.targetId, claimsByRecord, ctx));
            continue;
        }
        const cents = centsOf(f.amount);
        if (cents <= 0) continue;
        if (f.lineKind === 'pi') {
            paid.push(paidRow(f, {
                id: feedId({ form: 'pay', supplierPaymentId: f.supplierPaymentId, lineKind: 'pi', targetId: f.targetId }),
                kind: f.paymentType === 'deposit' ? 'deposit' : 'balance', poId: f.purchaseOrderId, cents,
                settles: feedId({ form: 'pi', invoicePaymentId: f.targetId }), containerRef: null, shipmentId: null,
            }, ctx));
        } else {
            paid.push(paidRow(f, {
                id: feedId({ form: 'pay', supplierPaymentId: f.supplierPaymentId, lineKind: 'po_deposit', targetId: f.targetId }),
                kind: 'deposit', poId: f.targetId, cents,
                settles: feedId({ form: 'dep', poId: f.targetId }), containerRef: null, shipmentId: null,
            }, ctx));
        }
    }
    paid.sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.concat(paid);
}

module.exports = {
    TEXT_LIMITS, shipmentIdOf, poDirectory, collectPaidRows, splitCents, formatCents, toForecastRows,
};
