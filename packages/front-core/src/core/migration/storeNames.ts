// Generation-scoped PXE store naming. Pure (no RPC, no @aztec runtime imports)
// so platform probes and test shims can consume it without the detection
// module's node-client dependency.
import { GENERATIONS } from "@obsidion/core/constants"
import type { GenerationManifestEntry } from "@obsidion/core/types"

/** Store-name prefix for a generation×network PXE store. */
export function generationStorePrefix(version: number, networkName: string): string {
  return `v${version}_${networkName}`
}

/** Physical base name of the pre-generation-prefix PXE store. */
export function legacyStoreBaseName(networkName: string): string {
  return `${networkName}_pxe_data`
}

/**
 * The generation that owns the pre-generation-prefix legacy store: exactly one
 * app lineage ever wrote unprefixed stores — the oldest generation, i.e. the
 * first entry (GENERATIONS is append-ordered). Adoption renames the legacy
 * store to THIS generation's prefix, and detection's legacy fallback probes
 * only for it. Keying on "any frozen entry" instead would mis-route under a
 * future two-frozen-generation manifest.
 */
export function prePrefixLineageVersion(
  generations: readonly GenerationManifestEntry[] = GENERATIONS,
): number {
  const oldest = generations[0]
  if (!oldest) throw new Error("GENERATIONS manifest is empty")
  return oldest.version
}
