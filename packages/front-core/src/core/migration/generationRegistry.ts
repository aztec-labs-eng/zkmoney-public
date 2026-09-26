// Generation detection — which rollup generation is canonical RIGHT NOW, and
// which frozen generations still hold funds worth migrating. Canonicity is
// runtime-derived from the node's rollupVersion (a single binary spans the
// cutover, so the manifest's static `status` is a hint, never the truth).
//
// Trust split: a frozen generation's portal + L1 asset pin the exit verifier
// and the reclaim target, so consumers must take them from the on-chain
// registry (or chain-verify any fetched value) — this module only reports
// WHICH generations are in play. Node RPC only; no contract calls.

import { GENERATIONS } from "@obsidion/core/constants"
import { createNode } from "@obsidion/sdk"
import { getActiveGenerationNode } from "../activeGenerationNode.js"
import { getNodeApiKey } from "../nodeApiKey.js"
import type { GenerationManifestEntry } from "@obsidion/core/types"

export interface GenerationDetection {
  /** The node's reported on-chain rollup version. */
  onChainVersion: number
  /** Manifest entry matching the on-chain version; null = this build doesn't support it. */
  canonical: GenerationManifestEntry | null
  /** Frozen generations (≠ canonical) whose local store still holds state. */
  migratable: GenerationManifestEntry[]
  /** Frozen generations whose store probe threw — status unknown, NOT "none". */
  probeFailed: GenerationManifestEntry[]
  /** True when the on-chain version matches no embedded generation. */
  unsupported: boolean
  /** True when a `verifyCanonical` cross-check rejected the node's reported version (spoof guard). */
  spoofRejected: boolean
}

export interface DetectGenerationsOptions {
  /** Canonical node RPC URL (the endpoint the app is configured against). */
  nodeUrl: string
  /**
   * Probe: does this generation's local store hold funds/state for the acting
   * account? Platform-supplied.
   */
  hasLocalState: (generation: GenerationManifestEntry) => Promise<boolean>
  /** Manifest override for tests; defaults to the build's GENERATIONS. */
  generations?: readonly GenerationManifestEntry[]
  /** Node-info fetch override for tests; defaults to a real node client. */
  getRollupVersion?: (nodeUrl: string) => Promise<number>
  /**
   * Cross-check the node's reported version against the trustless on-chain
   * rollup registry (a node cannot spoof a cutover). Platform-injected
   * so this module stays contract-call-free; when it returns false the reported
   * version is rejected (canonical=null, spoofRejected=true).
   */
  verifyCanonical?: (version: number) => Promise<boolean>
}

async function fetchRollupVersion(nodeUrl: string): Promise<number> {
  // Prefer the canonical generation's node (published by the wallet) — a fresh
  // v5 client speaks aztec_* and fails against a v4 node. Falls back to a
  // fresh client only pre-boot; callers already tolerate a probe failure.
  const node = getActiveGenerationNode() ?? createNode(nodeUrl, getNodeApiKey())
  const info = await node.getNodeInfo()
  return Number(info.rollupVersion)
}

/**
 * Resolve the canonical generation from the chain and the migratable frozen
 * set from local state. Runs at launch and on re-check; a canonical flip
 * between calls is the cutover signal (the caller re-inits onto the new
 * generation's stack).
 */
export async function detectGenerations(
  options: DetectGenerationsOptions,
): Promise<GenerationDetection> {
  const generations = options.generations ?? GENERATIONS
  const getVersion = options.getRollupVersion ?? fetchRollupVersion

  const onChainVersion = await getVersion(options.nodeUrl)

  // Spoof guard: a node reporting a version the on-chain registry disagrees
  // with must not drive a cutover flip. Reject → treat as unsupported.
  const spoofRejected =
    options.verifyCanonical !== undefined && !(await options.verifyCanonical(onChainVersion))

  const canonical = spoofRejected
    ? null
    : generations.find((g) => g.version === onChainVersion) ?? null

  const frozen = generations.filter((g) => g.version !== onChainVersion)
  const migratable: GenerationManifestEntry[] = []
  const probeFailed: GenerationManifestEntry[] = []
  for (const gen of frozen) {
    // A probe throw is "unknown" (surface a re-check affordance), never
    // "migratable" and never silently folded into "none".
    try {
      if (await options.hasLocalState(gen)) migratable.push(gen)
    } catch {
      probeFailed.push(gen)
    }
  }

  return {
    onChainVersion,
    canonical,
    migratable,
    probeFailed,
    unsupported: canonical === null,
    spoofRejected,
  }
}

/** UI-facing migration state: whether to prompt, stay silent, or offer a re-check. */
export type MigrationCtaState = "has-migratable" | "none" | "unknown"

/**
 * Map a detection result to the prompt state: a real migratable balance
 * shows the CTA; a probe error is a distinct re-checkable "unknown", not "none",
 * so a transient failure never masquerades as "nothing to migrate".
 */
export function migrationCtaState(detection: GenerationDetection): MigrationCtaState {
  if (detection.migratable.length > 0) return "has-migratable"
  if (detection.probeFailed.length > 0) return "unknown"
  return "none"
}

// Store naming lives in ./storeNames (pure, no node-client import); re-exported
// here so detection consumers keep one import surface.
export { generationStorePrefix, legacyStoreBaseName, prePrefixLineageVersion } from "./storeNames"

/**
 * The manifest's canonical entry — the boot-time default generation. Offline
 * boot can't block on node detection, so stores open under this version;
 * `detectGenerations` is the runtime truth and a flip re-inits.
 */
export function manifestCanonicalVersion(
  generations: readonly GenerationManifestEntry[] = GENERATIONS,
): number {
  const canonical = generations.find((g) => g.status === "canonical")
  if (!canonical) throw new Error("GENERATIONS manifest has no canonical entry")
  return canonical.version
}

/** True only for a rollup version the manifest lists as frozen; unknown versions (sandbox, previews) are not. */
export function isFrozenGenerationVersion(
  version: number,
  generations: readonly GenerationManifestEntry[] = GENERATIONS,
): boolean {
  return generations.some((g) => g.version === version && g.status === "frozen")
}

/**
 * The canonical generation's `stack` ("v4" | "v5"). Selects the matching
 * version of a version-bearing bundled artifact — the standalone honk circuits
 * (zkJWT manifests + VK) must match the bb runtime. Defaults to "v5" for a
 * single-generation build whose canonical entry omits `stack`.
 */
export function canonicalGenerationStack(
  generations: readonly GenerationManifestEntry[] = GENERATIONS,
): "v4" | "v5" {
  const canonical = generations.find((g) => g.status === "canonical")
  if (!canonical) throw new Error("GENERATIONS manifest has no canonical entry")
  return canonical.stack ?? "v5"
}
