/**
 * The witness a subscribe on the open (sponsored) rail rides: oxide's NamePortal message attesting
 * that this wallet's OxideAccount holds a name, plus the bootstrap key that binds the L2 address.
 *
 * Nothing is stored. The caller supplies the account and the name it holds, the message witnesses
 * are recovered by scanning the Inbox's `MessageSent` logs, and the binding signature re-derives
 * from the master secret — so a wallet restored on a fresh device rebuilds the whole set. A
 * subscription note already held makes the scan unnecessary.
 *
 * A subscribe cannot be built while no name is registered, no message has been emitted, one is in
 * the Inbox but the rollup has not imported it, or this FPC already consumed the only one with the
 * note still syncing; the route gate holds sponsored flows on those states.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  findRegistrationMessage,
  registrationInbox,
  REGISTRATION_MESSAGE_SECRET,
  type ClaimFpcGateWitness,
  type ObsidionWallet,
} from "@obsidion/sdk"
import type { VerifiedOxideIdentity } from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { buildOxideAccountBinding, type OnboardingKeys } from "./oxideOnboarding"

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
 * is in the Inbox but the rollup has not imported it (`messageHash` is what to wait on), or this
 * FPC consumed the only one — only this account could have — and the PXE has not synced the note.
 * `read-error` is none of those: a read failed, and the answer is unknown rather than negative.
 */
export type RegistrationPending =
  | { pending: "message" }
  | { pending: "import"; messageHash: Fr }
  | { pending: "note" }
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
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
): Promise<RegistrationGate> {
  if (!deps.identity) return { pending: "message" }
  const { account: oxideAccount, nameHash } = deps.identity
  const info = await deps.wallet.node.getNodeInfo()
  const publicClient = l1PublicClient(deps.config)

  const message = await findRegistrationMessage(
    registrationInbox(publicClient, info.l1ContractAddresses.inboxAddress),
    deps.wallet.node,
    {
      fpc: AztecAddress.fromStringUnsafe(deps.generation.fpcAddress),
      namePortal: EthAddress.fromString(deps.generation.namePortal),
      owner: EthAddress.fromString(oxideAccount),
      nameHash: Buffer.from(nameHash.replace(/^0x/, ""), "hex"),
      rollupVersion: info.rollupVersion,
    },
  )
  if (!message) return { pending: "message" }
  if (message.status === "pending") return { pending: "import", messageHash: message.messageHash }
  if (message.status === "consumed") return { pending: "note" }
  return {
    gate: {
      kind: "registration",
      ...(await buildOxideAccountBinding(keys, nameHash)),
      secret: REGISTRATION_MESSAGE_SECRET,
      leafIndex: new Fr(message.leafIndex),
    },
  }
}
