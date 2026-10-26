/**
 * The exit from a deployment whose portal is frozen: refund every source fund to the user's own L1
 * account, one capped batch per transaction, each sent from that account. Nothing is broadcast on L2
 * and no relayer takes part, so the refund carries no tip.
 */
import { nextFrozenSelfRefund, type FrozenMigrationRuntime } from "@obsidion/sdk"
import type { Hex } from "viem"
import type { L1ExitChannel } from "../deposit/sipaRecovery"

export type FrozenExitRuntime = Pick<FrozenMigrationRuntime, "candidates" | "build">

/** What the frozen portal refunds now, the part of it in payment links, and what waits. */
export async function frozenExitSummary(runtime: FrozenExitRuntime) {
  const { candidates, waiting, maxBatchAmount } = await runtime.candidates({ fresh: true })
  let refundable = 0n
  let links = 0n
  // A note above the portal's cap fits no refund.
  let overCap = 0n
  for (const c of candidates) {
    if (BigInt(c.amount) > maxBatchAmount) overCap += BigInt(c.amount)
    else {
      refundable += BigInt(c.amount)
      if (c.kind === "escrow-note") links += BigInt(c.amount)
    }
  }
  return { refundable, links, waiting: (waiting ?? 0n) + overCap }
}

export interface FrozenExitProgress {
  /** Refunded so far in this run. */
  refunded: bigint
  hashes: Hex[]
}

// Outlives the screen: a second run would resend the first one's unconfirmed batch.
let running = false
// A sent refund whose receipt never came. The next run waits for it, so it never sends it twice.
let pending: Hex | undefined

/**
 * Refunds batches until none is left. A batch that reverts or comes back after its own refund
 * stops the run. Resolves to what moved and what is left behind.
 */
export async function runFrozenExit(
  runtime: FrozenExitRuntime,
  channel: L1ExitChannel,
  onBatch?: (progress: FrozenExitProgress) => void,
) {
  if (running) throw new Error("A withdrawal is already running. Wait for it to finish.")
  running = true
  try {
    if (pending) {
      await channel.waitForReceipt(pending)
      pending = undefined
    }
    return await refundAll(runtime, channel, onBatch)
  } finally {
    running = false
  }
}

async function refundAll(
  runtime: FrozenExitRuntime,
  channel: L1ExitChannel,
  onBatch?: (progress: FrozenExitProgress) => void,
) {
  const progress: FrozenExitProgress = { refunded: 0n, hashes: [] }
  const sent = new Set<string>()
  for (let fresh = true; ; fresh = false) {
    const next = await nextFrozenSelfRefund(runtime, channel.target, { fresh })
    if (!next.refund) return { ...progress, stranded: next.remaining, waiting: next.waiting }
    const { ids, amount, to, data } = next.refund
    if (ids.some((id) => sent.has(id)))
      throw new Error("A refund already sent is still unconfirmed. Wait a minute and try again.")
    const hash = await channel.sendTransaction(to, data)
    pending = hash
    const ok = await channel.waitForReceipt(hash)
    pending = undefined
    if (!ok) throw new Error(`Refund transaction ${hash} reverted, so nothing moved. Try again.`)
    ids.forEach((id) => sent.add(id))
    progress.refunded += amount
    progress.hashes.push(hash)
    onBatch?.({ ...progress, hashes: [...progress.hashes] })
  }
}
