/** Reconstruct SIPA identities from `SIPA` events within the same rollup/deployment version. */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { Fr } from "@aztec/aztec.js/fields"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import { EthAddress } from "@aztec/foundation/eth-address"
import { isAllZeroHex } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"

import {
  computeAccountSIPAAddress,
  computeSIPAAddress,
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  type SipaK1Point,
} from "./sipa"
import type { RefundableSipaEvent, RefundableSipaSource } from "./refundableDeposits"

/**
 * This helper is intentionally intra-rollup: the events, tuple, deposit implementation and address
 * formula must all belong to the same deployed version.
 *
 * The implementation comes from the tuple and nowhere else. `SIPAFactory.implementationFor`
 * is keyed by rollup version, and several generations share one version, so it names the newest
 * generation's implementation rather than the one a retired generation's addresses commit to —
 * reading it here would derive an address no deposit was ever sent to. A tuple that publishes no
 * implementation predates the version-scoped scheme, so its SIPAs have a different address preimage
 * and are not derivable by this formula either: fail loudly rather than report zero balances.
 *
 * The tuple's `sipaRecoveryProtocol` selects the address preimage: a legacy-eoa deployment commits
 * to the stealth recovery address, an account deployment commits to the recovery commitment of
 * the owner's L1 account, which the caller supplies as `recoveryAccount`.
 */
export async function deriveRefundableSipaSources(args: {
  events: readonly RefundableSipaEvent[]
  recipientL2Address: string
  stealthPublicKey: SipaK1Point
  tuple: OxideEnvTuple
  recoveryAccount?: string
}): Promise<RefundableSipaSource[]> {
  const { sipaFactory, rollupVersion, depositSIPAImplementation } = args.tuple
  const accountProtocol = args.tuple.sipaRecoveryProtocol === "account"
  if (accountProtocol && !args.recoveryAccount) {
    throw new Error(
      `oxide tuple for portal ${args.tuple.portal} uses the account recovery protocol; SIPA ` +
        "discovery needs the owner's recovery account",
    )
  }
  if (!sipaFactory || !/^\d+$/.test(rollupVersion)) {
    throw new Error("oxide tuple lacks sipaFactory / numeric rollupVersion")
  }
  if (!depositSIPAImplementation || isAllZeroHex(depositSIPAImplementation)) {
    throw new Error(
      `oxide tuple for portal ${args.tuple.portal} publishes no depositSIPAImplementation — its ` +
        "SIPA addresses cannot be derived, and the factory's version pointer names another " +
        "generation's implementation",
    )
  }

  const recipient = AztecAddress.fromStringUnsafe(args.recipientL2Address)
  const implementation = EthAddress.fromString(depositSIPAImplementation)
  const seen = new Set<string>()
  const out: RefundableSipaSource[] = []
  for (const event of args.events) {
    const secret = Fr.fromString(event.messageSecret)
    const secretKey = secret.toString().toLowerCase()
    if (seen.has(secretKey)) continue
    seen.add(secretKey)
    const recipientCommitment = await computeStealthRecipientHash(secret, recipient)
    // Deposit intentData is the 32-byte recipient commitment; intentHash = keccak256 of it.
    const intentHash = keccak256(recipientCommitment.toBuffer())
    const common = {
      sipaFactory: EthAddress.fromString(sipaFactory),
      implementation,
      intentHash,
      rollupVersion: BigInt(rollupVersion),
      resweepable: event.resweepable,
    }
    const sipaAddress = accountProtocol
      ? computeAccountSIPAAddress({
          ...common,
          recoveryCommitment: deriveRecoveryCommitment(
            secret,
            EthAddress.fromString(args.recoveryAccount!),
          ),
        })
      : computeSIPAAddress({
          ...common,
          recoveryAddress: deriveRecoveryAddress(args.stealthPublicKey, secret),
        })
    out.push({
      sipaAddress: sipaAddress.toString(),
      recipientL2Address: args.recipientL2Address,
      messageSecret: secret.toString(),
      origin: "sipa-event",
    })
  }
  return out
}
