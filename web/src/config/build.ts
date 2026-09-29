// Copied from workflows/web/src/config/build.ts — changes: none
/**
 * The identity of THIS build of the frontend: which commit, from which branch, built
 * when and for which Vercel target. Collected by `vite.config.ts` while building and
 * inlined as `__BUILD__` (see `src/build.d.ts`) — the served bundle cannot find any of
 * this out for itself, so it is the only honest source.
 *
 * The version is the build's UTC minute — automatic, so it changes on every deploy.
 * The git fields can be null: a build outside git and off Vercel simply does not know
 * its commit, and the page says "unknown" rather than inventing one.
 */

export interface BuildInfo {
  version: string;
  commit: string | null;
  branch: string | null;
  message: string | null;
  builtAt: string;
  target: string;
  deploymentId: string | null;
}

export const BUILD: BuildInfo = { ...__BUILD__ };

/** The first seven characters — what git itself shows and what the test records carry. */
export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/** One line naming the build: `20260910.1231 (abc1234)`, the version and its commit. */
export function versionLabel(build: BuildInfo = BUILD): string {
  const commit = shortCommit(build.commit);
  return commit ? `${build.version} (${commit})` : build.version;
}
