// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Per-PO model: one purchase order's value, what is paid, stated and still
// to come, pro-rated over its containers, as PaymentItems.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

const { dateOf, addDays } = require('./dates');
const { getContainerForOrder } = require('./containers');
const { statusOf, isLandedLine, isDepartedLine, lineValueOf, firstDate, minDate } = require('./lines');
const { EPS, MIN_DERIVED, money, fmt2, working } = require('./money');
const { describeRule, resolveTermsRule } = require('./terms');
const { NO_POLICY } = require('./policy');
const { buildPoChain, freightModeOf, deriveGroupDue, applyDepositPolicy } = require('./due');

/** @typedef {import('./types').Ymd} Ymd */
/** @typedef {import('./types').Order} Order */
/** @typedef {import('./types').Container} Container */
/** @typedef {import('./types').ContainerEvents} ContainerEvents */
/** @typedef {import('./types').PurchaseOrderBundle} PurchaseOrderBundle */
/** @typedef {import('./types').InvoicePayment} InvoicePayment */
/** @typedef {import('./types').SupplierMatch} SupplierMatch */
/** @typedef {import('./types').EffectivePolicy} EffectivePolicy */
/** @typedef {import('./types').ShipmentPaymentClaim} ShipmentPaymentClaim */
/** @typedef {import('./types').DataQualityIssue} DataQualityIssue */
/** @typedef {import('./types').PoPaymentSummary} PoPaymentSummary */

/**
 *  One purchase order: its value, what is paid, stated and still to come,
 *  pro-rated over its containers, as PaymentItems. Null when nothing is left
 *  (no live lines, fully paid, or every box landed and settled).
 *  @param {{ bundle: PurchaseOrderBundle, lines: Order[], payments: InvoicePayment[], supplierTerms: string|null, supplierMatch?: SupplierMatch|null, containerIndex?: Map<string, Container>|null, policy?: EffectivePolicy, containerEvents?: Map<string, ContainerEvents>|null, shipmentClaims?: ShipmentPaymentClaim[], appliedToPi?: Map<number, number>, depositPaidByPayment?: { amount: number, paidOn: Ymd|null }|null, today: Ymd, issues?: DataQualityIssue[] }} args
 *  @returns {PoPaymentSummary|null}
 */
function summarizePo(args) {
    const { bundle, today } = args;
    const policy = args.policy ?? NO_POLICY;
    const appliedToPi = args.appliedToPi ?? new Map();
    const depositByPayment = args.depositPaidByPayment && args.depositPaidByPayment.amount > EPS ? args.depositPaidByPayment : null;
    const issues = args.issues ?? [];
    const lines = args.lines.filter(o => o.status !== 'DESTROYED');
    if (!lines.length)
        return null;
    const destroyedLines = args.lines.length - lines.length;
    const currency = (bundle.currency || 'USD').trim().toUpperCase();
    const supplierRaw = (bundle.supplier ?? lines.find(l => l.supplier)?.supplier ?? '').trim() || null;
    const sm = args.supplierMatch ?? null;
    const supplier = sm && sm.how !== 'legacy' ? sm.supplier.name : supplierRaw;
    const poNumber = bundle.poNumber || `PO ${bundle.id}`;
    const shippingTotal = Number(bundle.shippingTotal) || 0;
    const flags = new Set();
    const issue = (kind, detail, amount = null, shipmentReference = null) => issues.push({ kind, poId: bundle.id, poNumber, supplier, currency, detail, amount, shipmentReference });
    // Lines → value
    let linesValue = null;
    let unpricedLines = 0;
    let totalUnits = 0;
    for (const o of lines) {
        // eslint-disable-next-line no-unused-vars -- never read in the TS either (paymentsFlowMath.ts L1541); kept for identity
        totalUnits += o.quantity || 0;
        const v = lineValueOf(o);
        if (v == null)
            unpricedLines++;
        else
            linesValue = (linesValue ?? 0) + v;
    }
    if (unpricedLines)
        flags.add('unpriced_lines');
    // Payments (invoice must still exist on the bundle)
    const invoiceById = new Map();
    for (const inv of bundle.invoices ?? [])
        invoiceById.set(inv.id, inv);
    const rows = args.payments
        .filter(p => invoiceById.has(p.invoiceId))
        .map(p => ({ payment: p, invoice: invoiceById.get(p.invoiceId) }))
        .sort((a, b) => (b.invoice.uploadedAt || '').localeCompare(a.invoice.uploadedAt || '') || b.payment.id - a.payment.id);
    const active = rows.filter(r => r.payment.paymentStatus !== 'skipped');
    const paymentByInvoice = new Set(rows.map(r => r.payment.invoiceId));
    const noPayment = [];
    for (const inv of bundle.invoices ?? []) {
        if (paymentByInvoice.has(inv.id))
            continue;
        const st = inv.latestCheck?.status;
        noPayment.push(st === 'failed' ? 'check failed' : st === 'succeeded' ? 'no terms found' : 'not checked yet');
    }
    if (noPayment.length) {
        issue('invoice_no_payment', `${noPayment.length} PI${noPayment.length === 1 ? '' : 's'} without extracted terms (${[...new Set(noPayment)].join(', ')})`);
    }
    for (const r of active) {
        if (r.payment.currency && r.payment.currency.trim().toUpperCase() !== currency) {
            flags.add('currency_mismatch');
            issue('currency_mismatch', `PI says ${r.payment.currency.trim().toUpperCase()}, PO is ${currency} — PO currency used`);
            break;
        }
    }
    // Terms
    const parsedRule = resolveTermsRule(rows.map(r => r.payment), args.supplierTerms);
    // Company policy lays over the terms: a fixed deposit % replaces the text's.
    const rule = policy.depositPct != null
        ? { ...parsedRule, depositPct: policy.depositPct, notes: [...parsedRule.notes, 'policy_pct'] }
        : parsedRule;
    if (policy.depositPct != null || policy.balanceTrigger || policy.balanceOffsetDays != null)
        flags.add('policy_applied');
    if (rule.confidence === 'none') {
        flags.add('terms_unclear');
        const why = rule.raw
            ? `Terms not understood: "${rule.raw}"`
            : !sm
                ? `"${supplierRaw ?? '—'}" is not in JFPRO — add the supplier there or fix the name on the PO`
                : sm.how === 'legacy'
                    ? `Only a Shipsline-legacy JFPRO record ("${sm.supplier.name}") with blank terms — add terms to it or merge it into the native supplier`
                    : `No payment terms on the JFPRO supplier "${sm.supplier.name}" — add them in JFPRO`;
        issue('terms_unclear', why);
    }
    else if (rule.confidence === 'partial') {
        flags.add('terms_partial');
        issue('terms_partial', `${describeRule(rule)} — read from "${rule.raw ?? ''}"`);
    }
    // PO total
    let poTotal = null;
    let totalBasis = 'none';
    let invoiceTotalFrom = null;
    const totalRow = active.find(r => (r.payment.paymentType === 'full' || r.payment.paymentType === 'deposit') && (r.payment.invoiceTotal ?? 0) > 0);
    if (totalRow) {
        poTotal = money(totalRow.payment.invoiceTotal);
        totalBasis = 'invoice';
        invoiceTotalFrom = totalRow.invoice.id;
        flags.add('invoice_total_used');
        if (linesValue != null && unpricedLines === 0) {
            const fromLines = linesValue + shippingTotal;
            if (Math.abs(poTotal - fromLines) > Math.max(1, fromLines * 0.02)) {
                flags.add('total_mismatch');
                issue('total_mismatch', `PI total ${money(poTotal).toLocaleString('en-GB')} vs lines + shipping ${money(fromLines).toLocaleString('en-GB')}`, money(poTotal - fromLines));
            }
        }
    }
    else if (linesValue != null) {
        poTotal = money(linesValue + shippingTotal);
        totalBasis = 'lines';
    }
    if (poTotal == null)
        issue('unvalued', unpricedLines ? `${unpricedLines} line${unpricedLines === 1 ? '' : 's'} without a unit price and no PI total` : 'No PI total');
    else if (unpricedLines)
        issue('unpriced_lines', totalBasis === 'invoice'
            ? `${unpricedLines} of ${lines.length} lines without a unit price — shares by quantity`
            : `${unpricedLines} of ${lines.length} lines without a unit price — left out of the PO total; their containers show no balance`);
    // Paid / stated
    let paid = 0;
    // What `paid` is made of, by kind of payment, for the working shown on each
    // item: "PI marked paid" alone reads as the whole PI when it is its deposit.
    const paidParts = { depositPis: 0, depositPiCount: 0, fullPis: 0, balancePis: 0, onOpenDeposit: 0, onOpenOther: 0 };
    for (const r of active) {
        if (r.payment.paymentStatus !== 'paid')
            continue;
        if ((r.payment.amountDue ?? 0) > 0) {
            const amt = r.payment.amountDue;
            paid += amt;
            if (r.payment.paymentType === 'deposit') {
                paidParts.depositPis += amt;
                paidParts.depositPiCount++;
            }
            else if (r.payment.paymentType === 'full')
                paidParts.fullPis += amt;
            else
                paidParts.balancePis += amt;
        }
        else
            issue('paid_no_amount', `PI ${r.invoice.filename} marked paid without an amount`);
    }
    // A transfer applied to a PI that is still open: that part is paid, the
    // rest is what the row still asks for.
    const appliedOn = (r) => r.payment.paymentStatus === 'pending' || r.payment.paymentStatus === 'arranged'
        ? Math.min(appliedToPi.get(r.payment.id) ?? 0, Math.max(0, r.payment.amountDue ?? 0))
        : 0;
    const dueLeft = (r) => money(Math.max(0, (r.payment.amountDue ?? 0) - appliedOn(r)));
    for (const r of active) {
        const a = appliedOn(r);
        paid += a;
        if (r.payment.paymentType === 'deposit')
            paidParts.onOpenDeposit += a;
        else
            paidParts.onOpenOther += a;
    }
    // A deposit paid by transfer before any PI was filed: stated, not inferred.
    if (depositByPayment)
        paid += depositByPayment.amount;
    // Balance records per box. A PAID one is paid money and settles its box.
    // An OPEN one never sets what is owed — the terms and the goods on board do
    // (user rule, 2026-09-28: "our derived figure should never change until
    // line items are updated"). Its figure is only compared with the terms';
    // money already applied to it is that box's, taken off that box's share.
    const claims = args.shipmentClaims ?? [];
    for (const c of claims) {
        if ((c.payment.currency || '').toUpperCase() === currency)
            continue;
        flags.add('currency_mismatch');
        issue('shipment_payment_currency', `Balance invoice for ${c.containerNumber} is in ${c.payment.currency}, this PO is in ${currency} — the PO's currency is used`, null, c.containerNumber);
    }
    const paidClaims = claims.filter(c => c.payment.status === 'paid' || c.settled);
    const openClaims = claims.filter(c => !c.settled && (c.payment.status === 'pending' || c.payment.status === 'arranged'));
    const shipmentPaid = money(paidClaims.reduce((a, c) => a + c.amount, 0));
    const shipmentStated = money(openClaims.reduce((a, c) => a + c.amount, 0));
    const paidClaimGroups = new Set(paidClaims.filter(c => !c.partlyPaid && !openClaims.some(o => o.payment.id === c.payment.id)).map(c => c.containerNumber));
    const openPaymentIds = new Set(openClaims.map(c => c.payment.id));
    // Part payments on a still-open record, per box: paid money, but this
    // box's — they come off its own share, not the PO's spread.
    const settledOnOpenBox = new Map();
    for (const c of paidClaims) {
        if (!c.settled || !openPaymentIds.has(c.payment.id))
            continue;
        settledOnOpenBox.set(c.containerNumber, money((settledOnOpenBox.get(c.containerNumber) ?? 0) + c.amount));
    }
    const settledOnOpenTotal = money([...settledOnOpenBox.values()].reduce((a, v) => a + v, 0));
    // The open record's whole figure for this PO in each box, to compare with.
    const recordOnBox = new Map();
    for (const c of claims) {
        if (!openPaymentIds.has(c.payment.id))
            continue;
        const r = recordOnBox.get(c.containerNumber);
        recordOnBox.set(c.containerNumber, { amount: money((r?.amount ?? 0) + c.amount), payment: c.payment });
    }
    paid = money(paid + shipmentPaid);
    const statedRows = active.filter(r => (r.payment.paymentStatus === 'pending' || r.payment.paymentStatus === 'arranged') && dueLeft(r) > EPS);
    let stated = money(statedRows.reduce((a, r) => a + dueLeft(r), 0));
    for (let i = 0; i < statedRows.length; i++) {
        for (let j = i + 1; j < statedRows.length; j++) {
            const a = statedRows[i].payment, b = statedRows[j].payment;
            if (a.paymentType === b.paymentType && Math.abs((a.amountDue ?? 0) - (b.amountDue ?? 0)) < EPS) {
                flags.add('duplicate_stated');
                issue('duplicate_stated', `Two ${a.paymentType} PIs for the same amount`, a.amountDue);
                i = statedRows.length;
                break;
            }
        }
    }
    const proofCount = (bundle.payments ?? []).length;
    // Container groups
    const orderDate = firstDate(lines, 'poDate') ?? firstDate(lines, 'orderedDate') ?? dateOf(bundle.createdAt);
    const invoiceDate = rows.length ? dateOf(rows[0].invoice.uploadedAt) : null;
    // When the deposit went out, if anything says: a deposit PI marked paid
    // (its status change), else the oldest proof file (matched to the deposit
    // stage first), else — goods shipped — the ship date.
    const depositPaidReal = (() => {
        if (depositByPayment?.paidOn)
            return depositByPayment.paidOn;
        const paidDep = active.filter(r => r.payment.paymentStatus === 'paid' && r.payment.paymentType !== 'balance').map(r => dateOf(r.payment.updatedAt)).filter(Boolean);
        if (paidDep.length)
            return paidDep.sort()[0];
        const proofs = (bundle.payments ?? []).map(x => dateOf(x.uploadedAt)).filter(Boolean);
        if (proofs.length)
            return proofs.sort()[0];
        return firstDate(lines, 'shippedDate');
    })();
    const chain = buildPoChain({
        estimates: policy.estimates, orderDate, invoiceDate, lines, bundle, depositPaidReal,
        // The deposit's own expected date: a pending deposit PI's date, else policy on the PO date.
        depositForecast: () => {
            const pendingDep = statedRows.find(r => r.payment.paymentType === 'deposit' || r.payment.paymentType === 'full');
            const contractual = pendingDep ? (dateOf(pendingDep.payment.dueDate) ?? dateOf(pendingDep.invoice.uploadedAt) ?? orderDate) : orderDate;
            return applyDepositPolicy({ policy, contractual, chain, today }).dueDate;
        },
    });
    const groups = new Map();
    for (const o of lines) {
        const k = o.containerNumber?.trim() || null;
        if (!groups.has(k))
            groups.set(k, []);
        groups.get(k).push(o);
    }
    const groupKeys = [...groups.keys()].sort((a, b) => {
        if (a == null)
            return 1;
        if (b == null)
            return -1;
        return a.localeCompare(b, undefined, { numeric: true });
    });
    // Quantity stands in for value only when the total covers every line (a PI
    // total). A total built from lines holds the priced lines alone, so splitting
    // it by quantity would hand a priced box's money to unpriced ones — by value,
    // an unpriced line weighs 0, as it does in the total.
    const byQty = unpricedLines > 0 && totalBasis === 'invoice';
    if (byQty && groupKeys.length > 1)
        flags.add('prorated_by_qty');
    const weights = groupKeys.map(k => groups.get(k).reduce((a, o) => a + (byQty ? (o.quantity || 0) : (lineValueOf(o) ?? 0)), 0));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    // Pre-arrival terms: a landed container's balance had to be paid to get the
    // goods released. Only terms that fall due after arrival can still owe.
    const effectiveBalanceTrigger = policy.balanceTrigger ?? rule.balanceTrigger;
    const effectiveOffset = policy.balanceTrigger ? (policy.balanceOffsetDays ?? 0) : (policy.balanceOffsetDays ?? rule.balanceOffsetDays);
    const postArrivalTerms = (effectiveBalanceTrigger === 'arrival' || effectiveBalanceTrigger === 'delivery' || effectiveBalanceTrigger === 'invoice') && effectiveOffset > 0;
    const containers = groupKeys.map((k, i) => {
        const gl = groups.get(k);
        let live;
        for (const o of gl) {
            live = getContainerForOrder(o, args.containerIndex);
            if (live)
                break;
        }
        const raw = k ? args.containerEvents?.get(k) ?? args.containerEvents?.get(k.toUpperCase()) : undefined;
        // The shipment's stage can lead its orders (a road shipment marked under
        // way keeps CONSOLIDATED orders) — it counts alongside the line statuses.
        // Its stage moments are trusted only once the stage says so: the backfill
        // copied stray order dates into departed_at on shipments still BOOKED.
        const stage = raw?.stage ?? null;
        const stageLanded = stage === 'ARRIVED' || stage === 'CLOSED';
        const stageMoved = stageLanded || stage === 'IN_TRANSIT';
        const events = raw ? { ...raw, departedAt: stageMoved ? raw.departedAt : null, arrivedAt: stageLanded ? raw.arrivedAt : null } : undefined;
        const landed = gl.some(isLandedLine) || stageLanded;
        const liveDeparted = !!live?.times?.departureIsActual && (dateOf(live.times.departure) ?? '9999') <= today;
        const departed = landed || liveDeparted || stageMoved || gl.every(isDepartedLine);
        const due = deriveGroupDue({ rule, policy, events, lines: gl, live, containerNumber: k, landed, departed, orderDate, invoiceDate, chain, today });
        const value = gl.reduce((a, o) => { const v = lineValueOf(o); return v == null ? a : (a ?? 0) + v; }, null);
        const deliveredOn = landed ? (minDate(gl, 'arrivedDate') ?? minDate(gl, 'deliveryDate') ?? dateOf(events?.arrivedAt) ?? dateOf(events?.ata)) : null;
        // Air goods are released before the balance is paid — it goes with a
        // later transfer — so from the company's start date landing settles
        // nothing: the balance is owed, due by the rule's limit after delivery
        // (buildPaymentsFlow pulls it forward to the supplier's next payment).
        // No delivery date on file counts as before the start date.
        const airOwed = landed && !postArrivalTerms && policy.airOwedFrom != null && deliveredOn != null
            && deliveredOn >= policy.airOwedFrom && freightModeOf(k, events, gl) === 'air';
        const airLimitDate = airOwed ? addDays(deliveredOn, policy.airLimitDays) : null;
        return {
            containerNumber: k,
            share: weightSum > 0 ? weights[i] / weightSum : 1 / groupKeys.length,
            lineCount: gl.length,
            units: gl.reduce((a, o) => a + (o.quantity || 0), 0),
            value,
            dueDate: airOwed ? airLimitDate : due.dueDate,
            contractualDate: airOwed ? airLimitDate : due.contractualDate,
            landed,
            departed,
            estimated: airOwed ? false : due.estimated,
            blocked: airOwed ? null : due.blocked,
            flags: airOwed ? ['air_owed'] : due.flags,
            etd: firstDate(gl, 'shippedDate') ?? dateOf(live?.times?.departure) ?? firstDate(gl, 'estimatedDepartureDate') ?? dateOf(events?.departedAt),
            eta: dateOf(live?.times?.ata) ?? dateOf(events?.ata) ?? dateOf(live?.times?.eta) ?? firstDate(gl, 'eta') ?? dateOf(events?.arrivedAt),
            // A paid invoice is a fact and outranks both inferences; it is set here
            // so proof matching below never spends a proof on a settled group.
            // An open balance record on a landed box says money is still owed there
            // (typically the rest of a part payment): landing does not settle it.
            settledBy: (k != null && paidClaimGroups.has(k)) ? 'payment'
                : landed && !postArrivalTerms && !airOwed && !(k != null && recordOnBox.has(k)) ? 'landed' : null,
            airOwed,
            deliveredOn,
        };
    });
    const anyDeparted = containers.some(c => c.departed);
    const landedAll = containers.every(c => c.landed);
    // Owed air fields for the items a container produces.
    const airFieldsOf = (c) => c?.airOwed ? { deliveredOn: c.deliveredOn, airLimitDate: c.dueDate } : {};
    // Exclusions / sanity
    const fullyPaid = poTotal != null && paid >= poTotal - EPS && statedRows.length === 0 && openClaims.length === 0;
    if (poTotal != null && paid > poTotal + EPS) {
        flags.add('overpaid');
        issue('overpaid', `Paid ${money(paid).toLocaleString('en-GB')} against a PO value of ${money(poTotal).toLocaleString('en-GB')}`, money(paid - poTotal));
    }
    // Every box landed and settled — by payment or by landing (owed air and a
    // box with an open record are not).
    const assumeSettled = landedAll && !postArrivalTerms && containers.every(c => c.settledBy != null);
    if ((fullyPaid || assumeSettled) && statedRows.length === 0 && openClaims.length === 0)
        return null;
    // Payment stages, oldest first — the order proofs are matched in.
    // PIs already marked paid absorb a proof each before anything else.
    const paidRows = active.filter(r => r.payment.paymentStatus === 'paid');
    const statedAsc = [...statedRows].sort((a, b) => (a.invoice.uploadedAt || '').localeCompare(b.invoice.uploadedAt || '') || a.payment.id - b.payment.id);
    let proofsLeft = proofCount;
    let proofsMatched = 0;
    proofsLeft = Math.max(0, proofsLeft - paidRows.length);
    proofsMatched += Math.min(proofCount, paidRows.length);
    const statedCovered = new Set();
    for (const r of statedAsc) {
        if (proofsLeft <= 0)
            break;
        statedCovered.add(r.payment.id);
        proofsLeft--;
        proofsMatched++;
    }
    const hasStatedDeposit = !!depositByPayment || active.some(r => r.payment.paymentType === 'deposit' || r.payment.paymentType === 'full');
    let depositStageByProof = false;
    if (!hasStatedDeposit && rule.depositPct != null && rule.depositPct > 0 && proofsLeft > 0) {
        depositStageByProof = true;
        proofsLeft--;
        proofsMatched++;
    }
    const balanceByProof = new Set();
    for (const c of containers) {
        if (proofsLeft <= 0)
            break;
        if (c.settledBy)
            continue;
        balanceByProof.add(c.containerNumber);
        proofsLeft--;
        proofsMatched++;
    }
    for (const c of containers)
        if (balanceByProof.has(c.containerNumber))
            c.settledBy = 'proof';
    // Owed air freight with unpriced lines: what is owed for them is unknown
    // (a lines-built total leaves them out), so say so rather than stay quiet.
    for (const c of containers) {
        if (!c.airOwed || c.settledBy || byQty)
            continue;
        const unpriced = (groups.get(c.containerNumber) ?? []).filter(o => lineValueOf(o) == null).length;
        if (!unpriced)
            continue;
        issue('air_unpriced', `Air freight ${c.containerNumber ?? ''} delivered ${c.deliveredOn}: ${unpriced} line${unpriced === 1 ? '' : 's'} without a unit price — what is owed for ${unpriced === 1 ? 'it' : 'them'} is unknown; add prices on the PO`, null, c.containerNumber);
    }
    let assumedPaid = 0;
    const items = [];
    const baseFlags = [...flags].filter(f => f === 'terms_unclear' || f === 'terms_partial' || f === 'currency_mismatch' || f === 'overpaid');
    const assumedNotes = [];
    // A supplier who bills the balance per shipment often ALSO has a PO-level
    // "100% against documents" PI on file for the same goods. Money paid per
    // shipment covers that PI pound for pound and only the uncovered remainder
    // is still shown. (An open record is not money and covers nothing.)
    let coverLeft = money(shipmentPaid);
    let supersededTotal = 0;
    // A container whose balance is PAID is done. Money that names no container
    // — an undated PI, the terms-derived balance — spreads over the remaining
    // containers only, renormalised, so nothing is double counted onto a paid
    // box and nothing the PO still owes quietly disappears.
    const coveredGroups = new Set(paidClaimGroups);
    const isCovered = (c) => c.containerNumber != null && coveredGroups.has(c.containerNumber);
    const uncoveredShareTotal = containers.filter(c => !isCovered(c)).reduce((a, c) => a + c.share, 0);
    const spreadShare = (c) => (uncoveredShareTotal > 0 ? c.share / uncoveredShareTotal : 0);
    // The working's words for that spread: what the container holds of what
    // is left to split (weights[i] is containers[i]'s value, or units by qty).
    const shareLabel = (c) => (c.containerNumber ? `Share in ${c.containerNumber}` : 'Share not yet in a container');
    const shareSource = (c) => {
        const open = containers.map((x, i) => ({ x, w: weights[i] })).filter(({ x }) => !isCovered(x));
        const paidBoxes = containers.length - open.length;
        const tail = paidBoxes ? ` — ${paidBoxes} paid container${paidBoxes === 1 ? '' : 's'} left out` : '';
        if (!(weightSum > 0))
            return `split evenly over ${open.length} container${open.length === 1 ? '' : 's'}${tail}`;
        const mine = weights[containers.indexOf(c)];
        const all = open.reduce((a, o) => a + o.w, 0);
        return byQty
            ? `${mine.toLocaleString('en-GB')} of ${all.toLocaleString('en-GB')} units${tail}`
            : `goods on board ${fmt2(mine)} of ${fmt2(all)}${tail}`;
    };
    const poValueSource = totalBasis === 'invoice' && totalRow
        ? `PI total — ${totalRow.invoice.filename}`
        : `${lines.length - unpricedLines} priced line${lines.length - unpricedLines === 1 ? '' : 's'} ${fmt2(linesValue ?? 0)}${shippingTotal ? ` + shipping ${fmt2(shippingTotal)}` : ''}${unpricedLines ? ` · ${unpricedLines} unpriced line${unpricedLines === 1 ? '' : 's'} left out` : ''}`;
    // Stated items — the PI's own figures. A pending balance PI with no due date
    // on a PO spread over several containers is split by share, since "against
    // B/L" style terms fall due per shipment.
    for (const r of statedRows) {
        const p = r.payment;
        const kind = p.paymentType === 'deposit' ? 'deposit' : 'balance';
        if (statedCovered.has(p.id)) {
            assumedPaid += dueLeft(r);
            assumedNotes.push(`${kind} PI ${money(dueLeft(r)).toLocaleString('en-GB')}`);
            continue;
        }
        let rowAmount = dueLeft(r);
        const piWork = working().set(p.paymentType === 'deposit' ? 'Deposit PI' : p.paymentType === 'full' ? '100% PI' : 'Balance PI', p.amountDue ?? 0, `${r.invoice.filename} — what the PI asks for`);
        if (appliedOn(r) > EPS)
            piWork.minus('Paid by transfer', appliedOn(r), 'transfers recorded against this PI');
        let superseded = false;
        if (kind === 'balance' && coverLeft > EPS) {
            const covered = Math.min(rowAmount, coverLeft);
            coverLeft = money(coverLeft - covered);
            rowAmount = money(rowAmount - covered);
            supersededTotal = money(supersededTotal + covered);
            superseded = true;
            piWork.minus('Covered by paid container balances', covered, 'the same goods, paid container by container');
            if (rowAmount <= EPS)
                continue;
        }
        const itemFlags = new Set(baseFlags);
        if (superseded)
            itemFlags.add('superseded_by_shipment_invoice');
        if (appliedOn(r) > EPS)
            itemFlags.add('partly_paid');
        if (p.paymentType === 'other' || p.paymentType === 'unknown') {
            itemFlags.add('type_unknown');
            issue('type_unknown', `PI ${r.invoice.filename} payment type "${p.paymentType}" — treated as balance`, p.amountDue);
        }
        if (p.paymentStatus === 'arranged')
            itemFlags.add('arranged');
        if (kind === 'deposit' && anyDeparted) {
            itemFlags.add('goods_moved');
            issue('stale_status', `Deposit PI ${money(p.amountDue).toLocaleString('en-GB')} still pending although the goods have shipped — mark it paid or skipped`, p.amountDue);
        }
        const status = p.paymentStatus === 'arranged' ? 'arranged' : 'pending';
        const base = { kind, basis: 'stated', poId: bundle.id, poNumber, supplier, currency, status, invoiceId: p.invoiceId, paymentId: p.id, shipmentPaymentId: null };
        const statedDue = dateOf(p.dueDate);
        if (kind === 'deposit') {
            if (!statedDue)
                itemFlags.add('derived_date');
            const d = applyDepositPolicy({ policy, contractual: statedDue ?? dateOf(r.invoice.uploadedAt) ?? orderDate ?? today, chain, today });
            for (const f of d.flags)
                itemFlags.add(f);
            items.push({ ...base, id: `stated:${p.id}`, amount: rowAmount, dueDate: d.dueDate, contractualDate: d.contractualDate, trigger: 'order', containerNumber: null, containerShare: null, blocked: d.blocked, flags: [...itemFlags], derivation: piWork.steps });
            continue;
        }
        if (statedDue) {
            // The PI names its own date; company grace still applies on top.
            const withGrace = policy.balanceGraceDays > 0 ? addDays(statedDue, policy.balanceGraceDays) : statedDue;
            if (withGrace !== statedDue)
                itemFlags.add('grace_applied');
            items.push({ ...base, id: `stated:${p.id}`, amount: rowAmount, dueDate: withGrace, contractualDate: statedDue, trigger: effectiveBalanceTrigger, containerNumber: containers.length === 1 ? containers[0].containerNumber : null, containerShare: null, blocked: null, flags: [...itemFlags], derivation: piWork.steps });
            continue;
        }
        itemFlags.add('derived_date');
        if (containers.length <= 1) {
            const c = containers[0];
            const f = new Set([...itemFlags, ...(c?.flags ?? [])]);
            items.push({ ...base, id: `stated:${p.id}`, amount: rowAmount, dueDate: c?.dueDate ?? null, contractualDate: c?.contractualDate ?? null, trigger: effectiveBalanceTrigger, containerNumber: c?.containerNumber ?? null, containerShare: null, blocked: c?.blocked ?? null, flags: [...f], ...airFieldsOf(c), derivation: piWork.steps });
            continue;
        }
        for (const c of containers) {
            if (isCovered(c))
                continue;
            const amount = money(rowAmount * spreadShare(c));
            if (amount < EPS)
                continue;
            const f = new Set([...itemFlags, ...c.flags, 'multi_container']);
            if (byQty)
                f.add('prorated_by_qty');
            items.push({
                ...base, id: `stated:${p.id}:${c.containerNumber ?? 'none'}`, amount, dueDate: c.dueDate, contractualDate: c.contractualDate, trigger: effectiveBalanceTrigger,
                containerNumber: c.containerNumber, containerShare: c.share, blocked: c.blocked, flags: [...f], ...airFieldsOf(c),
                derivation: piWork.fork().times(shareLabel(c), spreadShare(c), shareSource(c)).steps,
            });
        }
    }
    // What is still owed on paper: the PI amounts that survived supersession.
    // (Open balance records are compared with the derived share below, never added.)
    stated = money(stated - supersededTotal);
    // Derived remainder — what the terms say is still to come.
    let remainder = 0;
    let derivedDeposit = 0;
    let derivedBalance = 0;
    let derivedBalanceEmitted = 0;
    if (poTotal != null && !assumeSettled) {
        // Part payments on an open record belong to their box: they are taken off
        // that box's share below, not spread across the PO here.
        remainder = money(Math.max(0, poTotal - (paid - settledOnOpenTotal) - stated));
        const depositTarget = rule.depositPct != null ? poTotal * rule.depositPct / 100 : null;
        const depositCovered = active
            .filter(r => r.payment.paymentType !== 'balance' && (r.payment.paymentStatus === 'paid' || r.payment.paymentStatus === 'pending' || r.payment.paymentStatus === 'arranged'))
            .reduce((a, r) => a + (r.payment.amountDue ?? 0), 0)
            + (depositByPayment?.amount ?? 0);
        derivedDeposit = depositTarget == null ? 0 : money(Math.min(remainder, Math.max(0, depositTarget - depositCovered)));
        derivedBalance = money(remainder - derivedDeposit);
        const depositDeductedOnInvoice = claims.some(c => (c.payment.depositDeducted ?? 0) > 0);
        // The working the balance items share: what is left to pay on the PO.
        // Money paid is named for what it paid — a deposit PI marked paid is the
        // deposit, not the whole PI.
        const paidHere = money(paid - settledOnOpenTotal);
        const boxesPaid = money(shipmentPaid - settledOnOpenTotal);
        const poWork = working().set('PO value', poTotal, poValueSource);
        if (paidHere > EPS) {
            const depositOnly = paidParts.fullPis <= EPS && paidParts.balancePis <= EPS && paidParts.onOpenOther <= EPS && boxesPaid <= EPS;
            poWork.minus(depositOnly ? 'Deposit paid' : 'Paid so far', paidHere, [
                paidParts.depositPis > EPS ? `deposit PI${paidParts.depositPiCount > 1 ? 's' : ''} marked paid ${fmt2(paidParts.depositPis)}` : null,
                paidParts.fullPis > EPS ? `100% PI marked paid ${fmt2(paidParts.fullPis)}` : null,
                paidParts.balancePis > EPS ? `balance PI marked paid ${fmt2(paidParts.balancePis)}` : null,
                paidParts.onOpenDeposit > EPS ? `transfer on the open deposit PI ${fmt2(paidParts.onOpenDeposit)}` : null,
                paidParts.onOpenOther > EPS ? `transfers on open PIs ${fmt2(paidParts.onOpenOther)}` : null,
                depositByPayment ? `deposit paid by transfer ${fmt2(depositByPayment.amount)}` : null,
                boxesPaid > EPS ? `paid container balances ${fmt2(boxesPaid)}` : null,
            ].filter(Boolean).join(' · '));
        }
        // Open PIs come off the PO: each is a payment of its own — unless a proof
        // on the PO was matched to it, in which case it is treated as paid.
        const statedByProof = money(statedRows.filter(r => statedCovered.has(r.payment.id)).reduce((a, r) => a + dueLeft(r), 0));
        const statedOpen = money(stated - statedByProof);
        if (statedByProof > EPS)
            poWork.minus('PIs treated as paid', statedByProof, 'open PIs a proof of payment on the PO is matched to');
        if (statedOpen > EPS)
            poWork.minus('Asked for on open PIs', statedOpen, 'each open PI is a payment of its own');
        const pctSource = policy.depositPct != null
            ? 'company payment rule'
            : rule.source === 'invoice' ? `the PI's terms${rule.raw ? ` “${rule.raw}”` : ''}`
                : rule.source === 'supplier' ? `the supplier's terms in JFPRO${rule.raw ? ` “${rule.raw}”` : ''}` : 'the terms';
        const balanceWork = poWork.fork();
        // A subtotal only where it helps: before a deposit that comes off what is
        // left (and only once something was taken off already), or where what is
        // paid and invoiced covers the PO and the figure stops at nothing.
        const clamped = Math.abs(balanceWork.figure - remainder) > 0.005;
        if (clamped || (derivedDeposit > EPS && balanceWork.steps.length > 1)) {
            balanceWork.set('Left to pay on the PO', remainder, clamped ? 'what is paid and invoiced already covers the PO' : undefined);
        }
        if (derivedDeposit > EPS) {
            balanceWork.minus(`Deposit, ${rule.depositPct}% of the PO`, derivedDeposit, derivedDeposit < MIN_DERIVED ? 'under 0.50 — left out'
                : depositDeductedOnInvoice ? 'the supplier’s invoice deducts it, so it went out'
                    : depositStageByProof ? 'treated as paid — a proof of payment is on the PO'
                        : anyDeparted ? 'treated as paid — the goods have shipped'
                            : 'still to pay — a payment of its own');
        }
        // "70% of the PO" only when that is exactly what is left.
        const balancePct = rule.depositPct != null ? 100 - rule.depositPct : null;
        balanceWork.set('Balance for the PO', derivedBalance, balancePct != null && Math.abs(derivedBalance - poTotal * balancePct / 100) < 0.005 ? `${Math.round(balancePct * 100) / 100}% of the PO` : undefined);
        if (derivedDeposit >= MIN_DERIVED) {
            if (depositDeductedOnInvoice) {
                // The supplier netted the deposit off their balance invoice, so it was
                // paid — they would not discount money they never received.
                assumedPaid += derivedDeposit;
                flags.add('assumed_paid');
                flags.add('deposit_deducted');
            }
            else if (depositStageByProof) {
                assumedPaid += derivedDeposit;
                assumedNotes.push(`deposit ${money(derivedDeposit).toLocaleString('en-GB')}`);
            }
            else if (anyDeparted) {
                // Goods don't ship unpaid — the deposit went out even if nobody recorded it.
                assumedPaid += derivedDeposit;
                flags.add('assumed_paid');
            }
            else {
                const itemFlags = new Set(baseFlags);
                if (!orderDate && lines.every(l => statusOf(l) === 'SCHEDULED'))
                    itemFlags.add('po_not_sent');
                if (depositByPayment)
                    itemFlags.add('partly_paid');
                const d = applyDepositPolicy({ policy, contractual: orderDate, chain, today });
                for (const f of d.flags)
                    itemFlags.add(f);
                const depositWork = working().set('PO value', poTotal, poValueSource).percent(`Deposit ${rule.depositPct}%`, rule.depositPct, pctSource);
                if (depositCovered > EPS)
                    depositWork.minus('Deposit already on file', depositCovered, 'deposit and 100% PIs (paid or open) and deposits paid by transfer');
                if (remainder < depositTarget - depositCovered - 0.005)
                    depositWork.set('Capped at what is left on the PO', derivedDeposit, 'the PO value less what is paid and what open PIs ask for');
                items.push({
                    id: `derived:dep:${bundle.id}`,
                    kind: 'deposit',
                    basis: 'derived',
                    poId: bundle.id,
                    poNumber,
                    supplier,
                    currency,
                    amount: derivedDeposit,
                    dueDate: d.dueDate,
                    contractualDate: d.contractualDate,
                    trigger: 'order',
                    containerNumber: null,
                    containerShare: null,
                    status: 'projected',
                    blocked: d.blocked,
                    shipmentPaymentId: null,
                    flags: [...itemFlags],
                    invoiceId: null,
                    paymentId: null,
                    derivation: depositWork.steps,
                });
            }
        }
        if (derivedBalance >= MIN_DERIVED) {
            for (const c of containers) {
                // A paid container is done; what is left of the PO belongs to the
                // containers still to be paid.
                if (isCovered(c))
                    continue;
                const share = money(derivedBalance * spreadShare(c));
                const record = c.containerNumber != null ? recordOnBox.get(c.containerNumber) ?? null : null;
                const partPaid = c.containerNumber != null ? settledOnOpenBox.get(c.containerNumber) ?? 0 : 0;
                // What is owed here: the terms' share, less what was already applied to this box.
                const amount = money(Math.max(0, share - partPaid));
                if (amount < MIN_DERIVED)
                    continue;
                if (c.settledBy) {
                    assumedPaid += amount;
                    if (c.settledBy === 'proof')
                        assumedNotes.push(`balance ${money(amount).toLocaleString('en-GB')}${c.containerNumber ? ` (${c.containerNumber})` : ''}`);
                    else
                        flags.add('assumed_paid');
                    continue;
                }
                const itemFlags = new Set([...baseFlags, ...c.flags]);
                if (byQty)
                    itemFlags.add('prorated_by_qty');
                if (partPaid > EPS)
                    itemFlags.add('partly_paid');
                if (record) {
                    if (record.payment.status === 'arranged')
                        itemFlags.add('arranged');
                    // The record's figure is compared, never used.
                    if (Math.abs(record.amount - share) > Math.max(1, share * 0.02)) {
                        itemFlags.add('invoice_vs_share');
                        issue('shipment_payment_mismatch', `A balance of ${money(record.amount).toLocaleString('en-GB')} is recorded for ${c.containerNumber}, the terms say ${money(share).toLocaleString('en-GB')} — the terms figure is what is owed`, money(record.amount - share), c.containerNumber);
                    }
                }
                derivedBalanceEmitted = money(derivedBalanceEmitted + amount);
                const boxWork = balanceWork.fork().times(shareLabel(c), spreadShare(c), shareSource(c));
                if (partPaid > EPS)
                    boxWork.minus('Already paid on this container', partPaid, 'transfers applied to its balance record');
                items.push({
                    id: `derived:bal:${bundle.id}:${c.containerNumber ?? 'none'}`,
                    kind: 'balance',
                    basis: 'derived',
                    poId: bundle.id,
                    poNumber,
                    supplier,
                    currency,
                    amount,
                    dueDate: c.dueDate,
                    contractualDate: c.contractualDate,
                    trigger: effectiveBalanceTrigger,
                    containerNumber: c.containerNumber,
                    containerShare: c.share,
                    // An open record makes it pending (or arranged): something is on file for it.
                    status: record ? (record.payment.status === 'arranged' ? 'arranged' : 'pending') : 'projected',
                    blocked: c.blocked,
                    shipmentPaymentId: record ? record.payment.id : null,
                    flags: [...itemFlags],
                    invoiceId: null,
                    paymentId: null,
                    ...airFieldsOf(c),
                    ...(partPaid > EPS ? { owedInFull: share } : {}),
                    derivation: boxWork.steps,
                });
            }
        }
    }
    assumedPaid = money(assumedPaid);
    if (assumedNotes.length) {
        flags.add('assumed_paid');
        issue('proof_assumed_paid', `${proofCount} proof${proofCount === 1 ? '' : 's'}: ${assumedNotes.join('; ')}`, assumedPaid);
    }
    // What the pro-rating actually produced, after invoices took their boxes.
    const derivedBalanceReported = derivedBalanceEmitted;
    const outstanding = money(items.reduce((a, it) => a + it.amount, 0));
    if (!items.length && (fullyPaid || landedAll))
        return null;
    return {
        poId: bundle.id,
        poNumber,
        supplier,
        supplierRaw,
        currency,
        poTotal,
        totalBasis,
        invoiceTotalFrom,
        linesValue: linesValue == null ? null : money(linesValue),
        shippingTotal,
        lineCount: lines.length,
        unpricedLines,
        destroyedLines,
        paid,
        assumedPaid,
        shipmentPaid,
        shipmentStated,
        stated,
        remainder,
        derivedDeposit,
        derivedBalance: derivedBalanceReported,
        outstanding,
        rule,
        policy,
        containers,
        proofCount,
        proofsMatched,
        excluded: fullyPaid ? 'fully_paid' : assumeSettled ? 'complete' : null,
        flags: [...flags],
        items: fullyPaid ? [] : items,
    };
}

module.exports = {
    summarizePo,
};
