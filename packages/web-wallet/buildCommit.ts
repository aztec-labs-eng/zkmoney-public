import { execFileSync } from "node:child_process"

/**
 * The source revision a bundle was built from, baked by `vite.config.ts` as `__BUILD_COMMIT__` and
 * logged once at boot. The deployed bundle is a static artifact with no git to ask, so the value is
 * resolved while the config loads: CI's `VITE_APP_VERSION` (the sha `bakedConfigProfile.ts` also
 * stamps into `build-target.json`), else the working tree's HEAD, else a placeholder — a build with
 * neither still ships.
 */

export const BUILD_COMMIT_UNKNOWN = "unknown"

/** Runs git and returns its stdout; throws when git or the repository is absent. */
export type GitRunner = (args: string[]) => string

const runGit: GitRunner = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

export function resolveBuildCommit(
  env: Record<string, string | undefined>,
  git: GitRunner = runGit,
): string {
  const ciRevision = env.VITE_APP_VERSION?.trim()
  if (ciRevision) return ciRevision
  let head: string
  try {
    head = git(["rev-parse", "HEAD"]).trim()
  } catch {
    return BUILD_COMMIT_UNKNOWN
  }
  if (!head) return BUILD_COMMIT_UNKNOWN
  try {
    return git(["status", "--porcelain"]).trim() ? `${head} (dirty)` : head
  } catch {
    return head
  }
}
