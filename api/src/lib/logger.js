// Copied from workflows/api/src/lib/logger.js — changes: none
'use strict';

// Structured, timestamped console logger. Same shape/behaviour as ShipLine's
// src/lib/logger.js so log lines look identical across the two services.
//
// LOG_LEVEL (error | warn | info, default info) gates emission BEFORE the
// timestamp/stringify work — some call sites log objects inside per-row loops,
// so a suppressed level must cost nothing.

const LEVELS = { error: 0, warn: 1, info: 2 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function formatLog(level, args) {
    const timestamp = new Date().toISOString();
    const msg = args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        // A circular argument must not THROW from inside the error path —
        // log.error is called by serverError, and a throw here left the
        // request hanging to gateway timeout instead of returning its 500.
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    return `[${timestamp}] [${level}]  ${msg}`;
}

module.exports = {
    info: (...args) => { if (threshold >= LEVELS.info) console.log(formatLog('INFO', args)); },
    warn: (...args) => { if (threshold >= LEVELS.warn) console.warn(formatLog('WARN', args)); },
    error: (...args) => { if (threshold >= LEVELS.error) console.error(formatLog('ERROR', args)); },
};
