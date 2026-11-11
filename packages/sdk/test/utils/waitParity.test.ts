/**
 * The sdk's copies of aztec.js's receipt and message waits (docs/conventions/dependency-patches.md)
 * against the installed aztec.js: each case runs both over the same scripted node and fake clock,
 * and each must read at the same times and end the same way. A failure here means the pinned
 * aztec.js changed its waits: port the change into the copy, or drop the copy.
 */
import { DefaultWaitOpts, type WaitOpts } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import { waitForTx as upstreamWaitForTx, type AztecNode } from "@aztec-labs/aztec.js/node"
import {
  DroppedTxReceipt,
  MinedTxReceipt,
  PendingTxReceipt,
  TxExecutionResult,
  TxHash,
  TxStatus,
  type TxReceipt,
} from "@aztec-labs/stdlib/tx"
import { createPace } from "@obsidion/core/cadence"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { waitForRegistrationMessage } from "../../src/services/name/registrationMessage"
import { waitForTx } from "../../src/utils/waitForTx"

const HASH = TxHash.zero()
const pending = () => new PendingTxReceipt(HASH, undefined)
const dropped = () => new DroppedTxReceipt(HASH, "evicted")
/** A mined receipt: the waits read only its status and its execution result. */
const mined = (status: TxStatus, result = TxExecutionResult.SUCCESS): TxReceipt =>
  new MinedTxReceipt(
    HASH,
    status as never,
    result,
    1n,
    {} as never,
    1 as never,
    1 as never,
    0,
    1 as never,
    undefined,
  )

/** What a wait did: when it read, and how it ended. */
type Trace = { reads: number[]; end: string }

/** Runs `wait` to its end on the fake clock, reading `next` on each call. */
async function trace<R>(next: () => R, wait: (read: () => R) => Promise<unknown>): Promise<Trace> {
  const t0 = Date.now()
  const reads: number[] = []
  let end: string | undefined
  void wait(() => (reads.push(Date.now() - t0), next())).then(
    (r) => (end = `ok ${(r as { status?: string }).status ?? r}`),
    (e: Error) => (end = `${e.name}: ${e.message}`),
  )
  for (let i = 0; end === undefined && i < 2_000; i++) await vi.advanceTimersByTimeAsync(250)
  return { reads, end: end ?? "never ended" }
}

/** A node whose receipts follow `script`, holding its last one. */
const scripted = (script: (() => TxReceipt)[]) => {
  let i = 0
  return () => script[Math.min(i++, script.length - 1)]()
}

const RECEIPTS: [string, (() => TxReceipt)[], WaitOpts | undefined][] = [
  ["pending, then checkpointed", [pending, pending, () => mined(TxStatus.CHECKPOINTED)], undefined],
  [
    "proposed is not enough by default",
    [pending, () => mined(TxStatus.PROPOSED), () => mined(TxStatus.CHECKPOINTED)],
    undefined,
  ],
  [
    "proposed when asked for it",
    [pending, () => mined(TxStatus.PROPOSED)],
    { waitForStatus: TxStatus.PROPOSED },
  ],
  [
    "dropped inside the grace, then mined",
    [dropped, dropped, () => mined(TxStatus.FINALIZED)],
    undefined,
  ],
  ["dropped past the grace", [dropped], undefined],
  ["dropped with no grace", [dropped], { ignoreDroppedReceiptsFor: 0 }],
  [
    "dropped at the end of a short grace",
    [dropped],
    { ignoreDroppedReceiptsFor: 2, interval: 0.5 },
  ],
  ["reverted", [() => mined(TxStatus.CHECKPOINTED, TxExecutionResult.REVERTED)], undefined],
  [
    "reverted, not thrown",
    [() => mined(TxStatus.CHECKPOINTED, TxExecutionResult.REVERTED)],
    { dontThrowOnRevert: true },
  ],
  ["timeout", [pending], { timeout: 3 }],
  ["no timeout", [...Array(20).fill(pending), () => mined(TxStatus.PROVEN)], { timeout: 0 }],
  ["an interval", [pending, pending, () => mined(TxStatus.CHECKPOINTED)], { interval: 2.5 }],
  ["an initial delay", [pending, () => mined(TxStatus.CHECKPOINTED)], { initialDelay: 4 }],
  ["an initial delay past the timeout", [pending], { initialDelay: 10, timeout: 3 }],
  [
    "an initial delay and no timeout",
    [pending, () => mined(TxStatus.CHECKPOINTED)],
    { initialDelay: 4, timeout: 0 },
  ],
]

describe("the sdk's waits match aztec.js's", () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }),
  )
  afterEach(() => vi.useRealTimers())

  it("keeps aztec.js's defaults", () => {
    expect(DefaultWaitOpts).toEqual({ ignoreDroppedReceiptsFor: 5, timeout: 300, interval: 1 })
  })

  it.each(RECEIPTS)("waitForTx: %s", async (_, script, opts) => {
    const run = (wait: (node: AztecNode) => Promise<TxReceipt>) =>
      trace(scripted(script), (read) => wait({ getTxReceipt: async () => read() } as never))
    const upstream = await run((node) => upstreamWaitForTx(node, HASH, opts))
    const copy = await run((node) => waitForTx(node, HASH, opts, createPace()))
    expect(upstream.end).not.toBe("never ended")
    expect(copy).toEqual(upstream)
  })

  it.each([
    ["imported on the third read", [false, false, true], 30],
    ["never imported", [false], 3],
    ["no timeout", [...Array(10).fill(false), true], 0],
  ] as const)("waitForRegistrationMessage: %s", async (_, script, timeoutSeconds) => {
    const run = (wait: (node: never) => Promise<boolean>) => {
      const ready = scripted(script.map((r) => () => r) as never)
      return trace(ready as () => boolean, (read) =>
        wait({
          getL1ToL2MessageIndex: async () => (read() ? 0n : undefined),
          getBlockData: async () => ({
            header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: 1 } } },
          }),
        } as never),
      )
    }
    const hash = { toString: () => "0x01" } as Fr
    const upstream = await run((node) => waitForL1ToL2MessageReady(node, hash, { timeoutSeconds }))
    const copy = await run((node) =>
      waitForRegistrationMessage(node, hash, { timeoutSeconds }, createPace()),
    )
    expect(upstream.end).not.toBe("never ended")
    expect(copy).toEqual(upstream)
  })
})
