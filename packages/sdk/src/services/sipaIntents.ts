import type { LegacySipaDeployArgs } from "@oxide/l1-contracts/legacy_sipa.js"
import { EthAddress } from "@aztec/foundation/eth-address"
/**
 * SIPA intent builders — the wallet-side wrappers over the vendored intent codec.
 *
 * Every SIPA commits to one word, `intentHash = keccak256(intentData)`, and its CREATE2
 * address commits to `(implementation, intentHash, plumbing)` where the implementation IS
 * the intent type (a `DepositSIPA` / `RegistrationSIPA` clone). `intentData` and any
 * `proofs` are revealed at sweep. The record encoders, the deploy/sweep/predict encoders,
 * and the payload frame all live in `@oxide/l1-contracts`; these builders assemble the
 * `(implementation, intentHash, intentData, proofs)` tuple one intent at a time and pack it
 * for the L2 broadcast.
 */

import type { AztecAddress } from "@aztec/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import type { Fr } from "@aztec/aztec.js/fields"
import {
  encodeDepositIntentData,
  buildSipaDeployAndSweepOperation,
  buildSipaSweepOperation,
  depositPayoutTokenFor,
  DepositSubsidyAbi,
  predictSIPA,
  type SipaDeployArgs,
  encodeRegistrationIntentData,
  encodeRegistrationProofs,
  readSIPAImplementation,
  SipaIntent as OxideSipaIntent,
  type DomainAuthArg,
  type R1InstallArg,
  type RegistrationIntent,
  type SignedTermsArg,
} from "@oxide/l1-contracts"
import {
  broadcastL1Operation,
  type L1OperationBroadcaster,
} from "@oxide/oxide-client/broadcaster_calls.js"
import { notifySipaRecipient, type SipaNotifier } from "@oxide/oxide-client/sipa_event_calls.js"
import {
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import { keccak256, toHex, type Address, type Hex, type PublicClient } from "viem"

/**
 * An unset pointer reads as the zero address rather than reverting. Deriving over it yields an
 * address whose clone can never run code, so a deposit sent there is unreachable — and a fee read
 * against it would quote zero, which reads as "everything is sweepable". Fail closed instead.
 *
 * The reads themselves come from `@oxide/l1-contracts` rather than a local ABI: the pointers are
 * keyed on the portal and the intent, and a hand-kept copy of that key is exactly what goes silently
 * wrong when oxide re-keys them.
 */
function requireBlessedImplementation(
  implementation: Address,
  family: string,
  portal: Address,
): Address {
  if (/^0x0+$/i.test(implementation)) {
    throw new Error(`SIPAFactory has no ${family} implementation blessed for portal ${portal}`)
  }
  return implementation
}

/** The deposit implementation `portal` is served by (`SIPAFactory.implementationFor`). */
export async function readDepositSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
  portal: Address,
): Promise<Address> {
  const implementation = await readSIPAImplementation(
    publicClient,
    sipaFactory,
    portal,
    OxideSipaIntent.Deposit,
  )
  return requireBlessedImplementation(implementation, "deposit", portal)
}

/** The registration implementation `portal` is served by. */
export async function readRegistrationSIPAImplementation(
  publicClient: PublicClient,
  sipaFactory: Address,
  portal: Address,
): Promise<Address> {
  const implementation = await readSIPAImplementation(
    publicClient,
    sipaFactory,
    portal,
    OxideSipaIntent.Registration,
  )
  return requireBlessedImplementation(implementation, "registration", portal)
}

/** A built intent: what a SIPA commits to plus what the sweep reveals. */
export interface SipaIntent {
  /** The intent-type implementation each SIPA clones (`DepositSIPA` / `RegistrationSIPA`). */
  implementation: Address
  /** `keccak256(intentData)` — the single committed word, baked into the clone. */
  intentHash: Hex
  /** The abi-encoded intent record, re-hashed against `intentHash` at sweep. */
  intentData: Hex
  /** Non-committed data the intent's `_execute` consumes; `0x` for a deposit. */
  proofs: Hex
}

/**
 * The deposit intent: forward the whole balance to an L2 recipient, no fee, no side effect.
 * `implementation` is the portal's `SIPAFactory.implementationFor`.
 */
export function buildDepositIntent(params: {
  implementation: Address
  recipientCommitment: Hex
}): SipaIntent {
  const intentData = encodeDepositIntentData(params.recipientCommitment)
  return {
    implementation: params.implementation,
    intentHash: keccak256(intentData),
    intentData,
    proofs: "0x",
  }
}

/**
 * The registration intent: register the identity record, fee to the beneficiary, remainder to the
 * owner. `implementation` is the portal's `SIPAFactory.implementationFor`.
 */
export function buildRegistrationIntent(params: {
  implementation: Address
  intent: RegistrationIntent
  consentSig: Hex
  bootstrap: Address
  domainAuth: DomainAuthArg
  signedTerms: SignedTermsArg
  r1Install: R1InstallArg
}): SipaIntent {
  const intentData = encodeRegistrationIntentData(params.intent)
  const proofs = encodeRegistrationProofs({
    consentSig: params.consentSig,
    bootstrap: params.bootstrap,
    domainAuth: params.domainAuth,
    signedTerms: params.signedTerms,
    r1Install: params.r1Install,
  })
  return {
    implementation: params.implementation,
    intentHash: keccak256(intentData),
    intentData,
    proofs,
  }
}

/** Split a `bytes32` intentHash into the two big-endian u128 limbs the `SIPA` event carries. */
export function splitIntentHash(intentHash: Hex): { hi: bigint; lo: bigint } {
  const value = BigInt(intentHash)
  return { hi: value >> 128n, lo: value & ((1n << 128n) - 1n) }
}

/** Recombine the event's two big-endian u128 limbs back into the `bytes32` intentHash. */
export function joinIntentHash(hi: bigint, lo: bigint): Hex {
  return toHex((hi << 128n) | lo, { size: 32 })
}

/** What the recipient of a SIPA learns from its `SIPA` event. */
export interface SipaNotification {
  recipient: AztecAddress
  sharedSecretSalt: Fr
  resweepable: boolean
  /** `keccak256(intentData)`, the word the SIPA address commits to. */
  intentHash: Hex
}

/**
 * Publish a SIPA: the token's `SIPA` event to its recipient, then the L1 operations that sweep it.
 * The calls must ride one L2 tx.
 */
export function buildSipaBroadcast(
  token: SipaNotifier,
  broadcaster: L1OperationBroadcaster,
  notification: SipaNotification,
  operations: BroadcastL1Operation[],
): ContractFunctionInteraction[] {
  const { recipient, ...event } = notification
  return [
    notifySipaRecipient(token, recipient, event),
    ...operations.map((operation) => broadcastL1Operation(broadcaster, operation)),
  ]
}

/** Re-exported so a caller names the intent/auth shapes the builders take from one import site. */
export type { RegistrationIntent, DomainAuthArg }
export type { RegistrationProofs, R1InstallArg, K1PointArg } from "@oxide/l1-contracts"
/** Re-exported so an out-of-workspace caller (the web wallet's registration broadcast) can assemble a
 *  registration intent's `proofs` without importing the vendored package directly. */
export { encodeRegistrationProofs, encodeLegacyRegistrationProofs } from "@oxide/l1-contracts"

export {
  buildSipaDeployAndSweepOperation,
  predictAccountAddress,
  encodeAccountInitCode,
  depositPayoutTokenFor,
  SipaIntent as OxideSipaIntent,
} from "@oxide/l1-contracts"
export { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
export { predictLegacySIPA } from "@oxide/l1-contracts/legacy_sipa.js"

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * `DepositSubsidy.deployAndSweepForSubsidy` deploys the SIPA it derives from its own portal, factory
 * and rollup version, not from the broadcast's deploy args. Refuse to publish unless that SIPA is
 * `sipa`: otherwise a funded address is never swept. A SIPA that has code is swept as is.
 */
export async function assertSubsidySweepsSipa(
  publicClient: PublicClient,
  params: {
    depositSubsidy: Address
    portal: Address
    sipaFactory: Address
    intent: OxideSipaIntent
    deployArgs: SipaDeployArgs
    intentData: Hex
    sipa: Address
  },
): Promise<void> {
  const { depositSubsidy, deployArgs } = params
  const [portal, sipaFactory, rollupVersion] = await Promise.all([
    publicClient.readContract({ address: depositSubsidy, abi: DepositSubsidyAbi, functionName: "PORTAL" }),
    publicClient.readContract({
      address: depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "SIPA_FACTORY",
    }),
    publicClient.readContract({
      address: depositSubsidy,
      abi: DepositSubsidyAbi,
      functionName: "ROLLUP_VERSION",
    }),
  ])
  const refuse = (reason: string) => {
    throw new Error(`Deposit subsidy ${depositSubsidy} would not sweep SIPA ${params.sipa}: ${reason}`)
  }
  if (!sameAddress(portal, params.portal)) refuse(`it serves portal ${portal}`)
  if (!sameAddress(sipaFactory, params.sipaFactory)) refuse(`it deploys through ${sipaFactory}`)
  const intentHash = keccak256(params.intentData)
  if (intentHash.toLowerCase() !== deployArgs.intentHash.toLowerCase()) {
    refuse(`the intent data hashes to ${intentHash}, not ${deployArgs.intentHash}`)
  }
  const implementation = await readSIPAImplementation(
    publicClient,
    sipaFactory,
    portal,
    params.intent,
  )
  if (!sameAddress(implementation, deployArgs.implementation)) {
    refuse(`the portal's implementation is ${implementation}`)
  }
  const predicted = await predictSIPA(
    publicClient,
    sipaFactory,
    implementation,
    intentHash,
    deployArgs.recoveryCommitment,
    rollupVersion,
    deployArgs.resweepable,
  )
  if (!sameAddress(predicted, params.sipa)) refuse(`it would deploy ${predicted}`)
}

/** Publish a SIPA with one sweep operation per funding token, deploying it first when it has no code. */
export function buildSipaSweepBroadcasts(
  token: SipaNotifier,
  broadcaster: L1OperationBroadcaster,
  params: SipaNotification & {
    sipa: Address
    deployed: boolean
    sipaFactory: Address
    intent: OxideSipaIntent
    deployArgs: SipaDeployArgs | LegacySipaDeployArgs
    intentData: Hex
    proofs: Hex
    operationExecutor: Address
    depositSubsidy: Address
    chainId: bigint
    tokens: Address[]
  },
): ContractFunctionInteraction[] {
  const tokens = [...new Set(params.tokens.map((token) => token.toLowerCase() as Address))]
  if (!tokens.length) throw new Error("A SIPA broadcast needs at least one funding token")
  return buildSipaBroadcast(
    token,
    broadcaster,
    params,
    tokens.map((token) => {
      const sweep = {
        sipa: params.sipa,
        sweepArgs: {
          token,
          relayer: params.operationExecutor,
          intentData: params.intentData,
          proofs: params.proofs,
        },
        depositSubsidy: params.depositSubsidy,
        payoutToken: depositPayoutTokenFor(
          params.chainId,
          EthAddress.fromString(token),
        ).toString() as Address,
        condition: L1OperationCondition.balance(
          EthAddress.fromString(token),
          EthAddress.fromString(params.sipa),
        ),
      }
      return params.deployed
        ? buildSipaSweepOperation(sweep)
        : buildSipaDeployAndSweepOperation({
            ...sweep,
            sipaFactory: params.sipaFactory,
            intent: params.intent,
            deployArgs: params.deployArgs,
          })
    }),
  )
}
