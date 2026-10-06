// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ 77577a1 — changes: new, not in the TS: stable JFlow feed ids (PHASE2 §3 P2) for every item kind the model emits at this pin (goods, charges, QC units, top-ups, extras, split parts in a draft or plan) and for every transfer line kind
'use strict';

// Stable feed ids for payments-flow rows — JFlow PHASE2 §3 "Ids (P2)" and
// CONTRACT §1.1 P2. Not part of the ShipLine TS: the TS's own item ids
// (`stated:<pi>[:<ctr>]`, `derived:bal:<po>:<ctr>`) carry free-text container
// refs, so they are neither key-safe nor stable. A feed id is
// [A-Za-z0-9_-]{1,64}, so JFlow's `ship.<id>` key needs no escaping.
//
//   open rows  dep-<po>                          derived deposit
//              pi-<invoicePayment>[-<g>]         a PI's own figure; -<g> when split per container
//              pi-<invoicePayment>-c<g>|f<g>     a PI's charges (c) or _FQC (f) share in one container
//              bal-<po>-<g>                      derived balance for one container group
//              chg-<po>-<g>                      the PO's charges above its lines (PI total, PO shipping), with its first box
//              fqc-<po>-<g>                      (pre-2026-10-02 form) _FQC units carried on a goods balance
//              top-<po>-<g>                      a top-up: goods added after the container was paid
//              qc-<orderId>                      a QC unit (one _FQC line), owed on its own
//              ext-<extraId>                     an extra charge or credit, or a forwarder's shipment cost
//              inv-<shipmentPayment>-<po>-a|s    one PO's allocated (a) or shared (s) claim on a balance invoice
//   paid rows  pay-<supplierPayment>-pi|dep<target>        a transfer line on a PI / a PO deposit
//              pay-<supplierPayment>-ext|qc<target>        a transfer line on an extra / a QC unit
//              pay-<supplierPayment>-bal<target>[-<po>]    a transfer line on a balance record, one row per
//                                                PO it is split to; no -<po> only when no PO claims the record
//              spd-<shipmentPayment>[-<po>]      a balance record marked paid with no transfer, split likewise
//   <g>        s<shipmentId> when the ref is spelt exactly as a shipment's
//              reference, else r<first 10 hex of sha256(trim(ref))> (case
//              kept), else n (not booked); d<shipmentId> for the part of a
//              PO's unbooked goods that sits in a DRAFT or PLANNED shipment
//              (the TS's `@open:<id>` suffix; `@none` is the rest, n)
//
// <g> keeps case because the model does: summarizePo groups a PO's lines by
// the trimmed container ref as spelt, so "abc1" and "ABC1" are two groups and
// two balances. A ref only maps to s<id> when it equals the shipment's
// reference, and the hash is over the ref as spelt, so distinct groups always
// get distinct tokens. The row's shipmentId still follows the model's
// exact-then-upper-case lookup (forecast.js). The -<po> suffix keeps a
// transfer split over several POs to one id per row.
//
// Ids survive date drift, amount changes, part payments and a draft becoming
// real (same shipment id: …-d<id> becomes …-s<id> only when the lines are
// booked, which IS a stage change). A stage change mints a new id: a PI
// replacing a derived deposit (dep- → pi-), lines getting booked (…-n or
// …-d<id> → …-s<id>), a derived balance becoming a balance record's claim.

const crypto = require('crypto');

const FEED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_RE = /^(s\d+|d\d+|r[0-9a-f]{10}|n)$/;
const LINE_KIND = { balance: 'bal', pi: 'pi', po_deposit: 'dep', extra: 'ext', qc: 'qc' };
const CLAIM_SOURCE = { allocated: 'a', share: 's' };
const OF_TOKEN = { charges: 'c', fqc: 'f' };

/** @param {unknown} s @returns {boolean} */
function isFeedId(s) {
    return typeof s === 'string' && FEED_ID_RE.test(s);
}

function idPart(v, name) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`feedId: ${name} must be a positive integer (got ${JSON.stringify(v)})`);
    return String(v);
}

function groupPart(g) {
    if (typeof g !== 'string' || !GROUP_RE.test(g)) throw new TypeError(`feedId: group must be s<id>, d<id>, r<10 hex> or n (got ${JSON.stringify(g)})`);
    return g;
}

/**
 * <g> for a container ref, from the trimmed ref exactly as spelt — the key
 * the model groups a PO's lines by. s<id> when `shipmentIdByRef` (reference →
 * shipments.id, e.g. PaymentsFlowView's shipmentIdByRef) has the ref as
 * spelt; otherwise a hash of the ref as spelt; n when blank.
 * @param {string|null|undefined} ref
 * @param {Map<string, number>|null} [shipmentIdByRef]
 * @returns {string}
 */
function groupToken(ref, shipmentIdByRef) {
    const r = ref == null ? '' : String(ref).trim();
    if (!r) return 'n';
    const id = shipmentIdByRef ? shipmentIdByRef.get(r) : undefined;
    if (id != null) return `s${idPart(id, 'shipmentId')}`;
    return 'r' + crypto.createHash('sha256').update(r, 'utf8').digest('hex').slice(0, 10);
}

/**
 * <g> for the TS's split-part key on an unbooked row: `open:<shipmentId>` (the
 * goods sitting in that draft or plan) → d<id>; `none` (the rest) → n.
 * @param {string} partKey
 * @returns {string}
 */
function partToken(partKey) {
    const m = /^open:(\d+)$/.exec(partKey);
    if (m) return `d${idPart(Number(m[1]), 'openShipmentId')}`;
    if (partKey === 'none') return 'n';
    throw new TypeError(`feedId: unknown split part ${JSON.stringify(partKey)}`);
}

/**
 * @typedef {{ form: 'dep', poId: number }
 *   | { form: 'pi', invoicePaymentId: number, group?: string|null, of?: 'charges'|'fqc'|null }
 *   | { form: 'bal'|'chg'|'fqc'|'top', poId: number, group: string }
 *   | { form: 'qc', orderId: number }
 *   | { form: 'ext', extraId: number }
 *   | { form: 'inv', shipmentPaymentId: number, poId: number, source: 'allocated'|'share' }
 *   | { form: 'pay', supplierPaymentId: number, lineKind: 'balance'|'pi'|'po_deposit'|'extra'|'qc', targetId: number, poId?: number|null }
 *   | { form: 'spd', shipmentPaymentId: number, poId?: number|null }} FeedIdParts
 * `poId` on pay (lineKind 'balance' only) and spd: the PO a split row is for.
 */

/**
 * The feed id for one row. Throws a TypeError rather than build an id from
 * bad parts.
 * @param {FeedIdParts} parts
 * @returns {string}
 */
function feedId(parts) {
    let id;
    switch (parts?.form) {
        case 'dep':
            id = `dep-${idPart(parts.poId, 'poId')}`;
            break;
        case 'pi': {
            const of = parts.of == null ? '' : OF_TOKEN[parts.of];
            if (of === undefined) throw new TypeError(`feedId: of must be charges or fqc (got ${JSON.stringify(parts.of)})`);
            if (of && parts.group == null) throw new TypeError('feedId: a PI charges / fqc row needs its group');
            id = `pi-${idPart(parts.invoicePaymentId, 'invoicePaymentId')}${parts.group == null ? '' : `-${of}${groupPart(parts.group)}`}`;
            break;
        }
        case 'bal':
        case 'chg':
        case 'fqc':
        case 'top':
            id = `${parts.form}-${idPart(parts.poId, 'poId')}-${groupPart(parts.group)}`;
            break;
        case 'qc':
            id = `qc-${idPart(parts.orderId, 'orderId')}`;
            break;
        case 'ext':
            id = `ext-${idPart(parts.extraId, 'extraId')}`;
            break;
        case 'inv': {
            const src = CLAIM_SOURCE[parts.source];
            if (!src) throw new TypeError(`feedId: source must be allocated or share (got ${JSON.stringify(parts.source)})`);
            id = `inv-${idPart(parts.shipmentPaymentId, 'shipmentPaymentId')}-${idPart(parts.poId, 'poId')}-${src}`;
            break;
        }
        case 'pay': {
            const kind = LINE_KIND[parts.lineKind];
            if (!kind) throw new TypeError(`feedId: lineKind must be balance, pi, po_deposit, extra or qc (got ${JSON.stringify(parts.lineKind)})`);
            // A PI, a PO deposit, an extra or a QC unit is one PO's already: only a balance record is split.
            if (parts.poId != null && parts.lineKind !== 'balance') throw new TypeError(`feedId: only a balance line is split per PO (got poId on ${parts.lineKind})`);
            id = `pay-${idPart(parts.supplierPaymentId, 'supplierPaymentId')}-${kind}${idPart(parts.targetId, 'targetId')}${parts.poId == null ? '' : `-${idPart(parts.poId, 'poId')}`}`;
            break;
        }
        case 'spd':
            id = `spd-${idPart(parts.shipmentPaymentId, 'shipmentPaymentId')}${parts.poId == null ? '' : `-${idPart(parts.poId, 'poId')}`}`;
            break;
        default:
            throw new TypeError(`feedId: unknown form ${JSON.stringify(parts?.form)}`);
    }
    if (!FEED_ID_RE.test(id)) throw new TypeError(`feedId: ${id} is not [A-Za-z0-9_-]{1,64}`);
    return id;
}

/**
 * The TS's item id, taken apart. Forms at 77577a1 (summarizePo, buildPaymentsFlow):
 *   derived:dep:<po>
 *   derived:<bal|charges|fqc|topup>:<po>:<box|none>[@<part>]
 *   stated:<pi>[@<part>]
 *   stated:<pi>:[<charges|fqc>:]<box|none>[@<part>]
 *   extra:<id>
 *   qc:<orderId>
 * A box ref is free text (it may hold ':'), so the box is everything after the
 * PO / PI (and the `of` word) up to the last '@'; a part key is `open:<id>` or
 * `none`.
 * @param {string} id
 * @returns {{ basis: 'derived'|'stated'|'extra'|'qc', of: string|null, n: number, box: string|null, part: string|null }}
 */
function parseTsId(id) {
    const s = String(id);
    const at = s.lastIndexOf('@');
    const part = at === -1 ? null : s.slice(at + 1);
    const head = at === -1 ? s : s.slice(0, at);
    let m = /^derived:(dep|bal|charges|fqc|topup):(\d+)(?::(.*))?$/s.exec(head);
    if (m) return { basis: 'derived', of: m[1], n: Number(m[2]), box: m[3] ?? null, part };
    m = /^stated:(\d+)(?::(.*))?$/s.exec(head);
    if (m) {
        let rest = m[2] ?? null;
        let of = null;
        const ofm = rest == null ? null : /^(charges|fqc):(.*)$/s.exec(rest);
        if (ofm) { of = ofm[1]; rest = ofm[2]; }
        return { basis: 'stated', of, n: Number(m[1]), box: rest, part };
    }
    m = /^extra:(\d+)$/.exec(head);
    if (m) return { basis: 'extra', of: null, n: Number(m[1]), box: null, part };
    m = /^qc:(\d+)$/.exec(head);
    if (m) return { basis: 'qc', of: null, n: Number(m[1]), box: null, part };
    throw new TypeError(`itemFeedId: unexpected item id ${JSON.stringify(id)}`);
}

/** <g> for a parsed TS id: the split part when there is one, else the box as the model groups it. */
function groupOf(parsed, map) {
    if (parsed.part != null) return partToken(parsed.part);
    if (parsed.box == null || parsed.box === 'none') return 'n';
    return groupToken(parsed.box, map);
}

/**
 * The feed id of an open item (a model PaymentItem or QcItem). Derived deposit →
 * dep-; derived balance → bal- (with or without a balance record attached);
 * the PO's charges row → chg-; a top-up → top-; a stated PI → pi-, plus -<g>
 * when the TS split that PI over containers or parts, with c/f for its
 * charges / fqc share; an extra → ext-; a QC unit → qc-.
 * @param {import('./types').PaymentItem | import('./types').QcItem} item
 * @param {{ shipmentIdByRef?: Map<string, number>|null }} [ctx]
 * @returns {string}
 */
function itemFeedId(item, ctx = {}) {
    const map = ctx.shipmentIdByRef ?? null;
    const p = parseTsId(item.id);
    switch (p.basis) {
        case 'extra':
            return feedId({ form: 'ext', extraId: p.n });
        case 'qc':
            return feedId({ form: 'qc', orderId: p.n });
        case 'derived':
            if (p.of === 'dep') return feedId({ form: 'dep', poId: p.n });
            return feedId({ form: p.of === 'bal' ? 'bal' : p.of === 'charges' ? 'chg' : p.of === 'fqc' ? 'fqc' : 'top', poId: p.n, group: groupOf(p, map) });
        case 'stated': {
            // `stated:<pi>` alone keeps its bare id; anything more (a box, a part, an `of`) joins -<g>.
            const split = p.box != null || p.part != null;
            return feedId({ form: 'pi', invoicePaymentId: p.n, group: split ? groupOf(p, map) : null, of: p.of });
        }
        default:
            throw new TypeError(`itemFeedId: unexpected item ${item.id}`);
    }
}

module.exports = {
    FEED_ID_RE, isFeedId, groupToken, partToken, parseTsId, feedId, itemFeedId,
};
