// Generation-scoped contract-artifact registry. Compiled artifacts for a frozen
// generation live only in that generation's build snapshot, which the platform
// layer can reach but front-core (and web) cannot import directly. The platform
// registers those inert blobs here at boot; front-core's loaders read them by
// (stack, name) and fall back to the canonical/v5 artifact when none is
// registered. Mirrors registerGenerationStack — data instead of adapters.

import type { NoirCompiledContract } from "@aztec/stdlib/noir"

const artifacts = new Map<string, Map<string, NoirCompiledContract>>()

/** Platform layer registers one embedded generation's compiled artifact once. */
export function registerGenerationArtifact(
  stack: string,
  name: string,
  artifact: NoirCompiledContract,
): void {
  let byName = artifacts.get(stack)
  if (!byName) {
    byName = new Map()
    artifacts.set(stack, byName)
  }
  byName.set(name, artifact)
}

/** The blob a loader picks when the canonical stack matches; undefined when unregistered. */
export function getRegisteredGenerationArtifact(
  stack: string,
  name: string,
): NoirCompiledContract | undefined {
  return artifacts.get(stack)?.get(name)
}

/** Test hook: drop all registrations. */
export function clearGenerationArtifacts(): void {
  artifacts.clear()
}
