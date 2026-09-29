// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Payment terms: JFPRO / PI free text → a rule (deposit %, balance trigger,
// offset, confidence), and which source wins for a PO.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (frozen until the JFlow PHASE2 step 17 cut-over): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.
//
// Parser vectors (input → { depositPct, trigger, offset, confidence }):
//   "30% deposit on order confirmation, 70% balance before shipment" → 30, before_dispatch, 0, parsed
//   "30% T/T in advance, 70% B/L copy."                               → 30, bl, 0, parsed
//   "50% deposit, 50% before shipment"                                 → 50, before_dispatch, 0, parsed
//   "100% before dispatch"                                             → 0, before_dispatch, 0, parsed
//   "30% deposit, balance 30 days after B/L"                           → 30, bl, 30, parsed
//   "net 30"                                                           → 0, bl, 30, partial
//   "T/T 60 days from BL date"                                         → 0, bl, 60, parsed
//   "100% T/T 30 days after delivery"                                  → 0, delivery, 30, parsed
//   "payment before dispatch"                                          → 0, before_dispatch, 0, parsed
//   "Deposit 30% paid"                                                 → 30, unknown, 0, partial
//   "" / "As per contract"                                             → null, unknown, 0, none
//   "L/C at sight"                                                     → null, unknown, 0, none
//   "30% deposit, 70% against copy of B/L within 5 days"               → 30, bl, 5, parsed
//   "40% deposit, 60% before delivery"                                 → 40, before_dispatch, 0, parsed
//   "30% deposit, 70% 45 days after arrival at destination port"       → 30, arrival, 45, parsed
//   "50% deposit 50% balance 7 days before shipment"                   → 50, before_dispatch, -7, parsed
//   "30% deposit, 40% before shipment, 30% 30 days after delivery"     → 30, before_dispatch, 0, partial
//   "100% in advance"                                                  → 100, order, 0, parsed
//   "30% deposit; balance after receiving B/L copy"                    → 30, bl, 0, parsed
//   "30% deposit, 70% before shipment. Deposit paid on 12/03"          → 30, before_dispatch, 0, parsed
//   "30% deposit, balance thirty days after B/L"                       → 30, bl, 30, parsed
//   "30% deposit, 70% B/L copy, 30 days"                               → 30, bl, 30, parsed
//   JFPRO shorthand: "30D/70B BOL" → 30, bl, 0, parsed · "100D" → 100, order, 0, parsed
//   "100B BOL" → 0, bl, 0, parsed · "30D/70B 30 Days before BOL" → 30, bl, -30, parsed
//   "50D/50B Before dispatch" → 50, before_dispatch, 0, parsed
//   (asserted in api/test/unit/payments-flow-terms.test.js)

/** @typedef {import('./types').PaymentTermsRule} PaymentTermsRule */
/** @typedef {import('./types').InvoicePayment} InvoicePayment */

/** "net N" carries no anchor; bill-of-lading date is the conservative reading. */
const NET_TERMS_ANCHOR = 'bl';

const TRIGGER_LABEL = {
    before_dispatch: 'before dispatch',
    bl: 'against B/L',
    telex_release: 'on telex release',
    container_document: 'when document attached',
    arrival: 'on arrival',
    delivery: 'on delivery',
    invoice: 'after PI date',
    order: 'with order',
    unknown: 'terms unclear',
};

/** Human wording for a rule: "30% deposit · balance 30 d after B/L".
 *  @param {PaymentTermsRule} rule
 *  @returns {string} */
function describeRule(rule) {
    if (rule.confidence === 'none')
        return 'Terms not understood';
    const parts = [];
    if (rule.depositPct != null && rule.depositPct > 0) {
        parts.push(rule.depositPct >= 100 ? '100% with order' : `${rule.depositPct}% deposit`);
    }
    if (rule.depositPct == null || rule.depositPct < 100) {
        const bal = rule.depositPct != null ? `${Math.round(100 - rule.depositPct)}% ` : 'balance ';
        const off = rule.balanceOffsetDays;
        const when = rule.balanceTrigger === 'unknown'
            ? 'balance terms unclear'
            : off === 0
                ? TRIGGER_LABEL[rule.balanceTrigger]
                : `${Math.abs(off)} d ${off < 0 ? 'before' : 'after'} ${TRIGGER_LABEL[rule.balanceTrigger].replace(/^(before|against|on|after|with) /, '')}`;
        parts.push(rule.balanceTrigger === 'unknown' ? when : `${bal}${when}`);
    }
    return parts.join(' · ');
}

const NUMBER_WORDS = {
    one: '1', seven: '7', ten: '10', fourteen: '14', fifteen: '15', twenty: '20', thirty: '30',
    'forty-five': '45', 'forty five': '45', forty: '40', sixty: '60', ninety: '90',
};

function normaliseTerms(raw) {
    let s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    s = s.replace(/\bb\s*\/\s*l\b|\bb\.l\.?|\bbill of lad\w*|\bbol\b|\bbl\b/g, ' bl ');
    s = s.replace(/\bt\s*\/\s*t\b|\bt\.t\.?|\btt\b|\btelegraphic transfer\b|\bwire transfer\b/g, ' tt ');
    s = s.replace(/\bd\s*\/\s*p\b|\bd\.p\.?|\bcad\b|\bdocuments? agains\w*( payment)?\b/g, ' dp ');
    s = s.replace(/\bl\s*\/\s*c\b|\bl\.c\.?|\blc\b|\bletter of credit\b/g, ' lc ');
    s = s.replace(/\binadvance\b|\bin advanced?\b|\badvanced payment\b/g, ' in advance ');
    s = s.replace(/(\d+(?:\.\d+)?)\s*(%|percent|per cent|pct)/g, '$1%');
    s = s.replace(/\b(forty[- ]five|one|seven|ten|fourteen|fifteen|twenty|thirty|forty|sixty|ninety)\b(?=\s*(day|week|month))/g, m => NUMBER_WORDS[m] ?? m);
    return s.replace(/\s+/g, ' ').trim();
}

const PCT_RE = /(\d+(?:\.\d+)?)%/g;
const DEPOSIT_RE = /\bdeposit|\bdown ?payment|\badvanc|\bupfront|\bup front|\bprepay|\bprepaid|\bpre-?payment|\bwith (the )?order\b|\b(on|upon|against|when) (the )?order\b|\border confirm|\b(before|prior to|to start) production\b|\bfor production\b/;
const BALANCE_WORDS_RE = /\bbalance|\bremain|\bremainder|\brest\b|\bfinal\b|\bblance/;
const B0_BEFORE_RE = /\b(before|prior to|pre)[- ]?(dispatch|shipment|shipping|loading|departure|delivery|release|sailing)/;
const B0_READY_RE = /\b(finished|ready|readiness|completed|completion)\b/;
const B1_BL_RE = /\bbl\b|\bdp\b|\btelex|\bon board|\bshipping doc|\b(copy|set) of (the )?doc|\bcopy doc|\bagainst (the )?doc|\bdocuments\b|\bshipped\b|\b(after|upon|on|from|against)\s+(?:\w+\s+){0,3}(shipment|dispatch|loading|departure|sailing)\b|\betd\b|\bcopy bill\b|\bbill\b/;
const B2_DELIVERY_RE = /\bdeliver|\breceipt of (the )?goods|\bgoods received|\bwarehouse/;
const B3_ARRIVAL_RE = /\barriv|\beta\b|\bdestination|\blanding|\blanded|\bdischarge|\bport of/;
const B4_ORDER_RE = /\bin advance|\bupfront|\bprepay|\bwith (the )?order\b|\b(on|upon) (the )?order\b/;
const B7_INVOICE_RE = /\b(after|from) (the )?(date of )?(the )?(pi|invoice|proforma)\b|\binvoice date|\bpi date|\bpi issued/;
const B5_BARE_RE = /\bdispatch|\bshipment|\bshipping|\bloading/;
const NET_RE = /\bnet\s*(\d{1,3})\b/;
const OFFSET_RE = /(\d{1,3})\s*(day|week|month)s?\b/;

function triggerOf(text, notes) {
    if (B0_BEFORE_RE.test(text) || B0_READY_RE.test(text))
        return { trigger: 'before_dispatch', netDays: null };
    if (B1_BL_RE.test(text))
        return { trigger: 'bl', netDays: null };
    if (B2_DELIVERY_RE.test(text))
        return { trigger: 'delivery', netDays: null };
    if (B3_ARRIVAL_RE.test(text))
        return { trigger: 'arrival', netDays: null };
    if (B4_ORDER_RE.test(text))
        return { trigger: 'order', netDays: null };
    if (B7_INVOICE_RE.test(text))
        return { trigger: 'invoice', netDays: null };
    if (B5_BARE_RE.test(text)) {
        notes.push('bare_keyword');
        return { trigger: 'before_dispatch', netDays: null };
    }
    const net = NET_RE.exec(text);
    if (net) {
        notes.push('net_anchor_assumed');
        return { trigger: NET_TERMS_ANCHOR, netDays: Number(net[1]) };
    }
    return { trigger: 'unknown', netDays: null };
}

function offsetOf(text) {
    const m = OFFSET_RE.exec(text);
    if (!m)
        return 0;
    const n = Number(m[1]);
    const unit = m[2] === 'week' ? 7 : m[2] === 'month' ? 30 : 1;
    const after = text.slice(m.index + m[0].length);
    const negative = /^\s*(before|prior)/.test(after);
    return negative ? -n * unit : n * unit;
}

function splitClauses(s) {
    const rough = s.split(/[,;\n+]|\.(?!\d)|\band\b|\bthen\b/).map(c => c.trim()).filter(Boolean);
    const out = [];
    for (const c of rough) {
        const marks = [...c.matchAll(PCT_RE)].map(m => m.index ?? 0);
        if (marks.length <= 1) {
            out.push(c);
            continue;
        }
        let start = 0;
        for (let i = 1; i < marks.length; i++) {
            out.push(c.slice(start, marks[i]).trim());
            start = marks[i];
        }
        out.push(c.slice(start).trim());
    }
    return out.filter(Boolean);
}

const EMPTY_RULE = {
    depositPct: null, balanceTrigger: 'unknown', balanceOffsetDays: 0, source: 'none', raw: null, confidence: 'none', notes: [],
};

/** Deterministic free-text → rule. `source` is stamped by resolveTermsRule.
 *  @param {string|null|undefined} raw
 *  @returns {PaymentTermsRule} */
function parsePaymentTerms(raw) {
    const text = raw == null ? '' : String(raw);
    if (!text.trim())
        return { ...EMPTY_RULE, raw: null };
    let s = normaliseTerms(text);
    const notes = [];
    let partial = false;
    let depositPct = null;
    let shorthandBalance = null;
    // JFPRO house shorthand: "30D/70B BOL", "100D", "100B BOL", "50D/50B Before dispatch".
    const sh = /(?:^|\s)(\d{1,3})\s*d\b(?:\s*\/\s*(\d{1,3})\s*b\b)?/.exec(s);
    if (sh) {
        depositPct = Number(sh[1]);
        if (sh[2] != null)
            shorthandBalance = Number(sh[2]);
        s = s.replace(sh[0], ' ');
    }
    const shb = /(?:^|\s)(\d{1,3})\s*b\b/.exec(s);
    if (shb && shorthandBalance == null) {
        shorthandBalance = Number(shb[1]);
        s = s.replace(shb[0], ' ');
        if (depositPct == null)
            depositPct = Math.max(0, 100 - shorthandBalance);
    }
    s = s.replace(/\s+/g, ' ').trim();
    const clauses = splitClauses(s).map(c => {
        const pctMatch = /(\d+(?:\.\d+)?)%/.exec(c);
        let pct = pctMatch ? Number(pctMatch[1]) : null;
        if (pct != null && pct > 100)
            pct = null;
        return { text: c, pct, role: 'other', trigger: 'unknown', offset: 0, partialNotes: [] };
    });
    // Orphan offset ("…, 30 days") merges into the preceding balance clause.
    for (let i = clauses.length - 1; i > 0; i--) {
        const c = clauses[i];
        if (c.pct == null && OFFSET_RE.test(c.text) && !DEPOSIT_RE.test(c.text) && triggerOf(c.text, []).trigger === 'unknown') {
            clauses[i - 1].text += ' ' + c.text;
            clauses.splice(i, 1);
        }
    }
    const anyPct = clauses.some(c => c.pct != null) || depositPct != null;
    for (const c of clauses) {
        if (DEPOSIT_RE.test(c.text) && !(c.pct === 100 && B0_BEFORE_RE.test(c.text))) {
            c.role = 'deposit';
            continue;
        }
        const t = triggerOf(c.text, c.partialNotes);
        if (t.trigger !== 'unknown') {
            c.role = 'balance';
            c.trigger = t.trigger;
            c.offset = t.netDays != null ? t.netDays : offsetOf(c.text);
        }
    }
    // Deposit percentage from deposit clauses (several stages → summed).
    const depositClauses = clauses.filter(c => c.role === 'deposit');
    const depositPcts = depositClauses.map(c => c.pct).filter((p) => p != null);
    if (depositPcts.length) {
        depositPct = depositPcts.reduce((a, b) => a + b, 0);
        if (depositPcts.length > 1) {
            notes.push('multi_stage');
            partial = true;
        }
    }
    else if (depositClauses.length && !anyPct) {
        depositPct = 100; // "payment in advance"
    }
    // An unclassified pct clause ahead of a balance clause is the deposit stage
    // ("T/T 30% before and 70% against B/L copy").
    const balanceClauses = clauses.filter(c => c.role === 'balance');
    if (depositPct == null && balanceClauses.length) {
        const firstBalanceIdx = clauses.indexOf(balanceClauses[0]);
        const lead = clauses.slice(0, firstBalanceIdx).find(c => c.role === 'other' && c.pct != null && c.pct < 100);
        if (lead) {
            depositPct = lead.pct;
            lead.role = 'deposit';
            notes.push('position_deposit');
        }
    }
    // Balance trigger: first balance clause wins (earliest due, conservative).
    let trigger = 'unknown';
    let offset = 0;
    if (balanceClauses.length) {
        trigger = balanceClauses[0].trigger;
        offset = balanceClauses[0].offset;
        for (const n of balanceClauses[0].partialNotes) {
            notes.push(n);
            partial = true;
        }
        const distinct = new Set(balanceClauses.map(c => `${c.trigger}:${c.offset}`));
        if (distinct.size > 1) {
            notes.push('multi_stage');
            partial = true;
        }
    }
    // Percent bookkeeping.
    const balancePcts = balanceClauses.map(c => c.pct).filter((p) => p != null);
    const balanceSum = shorthandBalance != null ? shorthandBalance : balancePcts.reduce((a, b) => a + b, 0);
    if (depositPct == null) {
        if (balancePcts.some(p => p === 100))
            depositPct = 0;
        else if (balancePcts.length)
            depositPct = Math.max(0, 100 - balanceSum);
        else if (!anyPct && balanceClauses.length === 1 && !BALANCE_WORDS_RE.test(balanceClauses[0].text))
            depositPct = 0;
        else if (balanceClauses.length) {
            notes.push('split_unknown');
            partial = true;
        }
    }
    else if ((balancePcts.length || shorthandBalance != null) && Math.abs(depositPct + balanceSum - 100) > 1) {
        notes.push('pct_mismatch');
        partial = true;
    }
    if (depositPct != null && depositPct >= 100) {
        depositPct = 100;
        trigger = 'order';
        offset = 0;
    }
    else if (depositPct != null && trigger === 'unknown') {
        notes.push('deposit_only');
        partial = true;
    }
    if (depositPct == null && trigger === 'unknown') {
        if (/\blc\b/.test(s))
            notes.push('lc_terms');
        return { ...EMPTY_RULE, raw: text, notes };
    }
    return {
        depositPct,
        balanceTrigger: trigger,
        balanceOffsetDays: offset,
        source: 'none',
        raw: text,
        confidence: partial || depositPct == null ? 'partial' : 'parsed',
        notes,
    };
}

const CONFIDENCE_RANK = { parsed: 2, partial: 1, none: 0 };

/** Best-understood source wins: a fully parsed reading beats a partial one
 *  whichever side it came from; on a tie the newest PI's own terms (dueTerms,
 *  then rawTermsText) beat the JFPRO supplier default. `depositPct` is
 *  back-filled from the PI's extracted depositPercentage when the text gave
 *  no split. Older PIs never override a newer one.
 *  @param {Pick<InvoicePayment, 'dueTerms'|'rawTermsText'|'depositPercentage'>[]} paymentsNewestFirst
 *  @param {string|null|undefined} supplierTerms
 *  @returns {PaymentTermsRule} */
function resolveTermsRule(paymentsNewestFirst, supplierTerms) {
    const newest = paymentsNewestFirst[0] ?? null;
    const candidates = [];
    if (newest) {
        for (const text of [newest.dueTerms, newest.rawTermsText]) {
            const r = parsePaymentTerms(text);
            if (r.confidence !== 'none')
                candidates.push({ ...r, source: 'invoice' });
        }
    }
    const fromSupplier = parsePaymentTerms(supplierTerms);
    if (fromSupplier.confidence !== 'none')
        candidates.push({ ...fromSupplier, source: 'supplier' });
    // Stable sort: candidates are already in precedence order, so equal
    // confidence keeps the PI ahead of the supplier default.
    let rule = candidates.sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])[0] ?? null;
    if (!rule) {
        rule = { ...EMPTY_RULE, raw: newest?.dueTerms ?? newest?.rawTermsText ?? supplierTerms ?? null };
    }
    const extractedPct = newest?.depositPercentage;
    if (rule.depositPct == null && extractedPct != null && extractedPct > 0 && extractedPct <= 100) {
        rule = {
            ...rule,
            depositPct: extractedPct,
            source: rule.source === 'none' ? 'invoice' : rule.source,
            confidence: rule.confidence === 'parsed' ? 'parsed' : 'partial',
            notes: [...rule.notes, 'pct_backfilled'],
        };
    }
    return rule;
}

module.exports = {
    describeRule, parsePaymentTerms, resolveTermsRule,
};
