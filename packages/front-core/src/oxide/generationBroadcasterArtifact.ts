// Generation-aware Broadcaster artifact.
//
// The broadcaster's compiled artifact carries per-function verification keys,
// and noir emits a different VK size per version (v4 4064 / v5 4576 fields).
// registerContractClass validates those VKs against the generation's bb, so a v5 artifact
// fails registration into a v4 PXE with
// `mega_vk_as_fields: wrong size expected 4064 got 4576`.
//
// The sdk barrel's getBroadcasterArtifact bundles only the v5 artifact. On a
// v4-canonical build the platform registers the v4 blob (registerGenerationArtifact,
// under "sipaBroadcaster"); here we pick it by canonical stack, else the v5 default.

import { loadContractArtifact } from "@aztec/stdlib/abi"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import { getBroadcasterArtifact } from "@obsidion/sdk"
import { canonicalGenerationStack, getRegisteredGenerationArtifact } from "src/core"

let _cached: Promise<ContractArtifact> | null = null

export function getGenerationBroadcasterArtifact(): Promise<ContractArtifact> {
  _cached ??= (async () => {
    if (canonicalGenerationStack() === "v4") {
      const v4 = getRegisteredGenerationArtifact("v4", "sipaBroadcaster")
      if (!v4) {
        throw new Error(
          "No v4 SIPABroadcaster artifact registered; the platform must call registerGenerationArtifact at v4 boot",
        )
      }
      return loadContractArtifact(v4)
    }
    return getBroadcasterArtifact()
  })().catch((e) => {
    // Not cached: a v4 device that hasn't registered its blob yet may retry after boot completes.
    _cached = null
    throw e
  })
  return _cached
}
