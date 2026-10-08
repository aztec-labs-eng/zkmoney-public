/**
 * The one boot pass for user transactions, mounted only in the active tab: whatever an earlier tab
 * left `local` ends with its flow's record, `sent` operations settle from the chain, and the
 * withdrawal tracker picks up burns past submit.
 */
import { useEffect } from "react"
import type { AztecNode } from "@aztec/stdlib/interfaces/client"
import { TransactionStorage, useAztecContext, type OperationRecord } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { slowWhenHidden } from "../../platform/visibilityScheduler"
import { usePxeBoot } from "../../ui/PxeBoot"
import { ensureWithdrawalTracker, getWithdrawalStore } from "../withdraw/withdrawGateway"
import { getOperationStore } from "./operations"

export const RESOLVE_SENT_MS = 10_000

const warn = (err: unknown) =>
  console.warn("[OperationsMount] could not recover interrupted operations:", err)

/**
 * End what an earlier tab left before submit: every operation, and the active scope's flow
 * records. One tab runs the wallet and this one starts nothing before `activeSince`, when it became
 * the active tab, so a record that started by then and holds no hash can never be sent. First the
 * operation and its flow's record are made to agree on a hash either one holds, so neither is
 * failed while the other says it is on chain.
 */
export async function recoverInterrupted(
  activeSince: number,
  now: number = Date.now(),
): Promise<void> {
  await reconcileHashes(activeSince).catch(warn)
  const age = now - activeSince
  await Promise.all([
    getOperationStore().failInterrupted(activeSince, now).catch(warn),
    TransactionStorage.get(webStorage).failInterruptedSends(now, age).catch(warn),
    getWithdrawalStore().failInterruptedSubmissions(now, age).catch(warn),
  ])
}

async function reconcileHashes(activeSince: number): Promise<void> {
  const ops = getOperationStore()
  const rows = TransactionStorage.get(webStorage)
  const withdrawals = getWithdrawalStore()
  await Promise.all([ops.load(), withdrawals.load()])
  const transactions = await rows.getTransactions()
  const owns = (op: OperationRecord) => (tx: { queueId?: string; operationId?: string }) =>
    tx.queueId === op.operationId || tx.operationId === op.operationId
  for (const op of ops.list()) {
    const row = transactions.find(owns(op))
    const burn = withdrawals.list().find((w) => w.operationId === op.operationId)
    if (op.state === "sent" && op.txHash) {
      const txHash = op.txHash
      if (row && !row.txHash) {
        await rows.updateTransaction(
          (tx) => owns(op)(tx) && !tx.txHash,
          (tx) => void (tx.txHash = txHash),
        )
      }
      if (burn?.phase === "submitting" && !burn.l2TxHash) {
        await withdrawals.patch(burn.localId, {
          phase: "submitting",
          l2TxHash: txHash as `0x${string}`,
          reorgEpoch: burn.reorgEpoch,
        })
      }
    } else if (op.state === "local" && op.startedAt <= activeSince) {
      const txHash = row?.txHash || burn?.l2TxHash
      if (txHash) await ops.markSent(op.operationId, txHash)
    }
  }
}

let swept = false

export function OperationsMount({
  node,
  activeSince,
}: {
  node: AztecNode
  activeSince: number
}): null {
  const { obsidionWallet } = useAztecContext()
  const ready = usePxeBoot().bootStatus === "ready"

  useEffect(() => {
    if (!ready || swept) return
    swept = true
    void recoverInterrupted(activeSince)
  }, [ready, activeSince])

  useEffect(() => {
    if (!ready) return
    const store = getOperationStore()
    const pass = () => void store.resolveSent(node).catch(() => {})
    const scheduler = slowWhenHidden(Infinity)
    pass()
    const handle = scheduler.setInterval(pass, RESOLVE_SENT_MS)
    return () => scheduler.clearInterval(handle)
  }, [ready, node])

  useEffect(() => {
    if (!ready || !obsidionWallet) return
    ensureWithdrawalTracker(obsidionWallet).catch((err) =>
      console.warn("[OperationsMount] withdrawal tracker boot failed:", err),
    )
  }, [ready, obsidionWallet])

  return null
}
