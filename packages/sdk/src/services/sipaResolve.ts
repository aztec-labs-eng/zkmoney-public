/**
 * SIPA name resolution — the sender-side CCIP-read (EIP-3668) resolve of
 * `<label>.<ensDomain>` to the recipient's counterfactual SIPA deposit
 * address. The Resolver module's `resolve` reverts with `OffchainLookup`; viem's
 * `ccipRead` performs the gateway HTTP leg and completes the round-trip
 * through `resolveWithProof` — all inside one `readContract`, so no proof
 * plumbing lives here. The proof only attests name→address integrity and is
 * verified in-place by the Resolver; the money path (funding the returned
 * address) is a plain ERC-20 transfer.
 *
 * Lives in sdk because these are contract reads; front-core never originates
 * a contract call.
 */

import type { Address, PublicClient } from "viem"
import { resolveName } from "@oxide/l1-contracts"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * CCIP-resolve `name` (e.g. `alice.oxidestaging.eth`) to a SIPA deposit address.
 * Throws on a zero-address result — funding the zero address is
 * unrecoverable, so an unresolvable name must never reach the send path.
 * The resolved address is single-use and short-lived (the resolver's
 * retention window); resolve fresh per deposit, never cache.
 */
export async function resolveSipaAddress(
  publicClient: PublicClient,
  sipaResolver: Address,
  name: string,
): Promise<Address> {
  const address = await resolveName(publicClient, sipaResolver, name)
  if (address.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`SIPA resolve returned the zero address for "${name}"`)
  }
  return address
}

/**
 * The SIPAFactory's on-chain CREATE2 predictor, re-exported so front-core
 * parity tests consume the contract read through
 * sdk instead of originating it themselves.
 */
export { predictSIPA } from "@oxide/l1-contracts"
