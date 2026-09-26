/**
 * SIPA resolver-operator discovery — the L1 `AccountMetadataRegistry` reads that locate
 * the Labs operator's L2 broadcast account. The env manifest does not carry that address;
 * the on-chain `ResolverOperator` record is the only source. The caller
 * feeds `l2Address` to `pxe.registerSender`
 * so the PXE can discover the operator's broadcast SIPA notes.
 *
 * The registry keeps no operator enumeration, so the candidate set comes from the
 * `ResolverOperatorUpdated` history: one log per (re-)registration, deduped by
 * operator address, then each survivor's current record read back on-chain.
 *
 * Lives in sdk because these are contract reads; front-core never originates
 * a contract call.
 */

import type { Address, Hex, PublicClient } from "viem"
import { AccountMetadataRegistryAbi, readResolverOperator } from "@oxide/l1-contracts"
import { chunkedContractEvents } from "./l1Logs.js"
import { Network } from "@obsidion/core/constants"
import type { SipaK1Point } from "./sipaStealth.js"

export interface SipaResolverOperatorRecord {
  /** The operator's L1 record-owner EOA (the `setResolverOperator` caller). */
  owner: Address
  /** The L2 account the operator broadcasts SIPA notes from — the `registerSender` target. */
  l2Address: Hex
  /** The operator's CCIP gateway URL template. */
  url: string
  /** The TEE portal the operator's SIPAs deposit into, baked into their deposit implementation. */
  oxidePortal: Address
  /** The operator's stealth-derivation key — the ECDH counterparty a self-resolving
   * recipient derives against, not the recipient's own key. */
  resolverPublicKey: SipaK1Point
}

/**
 * Every resolver operator the AccountMetadataRegistry recorded in `range`, at its current values.
 * An operator whose record was never written (or was zeroed) is dropped — an empty `url` is the
 * registry's uninitialized sentinel.
 *
 * `range` is required and has no default: selection here is an anti-squatter decision, and a window
 * that hides the legitimate operator while showing a recent impostor turns the preferred-owner
 * tie-break and the mainnet ambiguity check into a silent first-match. Pass a window that starts
 * at or before the deployment whose portal you will select for — its record cannot predate it.
 */
export async function fetchSipaResolverOperators(
  publicClient: PublicClient,
  accountMetadataRegistry: Address,
  range: { fromBlock: bigint; toBlock: bigint },
): Promise<SipaResolverOperatorRecord[]> {
  const logs = await chunkedContractEvents(
    publicClient,
    {
      address: accountMetadataRegistry,
      abi: AccountMetadataRegistryAbi,
      eventName: "ResolverOperatorUpdated",
    },
    range.fromBlock,
    range.toBlock,
  )
  const owners = [
    ...new Map(
      logs
        .map((log) => (log as { args?: { resolverOperator?: Address } }).args?.resolverOperator)
        .filter((owner): owner is Address => !!owner)
        .map((owner) => [owner.toLowerCase(), owner] as const),
    ).values(),
  ]
  const records = await Promise.all(
    owners.map(async (owner) => {
      const {
        l2Address,
        url,
        oxidePortal,
        publicKey: resolverPublicKey,
      } = await readResolverOperator(publicClient, accountMetadataRegistry, owner)
      return { owner, l2Address, url, oxidePortal, resolverPublicKey }
    }),
  )
  return records.filter((record) => record.url.length > 0)
}

/**
 * The known Labs resolver-operator EOA on the CURRENT staging deployment, used ONLY
 * as the anti-squatter tie-break (`preferredOwner`) when selecting among
 * manifest-matched operator records — `setResolverOperator` is permissionless and
 * the owner key is the one record field a squatter cannot copy. It is NOT authoritative
 * and MUST NOT be recorded into `UserRecord.resolverOperator` directly: operators rotate on
 * oxide deployment rolls, and a stale owner baked into the user record makes every
 * subsequent resolve of that tag revert with
 * `AccountMetadataRegistry__ResolverOperatorNotFound`. Staleness HERE degrades gracefully
 * (selection falls back to the manifest-matched record) but silently forfeits the squatter
 * defense — refresh this alongside the vendor pin on each roll (the live staging registry's
 * `ResolverOperatorUpdated` history).
 */
export const PREFERRED_RESOLVER_OWNER: Address = "0xe959F1c4F84C55c10114f3FA46a8DcFB51ab8d30"

/**
 * Per-network anti-squatter policy for `selectManifestResolverOperator`, shared by
 * ALL resolver-operator callers (signup, SIPA deposit discovery, and the ClaimFPC deploy that pins
 * the operator key its users must derive against) so they can't drift — a deploy pinning one
 * resolver's key while clients derive against another rejects every proof.
 * Testnet/sandbox use the known staging operator as the `preferredOwner`
 * tie-break; the first mainnet build ships with NO known operator and instead
 * fails closed on multiple manifest-matching candidates rather than silently
 * first-matching. If oxide later designates a canonical mainnet resolver owner
 * it becomes a manifest/config value.
 */
export function resolverSelectionPolicy(network: Network): {
  preferredOwner?: Address
  failOnAmbiguousMatch: boolean
} {
  return network === Network.MAINNET
    ? { failOnAmbiguousMatch: true }
    : { preferredOwner: PREFERRED_RESOLVER_OWNER, failOnAmbiguousMatch: false }
}

/**
 * Pick the operator whose record matches the manifest's portal (+ gateway URL
 * when the manifest carries one) — i.e. the operator publishing for the
 * CURRENT deployment. Operator records survive deployment rolls, so a
 * multi-record array can contain stale entries pointing at retired portals;
 * selecting one of those would register a sender that never broadcasts for
 * deposits on the live portal. `setResolverOperator` is permissionless, so a
 * squatter can also register manifest-matching values — callers that know
 * the operator's EOA pass it as `preferredOwner`, which wins over any other
 * candidate (a squatter can copy every record field except the owner key).
 * A caller with no known operator (e.g. the first mainnet build) sets
 * `failOnAmbiguousMatch` so multiple manifest-matching candidates fail closed
 * rather than silently first-matching a possible squatter.
 */
export function selectManifestResolverOperator(
  records: SipaResolverOperatorRecord[],
  manifest: {
    portal: string
    resolverGatewayUrl?: string
    preferredOwner?: string
    failOnAmbiguousMatch?: boolean
  },
): SipaResolverOperatorRecord {
  const candidates = records.filter(
    (record) =>
      record.oxidePortal.toLowerCase() === manifest.portal.toLowerCase() &&
      (!manifest.resolverGatewayUrl || record.url === manifest.resolverGatewayUrl),
  )
  if (candidates.length === 0) {
    throw new Error(
      `no resolver-operator record matches the manifest portal ${manifest.portal} ` +
        `(${records.length} registered operator(s))`,
    )
  }
  const preferred =
    manifest.preferredOwner &&
    candidates.find(
      (record) => record.owner.toLowerCase() === manifest.preferredOwner!.toLowerCase(),
    )
  if (preferred) return preferred
  if (manifest.failOnAmbiguousMatch && candidates.length > 1) {
    throw new Error(
      `${candidates.length} resolver-operator records match the manifest portal ${manifest.portal} ` +
        `and no preferred owner disambiguates them — refusing to first-match ` +
        `(anti-squatter fail-closed).`,
    )
  }
  return candidates[0]!
}
