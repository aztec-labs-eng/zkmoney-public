/**
 * A backup passkey rotation's deposit-address broadcast on the ledger: the `SIPA` event to the
 * two-key account and the sweep order the relayer runs, sponsored on the registered rail. Each
 * attempt is counted on the rotation's record, with its hash, before the node takes it, and each
 * landing written back; the flow's bound on that count decides when a funded, unswept address is
 * given up on. An attempt that dies before its hash sent nothing and is not counted.
 */
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import {
  BROADCAST_WAIT_MS,
  BroadcastDeferred,
  WalletError,
  isFailedSubmission,
  persistedRotation,
  PUBLISH_BOUND,
  publishLanded,
  recordPublishHash,
  recordPublishLanded,
  recordPublishSend,
  RotationStrippedError,
  type BackupRotationRecord,
  type BackupRotations,
  type BroadcastExecutor,
  type BroadcastJobOf,
} from "@obsidion/front-core"
import {
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  OxideSipaIntent,
  type ObsidionWallet,
  type PersistedRotation,
} from "@obsidion/sdk"
import { encodeAddPasskeyIntentData, encodeAddPasskeyProofs } from "@oxide/l1-contracts"
import type { Address, Hex } from "viem"
import { getWebOxideToken } from "../../config/classArtifacts"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { readSipaDeployed } from "../sipa/sipaSweep"
import { getSipaSweepRoutes } from "../sipa/sipaSweepRoutes"
import { claimSponsorContext, noteSubscribed } from "../registration/claimSponsorship"
import { RAIL_REGISTERED } from "../registration/rails"
import { unlockedSessionKeys } from "../registration/registrationResume"
import { registeredBroadcaster } from "../registration/webRegistrationBroadcast"
import type { ExecutorSession, Session } from "../../session/session"

/** The session whose ledger owes a rotation's broadcast, and whose broadcasts task sends it. */
export type RotationSession = Pick<Session, "sipaDeposits" | "tasks" | "wake">

/**
 * Owe a backup passkey rotation's deposit-address broadcast; the record under `owner` rebuilds it.
 * `republishSince`, for an address paid again: only a landing at or past that block settles it.
 */
export async function oweRotationBroadcast(
  session: RotationSession,
  owner: string,
  sipaAddress: string,
  republishSince?: number,
): Promise<void> {
  const { sipaDeposits, tasks, wake } = session
  await sipaDeposits.oweBroadcast(sipaAddress, {
    kind: "deposit",
    source: { type: "rotation", owner },
    ...(republishSince === undefined ? {} : { republishSince }),
  })
  void wake(tasks.sipaBroadcasts)
}

const ended = () => new WalletError("deposit.addressRetired", "backup passkey attempt ended")

/**
 * The record whose deposit address the job publishes, or null once it is gone or moved. Records
 * that do not read defer the job until a reload reads them: it never fails or ends over them.
 */
async function recordOf(
  rotations: BackupRotations,
  job: BroadcastJobOf<"rotation">,
): Promise<BackupRotationRecord | null> {
  const record = await rotations.get(job.source.owner).catch((err: unknown) => {
    if (rotations.view.get().failed) throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS)
    throw err
  })
  return record?.rotation?.sipa.toLowerCase() === job.address ? record : null
}

function signedRotation(record: BackupRotationRecord): PersistedRotation {
  try {
    return persistedRotation(record.rotation!)
  } catch (err) {
    if (err instanceof RotationStrippedError) throw ended()
    throw err
  }
}

/** A visitor's session owes no rotation broadcast, and sends none. */
export function rotationExecutor(
  wallet: ObsidionWallet,
  session: ExecutorSession,
): BroadcastExecutor<BroadcastJobOf<"rotation">> {
  const store = () => {
    if (!session.backupRotations) throw new WalletError("wallet.notReady", "no account session")
    return session.backupRotations
  }
  const bookkeeping = () => ({ store: store(), now: Date.now })
  return {
    landed: async (job) => {
      const record = await recordOf(store(), job)
      return record ? publishLanded(record, job.republishSince ?? 0) : false
    },
    send: async (job, attempt) => {
      const record = await recordOf(store(), job)
      if (!record?.plan) throw ended()
      // The flow gives a funded, unswept address up at this count; nothing more is proved for it.
      if ((record.publish?.count ?? 0) >= PUBLISH_BOUND) throw ended()
      const rotation = signedRotation(record)
      const keys = await unlockedSessionKeys(session, wallet)
      if (!keys) throw new BroadcastDeferred(Date.now() + BROADCAST_WAIT_MS, "unlock")
      const { config, chain } = session.page

      const contractService = await session.contractService.ready()
      const sponsorDeps = { session, wallet, account: keys.account, contractService }
      const tuple = await chain.feeTokenBridgeTuple.read()
      const sipa = rotation.sipa
      const [sponsor, token, broadcaster, deployed, routes] = await Promise.all([
        claimSponsorContext(sponsorDeps, RAIL_REGISTERED),
        getWebOxideToken(wallet, contractService, requireTupleField(tuple, "l2Token")),
        registeredBroadcaster(chain, wallet, tuple),
        readSipaDeployed(l1PublicClient(config), sipa),
        getSipaSweepRoutes(
          session.page,
          tuple,
          rotation.deployArgs,
          "add-passkey",
          bridgeUnderlying(tuple),
        ),
      ])
      const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
        recipient: AztecAddress.fromStringUnsafe(record.plan.address),
        sharedSecretSalt: rotation.sharedSecretSalt,
        resweepable: rotation.deployArgs.resweepable,
        intentHash: rotation.deployArgs.intentHash,
        sipa,
        deployed,
        sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
        intent: OxideSipaIntent.AddPasskey,
        deployArgs: rotation.deployArgs,
        intentData: encodeAddPasskeyIntentData(rotation.intent),
        proofs: encodeAddPasskeyProofs(rotation.signature),
        operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
        chainId: BigInt(config.l1ChainId),
        routes,
      })
      const innerCalls = (await Promise.all(interactions.map((call) => call.request()))).flatMap(
        (request) => request.calls,
      )
      const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor
      const user = keys.account.getAddress()
      const payer = sponsor.payer ?? user
      const common = {
        fpcAddress,
        fpcArtifact,
        railId,
        policy,
        user: payer,
        innerCalls,
        classWitnesses: [],
      }
      const payload = subscribe
        ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
        : await buildClaimSponsorPayload(common)

      // NO_FROM: the entrypoint's subscription is the eligibility. The event is sent to this
      // account, and the two-key account reads it once the wallet runs on it.
      const { receipt } = await wallet.sendTx(payload, {
        ...(attempt.operationId ? { operationId: attempt.operationId } : {}),
        onTxHash: async (txHash) => {
          await recordPublishSend(bookkeeping(), record)
          await recordPublishHash(bookkeeping(), record, txHash as Hex)
          await attempt.onTxHash(txHash)
        },
        from: NO_FROM,
        sendMessagesAs: user,
        additionalScopes: sponsor.payer ? [payer, user] : [user],
        fee: claimFpcSponsoredFee(policy, innerCalls),
      })
      if (subscribe) noteSubscribed({ session, account: keys.account }, fpcAddress, railId)
      session.oweFpcRefuel({ address: fpcAddress, artifact: fpcArtifact })
      return receipt.txHash.toString()
    },
    // The landing's block is what a republish is judged against; a receipt that no longer shows the
    // broadcast in a block records nothing, and the scheduler asks the chain again.
    onLanded: async (job) => {
      const record = await recordOf(store(), job)
      if (!record || !job.txHash) return
      const receipt = await wallet.node.getTxReceipt(TxHash.fromString(job.txHash))
      if (receipt.blockNumber === undefined || isFailedSubmission(receipt))
        throw new WalletError("unknown", "the broadcast is not in a block")
      await recordPublishLanded(bookkeeping(), record, {
        txHash: job.txHash as Hex,
        l2Block: receipt.blockNumber,
      })
    },
  }
}
