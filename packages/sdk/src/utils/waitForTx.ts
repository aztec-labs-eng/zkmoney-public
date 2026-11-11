import type { Pace } from "@obsidion/core/cadence"
import { DefaultWaitOpts, type WaitOpts } from "@aztec-labs/aztec.js/contracts"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { TimeoutError } from "@aztec-labs/foundation/error"
import { SortedTxStatuses, TxStatus, type TxHash, type TxReceipt } from "@aztec-labs/stdlib/tx"

const reached = (receipt: TxReceipt, status: TxStatus) =>
  SortedTxStatuses.indexOf(receipt.status) >= SortedTxStatuses.indexOf(status)

/**
 * aztec.js's `waitForTx`, its receipt reads waiting on `pace` so an environment that owns the chain
 * can wake them; the options, the grace for DROPPED receipts and the errors are aztec.js's.
 * `interval`, `timeout` and `initialDelay` are in seconds. Why it is a copy, and the test that
 * holds it to aztec.js: docs/conventions/dependency-patches.md.
 */
export async function waitForTx(
  node: Pick<AztecNode, "getTxReceipt">,
  txHash: TxHash,
  opts: WaitOpts | undefined,
  pace: Pick<Pace, "wait">,
): Promise<TxReceipt> {
  const ignoreDroppedFor =
    opts?.ignoreDroppedReceiptsFor ?? DefaultWaitOpts.ignoreDroppedReceiptsFor
  const waitForStatus = opts?.waitForStatus ?? TxStatus.CHECKPOINTED
  const timeout = opts?.timeout ?? DefaultWaitOpts.timeout
  const intervalMs = (opts?.interval ?? DefaultWaitOpts.interval ?? 1) * 1000
  const deadline = timeout ? Date.now() + timeout * 1000 : undefined
  if (opts?.initialDelay) await pace.wait(Math.min(opts.initialDelay, timeout ?? Infinity) * 1000)
  const startTime = Date.now()
  let receipt: TxReceipt
  for (;;) {
    receipt = await node.getTxReceipt(txHash)
    if (receipt.isDropped()) {
      if (!ignoreDroppedFor || (Date.now() - startTime) / 1000 > ignoreDroppedFor) break
    } else if (!receipt.isPending() && reached(receipt, waitForStatus)) break
    await pace.wait(intervalMs)
    if (deadline !== undefined && Date.now() > deadline)
      throw new TimeoutError("Timeout awaiting isMined")
  }
  if (!receipt.isMined())
    throw new Error(
      `Transaction ${txHash.toString()} was ${receipt.status}. Reason: ${
        receipt.error ?? "unknown"
      }`,
    )
  if (!receipt.hasExecutionSucceeded() && !opts?.dontThrowOnRevert)
    throw new Error(
      `Transaction ${txHash.toString()} reverted: ${receipt.executionResult}. Reason: ${
        receipt.error ?? "unknown"
      }`,
    )
  return receipt
}
