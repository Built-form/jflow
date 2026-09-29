// Copied from workflows/api/src/services/events.js — changes: `withTimeout` only, extracted to its own module (JFlow has no events service); default message no longer says "event emit"
'use strict';

// Bound a promise in time. Used by lib/secrets.js so a slow or unreachable
// Secrets Manager (a NAT/VPC misconfiguration) is a fast, loud 500 with a clear
// log line instead of a gateway timeout on every cold start.

/** Reject after ms so a slow call cannot hold the caller's response open. */
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message || `timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
