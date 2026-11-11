import {
  TagValidationError,
  type RegistryTagResolution,
} from "../core/services/RegistryTagResolver.js"
import type { ITagForwardResolver } from "./receiverTypes.js"

/**
 * Sender-tag forward resolution over an injected Registry resolver — always a fresh registry
 * read, never the contact cache. Narrows the rich union to the receiver's contract:
 * `resolved` → `{ l2Address }`; notFound / staleRollup / invalid tag → null (permanent reject);
 * a transport throw is rethrown so the receiver defers and retries. Platforms supply only their
 * resolver binding.
 */
export function createTagForwardResolver(
  resolveTag: (tag: string) => Promise<RegistryTagResolution>,
): ITagForwardResolver {
  return {
    async resolveL2(tag: string): Promise<{ l2Address: string } | null> {
      let resolution: RegistryTagResolution
      try {
        resolution = await resolveTag(tag)
      } catch (cause) {
        if (cause instanceof TagValidationError) return null
        throw cause
      }
      return resolution.status === "resolved" ? { l2Address: resolution.l2Address } : null
    },
  }
}

/** Case-insensitive membership of an Ethereum-format address. */
export function hasAddress(addresses: readonly string[], address: string): boolean {
  const needle = address.toLowerCase()
  return addresses.some((a) => a.toLowerCase() === needle)
}
