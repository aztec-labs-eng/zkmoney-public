import {
  BaseError,
  ContractFunctionRevertedError,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem"
import { normalize } from "viem/ens"
import type { QueryEntry, QueryFactory } from "../../engine/query"

/** A client on the L1 whose ENS names the lookups resolve. */
export type EnsClient = Pick<PublicClient, "getEnsName" | "getEnsAddress">
/** The active L1's client, or null on a chain with no ENS registry. Read per lookup. */
export type GetEnsClient = () => EnsClient | null

function isNormalized(name: string): boolean {
  try {
    return normalize(name) === name
  } catch {
    return false
  }
}

/** An address's ENS primary name, or null for none. Readers take a failed lookup as none. */
export type EnsNames = (address: Address) => QueryEntry<string | null>

/** Primary-name lookups over `getClient`, one per address; a failed one is read again. */
export function ensNames(query: QueryFactory, getClient: GetEnsClient): EnsNames {
  return query<[Address], string | null>("ensName", {
    load: async (address) => {
      const primary = (await getClient()?.getEnsName({ address })) ?? null
      // ENSIP-19: an unnormalized primary name reads as none, so a look-alike name never shows.
      return primary && isNormalized(primary) ? primary : null
    },
  })
}

/**
 * ENS names' addresses over `getClient`. Never fresh: a stealth-address name (a Fluidkey
 * *.fkey.id) answers a new address per lookup.
 */
export function ensAddresses(query: QueryFactory, getClient: GetEnsClient) {
  return query<[name: string], Address | null>("ensAddress", {
    load: (name) => lookupEnsAddress(getClient, name),
    stale: 0,
  })
}

/** Dotted text with no empty label: what ENS's guidelines say to look up. */
export function looksLikeEnsName(text: string): boolean {
  return text.includes(".") && !text.split(".").includes("")
}

/** Typed text as a normalized ENS name, or undefined when it isn't one. */
export function ensNameOf(text: string): string | undefined {
  if (!looksLikeEnsName(text)) return undefined
  try {
    return normalize(text)
  } catch {
    return undefined
  }
}

/** Universal Resolver reverts that mean the name has no address, not that the lookup failed. */
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
const NO_ADDRESS = new Set([
  "ResolverNotFound",
  "ResolverNotContract",
  "UnsupportedResolverProfile",
])

/**
 * The address an ENS name points to, or null when it points nowhere. Throws when
 * the lookup itself fails (RPC, resolver, or offchain gateway). Uncached: stealth-address names
 * (e.g. Fluidkey *.fkey.id) answer a fresh address per lookup.
 */
export async function lookupEnsAddress(
  getClient: GetEnsClient,
  name: string,
): Promise<Address | null> {
  const client = getClient()
  if (!client) return null
  try {
    const address = await client.getEnsAddress({ name, strict: true })
    return address && address !== zeroAddress ? address : null
  } catch (err) {
    const revert =
      err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (
      revert instanceof ContractFunctionRevertedError &&
      NO_ADDRESS.has(revert.data?.errorName ?? "")
    )
      return null
    throw err
  }
}
