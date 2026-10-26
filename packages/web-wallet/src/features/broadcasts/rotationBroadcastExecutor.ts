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
  BroadcastAbandoned,
  BroadcastDeferred,
  isFailedSubmission,
  persistedRotation,
  PUBLISH_BOUND,
  publishLanded,
  recordPublishHash,
  recordPublishLanded,
  recordPublishSend,
  RotationStrippedError,
  type BackupRotationRecord,
  type BroadcastExecutor,
  type BroadcastJob,
} from "@obsidion/front-core"
import {
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  ContractService,
  OxideSipaIntent,
  type ObsidionWallet,
  type PersistedRotation,
} from "@obsidion/sdk"
import { encodeUserOpIntentData, encodeUserOpProofs } from "@oxide/l1-contracts"
import type { Address, Hex } from "viem"
import { getWebOxideToken } from "../../config/classArtifacts"
import type { WebWalletConfig } from "../../config/env"
import { getFeeTokenBridgeTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { getBackupRotationStore } from "../backupPasskey/backupRotationStore"
import { readSipaDeployed } from "../deposit/sipaSweep"
import { getSipaSweepRoutes } from "../deposit/sipaSweepRoutes"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { claimSponsorContext, noteSubscribed } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { unlockedSessionKeys } from "../onboarding/registrationResume"
import { registeredBroadcaster } from "../onboarding/webRegistrationBroadcast"
import { WAIT_MS, WAITING_FOR_UNLOCK } from "./broadcasts"

const ENDED = "The backup passkey attempt ended"

/** The record whose deposit address the job publishes, or null once it is gone or moved. */
async function recordOf(job: BroadcastJob): Promise<BackupRotationRecord | null> {
  if (job.source.type !== "rotation") return null
  const record = await getBackupRotationStore().get(job.source.owner)
  return record?.rotation?.sipa.toLowerCase() === job.address ? record : null
}

function signedRotation(record: BackupRotationRecord): PersistedRotation {
  try {
    return persistedRotation(record.rotation!)
  } catch (err) {
    if (err instanceof RotationStrippedError) throw new BroadcastAbandoned(ENDED)
    throw err
  }
}

export function rotationExecutor(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
): BroadcastExecutor {
  const bookkeeping = () => ({ store: getBackupRotationStore(), now: Date.now })
  return {
    landed: async (job) => {
      const record = await recordOf(job)
      return record ? publishLanded(record, job.republishSince ?? 0) : false
    },
    send: async (job, attempt) => {
      const record = await recordOf(job)
      if (!record?.plan) throw new BroadcastAbandoned(ENDED)
      // The flow gives a funded, unswept address up at this count; nothing more is proved for it.
      if ((record.publish?.count ?? 0) >= PUBLISH_BOUND) throw new BroadcastAbandoned(ENDED)
      const rotation = signedRotation(record)
      const keys = await unlockedSessionKeys(wallet)
      if (!keys) throw new BroadcastDeferred(Date.now() + WAIT_MS, WAITING_FOR_UNLOCK)
      const contractService = ContractService.getInstance()
      const tuple = await getFeeTokenBridgeTuple(config)
      const sipa = rotation.sipa
      const [sponsor, token, broadcaster, deployed, routes] = await Promise.all([
        claimSponsorContext({ wallet, account: keys.account, contractService }, RAIL_REGISTERED),
        getWebOxideToken(wallet, contractService, requireTupleField(tuple, "l2Token")),
        registeredBroadcaster(wallet, tuple),
        readSipaDeployed(l1PublicClient(config), sipa),
        getSipaSweepRoutes(config, tuple, rotation.deployArgs, "user-op", bridgeUnderlying(tuple)),
      ])
      const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
        recipient: AztecAddress.fromStringUnsafe(record.plan.address),
        sharedSecretSalt: rotation.sharedSecretSalt,
        resweepable: rotation.deployArgs.resweepable,
        intentHash: rotation.deployArgs.intentHash,
        sipa,
        deployed,
        sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
        intent: OxideSipaIntent.UserOp,
        deployArgs: rotation.deployArgs,
        intentData: encodeUserOpIntentData(rotation.intent),
        proofs: encodeUserOpProofs(rotation.signature),
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
      if (subscribe) noteSubscribed(keys.account, fpcAddress, railId)
      maybeRefuelFpc({
        wallet,
        contractService,
        fpc: { address: fpcAddress, artifact: fpcArtifact },
      })
      return receipt.txHash.toString()
    },
    // The landing's block is what a republish is judged against; a receipt that no longer shows the
    // broadcast in a block records nothing, and the scheduler asks the chain again.
    onLanded: async (job) => {
      const record = await recordOf(job)
      if (!record || !job.txHash) return
      const receipt = await wallet.node.getTxReceipt(TxHash.fromString(job.txHash))
      if (receipt.blockNumber === undefined || isFailedSubmission(receipt))
        throw new Error("the broadcast is not in a block")
      await recordPublishLanded(bookkeeping(), record, {
        txHash: job.txHash as Hex,
        l2Block: receipt.blockNumber,
      })
    },
  }
}
