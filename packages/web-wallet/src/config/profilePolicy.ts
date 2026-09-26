/**
 * The web wallet's own rules for a resolved profile, kept pure and Node-safe: the boot path applies
 * them, and the build plugin applies the same ones before baking a snapshot, so a document the
 * wallet would refuse at boot cannot be baked. Nothing here may import browser or sdk code.
 */

import type { ResolvedWalletProfile } from "@obsidion/config-client"
import { Network } from "@obsidion/core/constants"
import type { OxideEnvProfile } from "@obsidion/core/types"

const NETWORKS: Record<string, Network> = {
  sandbox: Network.SANDBOX,
  testnet: Network.TESTNET,
  mainnet: Network.MAINNET,
}

/** Fail fast on unknown values — a typo'd network must never fall through to a default. */
export function parseNetwork(raw: string | undefined): Network {
  const key = raw ?? "sandbox"
  const network = NETWORKS[key]
  if (network === undefined) {
    throw new Error(`Unknown VITE_NETWORK "${key}" (expected sandbox|testnet|mainnet)`)
  }
  return network
}

type PolicyInput = Pick<ResolvedWalletProfile, "profile" | "versionId" | "snapshot">

const EPHEMERAL_MANIFEST = /\/(dev|sandbox)(\.v\d+)?\.json([?#]|$)/

/**
 * The version's oxide pointer, held to the release-guard invariants: present,
 * no dev/sandbox manifest on a durable network, a pinned mainnet cut. Returns a copy of the
 * pointer so callers seed one object.
 */
export function assertProfilePolicy(boot: PolicyInput, network: Network): OxideEnvProfile {
  const { profileId } = boot.profile
  // No pointer means no token, portal or tag resolution — refuse rather than boot without one.
  const oxide = boot.snapshot.oxide
  if (!oxide) {
    throw new Error(`profile "${profileId}" version "${boot.versionId}" has no oxide pointer`)
  }
  if (network === Network.MAINNET && !oxide.expectedGitSha) {
    throw new Error(
      `profile "${profileId}" resolves a mainnet oxide pointer with no expectedGitSha` +
        " — the manifest gate would degrade to schema-only and accept a different deploy cut.",
    )
  }
  if (network !== Network.SANDBOX && EPHEMERAL_MANIFEST.test(oxide.manifestUrl)) {
    throw new Error(
      `profile "${profileId}" resolves the oxide manifest to ${oxide.manifestUrl} — ` +
        "a dev or local manifest must not serve a durable network.",
    )
  }
  return { ...oxide }
}
