import {
  BaseError,
  ContractFunctionRevertedError,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem"
import { normalize } from "viem/ens"

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

const names = new Map<string, Promise<string | null>>()

/** The address's ENS primary name, cached per address. Best effort: any failure reads as none. */
export function lookupEnsName(getClient: GetEnsClient, address: Address): Promise<string | null> {
  const key = address.toLowerCase()
  let name = names.get(key)
  if (!name) {
    name = (async () => {
      const primary = (await getClient()?.getEnsName({ address })) ?? null
      // ENSIP-19: an unnormalized primary name reads as none, so a look-alike name never shows.
      return primary && isNormalized(primary) ? primary : null
    })().catch(() => {
      names.delete(key)
      return null
    })
    names.set(key, name)
  }
  return name
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
