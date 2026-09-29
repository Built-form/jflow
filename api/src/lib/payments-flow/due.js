// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Due dates: the PO event chain (real dates, else estimates), the freight
// mode, a container group's balance due date and the deposit's under policy.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

const { dateOf, addDays } = require('./dates');
const { parseInternalContainerNumber } = require('./containers');
const { statusOf, firstDate, minDate } = require('./lines');
const { normName } = require('./suppliers');

/** @typedef {import('./types').Ymd} Ymd */
/** @typedef {import('./types').Order} Order */
/** @typedef {import('./types').Container} Container */
/** @typedef {import('./types').ContainerEvents} ContainerEvents */
/** @typedef {import('./types').PurchaseOrderBundle} PurchaseOrderBundle */
/** @typedef {import('./types').PaymentRuleEstimates} PaymentRuleEstimates */
/** @typedef {import('./types').PaymentTermsRule} PaymentTermsRule */
/** @typedef {import('./types').EffectivePolicy} EffectivePolicy */
/** @typedef {import('./types').PoEventChain} PoEventChain */
/** @typedef {import('./types').DueResult} DueResult */
/** @typedef {import('./types').FreightMode} FreightMode */
/** @typedef {import('./types').PaymentBlocker} PaymentBlocker */
/** @typedef {import('./types').PaymentFlag} PaymentFlag */

const NO_EVENT = { date: null, estimated: false };

/**
 *  The PO-level events a lead time can count from, each a real date when
 *  known, else its own estimate, resolved lazily with a cycle guard (a looping
 *  rule set yields no date rather than a wrong one).
 *  @param {{ estimates: PaymentRuleEstimates, orderDate: Ymd|null, invoiceDate: Ymd|null, lines: Order[], bundle: PurchaseOrderBundle, depositPaidReal: Ymd|null, depositForecast: () => Ymd|null }} args
 *  @returns {PoEventChain}
 */
function buildPoChain(args) {
    const { estimates: est, lines, bundle } = args;
    const memo = new Map();
    const visiting = new Set();
    const artworkReal = (() => {
        const dates = lines.map(l => dateOf(l.artworkConfirmedDate));
        return dates.length && dates.every(Boolean) ? dates.reduce((a, d) => (!a || d > a ? d : a), null) : null;
    })();
    const signedReal = (() => {
        const d = (bundle.signedPis ?? []).map(x => dateOf(x.uploadedAt)).filter(Boolean);
        return d.length ? d.sort()[0] : null;
    })();
    const fromStep = (step) => {
        if (!step)
            return NO_EVENT;
        const base = get(step.from);
        return base.date ? { date: addDays(base.date, step.days), estimated: true } : NO_EVENT;
    };
    const get = anchor => {
        const hit = memo.get(anchor);
        if (hit)
            return hit;
        if (visiting.has(anchor))
            return NO_EVENT;
        visiting.add(anchor);
        let ev;
        switch (anchor) {
            case 'po':
                ev = { date: args.orderDate, estimated: false };
                break;
            case 'pi':
                ev = args.invoiceDate ? { date: args.invoiceDate, estimated: false } : fromStep(est.pi);
                break;
            case 'artwork':
                ev = artworkReal ? { date: artworkReal, estimated: false } : fromStep(est.artwork);
                break;
            case 'pi_signed':
                ev = signedReal ? { date: signedReal, estimated: false } : fromStep(est.piSigned);
                break;
            case 'deposit_paid': {
                if (args.depositPaidReal)
                    ev = { date: args.depositPaidReal, estimated: false };
                else {
                    const d = args.depositForecast();
                    ev = d ? { date: d, estimated: true } : NO_EVENT;
                }
                break;
            }
            case 'ready':
                ev = fromStep(est.ready);
                break;
            default: ev = NO_EVENT;
        }
        visiting.delete(anchor);
        memo.set(anchor, ev);
        return ev;
    };
    return { get };
}

/** SEA · AIR · ROAD for a container group: the shipment entity's mode, else
 *  the internal number's form ("104. Air Freight"), else the lines' air
 *  markers. Unbooked lines have no mode yet.
 *  @param {string|null} containerNumber
 *  @param {ContainerEvents|undefined} events
 *  @param {Order[]} lines
 *  @returns {FreightMode|null} */
function freightModeOf(containerNumber, events, lines) {
    const m = (events?.mode ?? '').toLowerCase();
    if (m === 'sea' || m === 'air' || m === 'road')
        return m;
    const parsed = parseInternalContainerNumber(containerNumber);
    if (parsed)
        return parsed.freight === 'AIR' ? 'air' : 'sea';
    if (lines.some(l => statusOf(l) === 'ON_AIR' || (l.awbNumber ?? '').trim()))
        return 'air';
    return null;
}

/** Due date of a container group under the supplier's terms and the company
 *  policy. Anchor chains prefer actual events over estimates: ShipsGo actuals
 *  and order dates first, then the shipment entity's dates (its `ata`, then
 *  its stage-change moments, flagged `derived_date`), then estimates.
 *  `estimated` says which one was used. Grace is added last and kept apart
 *  in `contractualDate`.
 *  @param {{ rule: PaymentTermsRule, policy: EffectivePolicy, events: ContainerEvents|undefined, lines: Order[], live: Container|undefined, containerNumber: string|null, landed: boolean, departed: boolean, orderDate: Ymd|null, invoiceDate: Ymd|null, chain: PoEventChain, today: Ymd }} args
 *  @returns {DueResult} */
function deriveGroupDue(args) {
    const { rule, policy, events, lines, live, landed, departed, chain, today } = args;
    const L = live?.times ?? null;
    const flags = [];
    let anchor = null;
    let estimated = false;
    // Policy trigger overrides the terms; telex / document triggers estimate
    // from the B/L date until the container entity reports the real event.
    let trigger = rule.balanceTrigger;
    let offset = rule.balanceOffsetDays;
    let eventDate = null;
    // How an awaited telex / document is expected to date, when it has not happened.
    let eventStep = null;
    if (policy.balanceTrigger) {
        flags.push('policy_applied');
        offset = policy.balanceOffsetDays ?? 0;
        if (policy.balanceTrigger === 'telex_release') {
            eventDate = dateOf(events?.telexReleasedAt);
            trigger = 'bl';
            // Until the telex exists, its estimate (else the B/L date) dates it.
            if (!eventDate) {
                flags.push('awaiting_telex');
                eventStep = policy.estimates.telex;
            }
        }
        else if (policy.balanceTrigger === 'container_document') {
            const want = normName(policy.balanceDocumentType);
            eventDate = dateOf(events?.documents?.find(d => normName(d.type) === want)?.attachedAt);
            trigger = 'bl';
            if (!eventDate) {
                flags.push('awaiting_document');
                eventStep = policy.estimates.document;
            }
        }
        else {
            trigger = policy.balanceTrigger;
        }
    }
    else if (policy.balanceOffsetDays != null) {
        flags.push('policy_applied');
        offset = policy.balanceOffsetDays;
    }
    const liveDeparture = dateOf(L?.departure);
    const liveActualDeparture = L?.departureIsActual ? liveDeparture : null;
    const shipped = firstDate(lines, 'shippedDate');
    const etd = firstDate(lines, 'estimatedDepartureDate');
    // ShipsGo's actual arrival, else the date entered on the shipment (air and
    // road never have a ShipsGo container).
    const ata = dateOf(L?.ata) ?? dateOf(events?.ata);
    const liveEta = dateOf(L?.eta);
    const eta = firstDate(lines, 'eta');
    const arrived = firstDate(lines, 'arrivedDate');
    const delivered = firstDate(lines, 'deliveryDate');
    // Stage-change moments on the shipment: when someone marked it under way /
    // arrived. Real events, but click times rather than sailing dates.
    const stageDeparted = dateOf(events?.departedAt);
    const stageArrived = dateOf(events?.arrivedAt);
    const blIssued = !!(events?.blNumber ?? '').trim();
    let blocked = null;
    // Transit by mode; unbooked lines have no mode yet, so sea (the longest) stands in.
    const mode = freightModeOf(args.containerNumber, events, lines);
    const transitDays = policy.estimates.transit[mode ?? 'sea'];
    // Expected departure when nothing better exists: the lines' ETD or ready
    // date, else the chain's "goods ready" estimate.
    const expectedEtd = minDate(lines, 'estimatedDepartureDate') ?? minDate(lines, 'estimatedReadyDate') ?? chain.get('ready').date;
    const departureOnFile = () => liveActualDeparture ?? shipped ?? liveDeparture ?? etd ?? stageDeparted ?? expectedEtd;
    // No ETA anywhere: the departure plus the rules' transit estimate.
    const etaFromTransit = () => {
        const dep = departureOnFile();
        return dep && transitDays != null ? addDays(dep, transitDays) : null;
    };
    if (args.containerNumber == null) {
        // Not booked into a container: nothing is payable yet. Keep a forecast
        // date from the ready date / ETD so the money still shows on the chart.
        flags.push('no_container');
        blocked = 'shipment';
        if (trigger === 'before_dispatch' || trigger === 'bl') {
            anchor = expectedEtd;
            estimated = true;
        }
        else if (trigger === 'arrival' || trigger === 'delivery') {
            // Only with a transit estimate: expected departure + transit.
            anchor = expectedEtd && transitDays != null ? addDays(expectedEtd, transitDays) : null;
            estimated = true;
        }
        else if (trigger === 'order') {
            anchor = args.orderDate;
        }
        else if (trigger === 'invoice') {
            anchor = args.invoiceDate ?? args.orderDate;
        }
    }
    else {
        switch (trigger) {
            case 'before_dispatch':
                if (shipped)
                    anchor = shipped;
                else if (liveActualDeparture)
                    anchor = liveActualDeparture;
                else if (stageDeparted) {
                    anchor = stageDeparted;
                    flags.push('derived_date');
                }
                else {
                    anchor = etd ?? liveDeparture;
                    estimated = anchor != null;
                }
                break;
            case 'bl':
                if (liveActualDeparture)
                    anchor = liveActualDeparture;
                else if (shipped)
                    anchor = shipped;
                else if (blIssued && (liveDeparture || etd || stageDeparted)) {
                    // The B/L exists, so its date is the departure on file, not a guess.
                    anchor = liveDeparture ?? etd ?? stageDeparted;
                    flags.push('bl_issued');
                }
                else if (stageDeparted) {
                    anchor = stageDeparted;
                    flags.push('derived_date');
                }
                else {
                    anchor = liveDeparture ?? etd;
                    estimated = anchor != null;
                }
                break;
            case 'arrival':
                if (ata)
                    anchor = ata;
                else if (landed && (arrived || delivered))
                    anchor = arrived ?? delivered;
                else if (stageArrived) {
                    anchor = stageArrived;
                    flags.push('derived_date');
                }
                else {
                    anchor = liveEta ?? eta ?? etaFromTransit();
                    estimated = anchor != null;
                }
                break;
            case 'delivery':
                if (delivered || arrived)
                    anchor = delivered ?? arrived;
                else if (ata)
                    anchor = ata;
                else if (stageArrived) {
                    anchor = stageArrived;
                    flags.push('derived_date');
                }
                else {
                    anchor = liveEta ?? eta ?? etaFromTransit();
                    estimated = anchor != null;
                }
                break;
            case 'order':
                anchor = args.orderDate;
                break;
            case 'invoice':
                anchor = args.invoiceDate ?? args.orderDate;
                break;
            default:
                anchor = null;
        }
    }
    // The real event (telex released / document attached) replaces the estimate;
    // until then its step ("1 week after the B/L / the arrival") dates it, and
    // it stays an estimate. No step: the B/L anchor as it stands.
    if (eventDate) {
        anchor = eventDate;
        estimated = false;
    }
    else if (eventStep) {
        const base = eventStep.from === 'arrival'
            ? (ata ?? liveEta ?? eta ?? etaFromTransit())
            : departureOnFile();
        if (base) {
            anchor = addDays(base, eventStep.days);
            estimated = true;
        }
    }
    let dueDate = anchor ? addDays(anchor, offset) : null;
    // A stale estimate (ETD / ready date already behind us, goods not moved)
    // is not an overdue payment — the money goes out when the goods do. Pull
    // it to today so it reads as imminent, and say why.
    if (dueDate && estimated && !departed && dueDate < today) {
        // Goods not even booked into a container: the timing is simply unknown,
        // so the item goes undated rather than pretending it lands today.
        dueDate = blocked ? null : today;
        flags.push('estimate_passed');
    }
    if (!dueDate && landed) {
        dueDate = arrived ?? delivered ?? ata ?? stageArrived ?? today;
        estimated = false;
        flags.push('landed_fallback');
    }
    else if (!dueDate && departed && (trigger === 'before_dispatch' || trigger === 'bl')) {
        dueDate = stageDeparted ?? today;
        estimated = false;
        flags.push('departed_no_date');
    }
    if (estimated && dueDate)
        flags.push('estimated');
    const contractualDate = dueDate;
    if (dueDate && policy.balanceGraceDays > 0) {
        dueDate = addDays(dueDate, policy.balanceGraceDays);
        flags.push('grace_applied');
    }
    return { dueDate, contractualDate, estimated: estimated && !!dueDate, blocked, flags };
}

/** When the deposit falls due under policy: the policy event (artwork
 *  confirmed / PI uploaded / PI signed) plus the deposit offset, never earlier
 *  than the contractual date. Until the event happens nothing is payable: the
 *  deposit carries a blocker and either no date or — when the rules give a
 *  lead time for that event — a forecast date flagged `estimated`, so the
 *  money shows on the chart without ever reading as "due today". A forecast
 *  already in the past goes undated (the plan slipped; timing unknown).
 *  @param {{ policy: EffectivePolicy, contractual: Ymd|null, chain: PoEventChain, today: Ymd }} args
 *  @returns {{ dueDate: Ymd|null, contractualDate: Ymd|null, blocked: PaymentBlocker|null, flags: PaymentFlag[] }} */
function applyDepositPolicy(args) {
    const { policy, chain, today } = args;
    const flags = [];
    let due = args.contractual;
    let blocked = null;
    let estimated = false;
    if (policy.depositTrigger !== 'po_sent') {
        flags.push('policy_applied');
        const [anchor, awaiting, blocker] = policy.depositTrigger === 'artwork_confirmed' ? ['artwork', 'awaiting_artwork', 'artwork']
            : policy.depositTrigger === 'pi_uploaded' ? ['pi', 'awaiting_pi', 'pi']
                : ['pi_signed', 'awaiting_pi_signed', 'pi_signed'];
        const ev = chain.get(anchor);
        const offset = policy.depositOffsetDays ?? 0;
        if (ev.date && !ev.estimated) {
            const fromEvent = addDays(ev.date, offset);
            due = !due || fromEvent > due ? fromEvent : due;
        }
        else {
            blocked = blocker;
            flags.push(awaiting);
            const forecast = ev.date ? addDays(ev.date, offset) : null;
            if (forecast && forecast >= today) {
                due = forecast;
                estimated = true;
            }
            else {
                due = null;
                if (forecast)
                    flags.push('estimate_passed');
            }
        }
    }
    else if (policy.depositOffsetDays != null && policy.depositOffsetDays !== 0 && due) {
        flags.push('policy_applied');
        due = addDays(due, policy.depositOffsetDays);
    }
    if (estimated)
        flags.push('estimated');
    const contractualDate = due;
    if (due && policy.depositGraceDays > 0) {
        due = addDays(due, policy.depositGraceDays);
        flags.push('grace_applied');
    }
    return { dueDate: due, contractualDate, blocked, flags };
}

module.exports = {
    buildPoChain, freightModeOf, deriveGroupDue, applyDepositPolicy,
};
