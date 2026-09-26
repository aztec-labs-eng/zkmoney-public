/**
 * A cached deposit address whose broadcast an earlier page sent is published only once the chain
 * includes it. Pending is neither repeated nor marked: its `publish` waits for the chain, and sends
 * again only if the broadcast was dropped.
 */
import { describe, expect, it, vi } from "vitest"
import { TxExecutionResult, TxStatus } from "@aztec/stdlib/tx"
import {
  broadcastState,
  makePublish,
  type BroadcastState,
} from "../src/features/deposit/sipaGateway"

const hash = `0x${"11".repeat(32)}`
const wallet = (receipt: () => Promise<unknown>) =>
  ({ node: { getTxReceipt: receipt } }) as unknown as Parameters<typeof broadcastState>[0]

describe("broadcastState", () => {
  it("reads an included broadcast as included", async () => {
    const w = wallet(async () => ({
      status: TxStatus.PROVEN,
      executionResult: TxExecutionResult.SUCCESS,
      blockNumber: 12,
    }))
    expect(await broadcastState(w, hash)).toBe("included")
  })

  it("reads a broadcast the node still holds as pending", async () => {
    const w = wallet(async () => ({ status: TxStatus.PENDING }))
    expect(await broadcastState(w, hash)).toBe("pending")
  })

  it("reads a dropped or reverted broadcast as dropped", async () => {
    expect(await broadcastState(wallet(async () => ({ status: TxStatus.DROPPED })), hash)).toBe(
      "dropped",
    )
    const reverted = wallet(async () => ({
      status: TxStatus.PROVEN,
      executionResult: TxExecutionResult.REVERTED,
      blockNumber: 12,
    }))
    expect(await broadcastState(reverted, hash)).toBe("dropped")
  })

  it("treats an unreachable node as pending, so nothing is repeated on a guess", async () => {
    const w = wallet(async () => {
      throw new Error("ECONNREFUSED")
    })
    expect(await broadcastState(w, hash)).toBe("pending")
  })
})

describe("makePublish", () => {
  const wait = { intervalMs: 1, timeoutMs: 10, sleep: async () => {} }
  const states = (...seq: BroadcastState[]) => vi.fn(async () => seq.shift() ?? "pending")

  it("sends once however often it is called, with the first caller's options", async () => {
    const send = vi.fn(async () => {})
    const publish = makePublish({ published: () => false, send, wait })
    await Promise.all([
      publish({ operationId: "a", saveHash: true }),
      publish({ operationId: "b" }),
    ])
    await publish()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ operationId: "a", saveHash: true })
  })

  it("sends nothing for an address another view has published since", async () => {
    const send = vi.fn(async () => {})
    await makePublish({ published: () => true, send, wait })()
    expect(send).not.toHaveBeenCalled()
  })

  it("waits out a pending broadcast and marks it published once included", async () => {
    const send = vi.fn(async () => {})
    const markPublished = vi.fn()
    const state = states("pending", "pending", "included")
    await makePublish({ published: () => false, send, pending: { state, markPublished }, wait })()
    expect(state).toHaveBeenCalledTimes(3)
    expect(markPublished).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it("sends again when a pending broadcast is dropped", async () => {
    const send = vi.fn(async () => {})
    const markPublished = vi.fn()
    const state = states("pending", "dropped")
    const publish = makePublish({
      published: () => false,
      send,
      pending: { state, markPublished },
      wait,
    })
    await publish({ operationId: "op", saveHash: true })
    expect(send).toHaveBeenCalledWith({ operationId: "op", saveHash: true })
    expect(markPublished).not.toHaveBeenCalled()
  })

  it("gives up, unresolved, on a broadcast that stays pending", async () => {
    const send = vi.fn(async () => {})
    const pending = { state: states(), markPublished: vi.fn() }
    await expect(makePublish({ published: () => false, send, pending, wait })()).rejects.toThrow(
      /still being published/,
    )
    expect(send).not.toHaveBeenCalled()
  })
})
