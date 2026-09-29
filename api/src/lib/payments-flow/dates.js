// Ported from ShipLine src/components/payments/paymentsFlowMath.ts @ f9499bc — changes: today required; dateOfInstant pinned to Europe/London
'use strict';

// Calendar math on 'YYYY-MM-DD' strings: epoch-day arithmetic, never
// new Date(string) for a calendar date. Deliberate difference from the TS:
// dateOfInstant is pinned to Europe/London (see below).
//
// Ported from ShipLine src/components/payments/paymentsFlowMath.ts at f9499bc
// (frozen until the JFlow PHASE2 step 17 cut-over): the TS with its types
// stripped (tsc transpileModule), split by concern. Behaviour, float money
// arithmetic and rounding are the TS's — change the TS first, never just this.
// Types: ./types.js.

const DAY_MS = 86_400_000;
const pad2 = (n) => String(n).padStart(2, '0');

/** Calendar date of any backend date string. Blank, `0000-00-00…` (a MySQL
 *  DATE written with '' — reads back as set, see api.ts encodeOrderPayload)
 *  and unparseable values → null. Datetime forms are sliced to their date.
 *  @param {string|null|undefined} v
 *  @returns {import('./types').Ymd|null} */
function dateOf(v) {
    if (v == null)
        return null;
    const s = String(v).trim();
    if (!s || /^0000-00-00/.test(s))
        return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m)
        return null;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31)
        return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

// The UK calendar, whatever the host's zone (Lambda runs in UTC).
const LONDON_YMD = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Calendar date, in the UK, of an instant string such as the shipment
 *  entity's `departedAt` ("2026-09-11T23:00:00.000Z" is the 12th in the UK).
 *  Plain dates and datetimes without a zone go through dateOf unchanged —
 *  slicing an instant would land a day early in summer.
 *  Deliberate difference from the TS, which used the host's zone (London in
 *  the browser, UTC on Lambda): pinned to Europe/London, so the server gives
 *  the page's answer. Everything else is the TS's.
 *  @param {string|null|undefined} v
 *  @returns {import('./types').Ymd|null} */
function dateOfInstant(v) {
    if (v == null)
        return null;
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s))
        return dateOf(s);
    const t = new Date(s);
    if (Number.isNaN(t.getTime()))
        return null;
    const part = {};
    for (const p of LONDON_YMD.formatToParts(t)) part[p.type] = p.value;
    return `${part.year}-${part.month}-${part.day}`;
}

function toEpochDay(d) {
    const [y, m, dd] = d.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, dd) / DAY_MS);
}

function fromEpochDay(n) {
    const dt = new Date(n * DAY_MS);
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** @param {import('./types').Ymd} d @param {number} n @returns {import('./types').Ymd} */
function addDays(d, n) {
    return fromEpochDay(toEpochDay(d) + n);
}

module.exports = {
    dateOf, dateOfInstant, addDays,
};
