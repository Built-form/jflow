// Copied from workflows/web/src/build.d.ts — changes: none
/**
 * What `vite.config.ts` inlines at build time under `define`. Read it through
 * `src/config/build.ts` only — that module is the one place that knows the shape and
 * turns it into something a screen can show.
 */
declare const __BUILD__: {
  /** The version: `20260910.1231`, the UTC minute of the build. Moves on every build. */
  version: string;
  /** Full commit hash the bundle was built from. */
  commit: string | null;
  branch: string | null;
  /** The commit's subject line. */
  message: string | null;
  /** ISO timestamp of the build itself. */
  builtAt: string;
  /** Vercel's VERCEL_ENV (`production` | `preview` | `development`), or `local` for a hand build. */
  target: string;
  /** Vercel's deployment id, null off Vercel. */
  deploymentId: string | null;
};
