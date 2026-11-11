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
import { sipaGenerationOf } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  assertSubsidySweepsSipa,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildDepositIntent,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  fetchSipaEvents,
  OxideSipaIntent,
  readSipaBroadcastTxHashes,
  type ClaimSponsorContext,
  type ObsidionWallet,
  type SipaIntent,
} from "@obsidion/sdk"
import {
  balanceMovingNow,
  BROADCAST_WAIT_MS,
  BroadcastDeferred,
  sipaDeployArgCandidates,
  WalletError,
  type BroadcastExecutor,
  type BroadcastJobOf,
  type SipaDeposit,
  type SipaRecoverCandidate,
  type Service,
} from "@obsidion/front-core"
import { getWebOxideToken } from "../../config/classArtifacts"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { ExecutorSession } from "../../session/session"
import { readSipaDeployed } from "../sipa/sipaSweep"
import { getSipaSweepRoutes } from "../sipa/sipaSweepRoutes"
import { predictSipaCandidate } from "../deposit/sipaPredict"
import { deriveSipa, sipaPoolDeployment } from "../deposit/sipaAddresses"
import type { SipaDiscovery, SipaKeys } from "../deposit/sipaRail"
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
  /** The factory the address deploys through: its SIPA set's. */
  sipaFactory: Address
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
    sipaFactory: candidate.sipaFactory,
    candidate,
  }
}

/**
 * Whether `candidate` deploys through the deployment's factory, or is of one of its earlier SIPA
 * sets.
 */
export function isKnownSipaSet(candidate: SipaRecoverCandidate, tuple: OxideEnvTuple): boolean {
  if (candidate.sipaFactory.toLowerCase() === tuple.sipaFactory?.toLowerCase()) return true
  const forwardingTable =
    "forwardingTable" in candidate.args ? candidate.args.forwardingTable : undefined
  return !!sipaGenerationOf(tuple, {
    sipaFactory: candidate.sipaFactory,
    forwardingTable,
    implementation: candidate.args.implementation,
  })
}

/**
 * What an address that no longer re-derives still publishes: its record, provided the record's args
 * deploy exactly that address under one of the deployment's SIPA sets. An address of another set is
 * not this deployment's to publish; its record stays for recovery.
 */
async function recordedPublishInputs(
  config: WebWalletConfig,
  record: SipaDeposit | undefined,
  tuple: OxideEnvTuple,
): Promise<SipaPublishInputs | null> {
  const recorded = publishInputsFromRecord(record)
  if (!recorded || !record) return null
  if (!isKnownSipaSet(recorded.candidate, tuple)) return null
  const predicted = await predictSipaCandidate(l1PublicClient(config), recorded.candidate)
  return predicted.toLowerCase() === record.sipaAddress.toLowerCase() ? recorded : null
}

/**
 * Whether the address's broadcast mined: its record's recipient, else the account, holds the `SIPA`
 * event its salt names, from `sinceBlock` on when the address is being published again.
 */
async function broadcastLanded(
  session: SlotSession,
  wallet: ObsidionWallet,
  address: string,
  sinceBlock?: number,
): Promise<boolean> {
  const { sipaDeposits, sipaKeys, sipaDiscovery } = session
  const record = await sipaDeposits.get(address)
  const keys = sipaKeys?.get()
  const salt = record?.messageSecret
  if (!salt || keys?.status !== "ready") return false

  await sipaDiscovery().ready()
  const tuple = await session.page.chain.oxideTuple.read()
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
 * equality check below a real check. An address that no longer re-derives, or has no slot on this
 * device, publishes from its record instead; nothing else is published under it.
 */
async function broadcastSipa(
  wallet: ObsidionWallet,
  tuple: OxideEnvTuple,
  keys: SipaKeys,
  record: SipaDeposit,
  slot: { day: number; nonce: number } | undefined,
  opts: {
    session: Pick<
      SlotSession,
      "sipaDiscovery" | "subscriptionChecks" | "page" | "contractService" | "oweFpcRefuel"
    >
    sponsor: ClaimSponsorContext
    operationId?: string
    onTxHash?: (txHash: string) => Promise<void>
  },
): Promise<string> {
  const { config } = opts.session.page
  const publicClient = l1PublicClient(config)

  const contractService = await opts.session.contractService.ready()
  const derived =
    slot && (await deriveSipa(opts.session.page, wallet, tuple, keys, slot.day, slot.nonce))
  // The user already holds the address and may have shared it. Broadcasting anything else strands
  // whatever they were sent.
  const inputs: SipaPublishInputs | null =
    derived && derived.address.toLowerCase() === record.sipaAddress.toLowerCase()
      ? {
          ...derived,
          messageSecret: derived.resolution.messageSecret,
          sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
        }
      : await recordedPublishInputs(config, record, tuple)
  if (!inputs) throw new WalletError("deposit.addressRetired")
  const { address, user, messageSecret, intent, sipaArgs, sipaFactory } = inputs
  const [deployed, routes] = await Promise.all([
    readSipaDeployed(publicClient, address),
    getSipaSweepRoutes(
      opts.session.page,
      tuple,
      sipaArgs,
      "deposit",
      requireTupleField(tuple, "token"),
      sipaFactory,
    ),
  ])
  if (!deployed && !("recoveryAddress" in sipaArgs)) {
    await assertSubsidySweepsSipa(publicClient, {
      routes,
      sipaFactory,
      intent: OxideSipaIntent.Deposit,
      deployArgs: sipaArgs,
      intentData: intent.intentData,
      sipa: address,
    })
  }
  const { sponsor } = opts
  const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor
  // The payer's note pays, else the session account's. The event is still sent to, and read as,
  // the address's account, which a previous account's record names.
  const payer = sponsor.payer ?? keys.recipient
  const scopes = payer.equals(user) ? [user] : [payer, user]
  // The event rides the pinned bridge's token, where this wallet reads its own SIPA events.
  const token = await getWebOxideToken(wallet, contractService, requireTupleField(tuple, "l2Token"))

  const { broadcaster } = await opts.session.sipaDiscovery().ready()
  const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
    recipient: user,
    sharedSecretSalt: messageSecret,
    resweepable: sipaArgs.resweepable,
    intentHash: intent.intentHash,
    sipa: address,
    deployed,
    sipaFactory,
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
  if (subscribe) noteSubscribed({ ...opts, account: keys.account }, fpcAddress, railId)
  opts.session.oweFpcRefuel({ address: fpcAddress, artifact: fpcArtifact })
  return receipt.txHash.toString()
}

/** The session's stores and SIPA services: a visitor has no keys. */
// Spelled out: a `Pick<Session, "sipaKeys">` here types the services by the tasks that build them.
type SlotSession = ExecutorSession & {
  sipaKeys: Service<SipaKeys> | null
  sipaDiscovery: () => Service<SipaDiscovery>
}

/** What the broadcasts task runs for the account's own deposit addresses. */
export function slotExecutor(
  wallet: ObsidionWallet,
  session: SlotSession,
): BroadcastExecutor<BroadcastJobOf<"slot">> {
  return {
    landed: (job) => broadcastLanded(session, wallet, job.address, job.republishSince),
    send: async (job, attempt) => {
      const { sipaDeposits, sipaKeys } = session
      const record = await sipaDeposits.get(job.address)
      if (!record) throw new WalletError("deposit.addressRetired")
      const keys = sipaKeys?.get()
      if (keys?.status !== "ready")
        throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "unlock")
      // The broadcast pays with the note a backup passkey's balance move spends.
      if (await balanceMovingNow(session.backupRotations, keys.value.recipient.toString()))
        throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "balanceMove")
      const tuple = await session.page.chain.oxideTuple.read()

      const contractService = await session.contractService.ready()
      let sponsor: ClaimSponsorContext
      try {
        sponsor = await claimSponsorContext(
          { session, wallet, account: keys.value.account, contractService },
          RAIL_REGISTERED,
        )
      } catch (err) {
        if (!(err instanceof RegistrationPendingError)) throw err
        throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "registration")
      }
      // Registered on the pinned deployment's rollup: a fill of the previous one is never served.
      if (job.kind === "pool" && record.slot?.deployment !== sipaPoolDeployment(tuple))
        throw new WalletError("deposit.addressRetired")
      return broadcastSipa(wallet, tuple, keys.value, record, record.slot, {
        session,
        sponsor,
        operationId: attempt.operationId,
        onTxHash: attempt.onTxHash,
      })
    },
  }
}

/** Txs from `fromBlock` on that broadcast one of `user`'s deposit addresses. */
export async function broadcastTxHashes(
  session: Pick<SlotSession, "sipaDiscovery" | "page">,
  wallet: ObsidionWallet,
  user: AztecAddress,
  fromBlock: number,
): Promise<Set<string>> {
  const tuple = await session.page.chain.oxideTuple.read()

  await session.sipaDiscovery().ready()
  const token = AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token"))
  return readSipaBroadcastTxHashes(wallet, token, user, fromBlock)
}
