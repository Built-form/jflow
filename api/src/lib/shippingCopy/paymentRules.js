// Copied from shipping/src/lib/payment-rules.js — changes: read side only (parsePaymentRuleEstimates, parseStoredEstimates, paymentRuleRowToJson); paymentRuleRowToJson drops supplierLabel, notes, updatedByEmail, createdAt, updatedAt (the model reads none); the body parser and the trigger lists are not copied
'use strict';

// Payment rules as GET /api/v1/payment-rules serialises them. Pure.

// Each estimate step counts from one event; the anchors allowed per step keep
// the chain acyclic (artwork cannot count from ready, ready cannot count from
// arrival…). Transit is per mode from the ETD.
const PAYMENT_RULE_ESTIMATE_STEPS = {
    artwork: ['po', 'pi', 'pi_signed'],
    pi: ['po', 'artwork'],
    piSigned: ['pi', 'po', 'artwork'],
    ready: ['po', 'pi', 'pi_signed', 'artwork', 'deposit_paid'],
    telex: ['bl', 'etd', 'arrival'],
    document: ['bl', 'etd', 'arrival'],
    // 2026-10-05: how long after the goods are ready unbooked goods leave — the rule that
    // dates "not payable yet" balances from today (shipping src/lib/payment-rules.js).
    departure: ['ready'],
};
const PAYMENT_RULE_FREIGHT_MODES = ['sea', 'air', 'road'];
const EMPTY_PAYMENT_RULE_ESTIMATES = () => ({
    artwork: null, pi: null, piSigned: null, ready: null, telex: null, document: null, departure: null,
    transit: { sea: null, air: null, road: null },
});

// { error } or { value: estimates } — always the full shape, nulls for unset.
function parsePaymentRuleEstimates(input) {
    const out = EMPTY_PAYMENT_RULE_ESTIMATES();
    if (input == null) return { value: out };
    if (typeof input !== 'object') return { error: 'estimates must be an object.' };
    const days = (v, name) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 365 ? { value: n } : { error: `${name} must be a whole number of days between 0 and 365.` };
    };
    for (const [key, anchors] of Object.entries(PAYMENT_RULE_ESTIMATE_STEPS)) {
        const step = input[key];
        if (step == null || step === '') continue;
        if (typeof step !== 'object') return { error: `estimates.${key} must be { from, days }.` };
        if (!anchors.includes(step.from)) return { error: `estimates.${key}.from must be one of: ${anchors.join(', ')}.` };
        const d = days(step.days, `estimates.${key}.days`);
        if (d.error) return { error: d.error };
        out[key] = { from: step.from, days: d.value };
    }
    const transit = input.transit;
    if (transit != null) {
        if (typeof transit !== 'object') return { error: 'estimates.transit must be { sea, air, road }.' };
        for (const mode of PAYMENT_RULE_FREIGHT_MODES) {
            const v = transit[mode];
            if (v == null || v === '') continue;
            const d = days(v, `estimates.transit.${mode}`);
            if (d.error) return { error: d.error };
            out.transit[mode] = d.value;
        }
    }
    return { value: out };
}

function parseStoredEstimates(raw) {
    if (!raw) return EMPTY_PAYMENT_RULE_ESTIMATES();
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsePaymentRuleEstimates(parsed).value ?? EMPTY_PAYMENT_RULE_ESTIMATES();
    } catch {
        return EMPTY_PAYMENT_RULE_ESTIMATES();
    }
}

function paymentRuleRowToJson(r) {
    if (!r) return null;
    return {
        id: r.id,
        scope: r.scope,
        supplierName: r.scope === 'supplier' ? r.supplier_name : null,
        depositPct: r.deposit_pct != null ? Number(r.deposit_pct) : null,
        depositTrigger: r.deposit_trigger || null,
        depositGraceDays: Number(r.deposit_grace_days) || 0,
        balanceTrigger: r.balance_trigger || null,
        balanceDocumentType: r.balance_document_type || null,
        balanceOffsetDays: r.balance_offset_days != null ? Number(r.balance_offset_days) : null,
        balanceGraceDays: Number(r.balance_grace_days) || 0,
        depositOffsetDays: r.deposit_offset_days != null ? Number(r.deposit_offset_days) : null,
        estimates: parseStoredEstimates(r.estimates_json),
        // The start date is company-wide: only the default rule carries one.
        airOwedFrom: r.scope === 'default' && r.air_owed_from ? String(r.air_owed_from).slice(0, 10) : null,
        airLimitDays: r.air_limit_days != null ? Number(r.air_limit_days) : null,
    };
}

module.exports = {
    parsePaymentRuleEstimates,
    parseStoredEstimates,
    paymentRuleRowToJson,
};
