// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Company payment policy: the default payment rule with a supplier's rule laid
// over it, and rules saved under an alias repeated under the native name.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

const { dateOf } = require('./dates');
const { looseName, matchSupplier } = require('./suppliers');

/** @typedef {import('./types').PaymentRule} PaymentRule */
/** @typedef {import('./types').EffectivePolicy} EffectivePolicy */
/** @typedef {import('./types').MintSoftSupplier} MintSoftSupplier */

/** Pay-by limit for owed air freight when neither rule sets one. */
const AIR_LIMIT_DEFAULT_DAYS = 60;

/** No lead-time estimates. Kept here (not imported from api.ts) so this module stays free of load-time side effects — api.ts reads import.meta.env. */
const EMPTY_PAYMENT_RULE_ESTIMATES = { artwork: null, pi: null, piSigned: null, ready: null, telex: null, document: null, transit: { sea: null, air: null, road: null } };
const NO_POLICY = {
    depositPct: null, depositTrigger: 'po_sent', depositOffsetDays: null, depositGraceDays: 0,
    balanceTrigger: null, balanceDocumentType: null, balanceOffsetDays: null, balanceGraceDays: 0,
    estimates: EMPTY_PAYMENT_RULE_ESTIMATES,
    airOwedFrom: null, airLimitDays: AIR_LIMIT_DEFAULT_DAYS,
    defaultRule: null, supplierRule: null,
};

/** Default rule + the first supplier rule whose name matches any of the
 *  candidate names (the PO's own supplier string and the JFPRO record it
 *  resolved to). A supplier rule overrides the default field by field; a
 *  blank field inherits. Two values mean "override with nothing": deposit
 *  'po_sent' and balance 'terms' put the supplier's own terms back in charge
 *  even when the default adds a condition. Supplier grace 0 = the default's.
 *  @param {PaymentRule[]|null|undefined} rules
 *  @param {(string|null|undefined)[]} candidateNames
 *  @returns {EffectivePolicy} */
function resolvePolicy(rules, candidateNames) {
    if (!rules?.length)
        return NO_POLICY;
    const def = rules.find(r => r.scope === 'default') ?? null;
    // Punctuation-blind so "Suzhou Sunmed Co.,Ltd." still finds the rule saved as "Suzhou Sunmed Co., Ltd".
    const keys = candidateNames.map(looseName).filter(Boolean);
    const sup = rules.find(r => r.scope === 'supplier' && r.supplierName && keys.includes(looseName(r.supplierName))) ?? null;
    if (!def && !sup)
        return NO_POLICY;
    const asTerms = sup?.balanceTrigger === 'terms';
    const noTerms = (t) => (t == null || t === 'terms' ? null : t);
    const balanceTrigger = asTerms ? null : (noTerms(sup?.balanceTrigger) ?? noTerms(def?.balanceTrigger));
    return {
        depositPct: sup?.depositPct ?? def?.depositPct ?? null,
        depositTrigger: sup?.depositTrigger ?? def?.depositTrigger ?? 'po_sent',
        // Timing belongs with the trigger: a supplier back on "with the PO" does not inherit the default's offset.
        depositOffsetDays: sup?.depositTrigger ? (sup.depositOffsetDays ?? null) : (sup?.depositOffsetDays ?? def?.depositOffsetDays ?? null),
        depositGraceDays: (sup?.depositGraceDays || 0) > 0 ? sup.depositGraceDays : (def?.depositGraceDays || 0),
        balanceTrigger,
        balanceDocumentType: balanceTrigger === 'container_document' ? (sup?.balanceTrigger ? sup.balanceDocumentType : (def?.balanceDocumentType ?? null)) : null,
        // The offset belongs with the trigger: a supplier back on its own terms
        // does not inherit the default's offset.
        balanceOffsetDays: asTerms ? (sup?.balanceOffsetDays ?? null) : (sup?.balanceOffsetDays ?? def?.balanceOffsetDays ?? null),
        balanceGraceDays: (sup?.balanceGraceDays || 0) > 0 ? sup.balanceGraceDays : (def?.balanceGraceDays || 0),
        estimates: mergeEstimates(def?.estimates, sup?.estimates),
        // The start date is company-wide; only the limit can differ per supplier.
        airOwedFrom: dateOf(def?.airOwedFrom),
        airLimitDays: sup?.airLimitDays ?? def?.airLimitDays ?? AIR_LIMIT_DEFAULT_DAYS,
        defaultRule: def,
        supplierRule: sup,
    };
}

function mergeEstimates(def, sup) {
    const step = (k) => sup?.[k] ?? def?.[k] ?? null;
    return {
        artwork: step('artwork'), pi: step('pi'), piSigned: step('piSigned'), ready: step('ready'), telex: step('telex'), document: step('document'),
        transit: {
            sea: sup?.transit?.sea ?? def?.transit?.sea ?? null,
            air: sup?.transit?.air ?? def?.transit?.air ?? null,
            road: sup?.transit?.road ?? def?.transit?.road ?? null,
        },
    };
}

/** Supplier rules saved under an alias or a legacy JFPRO name apply to the
 *  native record they resolve to: each such rule is repeated under its
 *  resolved name so resolvePolicy finds it from either side.
 *  @param {PaymentRule[]|null|undefined} rules
 *  @param {Map<string, MintSoftSupplier>} index
 *  @param {MintSoftSupplier[]} suppliers
 *  @returns {PaymentRule[]} */
function canonicalizeRules(rules, index, suppliers) {
    if (!rules?.length)
        return [];
    const out = [];
    for (const r of rules) {
        out.push(r);
        if (r.scope !== 'supplier' || !r.supplierName)
            continue;
        const m = matchSupplier(r.supplierName, index, suppliers);
        if (m && m.how !== 'legacy' && looseName(m.supplier.name) !== looseName(r.supplierName))
            out.push({ ...r, supplierName: m.supplier.name });
    }
    return out;
}

module.exports = {
    AIR_LIMIT_DEFAULT_DAYS, EMPTY_PAYMENT_RULE_ESTIMATES, NO_POLICY, resolvePolicy, canonicalizeRules,
};
