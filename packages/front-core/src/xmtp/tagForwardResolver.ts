import {
  TagValidationError,
  type RegistryTagResolution,
} from "../core/services/RegistryTagResolver.js"
import { normalizeTag } from "../utils/normalizeTag.js"
import type { ClaimedTagVerifier } from "./ConnectBackReceiver.js"
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

/**
 * Accept a scanner-claimed tag only when a fresh Registry read puts the tag's
 * bootstrap address on the sender's inbox. Invalid / unregistered / mismatched
 * tags return null (handle-only). A transport throw is rethrown so the receiver
 * defers rather than persisting a handle-only row that can never upgrade.
 */
export function createClaimedTagVerifier(
  resolveTag: (tag: string) => Promise<RegistryTagResolution>,
): ClaimedTagVerifier {
  return async (tag, senderXmtpAddresses) => {
    const bare = normalizeTag(tag)
    if (bare === null) return null
    let resolution: RegistryTagResolution
    try {
      resolution = await resolveTag(bare)
    } catch (cause) {
      if (cause instanceof TagValidationError) return null
      throw cause
    }
    if (resolution.status !== "resolved") return null
    if (!hasAddress(senderXmtpAddresses, resolution.xmtpAddress)) return null
    return { tag: bare, l2: resolution.l2Address }
  }
}

/** Case-insensitive membership of an Ethereum-format address. */
export function hasAddress(addresses: readonly string[], address: string): boolean {
  const needle = address.toLowerCase()
  return addresses.some((a) => a.toLowerCase() === needle)
}
