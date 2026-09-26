/**
 * SIPA discovery setup — the one-time PXE wiring that lets a device discover
 * resolver-published SIPA deposits. The Labs resolver sends the token's `SIPA`
 * event from its L2 account, and the PXE only decodes events from registered
 * senders. So:
 *
 *   1. read the resolver records off the L1 `AccountMetadataRegistry` (sdk
 *      reads) and pick the one matching the live manifest portal,
 *   2. register the broadcast account as a discovery sender (v5:
 *      `registerTaggingSecretSource`; 4.3.0: `registerSender` — duck-typed),
 *   3. `pxe.registerContract(Broadcaster)` — instance from the node at the
 *      manifest's `l2Broadcaster`, artifact bundled via `@obsidion/contracts`
 *      (class-id parity pinned by the drift sentinel test there) — so the
 *      wallet can broadcast its own SIPAs' sweeps.
 *
 * Pure over injected collaborators (narrow PXE/node surfaces, viem client,
 * resolved tuple, network) so the sequence is testable without a PXE or RPC.
 * Shared by every wallet front end; the platform supplies the collaborators.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract"
import type { PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  Network,
  fetchSipaResolverOperators,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type SipaResolverOperatorRecord,
} from "@obsidion/sdk"
import { deploymentScanRange } from "./deploymentScanRange"
import { getGenerationBroadcasterArtifact } from "./generationBroadcasterArtifact"
import { canonicalGenerationStack } from "src/core"

/** The narrow PXE surface the setup drives. Registration shape is per-generation:
 * the 4.3.0 PXE takes the combined `{ instance, artifact }`, the v5 PXE splits
 * class and instance registration. */
export interface SipaDiscoveryPxe {
  /** 4.3.0 sender registration; the v5 PXE replaced it with registerTaggingSecretSource. */
  registerSender?(sender: AztecAddress): Promise<unknown>
  registerTaggingSecretSource?(source: {
    kind: "address-derived"
    sender: AztecAddress
  }): Promise<unknown>
  registerContractClass(artifact: ContractArtifact): Promise<unknown>
  registerContract(
    contract:
      | ContractInstanceWithAddress
      | { instance: ContractInstanceWithAddress; artifact: ContractArtifact },
  ): Promise<unknown>
}

/** The narrow node surface the setup drives. */
export interface SipaDiscoveryNode {
  getContract(address: AztecAddress): Promise<ContractInstanceWithAddress | undefined>
}

export interface SipaDiscoverySetup {
  /** The selected resolver-operator record (l2Address = the registered sender). */
  resolver: SipaResolverOperatorRecord
  /** The registered Broadcaster address (= the manifest `l2Broadcaster`). */
  broadcaster: AztecAddress
}

/**
 * Wire SIPA event discovery into the PXE against the resolved oxide env tuple.
 * Idempotent: `registerSender` / `registerContract` are PXE upserts, so
 * re-running on a later boot is safe.
 */
export async function setupSipaDiscovery(deps: {
  pxe: SipaDiscoveryPxe
  node: SipaDiscoveryNode
  publicClient: PublicClient
  tuple: OxideEnvTuple
  network: Network
  /**
   * Deployment whose resolver record to use when none matches `tuple` — a same-rollup roll
   * re-points the shared resolver at the new portal, but the sender identity discovery needs is
   * unchanged. Pass the live tuple when `tuple` is a retired one.
   */
  resolverFallbackTuple?: OxideEnvTuple
  /**
   * The ClaimFPC that sponsors this wallet's own broadcasts. Sponsored calls run with the FPC as
   * `msg_sender`, so the events they emit are tagged with it — a PXE that did not emit them locally
   * discovers them only once the FPC is a registered sender.
   */
  artifactFor?: (address: AztecAddress) => Promise<ContractArtifact>
  sponsorFpc?: AztecAddress
  /**
   * Upper bound for the operator scan. A caller running several scans over one deployment passes
   * the head it bounded the others by, so one pass reports against one tip; absent, the head is
   * read here.
   */
  scanHead?: bigint
}): Promise<SipaDiscoverySetup> {
  const { pxe, node, publicClient, tuple, network } = deps
  const { accountMetadataRegistry, portal, l2Broadcaster } = tuple
  if (!accountMetadataRegistry || !portal || !l2Broadcaster) {
    throw new Error(
      "oxide manifest lacks the SIPA surface " +
        "(accountMetadataRegistry / portal / l2Broadcaster) — " +
        "SIPA discovery requires a dev.json-shaped deployment",
    )
  }

  // sdk's reads are typed against @aztec/viem; a plain-viem client is
  // runtime-identical but nominally distinct to tsc — bridge at the call boundary.
  const records = await fetchSipaResolverOperators(
    publicClient as unknown as Parameters<typeof fetchSipaResolverOperators>[0],
    accountMetadataRegistry as Parameters<typeof fetchSipaResolverOperators>[1],
    // The retired tuple's own window: it starts before the live deployment, so the fallback
    // record is inside it too.
    await deploymentScanRange(publicClient, tuple, deps.scanHead),
  )
  // updateResolverOperator is permissionless, so match the gateway URL too and apply the
  // shared per-network anti-squatter policy — a squatter can copy every record
  // field except the owner key (testnet prefers the known operator; mainnet
  // fails closed on ambiguity).
  const select = (t: OxideEnvTuple) =>
    selectManifestResolverOperator(records, {
      portal: t.portal,
      resolverGatewayUrl: t.resolverGatewayUrl,
      ...resolverSelectionPolicy(network),
    })
  let resolver: SipaResolverOperatorRecord
  try {
    resolver = select(tuple)
  } catch (error) {
    if (!deps.resolverFallbackTuple) throw error
    resolver = select(deps.resolverFallbackTuple)
  }
  await registerSender(pxe, AztecAddress.fromStringUnsafe(resolver.l2Address))
  if (deps.sponsorFpc) await registerSender(pxe, deps.sponsorFpc)

  const broadcaster = AztecAddress.fromStringUnsafe(l2Broadcaster)
  const instance = await node.getContract(broadcaster)
  if (!instance) {
    throw new Error(`Broadcaster instance not found at ${l2Broadcaster}`)
  }
  const artifact = deps.artifactFor
    ? await deps.artifactFor(broadcaster)
    : await getGenerationBroadcasterArtifact()
  if (canonicalGenerationStack() === "v4") {
    await pxe.registerContract({ instance, artifact })
  } else {
    await pxe.registerContractClass(artifact)
    await pxe.registerContract(instance)
  }

  return { resolver, broadcaster }
}

// Duck-typed like registerContractInPXE: the v5 PXE registers senders via
// registerTaggingSecretSource; the 4.3.0 PXE via registerSender.
async function registerSender(pxe: SipaDiscoveryPxe, sender: AztecAddress): Promise<void> {
  if (typeof pxe.registerTaggingSecretSource === "function") {
    await pxe.registerTaggingSecretSource({ kind: "address-derived", sender })
  } else if (typeof pxe.registerSender === "function") {
    await pxe.registerSender(sender)
  } else {
    throw new Error(
      "SIPA discovery: PXE exposes neither registerTaggingSecretSource nor registerSender",
    )
  }
}
