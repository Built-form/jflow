// Copied from workflows/api/src/lib/sql.js — changes: none
'use strict';

// Statement splitter for .sql migration files, shared by the two things that
// execute them: tools/migrate.js (the CLI runner) and src/lib/schema.js
// (ensureSchema, on Lambda cold start).
//
// It lives in src/lib rather than tools/ so the dependency points the right way:
// the Lambda package must not require anything out of tools/, or a future
// package.patterns exclusion would break cold start in a way that only shows up
// in a deployed environment.
//
// Logic copied verbatim from DispatchLine's tools/migrate.js. No DELIMITER /
// stored-procedure support — the migrations don't use any.

// Split a .sql file into individual statements: strip `-- ` comments (quote-aware,
// so a `--` inside a string literal survives) and split on `;` terminators.
function splitStatements(sql) {
    const statements = [];
    let cur = '';
    let inSingle = false, inDouble = false, inBacktick = false;
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (!inSingle && !inDouble && !inBacktick && c === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i++; // skip to end of line
            cur += '\n';
            continue;
        }
        if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
        else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
        else if (c === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
        // Only a `;` OUTSIDE any quoted literal terminates a statement — a `;`
        // inside a string/identifier is part of the statement, not a separator.
        if (c === ';' && !inSingle && !inDouble && !inBacktick) {
            const t = cur.trim();
            if (t) statements.push(t);
            cur = '';
            continue;
        }
        cur += c;
    }
    const tail = cur.trim();
    if (tail) statements.push(tail);
    return statements;
}

module.exports = { splitStatements };
