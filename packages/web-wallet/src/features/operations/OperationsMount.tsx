/**
 * The one boot pass for user transactions, mounted only in the active tab: once a session is open,
 * whatever an earlier tab left `local` ends with its flow's record; `sent` operations settle from
 * the chain, and the withdrawal tracker picks up burns past submit.
 */
import { useEffect } from "react"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { bestEffort, useAztecContext, useStore, type Activity } from "@obsidion/front-core"
import { openedSession } from "../../platform/session"
import { slowWhenHidden } from "../../platform/visibilityScheduler"
import { usePxeBoot } from "../../ui/PxeBoot"
import { ensureWithdrawalTracker, getWithdrawalStore } from "../withdraw/withdrawGateway"
import { getOperationStore } from "./operations"

export const RESOLVE_SENT_MS = 10_000

const warn = (err: unknown) =>
  console.warn("[OperationsMount] could not recover interrupted operations:", err)

/**
 * End what an earlier tab left before submit: every operation, and the session's flow records.
 * One tab runs the wallet and this one starts nothing before `activeSince`, when it became the
 * active tab, so a record that started by then and holds no hash can never be sent. First the
 * operation and its flow's record are made to agree on a hash either one holds, so neither is
 * failed while the other says it is on chain.
 */
export async function recoverInterrupted(
  activity: Activity,
  activeSince: number,
  now: number = Date.now(),
): Promise<void> {
  // A first open's migration has to land before the rows hold their hashes.
  await activity.ready.catch(warn)
  await reconcileHashes(activity, activeSince).catch(warn)
  const age = now - activeSince
  activity.failInterrupted(now, age)
  await Promise.all([
    getOperationStore().failInterrupted(activeSince, now).catch(warn),
    getWithdrawalStore().failInterruptedSubmissions(now, age).catch(warn),
  ])
}

async function reconcileHashes(activity: Activity, activeSince: number): Promise<void> {
  const ops = getOperationStore()
  const withdrawals = getWithdrawalStore()
  await Promise.all([ops.load(), withdrawals.load()])
  for (const op of ops.list()) {
    const row = activity.latest(op.operationId)
    const burn = withdrawals.list().find((w) => w.operationId === op.operationId)
    if (op.state === "sent" && op.txHash) {
      const txHash = op.txHash
      if (row && !row.txHash) await activity.setHash(op.operationId, txHash)
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
  const open = useStore(openedSession)

  useEffect(() => {
    if (!ready || !open || swept) return
    swept = true
    void recoverInterrupted(open.activity, activeSince)
  }, [ready, open, activeSince])

  useEffect(() => {
    if (!ready) return
    const store = getOperationStore()
    const pass = () => void bestEffort("unknown", store.resolveSent(node))
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
