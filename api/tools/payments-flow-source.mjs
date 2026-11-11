// The ShipLine source the payments-flow port is pinned to: one commit, and the
// files of it the model runs. Shared by tools/payments-flow-port.mjs (which
// builds src/lib/payments-flow/model.js from them) and
// tools/payments-flow-oracle.mjs (which runs them to write the golden expected
// files). Re-pin = move SOURCE here, rebuild the port, re-run the oracle.
//
// Hashes are over the text with CRLF folded to LF; `lines` counts lines the
// same way (a final newline adds none).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Re-pinned 2026-11-11 from 77577a1 (2026-10-06) to 362714c (2026-11-03), the
// model file's newest commit on ShipLine main and test: paid-with containers on
// PI transfer lines, combined / repackaged goods, deposits paid before their PI,
// paid containers against their own goods (credits, shortfalls), QC units
// overdue and not payable yet, boxes booked in through Receive.
// paymentsFlowMath.ts's runtime imports: paymentReviews.ts (the key builders,
// lib/payments-flow/keys.js) and containerHelpers.ts (lib/payments-flow/containers.js).
// Its import of orderHelpers.ts (containerHasLanded) is unused, so the
// transpile drops it; tools/payments-flow-port.mjs fails if that changes.
export const SOURCE = {
    commit: '362714c',
    files: {
        'src/components/payments/paymentsFlowMath.ts': { lines: 4696, sha256: '300e18f8b217a29eb53bb88c8fac15127c2f80c68ec7f5ccc5a31f55a91224bf' },
        'src/components/shared/containerHelpers.ts': { lines: 340, sha256: '50065005de3aca01d1c93ffe552fae542b6ca51b68bcd30724cf2c6681ad6f98' },
        'src/components/payments/paymentReviews.ts': { lines: 213, sha256: '7bca087364c88bde1ff2d16b9dbd4c09071d24d51d21ab84fb0a8674b0380f2d' },
    },
};

/** The text of `rel` under `dir`, CRLF folded to LF, with its line count and sha256. */
export function readSourceFile(dir, rel) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) throw new Error(`${file} not found`);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    return {
        text,
        lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    };
}

/**
 * Every pinned file under `dir`, checked against SOURCE. Throws on a missing
 * file, and on one whose hash or line count differs unless `allowOther`.
 * @returns {{ commit: string, files: Record<string, { lines: number, sha256: string }>, text: Record<string, string> }}
 */
export function checkSource(dir, { allowOther = false } = {}) {
    const out = { commit: SOURCE.commit, files: {}, text: {} };
    for (const [rel, want] of Object.entries(SOURCE.files)) {
        const got = readSourceFile(dir, rel);
        if ((got.sha256 !== want.sha256 || got.lines !== want.lines) && !allowOther) {
            throw new Error(`${rel} is not the pinned ${SOURCE.commit} copy (${got.lines} lines, sha256 ${got.sha256}); pass --allow-other-source to use it anyway`);
        }
        out.files[rel] = { lines: got.lines, sha256: got.sha256 };
        out.text[rel] = got.text;
    }
    return out;
}
