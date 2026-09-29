// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Supplier names: a PO's free-text supplier → the JFPRO record. Native records
// beat 'shipsline-legacy' ones (by tag); aliases match only when unambiguous.
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (re-synced with the oracle when ShipLine changes it): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

/** @typedef {import('./types').MintSoftSupplier} MintSoftSupplier */
/** @typedef {import('./types').SupplierMatch} SupplierMatch */

/**
 *  Trimmed, lower-cased.
 *  @param {string|null|undefined} s
 *  @returns {string}
 */
const normName = (s) => (s ?? '').trim().toLowerCase();

/** Punctuation-blind, single-spaced, lower-cased. "Suzhou Sunmed Co.,Ltd." ≡ "Suzhou Sunmed Co., Ltd".
 *  @param {string|null|undefined} s
 *  @returns {string} */
const looseName = (s) => normName(s).replace(/[^a-z0-9一-鿿]+/g, ' ').trim();

/** Legal-form filler that carries no identity. */
const NAME_FILLER = new Set(['co', 'ltd', 'limited', 'company', 'inc', 'llc', 'gmbh', 'spa', 'sa', 'corp', 'corporation', 'the', 'and']);
const nameTokens = (s) => looseName(s).split(' ').filter(t => t && !NAME_FILLER.has(t));

/** Lower-cased trimmed name → supplier (the DraftView "payment before
 *  dispatch" lookup, lifted). Loose (punctuation-blind) keys are added too.
 *  @param {MintSoftSupplier[]} suppliers
 *  @returns {Map<string, MintSoftSupplier>} */
function indexSuppliersByName(suppliers) {
    const m = new Map();
    for (const s of suppliers) {
        const k = normName(s.name);
        if (k && !m.has(k))
            m.set(k, s);
        const lk = looseName(s.name);
        if (lk && !m.has(lk))
            m.set(lk, s);
    }
    return m;
}

/** Shipsline-legacy JFPRO records — imported 2026-06-30, usually blank terms,
 *  often a duplicate of a native record under a slightly different name.
 *  @param {MintSoftSupplier} s
 *  @returns {boolean} */
const isLegacySupplier = (s) => !!s.tags?.some(t => t.name === 'shipsline-legacy');

/** Place names carry little identity — "Zhejiang Yuekang Medical" is the same
 *  supplier as "Changzhou Yuekang Medical" far more often than not. */
const GEO_TOKENS = new Set(['china', 'zhejiang', 'jiangsu', 'guangdong', 'fujian', 'hubei', 'shandong', 'hong', 'kong', 'hk', 'shanghai', 'suzhou', 'ningbo', 'guangzhou', 'shenzhen', 'dongguan', 'fuzhou', 'xiamen', 'hangzhou', 'changzhou', 'nantong', 'wuxi', 'yiwu', 'qingdao', 'dalian', 'tianjin', 'beijing', 'guilin', 'nanning', 'guangxi', 'anji', 'baoying', 'lipu', 'hubei', 'qianjiang', 'yangzhou', 'taizhou', 'wenzhou', 'jinhua', 'shaoxing', 'huzhou', 'ninghai', 'yinzhou']);
const tokenWeight = (t) => (GEO_TOKENS.has(t) ? 0.35 : 1);

function aliasMatch(name, pool) {
    const tokens = nameTokens(name).filter(t => t.length >= 3 && !/^\d+$/.test(t));
    if (!tokens.length)
        return null;
    const shortAlias = tokens.every(t => t.length < 4);
    const total = tokens.reduce((a, t) => a + tokenWeight(t), 0);
    const strong = tokens.filter(t => !GEO_TOKENS.has(t));
    if (!strong.length)
        return null;
    // How many suppliers carry each token — a very short alias ("Tam", "A2U")
    // must either open the supplier's name or be unique across the pool.
    const carriers = new Map();
    for (const s of pool)
        for (const t of new Set(nameTokens(s.name)))
            carriers.set(t, (carriers.get(t) ?? 0) + 1);
    const scored = pool.map(s => {
        const st = nameTokens(s.name);
        const set = new Set(st);
        if (shortAlias && st[0] !== tokens[0] && (carriers.get(tokens[0]) ?? 0) !== 1)
            return { s, score: 0, strongHit: false };
        const hit = tokens.filter(t => set.has(t));
        const score = hit.reduce((a, t) => a + tokenWeight(t), 0) / total;
        return { s, score, strongHit: hit.some(t => !GEO_TOKENS.has(t)) };
    }).filter(x => x.strongHit && x.score >= 0.55).sort((a, b) => b.score - a.score);
    if (!scored.length)
        return null;
    const best = scored[0];
    // Duplicate records of one supplier ("… Co., Ltd" / "… Co., Ltd.") share a
    // token signature and collapse to the first; a real rival at the same score
    // means the alias is ambiguous.
    const rivals = scored.filter(x => x.score >= best.score - 1e-9 && nameTokens(x.s.name).join(' ') !== nameTokens(best.s.name).join(' '));
    if (rivals.length)
        return null;
    return best.s;
}

/** Find the JFPRO supplier a PO's free-text supplier name refers to. Native
 *  records win over Shipsline-legacy ones at every step: a PO name that
 *  equals a legacy record still resolves to the native record that carries the
 *  terms. An alias only matches when it is unambiguous.
 *  @param {string|null|undefined} name
 *  @param {Map<string, MintSoftSupplier>} index
 *  @param {MintSoftSupplier[]} suppliers
 *  @returns {SupplierMatch|null} */
function matchSupplier(name, index, suppliers) {
    if (!normName(name))
        return null;
    const native = suppliers.filter(s => !isLegacySupplier(s));
    const legacy = suppliers.filter(isLegacySupplier);
    const exactIn = (pool) => pool.find(s => normName(s.name) === normName(name)) ?? pool.find(s => looseName(s.name) === looseName(name)) ?? null;
    const nativeExact = exactIn(native);
    if (nativeExact)
        return { supplier: nativeExact, how: 'exact' };
    const nativeAlias = aliasMatch(name, native);
    if (nativeAlias)
        return { supplier: nativeAlias, how: 'alias' };
    const legacyExact = exactIn(legacy) ?? (index.get(normName(name)) ?? index.get(looseName(name)) ?? null);
    if (legacyExact)
        return { supplier: legacyExact, how: 'legacy' };
    const legacyAlias = aliasMatch(name, legacy);
    if (legacyAlias)
        return { supplier: legacyAlias, how: 'legacy' };
    return null;
}

module.exports = {
    normName, looseName, indexSuppliersByName, isLegacySupplier, matchSupplier,
};
