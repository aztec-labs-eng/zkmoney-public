import type { Address, PublicClient } from "viem"
import type { Network } from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"

import {
  RegistryTagResolver,
  type RegistryTagResolution,
} from "../core/services/RegistryTagResolver"
import { loadOxideManifestTuple } from "./loadOxideManifestTuple"

export interface RegistryTagResolutionOpts {
  /** L1 read client. */
  publicClient: PublicClient
  /** Pinned manifest URL. */
  manifestUrl: string
  portal: string
  /** Network — MAINNET gates the manifest load. */
  network: Network
  /** Required on MAINNET. */
  expectedGitSha?: string
  /**
   * Pre-loaded manifest tuple — skips the fetch (a platform's cached tuple for debounced
   * type-ahead). Omit on commit-path calls so the resolver reads a fresh manifest.
   */
  tuple?: OxideEnvTuple
}

/**
 * Recipient-side forward tag resolution against the oxide Registry — the shared wiring behind every
 * send / add-contact / QR / incoming-transfer lookup. Loads the a1 env tuple, constructs
 * `RegistryTagResolver` with the live rollup version baked in, so every recipient-side caller
 * resolves identically instead of re-deriving it. Config comes in as opts so the
 * platform supplies its own manifest URL / L1 client / chain.
 */
async function buildResolver(
  opts: RegistryTagResolutionOpts,
): Promise<{ resolver: RegistryTagResolver; currentRollupVersion: bigint }> {
  const tuple =
    opts.tuple ??
    (await loadOxideManifestTuple({
      manifestUrl: opts.manifestUrl,
      portal: opts.portal,
      network: opts.network,
      expectedGitSha: opts.expectedGitSha,
    }))
  if (!tuple.registry || !tuple.accountMetadataRegistry || !tuple.ensDomain) {
    throw new Error(
      "oxide manifest lacks the Registry surface " +
        "(registry / accountMetadataRegistry / ensDomain) — " +
        "forward tag resolution requires a dev.json-shaped deployment",
    )
  }
  // rollupVersion scopes the resolved record to the live rollup (a record on a different rollup
  // surfaces as staleRollup), so a missing/blank value must fail hard rather than coerce to 0n.
  if (!/^\d+$/.test(tuple.rollupVersion ?? "")) {
    throw new Error(
      `oxide manifest has a missing or non-numeric rollupVersion ("${tuple.rollupVersion}") — ` +
        "forward tag resolution needs it to scope the record to the rollup",
    )
  }
  const resolver = new RegistryTagResolver({
    client: opts.publicClient,
    registry: tuple.registry as Address,
    accountMetadataRegistry: tuple.accountMetadataRegistry as Address,
    ensDomain: tuple.ensDomain,
  })
  return { resolver, currentRollupVersion: BigInt(tuple.rollupVersion) }
}

/**
 * Resolve a bare tag to its Registry record, scoped to the live rollup. Throws `TagValidationError`
 * on invalid input and rethrows RPC/transport failures; a confirmed unregistered name is `notFound`,
 * a record on another rollup is `staleRollup`.
 */
export async function resolveTagViaRegistry(
  tag: string,
  opts: RegistryTagResolutionOpts,
): Promise<RegistryTagResolution> {
  const { resolver, currentRollupVersion } = await buildResolver(opts)
  return resolver.resolveTag(tag, currentRollupVersion)
}

/**
 * Availability probe for onboarding: `true` when the name maps to any Registry account (registered,
 * including a record on a stale rollup), `false` when the name is free to claim.
 */
export async function isTagRegisteredOnRegistry(
  tag: string,
  opts: RegistryTagResolutionOpts,
): Promise<boolean> {
  const resolution = await resolveTagViaRegistry(tag, opts)
  return resolution.status !== "notFound"
}
