/**
 * Sends the broadcast of one of the account's own deposit addresses: a sponsored L2 batch that sends
 * this wallet the address's `SIPA` event and has the `Broadcaster` publish its sweep operation, so
 * the relayer learns the address exists. It needs no user signature: the account's subscription is
 * the eligibility, and a first-ever broadcast folds the deferred subscribe into the same tx.
 */
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getAddress, type Address, type Hex } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  assertSubsidySweepsSipa,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildDepositIntent,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  ContractService,
  fetchSipaEvents,
  OxideSipaIntent,
  readSipaBroadcastTxHashes,
  type ClaimSponsorContext,
  type ObsidionWallet,
  type SipaIntent,
} from "@obsidion/sdk"
import {
  BROADCAST_WAIT_MS,
  BroadcastDeferred,
  readyValue,
  sipaDeployArgCandidates,
  WalletError,
  type BroadcastExecutor,
  type BroadcastJobOf,
  type SipaDeposit,
  type SipaRecoverCandidate,
} from "@obsidion/front-core"
import { getWebOxideToken } from "../../config/classArtifacts"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { session } from "../../session/session"
import { balanceMovingNow } from "../backupPasskey/backupRotationStore"
import { readSipaDeployed } from "../sipa/sipaSweep"
import { getSipaSweepRoutes } from "../sipa/sipaSweepRoutes"
import { predictSipaCandidate } from "../deposit/sipaPredict"
import { deriveSipa, sipaPoolDeployment } from "../deposit/sipaAddresses"
import type { SipaKeys } from "../deposit/sipaRail"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { claimSponsorContext, noteSubscribed } from "../registration/claimSponsorship"
import { RegistrationPendingError } from "../registration/registrationRail"
import { RAIL_REGISTERED } from "../registration/rails"

/** What a broadcast publishes for one address. */
export interface SipaPublishInputs {
  address: Address
  user: AztecAddress
  messageSecret: Fr
  intent: SipaIntent
  sipaArgs: SipaRecoverCandidate["args"]
}

/** Publish inputs read back from a record, with the CREATE2 origin they came from. */
export interface RecordedPublishInputs extends SipaPublishInputs {
  candidate: SipaRecoverCandidate
}

/**
 * The publish inputs an address's record holds, written when the address was derived. An address
 * derived under an earlier key no longer re-derives from `(day, nonce)`, but the user may already
 * have shared it, so it publishes from its record. Null when the record lacks its identity or its
 * intent does not hash to what the address commits to.
 */
export function publishInputsFromRecord(
  record: SipaDeposit | null | undefined,
): RecordedPublishInputs | null {
  if (!record?.origin || !record.messageSecret || !record.recipientHash) return null
  if (!record.recipientL2Address) return null
  const [candidate] = sipaDeployArgCandidates(record, [])
  if (!candidate) return null
  const intent = buildDepositIntent({
    implementation: candidate.args.implementation,
    recipientCommitment: record.recipientHash as Hex,
  })
  if (intent.intentHash.toLowerCase() !== candidate.args.intentHash.toLowerCase()) return null
  return {
    address: getAddress(record.sipaAddress),
    user: AztecAddress.fromStringUnsafe(record.recipientL2Address),
    messageSecret: Fr.fromHexString(record.messageSecret),
    intent,
    sipaArgs: candidate.args,
    candidate,
  }
}

/**
 * What an address that no longer re-derives still publishes: its record, provided the record's args
 * deploy exactly that address under this deployment's factory. An address of another factory is not
 * this deployment's to publish; its record stays for recovery.
 */
async function recordedPublishInputs(
  record: SipaDeposit | undefined,
  tuple: OxideEnvTuple,
): Promise<SipaPublishInputs | null> {
  const recorded = publishInputsFromRecord(record)
  if (!recorded || !record) return null
  const factory = requireTupleField(tuple, "sipaFactory") as Address
  if (recorded.candidate.sipaFactory.toLowerCase() !== factory.toLowerCase()) return null
  const predicted = await predictSipaCandidate(l1PublicClient(getConfig()), recorded.candidate)
  return predicted.toLowerCase() === record.sipaAddress.toLowerCase() ? recorded : null
}

/**
 * Whether the address's broadcast mined: its record's recipient, else the account, holds the `SIPA`
 * event its salt names, from `sinceBlock` on when the address is being published again.
 */
async function broadcastLanded(
  wallet: ObsidionWallet,
  address: string,
  sinceBlock?: number,
): Promise<boolean> {
  const { sipaDeposits, sipaKeys, sipaDiscovery } = session()
  const record = await sipaDeposits.get(address)
  const keys = sipaKeys?.get()
  const salt = record?.messageSecret
  if (!salt || keys?.status !== "ready") return false
  await readyValue(sipaDiscovery)
  const tuple = await getOxideTuple(getConfig())
  const events = await fetchSipaEvents(
    wallet,
    AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token")),
    record.recipientL2Address
      ? AztecAddress.fromStringUnsafe(record.recipientL2Address)
      : keys.value.recipient,
    sinceBlock === undefined ? undefined : { fromBlock: BlockNumber(sinceBlock) },
  )
  const wanted = salt.toLowerCase()
  return events.some((event) => event.sharedSecretSalt.toString().toLowerCase() === wanted)
}

/**
 * Sponsors the L2 broadcast that tells the relayer the address exists. Re-derives from the slot
 * rather than taking the first derivation: the second derivation is independent, which makes the
 * equality check below a real check. An address that no longer re-derives publishes from its
 * record instead; nothing else is published under it.
 */
async function broadcastSipa(
  wallet: ObsidionWallet,
  tuple: OxideEnvTuple,
  keys: SipaKeys,
  record: SipaDeposit,
  slot: { day: number; nonce: number },
  opts: {
    sponsor: ClaimSponsorContext
    operationId?: string
    onTxHash?: (txHash: string) => Promise<void>
  },
): Promise<string> {
  const config = getConfig()
  const publicClient = l1PublicClient(config)
  const contractService = ContractService.getInstance()
  const derived = await deriveSipa(wallet, tuple, keys, slot.day, slot.nonce)
  // The user already holds the address and may have shared it. Broadcasting anything else strands
  // whatever they were sent.
  const inputs: SipaPublishInputs | null =
    derived.address.toLowerCase() === record.sipaAddress.toLowerCase()
      ? { ...derived, messageSecret: derived.resolution.messageSecret }
      : await recordedPublishInputs(record, tuple)
  if (!inputs) throw new WalletError("deposit.addressRetired", "the address no longer derives")
  const { address, user, messageSecret, intent, sipaArgs } = inputs
  const [deployed, routes] = await Promise.all([
    readSipaDeployed(publicClient, address),
    getSipaSweepRoutes(config, tuple, sipaArgs, "deposit", requireTupleField(tuple, "token")),
  ])
  if (!deployed && !("recoveryAddress" in sipaArgs)) {
    await assertSubsidySweepsSipa(publicClient, {
      routes,
      sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
      intent: OxideSipaIntent.Deposit,
      deployArgs: sipaArgs,
      intentData: intent.intentData,
      sipa: address,
    })
  }
  const { sponsor } = opts
  const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor
  // The payer's note pays; the event is still sent to, and read as, this account.
  const payer = sponsor.payer ?? user
  const scopes = sponsor.payer ? [payer, user] : [user]
  // The event rides the pinned bridge's token, where this wallet reads its own SIPA events.
  const token = await getWebOxideToken(wallet, contractService, requireTupleField(tuple, "l2Token"))
  const { broadcaster } = await readyValue(session().sipaDiscovery)
  const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
    recipient: user,
    sharedSecretSalt: messageSecret,
    resweepable: sipaArgs.resweepable,
    intentHash: intent.intentHash,
    sipa: address,
    deployed,
    sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
    intent: OxideSipaIntent.Deposit,
    deployArgs: sipaArgs,
    intentData: intent.intentData,
    proofs: intent.proofs,
    operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
    chainId: BigInt(config.l1ChainId),
    routes,
  })
  const broadcastCalls = (await Promise.all(interactions.map((call) => call.request()))).flatMap(
    (payload) => payload.calls,
  )
  // A first-ever broadcast folds the deferred subscription into this very tx. Later ones ride
  // `sponsor`, which spends one SubscriptionNote use.
  const common = {
    fpcAddress,
    fpcArtifact,
    railId,
    policy,
    user: payer,
    innerCalls: broadcastCalls,
    // The broadcast matches by address or the `ByAny` entry — no class witness.
    classWitnesses: [],
  }
  const payload = subscribe
    ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
    : await buildClaimSponsorPayload(common)
  // NO_FROM: the entrypoint's subscription is the eligibility. The `SIPA` event is sent to this
  // account, so this PXE discovers what it just broadcast. Resolves once mined.
  const { receipt } = await wallet.sendTx(payload, {
    from: NO_FROM,
    sendMessagesAs: user,
    additionalScopes: scopes,
    fee: claimFpcSponsoredFee(policy, common.innerCalls),
    operationId: opts.operationId,
    ...(opts.onTxHash ? { onTxHash: opts.onTxHash } : {}),
  })
  if (subscribe) noteSubscribed(keys.account, fpcAddress, railId)
  maybeRefuelFpc({ wallet, contractService, fpc: { address: fpcAddress, artifact: fpcArtifact } })
  return receipt.txHash.toString()
}

/** What the broadcasts task runs for the account's own deposit addresses. */
export function slotExecutor(wallet: ObsidionWallet): BroadcastExecutor<BroadcastJobOf<"slot">> {
  return {
    landed: (job) => broadcastLanded(wallet, job.address, job.republishSince),
    send: async (job, attempt) => {
      const { sipaDeposits, sipaKeys } = session()
      const record = await sipaDeposits.get(job.address)
      if (!record?.slot) throw new WalletError("deposit.addressRetired", "not a deposit address")
      const keys = sipaKeys?.get()
      if (keys?.status !== "ready")
        throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "unlock")
      // The broadcast pays with the note a backup passkey's balance move spends.
      if (await balanceMovingNow(keys.value.recipient.toString()))
        throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "balanceMove")
      const tuple = await getOxideTuple(getConfig())
      let sponsor: ClaimSponsorContext
      try {
        sponsor = await claimSponsorContext(
          { wallet, account: keys.value.account, contractService: ContractService.getInstance() },
          RAIL_REGISTERED,
        )
      } catch (err) {
        if (!(err instanceof RegistrationPendingError)) throw err
        throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "registration")
      }
      // Registered on the pinned deployment's rollup: a fill of the previous one is never served.
      if (job.kind === "pool" && record.slot.deployment !== sipaPoolDeployment(tuple))
        throw new WalletError("deposit.addressRetired", "pool fill of a retired deployment")
      return broadcastSipa(wallet, tuple, keys.value, record, record.slot, {
        sponsor,
        operationId: attempt.operationId,
        onTxHash: attempt.onTxHash,
      })
    },
  }
}

/** Txs from `fromBlock` on that broadcast one of `user`'s deposit addresses. */
export async function broadcastTxHashes(
  wallet: ObsidionWallet,
  user: AztecAddress,
  fromBlock: number,
): Promise<Set<string>> {
  const tuple = await getOxideTuple(getConfig())
  await readyValue(session().sipaDiscovery)
  const token = AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token"))
  return readSipaBroadcastTxHashes(wallet, token, user, fromBlock)
}
