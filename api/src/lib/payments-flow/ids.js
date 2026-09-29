// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London; new, not in the TS: stable JFlow feed ids (PHASE2 §3 P2)
'use strict';

// Stable feed ids for payments-flow rows — JFlow PHASE2 §3 "Ids (P2)" and
// CONTRACT §1.1 P2. Not part of the ShipLine TS: the TS's own item ids
// (`stated:<pi>[:<ctr>]`, `derived:bal:<po>:<ctr>`) carry free-text container
// refs, so they are neither key-safe nor stable. A feed id is
// [A-Za-z0-9_-]{1,64}, so JFlow's `ship.<id>` key needs no escaping.
//
//   open rows  dep-<po>                          derived deposit
//              pi-<invoicePayment>[-<g>]         a PI's own figure; -<g> when split per container
//              bal-<po>-<g>                      derived balance for one container group
//              inv-<shipmentPayment>-<po>-a|s    one PO's allocated (a) or shared (s) claim on a balance invoice
//   paid rows  pay-<supplierPayment>-pi|dep<target>        a transfer line on a PI / a PO deposit
//              pay-<supplierPayment>-bal<target>[-<po>]    a transfer line on a balance record, one row per
//                                                PO it is split to; no -<po> only when no PO claims the record
//              spd-<shipmentPayment>[-<po>]      a balance record marked paid with no transfer, split likewise
//   <g>        s<shipmentId> when the ref is spelt exactly as a shipment's
//              reference, else r<first 10 hex of sha256(trim(ref))> (case
//              kept), else n (not booked)
//
// <g> keeps case because the model does: summarizePo groups a PO's lines by
// the trimmed container ref as spelt, so "abc1" and "ABC1" are two groups and
// two balances. Step 14 upper-cased the ref (and matched a shipment through
// the upper-cased ref), which gave both the same id; from step 18 a ref only
// maps to s<id> when it equals the shipment's reference, and the hash is over
// the ref as spelt, so distinct groups always get distinct tokens. The row's
// shipmentId still follows the model's exact-then-upper-case lookup
// (forecast.js). The -<po> suffix (step 18) keeps a transfer split over
// several POs to one id per row.
//
// Ids survive date drift, amount changes, part payments and a draft becoming
// real (same shipment id). A stage change mints a new id: a PI replacing a
// derived deposit (dep- → pi-), lines getting booked (…-n → …-s<id>).
//
// At f9499bc the model emits only the dep-, pi- and bal- open forms. An open
// balance record never sets what is owed (the terms do), so it produces no
// item of its own: its PO's derived balance carries it (shipmentPaymentId,
// status pending/arranged) and keeps its bal- id. inv- is defined for
// claim-level rows but no open item maps to it.

const crypto = require('crypto');

const FEED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_RE = /^(s\d+|r[0-9a-f]{10}|n)$/;
const LINE_KIND = { balance: 'bal', pi: 'pi', po_deposit: 'dep' };
const CLAIM_SOURCE = { allocated: 'a', share: 's' };

/** @param {unknown} s @returns {boolean} */
function isFeedId(s) {
    return typeof s === 'string' && FEED_ID_RE.test(s);
}

function idPart(v, name) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`feedId: ${name} must be a positive integer (got ${JSON.stringify(v)})`);
    return String(v);
}

function groupPart(g) {
    if (typeof g !== 'string' || !GROUP_RE.test(g)) throw new TypeError(`feedId: group must be s<id>, r<10 hex> or n (got ${JSON.stringify(g)})`);
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
 * @typedef {{ form: 'dep', poId: number }
 *   | { form: 'pi', invoicePaymentId: number, group?: string|null }
 *   | { form: 'bal', poId: number, group: string }
 *   | { form: 'inv', shipmentPaymentId: number, poId: number, source: 'allocated'|'share' }
 *   | { form: 'pay', supplierPaymentId: number, lineKind: 'balance'|'pi'|'po_deposit', targetId: number, poId?: number|null }
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
        case 'pi':
            id = `pi-${idPart(parts.invoicePaymentId, 'invoicePaymentId')}${parts.group == null ? '' : `-${groupPart(parts.group)}`}`;
            break;
        case 'bal':
            id = `bal-${idPart(parts.poId, 'poId')}-${groupPart(parts.group)}`;
            break;
        case 'inv': {
            const src = CLAIM_SOURCE[parts.source];
            if (!src) throw new TypeError(`feedId: source must be allocated or share (got ${JSON.stringify(parts.source)})`);
            id = `inv-${idPart(parts.shipmentPaymentId, 'shipmentPaymentId')}-${idPart(parts.poId, 'poId')}-${src}`;
            break;
        }
        case 'pay': {
            const kind = LINE_KIND[parts.lineKind];
            if (!kind) throw new TypeError(`feedId: lineKind must be balance, pi or po_deposit (got ${JSON.stringify(parts.lineKind)})`);
            // A PI or a PO deposit is one PO's already: only a balance record is split.
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
 * The feed id of an open item (a model PaymentItem): derived deposit → dep-,
 * derived balance → bal- (with or without a balance record attached), stated
 * PI → pi-, plus -<g> when the TS split that PI over containers (its
 * 'multi_container' flag, set on exactly those items).
 * @param {import('./types').PaymentItem} item
 * @param {{ shipmentIdByRef?: Map<string, number>|null }} [ctx]
 * @returns {string}
 */
function itemFeedId(item, ctx = {}) {
    const map = ctx.shipmentIdByRef ?? null;
    if (item.basis === 'derived' && item.kind === 'deposit') return feedId({ form: 'dep', poId: item.poId });
    if (item.basis === 'derived' && item.kind === 'balance') return feedId({ form: 'bal', poId: item.poId, group: groupToken(item.containerNumber, map) });
    if (item.basis === 'stated') {
        const split = item.flags.includes('multi_container');
        return feedId({ form: 'pi', invoicePaymentId: item.paymentId, group: split ? groupToken(item.containerNumber, map) : null });
    }
    throw new TypeError(`itemFeedId: unexpected item ${item.id} (${item.basis} ${item.kind})`);
}

module.exports = {
    FEED_ID_RE, isFeedId, groupToken, feedId, itemFeedId,
};
