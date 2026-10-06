// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London; buildPaymentsFlow(input, {claims: true}) also returns balanceClaims (JFlow feed; without the option the output is the TS's); input.dueOverrides applied before the owed-air pass and owed air with a set date stays put (both from the TS @ 6565188, ported ahead of the re-pin — ./overrides.js; without rows nothing changes)
'use strict';

// Whole-model assembly: buildPaymentsFlow. Resolves balance invoices into
// per-PO claims, runs every PO, dates owed air freight, and rolls up per
// currency. Deliberate differences from the TS: today is required; and one
// opt-in addition (JFlow PHASE2 step 18) — options.claims adds
// `balanceClaims`, the per-PO claims every balance record resolved to, which
// the JFlow feed splits paid balances by. Without the option the output is
// exactly the TS's (api/test/unit/payments-flow-golden.test.js).
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

const { dateOf, addDays } = require('./dates');
const { lineValueOf } = require('./lines');
const { EPS, money } = require('./money');
const { parsePaymentTerms } = require('./terms');
const { normName, looseName, indexSuppliersByName, matchSupplier } = require('./suppliers');
const { canonicalizeRules, resolvePolicy } = require('./policy');
const { summarizePo } = require('./po');
const { applyDueOverrides } = require('./overrides');

/** Display order for currency tabs; anything else follows alphabetically. */
const CURRENCY_ORDER = ['USD', 'EUR', 'GBP', 'CNY', 'HKD', 'SGD'];

const DQ_ORDER = [
    'overpaid', 'air_missed', 'unvalued', 'air_unpriced', 'terms_unclear', 'currency_mismatch', 'shipment_payment_currency',
    'extraction_failed', 'shipment_payment_mismatch', 'invoice_no_payment', 'paid_no_amount',
    'duplicate_stated', 'stale_status', 'terms_partial', 'shipment_payment_unallocated',
    'unpriced_lines', 'total_mismatch', 'type_unknown', 'air_no_next', 'proof_assumed_paid',
];

function sortItems(items) {
    return [...items].sort((a, b) => {
        if (a.dueDate !== b.dueDate) {
            if (a.dueDate == null)
                return 1;
            if (b.dueDate == null)
                return -1;
            return a.dueDate.localeCompare(b.dueDate);
        }
        if (a.amount !== b.amount)
            return b.amount - a.amount;
        return a.poNumber.localeCompare(b.poNumber, undefined, { numeric: true });
    });
}

function currencyRank(c) {
    const i = CURRENCY_ORDER.indexOf(c);
    return i === -1 ? CURRENCY_ORDER.length : i;
}

/**
 * The whole model: every PO's open payments, per currency, as of `today`.
 * `today` is required ('YYYY-MM-DD', or a datetime read as its date): the TS
 * fell back to the host clock (localTodayYmd) when it was absent; the port
 * throws instead, so a server never computes "today" in the wrong zone.
 * `options.claims` (port addition, not in the TS): also return
 * `balanceClaims` — see types.js BalanceClaim.
 * @param {import('./types').PaymentsFlowInput} input
 * @param {{ claims?: boolean }} [options]
 * @returns {import('./types').PaymentsFlow}
 */
function buildPaymentsFlow(input, options) {
    const today = dateOf(input.today);
    if (today == null) throw new TypeError(`buildPaymentsFlow: input.today is required as 'YYYY-MM-DD' (got ${JSON.stringify(input.today)})`);
    const supplierByName = indexSuppliersByName(input.suppliers);
    // PO supplier name → JFPRO supplier, memoised (legacy POs use short aliases).
    const matches = new Map();
    const supplierFor = (name) => {
        const k = normName(name);
        if (!k)
            return null;
        if (!matches.has(k))
            matches.set(k, matchSupplier(name, supplierByName, input.suppliers));
        return matches.get(k);
    };
    const supplierRules = new Map();
    const supplierRuleFor = (name) => {
        const k = normName(name);
        if (!k)
            return null;
        if (!supplierRules.has(k)) {
            const s = supplierFor(name)?.supplier;
            if (!s)
                return null;
            supplierRules.set(k, { ...parsePaymentTerms(s.paymentTerms), source: 'supplier' });
        }
        return supplierRules.get(k);
    };
    const byId = new Map();
    const byNumber = new Map();
    for (const [k, b] of Object.entries(input.poBundles ?? {})) {
        if (!b)
            continue;
        const id = Number.isFinite(b.id) ? b.id : Number(k);
        byId.set(id, b);
        if (b.poNumber)
            byNumber.set(normName(b.poNumber), b);
    }
    const linesByPo = new Map();
    for (const o of input.orders) {
        let b = o.purchaseOrderId != null ? byId.get(o.purchaseOrderId) : undefined;
        if (!b && o.poNumber)
            b = byNumber.get(normName(o.poNumber));
        if (!b)
            continue;
        if (!linesByPo.has(b.id))
            linesByPo.set(b.id, []);
        linesByPo.get(b.id).push(o);
    }
    const paymentsByPo = new Map();
    for (const p of input.invoicePayments ?? []) {
        if (!paymentsByPo.has(p.purchaseOrderId))
            paymentsByPo.set(p.purchaseOrderId, []);
        paymentsByPo.get(p.purchaseOrderId).push(p);
    }
    // Rules saved under an alias / legacy name also apply to the native record.
    const rules = canonicalizeRules(input.rules, supplierByName, input.suppliers);
    // ── Balance invoices → per-PO claims ─────────────────────────────────
    // A record says "this supplier billed X for shipment 311". This model works
    // per PO per container, and splitting an unallocated invoice across that
    // supplier's POs in the box needs to see all of them at once — which
    // summarizePo, seeing one PO, cannot. So the resolution happens here.
    const canonicalSupplier = (name) => {
        const raw = (name ?? '').trim();
        const m = supplierFor(raw || null);
        return m && m.how !== 'legacy' ? m.supplier.name : raw;
    };
    const payableKey = (ref, supplier) => `${(ref ?? '').trim().toUpperCase()}|${looseName(canonicalSupplier(supplier))}`;
    // What each PO has in each container, and which (container, supplier) pairs
    // its POs answer to.
    const poBoxes = new Map();
    const posByPayable = new Map();
    for (const [poId, lines] of linesByPo) {
        const bundle = byId.get(poId);
        const supplierName = (bundle.supplier ?? lines.find(l => l.supplier)?.supplier ?? '').trim() || null;
        const byRef = new Map();
        for (const o of lines) {
            const ref = o.containerNumber?.trim();
            if (!ref)
                continue;
            const k = ref.toUpperCase();
            if (!byRef.has(k))
                byRef.set(k, { value: 0, units: 0, unpriced: false });
            const g = byRef.get(k);
            const v = lineValueOf(o);
            if (v == null)
                g.unpriced = true;
            else
                g.value += v;
            g.units += o.quantity || 0;
        }
        const boxes = new Set();
        for (const [k, g] of byRef) {
            boxes.add(k);
            const key = `${k}|${looseName(canonicalSupplier(supplierName))}`;
            if (!posByPayable.has(key))
                posByPayable.set(key, []);
            posByPayable.get(key).push({ poId, ...g });
        }
        poBoxes.set(poId, boxes);
    }
    // What transfers have applied to each obligation. A balance still open with
    // money applied splits into a settled part and what is left; a PI likewise
    // (inside summarizePo); a deposit paid on a PO with no PI is a stated fact.
    const appliedToBalance = new Map();
    const appliedToPiByPo = new Map();
    const depositPaidByPo = new Map();
    for (const sp of input.supplierPayments ?? []) {
        for (const l of sp.lines ?? []) {
            if (l.kind === 'balance') {
                appliedToBalance.set(l.targetId, money((appliedToBalance.get(l.targetId) ?? 0) + l.amount));
            }
            else if (l.kind === 'pi' && l.purchaseOrderId != null) {
                if (!appliedToPiByPo.has(l.purchaseOrderId))
                    appliedToPiByPo.set(l.purchaseOrderId, new Map());
                const m = appliedToPiByPo.get(l.purchaseOrderId);
                m.set(l.targetId, money((m.get(l.targetId) ?? 0) + l.amount));
            }
            else if (l.kind === 'po_deposit') {
                const prev = depositPaidByPo.get(l.targetId);
                const paidOn = dateOf(sp.paidOn);
                depositPaidByPo.set(l.targetId, {
                    amount: money((prev?.amount ?? 0) + l.amount),
                    paidOn: prev?.paidOn && paidOn ? (prev.paidOn < paidOn ? prev.paidOn : paidOn) : (prev?.paidOn ?? paidOn),
                });
            }
        }
    }
    const claimsByPo = new Map();
    // Port addition: each claim as resolved, before a part payment splits it
    // (options.claims only).
    const balanceClaims = [];
    const addClaim = (poId, claim) => {
        balanceClaims.push({ shipmentPaymentId: claim.payment.id, poId, containerNumber: claim.containerNumber, source: claim.source, amount: claim.amount });
        if (!claimsByPo.has(poId))
            claimsByPo.set(poId, []);
        const list = claimsByPo.get(poId);
        const p = claim.payment;
        const open = p.status === 'pending' || p.status === 'arranged';
        const applied = open ? Math.min(appliedToBalance.get(p.id) ?? 0, Number(p.amount) || 0) : 0;
        const total = Number(p.amount) || 0;
        if (!open || applied < EPS || total < EPS) {
            list.push(claim);
            return;
        }
        // Part paid: the covered share of this claim counts as paid money, the
        // rest is still asked for.
        const fraction = Math.min(1, applied / total);
        const settledAmount = money(claim.amount * fraction);
        const left = money(claim.amount - settledAmount);
        if (settledAmount > EPS)
            list.push({ ...claim, amount: settledAmount, settled: true });
        if (left > EPS)
            list.push({ ...claim, amount: left, partlyPaid: true });
    };
    // Issues that belong to a PO but are discovered here, materialised in the PO
    // loop below where the currency is known.
    const recordIssues = new Map();
    const addRecordIssue = (poId, kind, detail, amount, shipmentReference) => {
        if (!recordIssues.has(poId))
            recordIssues.set(poId, []);
        recordIssues.get(poId).push({ kind, detail, amount, shipmentReference });
    };
    // Records pointing at goods this model knows nothing about.
    const orphanIssues = [];
    const paymentsByPayable = new Map();
    const documentsByPayable = new Map();
    for (const payment of input.shipmentPayments ?? []) {
        const ref = (payment.shipmentReference ?? '').trim();
        if (!ref)
            continue;
        const key = payableKey(ref, payment.supplierName);
        if (!paymentsByPayable.has(key))
            paymentsByPayable.set(key, []);
        paymentsByPayable.get(key).push(payment);
        // A skipped record is filed, not owed.
        if (payment.status === 'skipped')
            continue;
        const refKey = ref.toUpperCase();
        const amount = money(Number(payment.amount) || 0);
        if (amount < EPS)
            continue;
        const currency = (payment.currency || 'USD').toUpperCase();
        let allocatedHere = 0;
        for (const a of payment.allocations ?? []) {
            if (a.purchaseOrderId == null)
                continue;
            const boxes = poBoxes.get(a.purchaseOrderId);
            if (!boxes || !boxes.has(refKey)) {
                // Money attributed to a purchase order with nothing in this box.
                orphanIssues.push({
                    kind: 'shipment_payment_mismatch', poId: 0, poNumber: a.poNumber ?? a.poRef ?? '—',
                    supplier: payment.supplierName, currency, shipmentReference: ref,
                    detail: `${money(a.amount).toLocaleString('en-GB')} on the ${ref} invoice is attributed to ${a.poNumber ?? a.poRef ?? 'a purchase order'}, which has no lines in that container`,
                    amount: money(a.amount),
                });
                continue;
            }
            if (a.amount < EPS)
                continue;
            addClaim(a.purchaseOrderId, { payment, containerNumber: ref, amount: money(a.amount), source: 'allocated' });
            allocatedHere = money(allocatedHere + a.amount);
        }
        const remainder = money(amount - allocatedHere);
        if (remainder > EPS) {
            const pool = posByPayable.get(key) ?? [];
            if (!pool.length) {
                orphanIssues.push({
                    kind: 'shipment_payment_unallocated', poId: 0, poNumber: '—',
                    supplier: payment.supplierName, currency, shipmentReference: ref,
                    detail: `${money(remainder).toLocaleString('en-GB')} invoiced for ${ref}, but no purchase order for this supplier has lines in that container`,
                    amount: money(remainder),
                });
            }
            else {
                // The invoice covers every line in the box, so an unpriced line must
                // still carry its part — and value cannot be weighed against units.
                // One basis for the whole box: value when every line is priced, else
                // quantity for everyone.
                const byQty = pool.some(x => x.unpriced);
                const weightOf = (x) => (byQty ? x.units : x.value);
                const total = pool.reduce((a, x) => a + weightOf(x), 0);
                for (const po of pool) {
                    const share = total > 0 ? remainder * weightOf(po) / total : remainder / pool.length;
                    if (share < EPS)
                        continue;
                    addClaim(po.poId, { payment, containerNumber: ref, amount: money(share), source: 'share' });
                }
                const basis = byQty ? 'by quantity (some lines have no unit price)' : 'by value';
                if (allocatedHere > EPS || (payment.allocations ?? []).length) {
                    addRecordIssue(pool[0].poId, 'shipment_payment_unallocated', `${money(remainder).toLocaleString('en-GB')} of the ${ref} invoice names no purchase order — shared out ${basis} by what each has on board`, money(remainder), ref);
                }
                else if (pool.length > 1) {
                    addRecordIssue(pool[0].poId, 'shipment_payment_unallocated', `The ${ref} invoice names no purchase order — shared across ${pool.length} POs ${basis} by what each has on board`, money(remainder), ref);
                }
            }
        }
        else if (remainder < -EPS) {
            orphanIssues.push({
                kind: 'shipment_payment_mismatch', poId: 0, poNumber: '—',
                supplier: payment.supplierName, currency, shipmentReference: ref,
                detail: `The split of the ${ref} invoice adds up to ${money(allocatedHere).toLocaleString('en-GB')}, more than the ${money(amount).toLocaleString('en-GB')} invoiced`,
                amount: money(-remainder),
            });
        }
    }
    for (const doc of input.shipmentPaymentDocuments ?? []) {
        const ref = (doc.shipmentReference ?? '').trim();
        if (!ref)
            continue;
        const key = payableKey(ref, doc.supplierName);
        if (!documentsByPayable.has(key))
            documentsByPayable.set(key, []);
        documentsByPayable.get(key).push(doc);
        if (doc.extractStatus !== 'failed')
            continue;
        orphanIssues.push({
            kind: 'extraction_failed', poId: 0, poNumber: '—',
            supplier: doc.supplierName, currency: 'USD', shipmentReference: ref,
            detail: `${doc.filename} for ${ref} could not be read${doc.extractError ? `: ${doc.extractError}` : ''} — re-run it or record the figures by hand`,
            amount: null,
        });
    }
    const issuesByCurrency = new Map();
    const summariesByCurrency = new Map();
    let poCount = 0;
    for (const [poId, lines] of linesByPo) {
        const bundle = byId.get(poId);
        poCount++;
        lines.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
        const supplierName = (bundle.supplier ?? lines.find(l => l.supplier)?.supplier ?? '').trim() || null;
        const match = supplierFor(supplierName);
        const supplierTerms = match?.supplier.paymentTerms ?? null;
        const policy = resolvePolicy(rules, [supplierName, match?.supplier.name]);
        const issues = [];
        const s = summarizePo({
            bundle, lines, payments: paymentsByPo.get(poId) ?? [], supplierTerms, supplierMatch: match,
            containerIndex: input.containerIndex, policy, containerEvents: input.containerEvents,
            shipmentClaims: claimsByPo.get(poId) ?? [], today, issues,
            appliedToPi: appliedToPiByPo.get(poId),
            depositPaidByPayment: depositPaidByPo.get(poId) ?? null,
        });
        if (s && match?.how === 'alias')
            s.rule.notes = [...s.rule.notes, `supplier_alias:${match.supplier.name}`];
        if (!s) {
            // The PO settled, but paying a balance invoice AND the PO-level PI for
            // the same goods is still worth saying out loud — and so is owed air
            // freight whose amount is unknown (it produced no item, so no PO row).
            for (const i of issues.filter(x => x.kind === 'overpaid' || x.kind === 'air_unpriced')) {
                if (!summariesByCurrency.has(i.currency)) {
                    summariesByCurrency.set(i.currency, []);
                    issuesByCurrency.set(i.currency, []);
                }
                issuesByCurrency.get(i.currency).push(i);
            }
            continue;
        }
        for (const r of recordIssues.get(poId) ?? []) {
            issues.push({ kind: r.kind, poId: s.poId, poNumber: s.poNumber, supplier: s.supplier, currency: s.currency, detail: r.detail, amount: r.amount, shipmentReference: r.shipmentReference });
        }
        if (!summariesByCurrency.has(s.currency)) {
            summariesByCurrency.set(s.currency, []);
            issuesByCurrency.set(s.currency, []);
        }
        summariesByCurrency.get(s.currency).push(s);
        // Issues only matter while money is still in play for the PO.
        if (s.items.length || s.excluded == null)
            issuesByCurrency.get(s.currency).push(...issues);
    }
    // ── Due dates set by hand (TS @ 6565188; ./overrides.js) ─────────────
    // A date someone gave a payment, or one row of it, replaces the derived
    // one before anything downstream reads it. No rows → nothing changes.
    const dueByKey = new Map();
    for (const d of input.dueOverrides ?? []) dueByKey.set(d.key, d);
    for (const pos of summariesByCurrency.values()) for (const p of pos) applyDueOverrides(p.items, dueByKey);
    // ── Owed air freight: when it will actually go ───────────────────────
    // It is paid with the supplier's next transfer — the next dated payment to
    // them in the same currency — but never later than the rule's limit after
    // delivery. A transfer to that supplier recorded after the delivery that
    // left it out means it was missed: due that day. The operator can still
    // pay it on its own or with anything else; this only dates the forecast.
    const balanceRefById = new Map();
    for (const p of input.shipmentPayments ?? [])
        balanceRefById.set(p.id, (p.shipmentReference ?? '').trim().toUpperCase());
    for (const [currency, pos] of summariesByCurrency) {
        const all = pos.flatMap(p => p.items);
        const transfers = (input.supplierPayments ?? []).filter(sp => (sp.currency || 'USD').toUpperCase() === currency);
        for (const it of all) {
            // A date set by hand keeps owed air where it was put (TS @ 6565188).
            if (!it.flags.includes('air_owed') || !it.deliveredOn || !it.airLimitDate || it.dueOverride)
                continue;
            const sup = looseName(it.supplier);
            const ref = (it.containerNumber ?? '').trim().toUpperCase();
            const paysThisBox = (sp) => (sp.lines ?? []).some(l => l.kind === 'balance'
                && ((l.shipmentReference ?? '').trim().toUpperCase() === ref || balanceRefById.get(l.targetId) === ref));
            const missedOn = transfers
                .filter(sp => looseName(canonicalSupplier(sp.supplierName)) === sup && !paysThisBox(sp))
                .map(sp => dateOf(sp.paidOn))
                .filter((d) => d != null && d >= it.deliveredOn)
                .sort()[0] ?? null;
            const next = all
                .filter(x => x !== it && !x.flags.includes('air_owed') && looseName(x.supplier) === sup && x.dueDate != null && x.dueDate >= today)
                .map(x => x.dueDate)
                .sort()[0] ?? null;
            const flags = new Set(it.flags);
            let due = it.airLimitDate;
            const issueBase = { poId: it.poId, poNumber: it.poNumber, supplier: it.supplier, currency, amount: it.amount, shipmentReference: it.containerNumber };
            if (missedOn) {
                if (missedOn < due)
                    due = missedOn;
                flags.add('air_missed');
                issuesByCurrency.get(currency).push({ ...issueBase, kind: 'air_missed', detail: `Air freight ${it.containerNumber} (delivered ${it.deliveredOn}) was left out of the ${missedOn} transfer to ${it.supplier ?? 'the supplier'} — pay it now` });
            }
            else if (next && next < due) {
                due = next;
                flags.add('air_rides_next');
            }
            else if (!next) {
                issuesByCurrency.get(currency).push({ ...issueBase, kind: 'air_no_next', detail: `Air freight ${it.containerNumber} (delivered ${it.deliveredOn}): no other payment to ${it.supplier ?? 'the supplier'} coming up — due by ${it.airLimitDate}` });
            }
            it.dueDate = due;
            it.contractualDate = due;
            it.flags = [...flags];
        }
    }
    for (const orphan of orphanIssues) {
        const cur = orphan.currency;
        if (!summariesByCurrency.has(cur)) {
            summariesByCurrency.set(cur, []);
            issuesByCurrency.set(cur, []);
        }
        issuesByCurrency.get(cur).push(orphan);
    }
    const in7 = addDays(today, 7);
    const in30 = addDays(today, 30);
    const currencies = [...summariesByCurrency.keys()]
        .sort((a, b) => currencyRank(a) - currencyRank(b) || a.localeCompare(b))
        .map(currency => {
        const pos = summariesByCurrency.get(currency);
        const items = sortItems(pos.flatMap(p => p.items));
        const kpis = { overdue: 0, due7: 0, due30: 0, unscheduled: 0, outstanding: 0, later: 0, notPayable: 0, overdueCount: 0, itemCount: items.length };
        for (const it of items) {
            kpis.outstanding += it.amount;
            if (it.blocked)
                kpis.notPayable += it.amount;
            if (it.dueDate == null)
                kpis.unscheduled += it.amount;
            else if (it.dueDate < today) {
                kpis.overdue += it.amount;
                kpis.overdueCount++;
            }
            else {
                if (it.dueDate <= in7)
                    kpis.due7 += it.amount;
                if (it.dueDate <= in30)
                    kpis.due30 += it.amount;
                else
                    kpis.later += it.amount;
            }
        }
        for (const k of Object.keys(kpis))
            kpis[k] = k.endsWith('Count') ? kpis[k] : money(kpis[k]);
        // By supplier
        const supMap = new Map();
        for (const p of pos) {
            const key = p.supplier ?? '(no supplier)';
            if (!supMap.has(key)) {
                supMap.set(key, {
                    supplier: key, currency, outstanding: 0, overdue: 0, due30: 0, unscheduled: 0, paid: 0, assumedPaid: 0, poCount: 0, itemCount: 0,
                    nextDue: null, supplierRule: supplierRuleFor(p.supplierRaw), supplierTerms: supplierFor(p.supplierRaw)?.supplier.paymentTerms ?? null,
                    jfproName: null,
                    matchHow: supplierFor(p.supplierRaw)?.how ?? null,
                    aliases: [],
                });
            }
            const r = supMap.get(key);
            if (p.supplierRaw && p.supplierRaw !== key && !r.aliases.includes(p.supplierRaw))
                r.aliases.push(p.supplierRaw);
            r.poCount++;
            r.paid += p.paid;
            r.assumedPaid += p.assumedPaid;
            for (const it of p.items) {
                r.outstanding += it.amount;
                r.itemCount++;
                if (it.dueDate == null)
                    r.unscheduled += it.amount;
                else if (it.dueDate < today)
                    r.overdue += it.amount;
                else if (it.dueDate <= in30)
                    r.due30 += it.amount;
                if (it.dueDate && (!r.nextDue || it.dueDate < r.nextDue))
                    r.nextDue = it.dueDate;
            }
        }
        const bySupplier = [...supMap.values()]
            .map(r => ({ ...r, outstanding: money(r.outstanding), overdue: money(r.overdue), due30: money(r.due30), unscheduled: money(r.unscheduled), paid: money(r.paid), assumedPaid: money(r.assumedPaid) }))
            .sort((a, b) => b.outstanding - a.outstanding || a.supplier.localeCompare(b.supplier));
        // By container (balance items only; deposits are PO-level). Lines not
        // booked into a container are not a container: they sit under
        // "not payable yet" in the view, keyed by supplier.
        const ctrMap = new Map();
        const shareByKey = new Map();
        for (const p of pos)
            for (const c of p.containers)
                shareByKey.set(`${p.poId}:${c.containerNumber ?? ''}`, c);
        for (const it of items) {
            if (it.kind !== 'balance' || it.blocked)
                continue;
            const key = it.containerNumber;
            if (!ctrMap.has(key))
                ctrMap.set(key, { containerNumber: key, currency, amount: 0, dueDate: null, etd: null, eta: null, landed: false, departed: false, estimated: false, poNumbers: [], itemCount: 0, payables: [] });
            const c = ctrMap.get(key);
            c.amount += it.amount;
            c.itemCount++;
            if (it.dueDate && (!c.dueDate || it.dueDate < c.dueDate))
                c.dueDate = it.dueDate;
            if (!c.poNumbers.includes(it.poNumber))
                c.poNumbers.push(it.poNumber);
            if (it.flags.includes('estimated'))
                c.estimated = true;
            const share = shareByKey.get(`${it.poId}:${key ?? ''}`);
            if (share) {
                c.landed = c.landed || share.landed;
                c.departed = c.departed || share.departed;
                if (share.etd && (!c.etd || share.etd < c.etd))
                    c.etd = share.etd;
                if (share.eta && (!c.eta || share.eta > c.eta))
                    c.eta = share.eta;
            }
            const supKey = it.supplier ?? '(no supplier)';
            let pay = c.payables.find(x => x.supplier === supKey);
            if (!pay) {
                pay = { supplier: supKey, amount: 0, dueDate: null, poNumbers: [], items: [], payments: [], documents: [] };
                c.payables.push(pay);
            }
            pay.amount += it.amount;
            pay.items.push(it);
            if (it.dueDate && (!pay.dueDate || it.dueDate < pay.dueDate))
                pay.dueDate = it.dueDate;
            if (!pay.poNumbers.includes(it.poNumber))
                pay.poNumbers.push(it.poNumber);
        }
        // Attach the records to the payables the items produced, then add a
        // payable for every record that produced none: a paid balance stays
        // visible as settled (so a wrong flip can be corrected) and an upload
        // still being read shows up straight away.
        for (const c of ctrMap.values()) {
            for (const pay of c.payables) {
                const key = `${(c.containerNumber ?? '').toUpperCase()}|${looseName(pay.supplier)}`;
                pay.payments = (paymentsByPayable.get(key) ?? []).filter(x => (x.currency || 'USD').toUpperCase() === currency);
                pay.documents = documentsByPayable.get(key) ?? [];
            }
        }
        const seenPayable = new Set();
        for (const c of ctrMap.values()) {
            for (const pay of c.payables)
                seenPayable.add(`${(c.containerNumber ?? '').toUpperCase()}|${looseName(pay.supplier)}`);
        }
        for (const [key, records] of paymentsByPayable) {
            if (seenPayable.has(key))
                continue;
            const inCurrency = records.filter(x => (x.currency || 'USD').toUpperCase() === currency);
            if (!inCurrency.length)
                continue;
            const ref = inCurrency[0].shipmentReference;
            const supplierName = canonicalSupplier(inCurrency[0].supplierName);
            if (!ctrMap.has(ref)) {
                const anyShare = [...shareByKey.entries()].find(([k]) => k.endsWith(`:${ref}`))?.[1];
                ctrMap.set(ref, {
                    containerNumber: ref, currency, amount: 0, dueDate: null,
                    etd: anyShare?.etd ?? null, eta: anyShare?.eta ?? null,
                    landed: anyShare?.landed ?? false, departed: anyShare?.departed ?? false,
                    estimated: false, poNumbers: [], itemCount: 0, payables: [],
                });
            }
            const c = ctrMap.get(ref);
            c.payables.push({
                supplier: supplierName, amount: 0, dueDate: null, poNumbers: [], items: [],
                payments: inCurrency, documents: documentsByPayable.get(key) ?? [],
            });
        }
        // A document with no record at all (extraction running or failed) still
        // belongs on its container, so the upload is visible immediately.
        for (const [key, docs] of documentsByPayable) {
            if (seenPayable.has(key) || paymentsByPayable.has(key))
                continue;
            const ref = docs[0].shipmentReference;
            const supplierName = canonicalSupplier(docs[0].supplierName);
            if (!supplierName)
                continue;
            const anyShare = [...shareByKey.entries()].find(([k]) => k.endsWith(`:${ref}`))?.[1];
            // Only on containers this currency's POs actually travel in, so an
            // upload does not sprout a payable under every currency tab.
            if (!ctrMap.has(ref) && !anyShare)
                continue;
            if (!ctrMap.has(ref)) {
                ctrMap.set(ref, {
                    containerNumber: ref, currency, amount: 0, dueDate: null,
                    etd: anyShare?.etd ?? null, eta: anyShare?.eta ?? null,
                    landed: anyShare?.landed ?? false, departed: anyShare?.departed ?? false,
                    estimated: false, poNumbers: [], itemCount: 0, payables: [],
                });
            }
            ctrMap.get(ref).payables.push({
                supplier: supplierName, amount: 0, dueDate: null, poNumbers: [], items: [],
                payments: [], documents: docs,
            });
        }
        const byContainer = [...ctrMap.values()]
            .map(c => ({ ...c, amount: money(c.amount), payables: c.payables.map(p => ({ ...p, amount: money(p.amount) })).sort((a, b) => b.amount - a.amount) }))
            .sort((a, b) => {
            if (a.dueDate !== b.dueDate) {
                if (a.dueDate == null)
                    return 1;
                if (b.dueDate == null)
                    return -1;
                return a.dueDate.localeCompare(b.dueDate);
            }
            return b.amount - a.amount;
        });
        const dataQuality = [...(issuesByCurrency.get(currency) ?? [])]
            .sort((a, b) => DQ_ORDER.indexOf(a.kind) - DQ_ORDER.indexOf(b.kind) || a.poNumber.localeCompare(b.poNumber, undefined, { numeric: true }));
        return { currency, kpis, items, pos, bySupplier, byContainer, dataQuality };
    });
    const flow = { today, currencies, poCount };
    if (options?.claims)
        flow.balanceClaims = balanceClaims;
    return flow;
}

module.exports = {
    CURRENCY_ORDER, buildPaymentsFlow,
};
