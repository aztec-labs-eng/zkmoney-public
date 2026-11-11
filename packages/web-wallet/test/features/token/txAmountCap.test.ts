// @vitest-environment node
/** The portal's per-operation cap: read with retries, kept per portal, read again after a failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toHex, type Address } from "viem"
import { createPageChain } from "../../../src/app/pageChain"
import { defaultConfig } from "../../support/page"
import { testChain } from "../../support/query"

const txAmountCap = (reads: ReturnType<typeof createPageChain>, portal: Address) =>
  reads.txAmountCap(portal).read()

let next = 1
const portal = (): Address => `0x${(next++).toString(16).padStart(40, "a")}`

/** The L1 node: its `eth_call`s answer in turn, and the last answer repeats. */
function node(...answers: (bigint | Error)[]) {
  const calls = vi.fn()
  const answer = ({ id, method }: { id: number; method: string }) => {
    expect(method).toBe("eth_call")
    calls()
    const next = answers.length > 1 ? answers.shift()! : answers[0]
    return next instanceof Error
      ? { jsonrpc: "2.0", id, error: { code: 3, message: next.message, data: "0x" } }
      : { jsonrpc: "2.0", id, result: toHex(next, { size: 32 }) }
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body))
    }),
  )
  return { calls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("txAmountCap", () => {
  it("retries a failed read twice before it answers", async () => {
    const { calls } = node(new Error("rpc"), new Error("rpc"), 5n)
    const cap = txAmountCap(createPageChain(defaultConfig, testChain()), portal())
    await vi.runAllTimersAsync()
    await expect(cap).resolves.toBe(5n)
    expect(calls).toHaveBeenCalledTimes(3)
  })

  it("reads a portal once, whatever its case", async () => {
    const { calls } = node(7n)
    const reads = createPageChain(defaultConfig, testChain())
    const at = portal()
    const read = txAmountCap(reads, at)
    await vi.runAllTimersAsync()
    await expect(read).resolves.toBe(7n)
    await expect(txAmountCap(reads, at.toUpperCase() as Address)).resolves.toBe(7n)
    expect(calls).toHaveBeenCalledOnce()
  })

  it("rejects after the third failure and reads again on the next read", async () => {
    const failure = new Error("rpc")
    const { calls } = node(failure, failure, failure, 9n)
    const reads = createPageChain(defaultConfig, testChain())
    const at = portal()
    const cap = txAmountCap(reads, at)
    const settled = expect(cap).rejects.toThrow("rpc")
    await vi.runAllTimersAsync()
    await settled
    const again = txAmountCap(reads, at)
    await vi.runAllTimersAsync()
    await expect(again).resolves.toBe(9n)
    expect(calls).toHaveBeenCalledTimes(4)
  })
})
