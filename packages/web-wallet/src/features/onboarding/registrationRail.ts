/**
 * The witness a subscribe on the open (sponsored) rail rides: oxide's NamePortal message attesting
 * that the account of this wallet's bootstrap key holds a name, plus a proof that the wallet holds
 * that key.
 *
 * Nothing is stored. The caller supplies the name the account holds, the message's leaf index is
 * recovered by scanning the Inbox's `MessageSent` logs, and the key proof re-derives from the master
 * secret — so a wallet restored on a fresh device rebuilds the whole set. A subscription note
 * already held makes the scan unnecessary.
 *
 * A subscribe cannot be built while no name is registered, no message has been emitted, or one is
 * in the Inbox but the rollup has not imported it; the route gate holds sponsored flows on those
 * states.
 */
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  findRegistrationMessage,
  readPortalChainIdentity,
  registrationInbox,
  type ClaimFpcGateWitness,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  deriveBootstrapKey,
  registrationKeyProof,
  type VerifiedOxideIdentity,
} from "@obsidion/front-core"
import type { Hex } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient, rollupScanFloor } from "../../config/oxideTuple"
import type { OnboardingKeys } from "./oxideOnboarding"

export interface RegistrationRailDeps {
  wallet: ObsidionWallet
  config: WebWalletConfig
  /**
   * The L1 account the portal attested about and the name it holds, or undefined when no published
   * generation holds a name for this wallet's key.
   */
  identity: VerifiedOxideIdentity | undefined
  /**
   * The generation this gate evaluates against. A ClaimFPC pins its registry, account factory and
   * NamePortal in its on-chain Config, so a gate read against any other generation can never
   * satisfy it.
   */
  generation: { fpcAddress: string; namePortal: string }
}

/**
 * Why the sponsored rail cannot bill this account yet: this wallet's OxideAccount holds no name, or
 * the portal has sent no message about it (the registration is still being swept), or the message
 * is in the Inbox but the rollup has not imported it (`messageHash` is what to wait on).
 * `read-error` is none of those: a read failed, and the answer is unknown rather than negative.
 */
export type RegistrationPending =
  | { pending: "message" }
  | { pending: "import"; messageHash: Fr }
  | { pending: "read-error" }

/** The registration gate's witness, or the wait for a message the rollup can prove against. */
export type RegistrationGate = { gate: ClaimFpcGateWitness } | RegistrationPending

/** Thrown when a sponsored batch needs a subscribe the registration message cannot yet gate. */
export class RegistrationPendingError extends Error {
  constructor(readonly state: RegistrationPending) {
    super("your registration has not reached the network yet")
    this.name = "RegistrationPendingError"
  }
}

export async function registrationGateWitness(
  deps: RegistrationRailDeps,
  keys: Pick<OnboardingKeys, "secretKey">,
): Promise<RegistrationGate> {
  if (!deps.identity) return { pending: "message" }
  const { nameHash } = deps.identity
  const publicClient = l1PublicClient(deps.config)
  // The message binds chain id and rollup version: the wallet's pinned identity. The Inbox to scan
  // is the portal's word on L1, not the node's.
  const [{ l1ChainId, rollupVersion }, { inboxAddress }] = await Promise.all([
    deps.wallet.getNodeIdentity(),
    readPortalChainIdentity(
      publicClient,
      deps.config.oxideProfile.portal as Hex,
      deps.config.l1ChainId,
    ),
  ])

  const message = await findRegistrationMessage(
    registrationInbox(publicClient, inboxAddress as Hex),
    deps.wallet.node,
    {
      fpc: AztecAddress.fromStringUnsafe(deps.generation.fpcAddress),
      namePortal: EthAddress.fromString(deps.generation.namePortal),
      bootstrap: EthAddress.fromString(deriveBootstrapKey(keys.secretKey).address),
      nameHash: Buffer.from(nameHash.replace(/^0x/, ""), "hex"),
      rollupVersion,
      l1ChainId,
    },
    { fromBlock: await rollupScanFloor(deps.config, publicClient, String(rollupVersion)) },
  )
  if (!message) return { pending: "message" }
  if (message.status === "pending") return { pending: "import", messageHash: message.messageHash }
  return {
    gate: {
      kind: "registration",
      ...registrationKeyProof(keys.secretKey, nameHash),
      leafIndex: new Fr(message.leafIndex),
    },
  }
}
