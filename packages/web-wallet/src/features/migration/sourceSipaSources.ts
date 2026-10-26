/**
 * A retired deployment's SIPAs and their swept deposits, found from chain data alone: the source
 * rollup's `SIPA` events and the L1 `Sweep` and `Deposit` logs. A new device finds them too.
 */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  deploymentScanRange,
  deriveBootstrapKey,
  deriveRefundableSipaSources,
  deriveStealthKey,
  scanSweptDeposits,
  setupSipaDiscovery,
} from "@obsidion/front-core"
import {
  fetchSipaEvents,
  predictAccountAddress,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import type { Address, PublicClient } from "viem"
import { getWebBroadcasterArtifact } from "../../config/classArtifacts"
import { getConfig } from "../../config/env"

export interface SourceSipaScan {
  /** The wallet and account on the deployment's rollup. */
  chain: { wallet: ObsidionWallet; account: ObsidionAccount }
  tuple: OxideEnvTuple
  /** The live deployment, whose resolver record a same-rollup roll re-points. */
  current: OxideEnvTuple
  publicClient: PublicClient
  masterSecret: Parameters<typeof deriveStealthKey>[0]
  /** One L1 head bounds every scan of one pass. */
  scanHead: bigint
}

export async function sourceSipaSources(o: SourceSipaScan) {
  const { chain, tuple, publicClient } = o
  // Registers the senders the deployment's `SIPA` events are tagged with: the resolver, and the
  // deployment's ClaimFPC for the broadcasts it sponsored.
  await setupSipaDiscovery({
    artifactFor: (address) => getWebBroadcasterArtifact(chain.wallet, address),
    pxe: chain.wallet.pxe as never,
    node: chain.wallet.node as never,
    publicClient,
    tuple,
    network: getConfig().network,
    resolverFallbackTuple: o.current,
    sponsorFpc: tuple.fpcBeneficiary
      ? AztecAddress.fromStringUnsafe(tuple.fpcBeneficiary)
      : undefined,
    scanHead: o.scanHead,
  })
  const recipient = chain.account.getAddress()
  const events = await fetchSipaEvents(
    chain.wallet,
    AztecAddress.fromStringUnsafe(tuple.l2Token),
    recipient as never,
  )
  return deriveRefundableSipaSources({
    events: events.map((event) => ({
      messageSecret: event.sharedSecretSalt.toString(),
      resweepable: event.resweepable,
      intentHash: event.intentHash,
    })),
    recipientL2Address: recipient.toString(),
    stealthPublicKey: deriveStealthKey(o.masterSecret).publicKey,
    tuple,
    // An account-protocol deployment commits its SIPAs to the owner's L1 account.
    recoveryAccount:
      tuple.sipaRecoveryProtocol === "account" && tuple.accountFactory
        ? await predictAccountAddress(
            publicClient,
            tuple.accountFactory as Address,
            deriveBootstrapKey(o.masterSecret).address,
          )
        : undefined,
  })
}

/** Every swept deposit of the deployment's SIPAs, plus those still holding L1 funds. Any gap throws. */
export async function sourceSweptDeposits(o: SourceSipaScan) {
  const sources = await sourceSipaSources(o)
  const range = await deploymentScanRange(o.publicClient, o.tuple, o.scanHead)
  return scanSweptDeposits(
    {
      publicClient: o.publicClient,
      portal: o.tuple.portal as Address,
      token: o.tuple.token as Address,
      fromBlock: range.fromBlock,
      head: range.toBlock,
    },
    sources,
  )
}
