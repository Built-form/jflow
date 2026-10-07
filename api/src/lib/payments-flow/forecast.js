// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: new, not in the TS: JFlow feed rows (toForecastRows), taken from the shipping step-18 draft with its route-only filterForecastRows dropped; a row's `dueSet` (the story of a date set by hand, from PaymentItem.dueOverride); since the 2026-10-06 re-pin: QC units, extras (incl. a forwarder's shipment cost), the PO's charges and top-up rows, split parts in a draft or plan, credits netted into the payment they offset, a `label`, and paid rows for `extra` and `qc` transfer lines
'use strict';

// The JFlow feed — the `items` of the body services/shippingSource.js returns
// (docs/PHASE2.md §3; CONTRACT §1.1 P2/P3), each accepted by services/shipping.js
// validateFeed. Not part of the ShipLine TS: this projects the model's output for
// JFlow, and adds the payments made.
//
//   open rows  the model's PaymentItems (flow.currencies[].items), one row each:
//              a PO's deposit and balances, its charges row, a top-up, an extra
//              charge (kind 'extra'; a forwarder's shipment cost carries flag
//              shipment_cost and names the forwarder as its supplier), and its
//              QC units (flow.currencies[].qcItems, kind 'qc'). A supplier credit
//              the model forecasts against an item (creditForecast) is NETTED
//              into that row (Dev, 2026-10-06): JFlow refuses a negative row and
//              has no incoming stock category; the row says so (flag
//              credit_netted) and a row netted to nothing is left out. Credits
//              with nothing to ride (flow.currencies[].credits) make no row.
//   paid rows  what left the account since `paidSince`:
//              - each transfer line (supplier_payments + supplier_payment_lines),
//                of every kind: balance, pi, po_deposit, extra, qc;
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
// dated by its payment, so firm. `label` says what a row is when it is not a
// PO's goods. Pure: no database, no clock.

const { dateOf } = require('./dates');
const { money, EPS } = require('./money');
const { EXTRA_KIND_LABEL } = require('./model');
const { feedId, groupToken, itemFeedId } = require('./ids');

/** @typedef {import('./types').FeedRow} FeedRow */
/** @typedef {import('./types').PaidFact} PaidFact */
/** @typedef {import('./types').PaymentsFlow} PaymentsFlow */
/** @typedef {import('./types').PaymentItem} PaymentItem */
/** @typedef {import('./types').QcItem} QcItem */
/** @typedef {{ poNumber: string, supplier: string|null, companyId: number|null, currency: string|null }} PoEntry */
/**
 * @typedef {object} FeedContext
 * @property {Map<number, PoEntry>} [pos]
 * @property {Map<string, number>|null} [shipmentIdByRef]
 * @property {import('./types').Order[]|null} [orders]  The PO lines: a shared box's goods, by company.
 * @property {Map<string, number|null>} [companiesByBox]  Set by toForecastRows.
 */

// JFlow's external_items widths (services/shipping.js TEXT_LIMITS,
// in characters): JFlow rejects a longer value, and with it the whole row, so
// display text is clipped to fit. No id depends on these fields.
const TEXT_LIMITS = { supplier: 255, poNumber: 64, containerRef: 100, label: 255 };
const LINE_KINDS = new Set(['balance', 'pi', 'po_deposit', 'extra', 'qc']);

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
        out.set(b.id, {
            poNumber: b.poNumber || `PO ${b.id}`, supplier: b.supplier ?? null, companyId: isId(b.companyId) ? b.companyId : null,
            currency: typeof b.currency === 'string' && b.currency ? b.currency : null,
        });
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
 * The story of a date set by hand (handover doc "Dates set by hand"): who, when,
 * in place of which derived date, for the whole payment or this row, and why.
 * `by` is the setter's display name, else the part of the email before @ — what
 * ShipLine's hover says (paymentsCopy.ts dueSetText). Null when the date is derived.
 * @param {PaymentItem} item
 * @returns {import('./types').FeedDueSet|null}
 */
function dueSetOf(item) {
    const o = item.dueOverride;
    if (!o) return null;
    const name = typeof o.setByName === 'string' ? o.setByName.trim() : '';
    const email = String(o.setByEmail ?? '');
    return {
        by: name || email.split('@')[0],
        email,
        at: o.setAt,
        derivedDate: o.derivedDueDate ?? null,
        scope: o.scope,
        note: o.note ?? null,
    };
}

/** The feed's kind for a model item: an extra is 'extra' whatever payment it rides with. */
const feedKindOf = (item) => (item.extraId != null ? 'extra' : item.kind);

/**
 * What a row is when it is not a PO's goods — the feed's `label` (TEXT_LIMITS.label):
 * an extra's kind ("Mould cost", "Freight"), the PO's charges row, a top-up, QC
 * units carried on a balance. Null for goods, and for a QC unit (qcRow labels it).
 * @param {PaymentItem} item
 * @returns {string|null}
 */
function rowLabel(item) {
    if (item.extraId != null) return EXTRA_KIND_LABEL[item.extraKind] ?? 'Extra charge';
    if (item.balanceOf === 'charges') return 'PO charges';
    if (item.balanceOf === 'fqc') return 'QC units';
    if (/^derived:topup:/.test(item.id)) return 'Top-up';
    return null;
}

/** The credit the model forecasts against an item, netted into its row (Dev, 2026-10-06). */
const creditOn = (item) => (item.creditForecast != null && item.creditForecast > EPS ? money(item.creditForecast) : 0);

const boxKey = (ref) => (ref == null ? '' : String(ref).trim().toUpperCase());

/**
 * The company a box's forwarder cost falls to, from the cents each company's items there
 * add up to: the only company, else the one with the biggest share (Dev, 2026-10-07).
 * null on a tie, and when the companies' items are in more than one currency: there are
 * no rates here to weigh one against the other.
 * @param {{ cents: Map<number, number>, currencies: Set<string> }} box
 * @returns {number|null}
 */
function biggestShare(box) {
    if (box.cents.size === 1) return [...box.cents.keys()][0];
    if (box.currencies.size > 1) return null;
    const [first, second] = [...box.cents].sort((a, b) => b[1] - a[1]);
    return first[1] > second[1] ? first[0] : null;
}

/** One company's cents in a box, in one currency. */
function weigh(boxes, key, companyId, cents, currency) {
    const box = boxes.get(key) ?? { cents: new Map(), currencies: new Set() };
    box.cents.set(companyId, (box.cents.get(companyId) ?? 0) + Math.max(0, cents));
    if (currency) box.currencies.add(currencyOf(currency));
    boxes.set(key, box);
}

/**
 * Container ref (upper-cased, as the model matches a shipment cost to its box) → the
 * company whose POs have goods in it: the only one, or of several the one with the
 * biggest share (biggestShare), else null.
 *
 * The share is of the GOODS in the box — each PO line's quantity × unit price, in the PO's
 * currency, paid or not (Dev, 2026-10-07: shipment 126's freight, packaging and handling
 * lost their company the morning its goods were paid, because the share was of what was
 * still owed). A box whose goods carry no price falls back to what is owed in it, from
 * every item of every currency that names a PO with a company.
 * @param {PaymentsFlow} flow
 * @param {FeedContext} ctx
 * @returns {Map<string, number|null>}
 */
function companiesByBox(flow, ctx) {
    const goods = new Map();
    for (const o of ctx.orders ?? []) {
        const key = boxKey(o.containerNumber);
        const po = isId(o.purchaseOrderId) ? ctx.pos?.get(o.purchaseOrderId) : null;
        if (!key || po?.companyId == null) continue;
        const value = o.unitPrice != null && o.unitPrice > 0 ? o.unitPrice * (o.quantity || 0) : 0;
        if (value <= 0) continue;
        weigh(goods, key, po.companyId, centsOf(value), po.currency);
    }
    const owed = new Map();
    for (const c of flow.currencies ?? []) {
        for (const item of c.items) {
            const key = boxKey(item.containerNumber);
            if (!key || !isId(item.poId) || goods.has(key)) continue;
            const companyId = ctx.pos?.get(item.poId)?.companyId ?? null;
            if (companyId == null) continue;
            weigh(owed, key, companyId, centsOf(item.amount), item.currency ?? c.currency);
        }
    }
    return new Map([...goods, ...owed].map(([key, box]) => [key, biggestShare(box)]));
}

const companyOfBox = (ref, ctx) => ctx.companiesByBox?.get(boxKey(ref)) ?? null;

/**
 * @param {PaymentItem} item
 * @param {FeedContext} ctx
 * @returns {FeedRow}
 */
function openRow(item, ctx) {
    const po = ctx.pos?.get(item.poId) ?? null;
    const credit = creditOn(item);
    const net = money(item.amount - credit);
    // A forwarder's shipment cost names no PO (poId 0): its company is the company of the
    // goods in that container (Dev, 2026-10-06), and when two companies share the
    // container, the one with the bigger share of them (Dev, 2026-10-07).
    const companyId = po?.companyId ?? (item.poId ? null : companyOfBox(item.containerNumber, ctx));
    return {
        id: itemFeedId(item, { shipmentIdByRef: ctx.shipmentIdByRef ?? null }),
        kind: feedKindOf(item),
        status: 'open',
        supplier: clip(item.supplier, TEXT_LIMITS.supplier),
        companyId,
        poId: isId(item.poId) ? item.poId : null,
        poNumber: clip(item.poNumber || null, TEXT_LIMITS.poNumber),
        shipmentId: shipmentIdOf(item.containerNumber, ctx.shipmentIdByRef),
        containerRef: clip(item.containerNumber ?? null, TEXT_LIMITS.containerRef),
        label: clip(rowLabel(item), TEXT_LIMITS.label),
        currency: item.currency,
        amount: net.toFixed(2),
        dueDate: item.dueDate ?? null,
        dateBasis: item.dueDate == null ? 'undated' : item.flags.includes('estimated') ? 'estimated' : 'firm',
        amountBasis: item.basis,
        blocked: item.blocked ?? null,
        arranged: item.status === 'arranged',
        paidOn: null,
        settles: null,
        flags: credit > 0 ? [...item.flags, 'credit_netted'] : [...item.flags],
        dueSet: dueSetOf(item),
    };
}

/**
 * A QC unit owed on its own (flow.currencies[].qcItems; ShipLine 2026-10-02):
 * one _FQC line, dated from its product's container, paid when the user chooses.
 * @param {QcItem} qc
 * @param {FeedContext} ctx
 * @returns {FeedRow}
 */
function qcRow(qc, ctx) {
    const po = ctx.pos?.get(qc.poId) ?? null;
    return {
        id: itemFeedId(qc, { shipmentIdByRef: ctx.shipmentIdByRef ?? null }),
        kind: 'qc',
        status: 'open',
        supplier: clip(qc.supplier, TEXT_LIMITS.supplier),
        companyId: po?.companyId ?? null,
        poId: isId(qc.poId) ? qc.poId : null,
        poNumber: clip(qc.poNumber || null, TEXT_LIMITS.poNumber),
        shipmentId: shipmentIdOf(qc.qcProductBox, ctx.shipmentIdByRef),
        containerRef: clip(qc.qcProductBox ?? null, TEXT_LIMITS.containerRef),
        label: clip(`QC units${qc.qcCode ? ` ${qc.qcCode.replace(/_FQC$/i, '')}` : ''}`, TEXT_LIMITS.label),
        currency: qc.currency,
        amount: money(qc.amount).toFixed(2),
        dueDate: qc.dueDate ?? null,
        dateBasis: qc.dueDate == null ? 'undated' : qc.flags.includes('estimated') ? 'estimated' : 'firm',
        amountBasis: qc.basis,
        blocked: qc.blocked ?? null,
        arranged: qc.status === 'arranged',
        paidOn: null,
        settles: null,
        flags: [...qc.flags],
        dueSet: null,
    };
}

function paidRow(fact, { id, kind, poId, cents, settles, containerRef, shipmentId, label = null }, ctx) {
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
        label: clip(label, TEXT_LIMITS.label),
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
        dueSet: null,
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
 * The feed rows: every open item of the model (goods, charges, top-ups,
 * extras, QC units; a row netted to nothing by a credit is left out), then
 * every payment made.
 * @param {PaymentsFlow} flow  buildPaymentsFlow(input, { claims: true })
 * @param {PaidFact[]} paidRows  collectPaidRows(input, { paidSince })
 * @param {FeedContext} [ctx]  pos: poDirectory(input.poBundles) (plus any PO a
 *   payment names that has no bundle); shipmentIdByRef: the page's map; orders: the PO
 *   lines (input.orders), which weigh a shared box's goods by company.
 * @returns {FeedRow[]}
 */
function toForecastRows(flow, paidRows, ctx = {}) {
    ctx = { ...ctx, companiesByBox: companiesByBox(flow, ctx) };
    const rows = [];
    for (const c of flow.currencies ?? []) {
        for (const item of c.items) {
            // Never 0 in practice (the model emits nothing under a cent); JFlow refuses ≤ 0.
            // A credit that covers the whole item nets it to nothing: no row.
            if (centsOf(item.amount - creditOn(item)) > 0) rows.push(openRow(item, ctx));
        }
        for (const qc of c.qcItems ?? []) {
            if (centsOf(qc.amount) > 0) rows.push(qcRow(qc, ctx));
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
        const payId = feedId({ form: 'pay', supplierPaymentId: f.supplierPaymentId, lineKind: f.lineKind, targetId: f.targetId });
        if (f.lineKind === 'pi') {
            paid.push(paidRow(f, {
                id: payId, kind: f.paymentType === 'deposit' ? 'deposit' : 'balance', poId: f.purchaseOrderId, cents,
                settles: feedId({ form: 'pi', invoicePaymentId: f.targetId }), containerRef: null, shipmentId: null,
            }, ctx));
        } else if (f.lineKind === 'extra') {
            // An extra charge, or a forwarder's shipment cost, paid: the row it settles is ext-<id>.
            paid.push(paidRow(f, {
                id: payId, kind: 'extra', poId: f.purchaseOrderId, cents,
                settles: feedId({ form: 'ext', extraId: f.targetId }),
                containerRef: f.shipmentReference ?? null, shipmentId: f.shipmentId ?? shipmentIdOf(f.shipmentReference, ctx.shipmentIdByRef),
            }, ctx));
        } else if (f.lineKind === 'qc') {
            paid.push(paidRow(f, {
                id: payId, kind: 'qc', poId: f.purchaseOrderId, cents,
                settles: feedId({ form: 'qc', orderId: f.targetId }), containerRef: null, shipmentId: null, label: 'QC units',
            }, ctx));
        } else {
            paid.push(paidRow(f, {
                id: payId, kind: 'deposit', poId: f.targetId, cents,
                settles: feedId({ form: 'dep', poId: f.targetId }), containerRef: null, shipmentId: null,
            }, ctx));
        }
    }
    paid.sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.concat(paid);
}

module.exports = {
    TEXT_LIMITS, LINE_KINDS, shipmentIdOf, poDirectory, collectPaidRows, splitCents, formatCents, dueSetOf, rowLabel, companiesByBox, toForecastRows,
};
