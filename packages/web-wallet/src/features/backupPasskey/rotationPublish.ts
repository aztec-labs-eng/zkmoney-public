import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { SIPADepositStore, type BackupRotationRecord } from "@obsidion/front-core"
import type { PersistedRotation } from "@obsidion/sdk"
import type { Address } from "viem"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { broadcastLanded, getBroadcastLedger, oweRotationBroadcast } from "../broadcasts/broadcasts"

/**
 * Publishes a rotation's deposit address: the rail's record for it, then its broadcast on the
 * ledger. Resolves once the broadcast landed, through however many attempts: the funding goes out
 * only after it. Rejects once the ledger drops the job.
 */
export async function publishRotationAddress(input: {
  owner: Address
  record: BackupRotationRecord
  rotation: PersistedRotation
  l1ChainId: number
  token: Address
}): Promise<void> {
  const { record, rotation } = input
  const recipient = record.plan?.address
  if (!recipient) throw new Error("nothing signed to publish")
  const sipa = rotation.sipa
  const deposits = SIPADepositStore.get(webStorage)
  await deposits.load()
  if (!deposits.get(sipa)) {
    await deposits.upsert(
      sipa,
      { phase: "broadcast" },
      {
        recipientL2Address: recipient,
        messageSecret: rotation.sharedSecretSalt.toString(),
        recipientHash: rotation.intent.recipientCommitment,
        recoveryAddress: "",
        l1ChainId: input.l1ChainId,
        amount: "0",
        tokenSymbol: WALLET_TOKEN_SYMBOL,
        startTime: Date.now(),
        tokenAddress: input.token,
        intent: "user-op",
      },
    )
  }
  await oweRotationBroadcast(input.owner, sipa)
  await broadcastLanded(sipa.toLowerCase())
}

/**
 * Sends the deposit address's landed broadcast again, from the block `sinceBlock` reads, or owes a
 * fresh one when the ledger lost the job; the flow decides when. False while a send is already owed.
 */
export async function republishRotationAddress(
  owner: Address,
  record: BackupRotationRecord,
  sinceBlock: () => Promise<number>,
): Promise<boolean> {
  const sipa = record.rotation?.sipa.toLowerCase()
  if (!sipa) return false
  const ledger = getBroadcastLedger()
  await ledger.load()
  const job = ledger.get(sipa)
  if (!job) {
    await oweRotationBroadcast(owner, sipa, await sinceBlock())
    return true
  }
  if (job.state !== "landed") return false
  return ledger.republish(sipa, await sinceBlock())
}
