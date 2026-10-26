import { describe, expect, it, vi } from "vitest"
import type { Address, Hex } from "viem"
import { EthAddress } from "@aztec/aztec.js/addresses"

const store = vi.hoisted(() => ({
  create: vi.fn(),
  load: async () => {},
  get: vi.fn((_id: string): object | null => null),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => store,
  currentDeployment: async () => undefined,
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => ({ deployedAtBlock: "5" }),
  l1PublicClient: () => ({ getBlock: async () => ({ timestamp: 1_700_000_000n }) }),
}))

const { recordFrozenRefund, recordSentFrozenRefunds } = await import(
  "../src/features/withdraw/frozenExit"
)
const { frozenExitSummary, runFrozenExit } = await import("../src/features/withdraw/frozenExitRun")

const USER = `0x${"44".repeat(20)}` as Address
const PORTAL = `0x${"cc".repeat(20)}`

/** A frozen portal holding `notes`, which refunds whatever a confirmed transaction named. */
function frozenPortal(notes: Record<string, bigint>) {
  const left = new Map(Object.entries(notes))
  let pending: string[] = []
  const runtime = {
    candidates: vi.fn(async (_opts?: { fresh?: boolean }) => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1_000n,
      waiting: 9n,
      candidates: [...left].map(([id, amount]) => ({
        id,
        amount: String(amount),
        kind: "note" as const,
      })),
    })),
    build: vi.fn(async ({ ids }: { ids: string[] }, recipient: Address, tip: bigint) => {
      expect([recipient, tip]).toEqual([USER, 0n])
      pending = ids
      return {
        amount: ids.reduce((sum, id) => sum + left.get(id)!, 0n),
        operation: { target: EthAddress.fromString(PORTAL), calldata: Buffer.from(ids.join(",")) },
      }
    }),
  }
  let n = 0
  const channel = {
    target: USER,
    sendTransaction: vi.fn(async (to: Address) => {
      expect(to).toBe(PORTAL)
      return `0x${String(++n).padStart(64, "0")}` as Hex
    }),
    waitForReceipt: vi.fn(async () => {
      pending.forEach((id) => left.delete(id))
      return true
    }),
  }
  return { runtime, channel }
}

describe("the frozen-portal exit", () => {
  it("sends every capped batch from the user's wallet until nothing is refundable", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n, b: 2n, c: 3n })
    const result = await runFrozenExit(runtime as never, channel)
    expect(result).toMatchObject({ refunded: 6n, stranded: 0n, waiting: 9n })
    expect(result.hashes).toHaveLength(2)
    expect(runtime.candidates.mock.calls.map(([o]) => o)).toEqual([
      { fresh: true },
      { fresh: false },
      { fresh: false },
    ])
  })

  it("counts a note above the portal's cap as not yet withdrawable", async () => {
    const { runtime } = frozenPortal({ a: 1n, big: 5_000n })
    expect(await frozenExitSummary(runtime as never)).toEqual({
      refundable: 1n,
      links: 0n,
      waiting: 5_009n,
    })
  })

  it("refunds payment link notes with the account's and names their part", async () => {
    const { runtime } = frozenPortal({ a: 1n })
    runtime.candidates.mockResolvedValueOnce({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1_000n,
      waiting: 0n,
      candidates: [
        { id: "a", amount: "1", kind: "note" as const },
        { id: "l", amount: "4", kind: "escrow-note" as never },
      ],
    })
    expect(await frozenExitSummary(runtime as never)).toEqual({
      refundable: 5n,
      links: 4n,
      waiting: 0n,
    })
  })

  it("stops on a reverted refund", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    channel.waitForReceipt.mockResolvedValueOnce(false)
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/reverted/)
    expect(channel.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("waits for a refund whose receipt timed out before sending again", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    channel.waitForReceipt.mockRejectedValueOnce(new Error("timed out"))
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/timed out/)
    await runFrozenExit(runtime as never, channel)
    expect(channel.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("refuses a second run while one is in flight", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    const first = runFrozenExit(runtime as never, channel)
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/already running/)
    await expect(first).resolves.toMatchObject({ refunded: 1n })
  })

  it("never sends a batch again while the portal still lists it", async () => {
    const { runtime, channel } = frozenPortal({ a: 1n })
    channel.waitForReceipt.mockResolvedValue(true)
    await expect(runFrozenExit(runtime as never, channel)).rejects.toThrow(/already sent/)
    expect(channel.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("records a Savings batch at its dollar value, with the shares that arrived", async () => {
    const hash = `0x${"ab".repeat(32)}` as Hex
    await recordFrozenRefund({
      hash,
      amount: 9n * 10n ** 18n,
      usd: 10n * 10n ** 18n,
      to: USER,
      symbol: "sUSDS",
    })
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "10",
        rawAmount: String(9n * 10n ** 18n),
        tokenSymbol: "sUSDS",
        relayerTip: "0",
        fpcFundingCut: "0",
        phase: "done",
        l1TxHash: hash,
      }),
    )
  })

  it("records past refund batches L1 paid that have no row, and skips the rest", async () => {
    const hash = (b: string) => `0x${b.repeat(32)}` as Hex
    store.get.mockImplementation((id) => (id === `wdraw_refund_${hash("01")}` ? {} : null))
    store.create.mockClear()
    const runtime = {
      refundsSent: vi.fn(async (_client: unknown, fromBlock: bigint) => {
        expect(fromBlock).toBe(5n)
        return [
          { hash: hash("01"), amount: 1n, recipient: USER, blockNumber: 7n },
          { hash: hash("02"), amount: 2n, recipient: USER, blockNumber: 8n },
        ]
      }),
    }
    await recordSentFrozenRefunds(runtime as never)
    expect(store.create).toHaveBeenCalledOnce()
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        l1TxHash: hash("02"),
        rawAmount: "2",
        startTime: 1_700_000_000_000,
      }),
    )
  })
})
