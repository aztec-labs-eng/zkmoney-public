import { readFileSync } from "node:fs"
import { relative } from "node:path"
import { BaseSequencer, type WorkspaceSpec } from "vitest/node"

/**
 * Splits files into `count` shards by measured seconds, longest first onto the lightest shard. A
 * file with no measurement weighs the median, so a new file still lands in exactly one shard.
 */
export function durationShards(
  files: string[],
  seconds: Record<string, number>,
  count: number,
): string[][] {
  const known = Object.values(seconds).sort((a, b) => a - b)
  const fallback = known[Math.floor(known.length / 2)] ?? 1
  const weight = (file: string) => seconds[file] ?? fallback
  const shards = Array.from({ length: count }, () => ({ total: 0, files: [] as string[] }))
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min))
    lightest.files.push(file)
    lightest.total += weight(file)
  }
  return shards.map((shard) => shard.files)
}

/** `--shard=i/n` by measured duration instead of vitest's file-count split. */
export default class DurationShardSequencer extends BaseSequencer {
  async shard(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const { root, shard } = this.ctx.config
    if (!shard) return files
    const seconds = JSON.parse(
      readFileSync(new URL("./sandbox-durations.json", import.meta.url), "utf8"),
    )
    const path = (spec: WorkspaceSpec) => relative(root, spec.moduleId)
    const mine = new Set(durationShards(files.map(path), seconds, shard.count)[shard.index - 1])
    return files.filter((spec) => mine.has(path(spec)))
  }
}
