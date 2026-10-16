import type { AztecAddress } from "@aztec/aztec.js/addresses"
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { Fr } from "@aztec/aztec.js/fields"
import type { FunctionCall } from "@aztec/stdlib/abi"
import { isContractDeployed } from "@oxide/l1-contracts"
import type { L1OperationBroadcaster } from "@oxide/oxide-client/broadcaster_calls.js"
import type { SipaNotifier } from "@oxide/oxide-client/sipa_event_calls.js"
import type { Address, PublicClient } from "viem"
import type { MetadataDestination } from "./metadataMigration.js"
import { readDepositMessageKey, readSweepEvents } from "./sipaClaim.js"
import {
  assertSubsidySweepsSipa,
  buildSipaSweepBroadcasts,
  OxideSipaIntent,
} from "./sipaIntents.js"
import type { SelfResolvedSipa, SipaSelfResolver } from "./sipaSelfResolve.js"
import { MAX_NONCE } from "./sipaStealth.js"
import type { TokenService } from "./TokenService.js"

/** What a migration needs to publish and receive SIPAs on its destination. */
export interface MigrationDestinationContext {
  client: PublicClient
  node: AztecNode
  destination: MetadataDestination
  selfResolver: SipaSelfResolver
  /** The destination token; it emits the SIPA event and stores the swept deposits. */
  token: SipaNotifier
  tokenService: TokenService
  broadcaster: L1OperationBroadcaster
  recipient: AztecAddress
  /** The OxideAccount that may recover a SIPA's balance. */
  recoveryAccount: Address
}

/**
 * A coordinate the plan persists. Its nonce sits between the resolver's, which count up from 0, and
 * self-resolution's, which count down from `MAX_NONCE - 1`, so it never shares a deposit address's secret.
 */
export function migrationSipaCoordinates(now = Date.now()): { day: number; nonce: number } {
  const [word] = crypto.getRandomValues(new Uint32Array(1))
  return { day: Math.floor(now / 86_400_000), nonce: MAX_NONCE / 4 + (word! % (MAX_NONCE / 2)) }
}

/** The ordinary DepositSIPA at `(day, nonce)` on the destination. */
export function resolveMigrationDeposit(
  c: MigrationDestinationContext,
  day: number,
  nonce: number,
): Promise<SelfResolvedSipa> {
  return c.selfResolver.resolveAddress({
    user: c.recipient,
    recoveryAccount: c.recoveryAccount,
    day,
    nonce,
    publicClient: c.client,
    sipaFactory: c.destination.factory,
    portal: c.destination.portal,
    rollupVersion: c.destination.rollupVersion,
  })
}

/** The calls that announce `resolved` to its recipient and broadcast its sweep. */
export async function migrationDepositCalls(
  c: MigrationDestinationContext,
  resolved: SelfResolvedSipa,
): Promise<FunctionCall[]> {
  const { sipaAddress: sipa, sipaArgs, intent, resolution } = resolved
  if ("recoveryAddress" in sipaArgs) {
    throw new Error("A migration deposit commits to the account's recovery commitment")
  }
  const deployed = await isContractDeployed(c.client, sipa)
  if (!deployed) {
    await assertSubsidySweepsSipa(c.client, {
      depositSubsidy: c.destination.depositSubsidy,
      portal: c.destination.portal,
      sipaFactory: c.destination.factory,
      intent: OxideSipaIntent.Deposit,
      deployArgs: sipaArgs,
      intentData: intent.intentData,
      sipa,
    })
  }
  const interactions = buildSipaSweepBroadcasts(c.token, c.broadcaster, {
    recipient: c.recipient,
    sharedSecretSalt: resolution.messageSecret,
    resweepable: sipaArgs.resweepable,
    intentHash: intent.intentHash,
    sipa,
    deployed,
    sipaFactory: c.destination.factory,
    intent: OxideSipaIntent.Deposit,
    deployArgs: sipaArgs,
    intentData: intent.intentData,
    proofs: intent.proofs,
    operationExecutor: c.destination.operationExecutor,
    depositSubsidy: c.destination.depositSubsidy,
    chainId: c.destination.chainId,
    tokens: [c.destination.token],
  })
  return (await Promise.all(interactions.map((call) => call.request()))).flatMap(
    (payload) => payload.calls,
  )
}

/**
 * Store every deposit `sipa` swept since `fromBlock`. False while none was swept or a message is in flight. Sweep
 * and message evidence outlive source tx pruning, so this never needs an old receipt.
 */
export async function receiveMigrationSweeps(
  c: MigrationDestinationContext,
  sipa: Address,
  fromBlock: bigint,
  sharedSecretSalt: Fr,
): Promise<boolean> {
  const sweeps = await readSweepEvents(c.client, sipa, fromBlock)
  if (!sweeps.length) return false
  for (const sweep of sweeps) {
    const key = await readDepositMessageKey(
      c.client,
      c.destination.portal,
      sweep.txHash,
      sweep.index,
    )
    if (!key || !(await isL1ToL2MessageReady(c.node, key))) return false
    await c.tokenService.ensureSweptDeposit({
      inboxIndex: sweep.index,
      amount: sweep.amount,
      recipient: c.recipient,
      sharedSecretSalt,
    })
  }
  return true
}
