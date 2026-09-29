// Copied from workflows/web/vite.config.ts — changes: the setupFiles comment (JFlow has no src/mocks; setup.ts installs a refusing test transport)
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// ── The build's identity, stamped in at build time ───────────────────────────
// The About page shows which version of the frontend is running. That is not a
// runtime fact — a served bundle has no way to ask what it was built from — so it
// is collected here, once, while Vite is building, and inlined as `__BUILD__`
// (declared in `src/build.d.ts`, read only in `src/config/build.ts`).
//
// Vercel is the source of truth for a deploy: it sets VERCEL_GIT_COMMIT_SHA,
// VERCEL_GIT_COMMIT_REF, VERCEL_GIT_COMMIT_MESSAGE, VERCEL_ENV and
// VERCEL_DEPLOYMENT_ID in every build's environment (they are system variables,
// exposed by default; no VITE_ prefix is needed because this file runs in node,
// not in the browser). A local build has none of those, so it asks git instead.
// Nothing is guessed: a field that is not known is null, and the page says so.

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** The commit's subject line only — Vercel hands over the whole message, body included. */
function subject(message: string | null): string | null {
  return message?.split(/\r?\n/, 1)[0]?.trim() || null;
}

/**
 * The version, and it is nothing anyone bumps: the build's UTC minute,
 * `20260910.1231`. It changes on every build, sorts, reads as a date, and two
 * deploys can never share one. `package.json`'s version is deliberately NOT part
 * of it — a hand-moved number stays at 0.1.0 deploy after deploy and answers the
 * wrong question. A commit count would be the other honest choice, but Vercel
 * clones only the last ten commits, so it cannot be counted there.
 */
function version(at: Date): string {
  const iso = at.toISOString(); // 2026-09-10T12:31:07.000Z
  return `${iso.slice(0, 10).replace(/-/g, '')}.${iso.slice(11, 16).replace(':', '')}`;
}

function buildInfo() {
  const onVercel = env('VERCEL') === '1';
  const now = new Date();
  return {
    version: version(now),
    commit: env('VERCEL_GIT_COMMIT_SHA') ?? git('rev-parse HEAD'),
    branch: env('VERCEL_GIT_COMMIT_REF') ?? git('rev-parse --abbrev-ref HEAD'),
    message: subject(env('VERCEL_GIT_COMMIT_MESSAGE') ?? git('log -1 --format=%s')),
    builtAt: now.toISOString(),
    // 'production' | 'preview' | 'development' on Vercel; 'local' for a build made by hand.
    target: onVercel ? env('VERCEL_ENV') ?? 'vercel' : 'local',
    deploymentId: onVercel ? env('VERCEL_DEPLOYMENT_ID') : null,
  };
}

// The port is configurable because it is not a preference: Google refuses a sign-in from an
// origin that is not registered on the OAuth client, and the origin includes the port. Set
// VITE_DEV_PORT to one that is already authorised rather than editing this file.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  server: { port: Number(loadEnv(mode, process.cwd(), '').VITE_DEV_PORT) || 5180 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The terminal as always, plus the record the About page shows: every FULL run rewrites
    // `public/test-results/web.json`; a filtered run or a partial rerun leaves it alone.
    reporters: ['default', './tools/test-report.mjs'],
    // Installs a transport that refuses every un-stubbed call, so no test can reach a real
    // API — see the comment in that file.
    setupFiles: ['src/test/setup.ts'],
  },
}));
