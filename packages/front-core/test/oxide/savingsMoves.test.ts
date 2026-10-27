import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Address, Hex } from "viem"
import { deriveSkyEscrowSalts } from "../../src/oxide/oxideAccountKeys"
import {
  settleSavingsMove,
  type SavingsMove,
  type SavingsMoveSettleDeps,
} from "../../src/oxide/savingsMoves"

const MAIN = "0x00000000000000000000000000000000000000aa" as Address
const SAVINGS = "0x00000000000000000000000000000000000000bb" as Address
const masterSecret = new Fr(7n)
const recipient = AztecAddress.fromStringUnsafe(`0x${"0".repeat(63)}5`)

const move = (direction: "in" | "out", extra: Partial<SavingsMove> = {}): SavingsMove => ({
  direction,
  withdrawalLocalId: "w1",
  escrow: "0x00000000000000000000000000000000000000ee",
  nonce: `0x${"01".repeat(32)}` as Hex,
  recipientCommitment: `0x${"02".repeat(32)}` as Hex,
  amount: "10",
  ...extra,
})

function deps(opts: { deposit?: boolean; claimFails?: boolean; head?: bigint } = {}) {
  const claims = { main: vi.fn(), savings: vi.fn() }
  const claimer = (side: "main" | "savings") => async () => ({
    claimSweptDeposit: async (params: unknown) => {
      claims[side](params)
      if (opts.claimFails) throw new Error("No L1 to L2 message found")
      return undefined as never
    },
  })
  const getContractEvents = vi.fn(async () =>
    opts.deposit === false ? [] : [{ args: { index: 12n, amount: 34n } }],
  )
  const getBlockNumber = vi.fn(async () => opts.head ?? 100n)
  // A block is final 64 blocks behind the head; blocks are 12 s apart, the head at 1,000,000 s.
  const getBlock = vi.fn(async (arg: { blockTag?: string; blockNumber?: bigint }) =>
    arg.blockNumber !== undefined
      ? {
          number: arg.blockNumber,
          timestamp: 1_000_000n - ((opts.head ?? 100n) - arg.blockNumber) * 12n,
        }
      : { number: (opts.head ?? 100n) - 64n },
  )
  const settleDeps: SavingsMoveSettleDeps = {
    publicClient: { getContractEvents, getBlockNumber, getBlock } as never,
    masterSecret,
    recipient,
    main: { portal: MAIN, fromBlock: 3n, claimer: claimer("main") },
    savings: { portal: SAVINGS, fromBlock: 5n, claimer: claimer("savings") },
  }
  return { settleDeps, claims, getContractEvents, getBlock }
}

describe("settleSavingsMove", () => {
  it("claims a move into Savings on Savings' token, with the salt its commitment came from", async () => {
    const { settleDeps, claims, getContractEvents } = deps()
    const { move: settled, claimError } = await settleSavingsMove(move("in"), settleDeps)

    expect(claimError).toBeUndefined()
    expect(settled.deposit).toEqual({ inboxIndex: "12", amount: "34", claimed: true })
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SAVINGS,
        eventName: "Deposit",
        args: { recipientCommitment: move("in").recipientCommitment },
        fromBlock: 5n,
        toBlock: 100n,
      }),
    )
    expect(claims.savings).toHaveBeenCalledWith({
      inboxIndex: 12n,
      amount: 34n,
      recipient,
      sharedSecretSalt: deriveSkyEscrowSalts(masterSecret, move("in").nonce).recipient,
    })
    expect(claims.main).not.toHaveBeenCalled()
  })

  it("lands a move out on Main", async () => {
    const { settleDeps, claims, getContractEvents } = deps()
    await settleSavingsMove(move("out"), settleDeps)
    expect(getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ address: MAIN }))
    expect(claims.main).toHaveBeenCalledOnce()
    expect(claims.savings).not.toHaveBeenCalled()
  })

  it("waits while the escrow has not deposited, and searches again from the first block not yet final", async () => {
    const { settleDeps, claims } = deps({ deposit: false })
    const pending = move("in")
    expect(await settleSavingsMove(pending, settleDeps)).toEqual({
      move: { ...pending, depositScanFrom: "37", depositScanFloor: expect.any(String) },
    })
    expect(claims.savings).not.toHaveBeenCalled()
  })

  it("searches from the move's cursor a window at a time", async () => {
    const { settleDeps, getContractEvents } = deps({ deposit: false, head: 25_000n })
    const { move: settled } = await settleSavingsMove(
      move("out", { depositScanFrom: "1000", depositScanFloor: "1000" }),
      settleDeps,
    )
    expect(
      getContractEvents.mock.calls.map((call) => {
        const [query] = call as unknown as [{ fromBlock: bigint; toBlock: bigint }]
        return [query.fromBlock, query.toBlock]
      }),
    ).toEqual([
      [1_000n, 10_999n],
      [11_000n, 20_999n],
      [21_000n, 25_000n],
    ])
    expect(settled.depositScanFrom).toBe("24937")
  })

  it("resumes a long search on the next sync", async () => {
    const { settleDeps, getContractEvents } = deps({ deposit: false, head: 1_000_000n })
    const { move: settled } = await settleSavingsMove(
      move("out", { depositScanFrom: "0", depositScanFloor: "0" }),
      settleDeps,
    )
    expect(getContractEvents).toHaveBeenCalledTimes(20)
    expect(settled.depositScanFrom).toBe("200000")
  })

  it("keeps the same move when its cursor is already at the head", async () => {
    const { settleDeps } = deps({ deposit: false })
    const atHead = move("in", { depositScanFrom: "100", depositScanFloor: "100" })
    expect((await settleSavingsMove(atHead, settleDeps)).move).toBe(atHead)
  })

  it("keeps a deposit whose claim failed, for the next sync", async () => {
    const { settleDeps } = deps({ claimFails: true })
    const { move: settled, claimError } = await settleSavingsMove(move("in"), settleDeps)
    expect(settled.deposit).toEqual({ inboxIndex: "12", amount: "34", claimed: false })
    expect(claimError).toBeInstanceOf(Error)
  })

  it("reads a claim the token already stored as claimed, with no error", async () => {
    const { settleDeps } = deps()
    settleDeps.savings.claimer = async () => ({
      claimSweptDeposit: async () => {
        throw new Error("Assertion failed: deposit already stored")
      },
    })
    const { move: settled, claimError } = await settleSavingsMove(move("in"), settleDeps)
    expect(claimError).toBeUndefined()
    expect(settled.deposit).toEqual({ inboxIndex: "12", amount: "34", claimed: true })
  })

  it("searches a move with no cursor from the block of its burn's start, never the chain's start", async () => {
    const { settleDeps, getContractEvents, getBlock } = deps({ deposit: false, head: 100_000n })
    // The burn began 6,000 s before the head: the last block at or before then, 500 blocks back.
    await settleSavingsMove(
      move("in"),
      { ...settleDeps, savings: { ...settleDeps.savings, fromBlock: undefined } },
      (1_000_000 - 6_000) * 1000,
    )
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 100_000n - 500n }),
    )
    // Recent blocks came fast (1 s apart over the last 1,000): an average of them would land after
    // the burn, the block found by its timestamp does not.
    getBlock.mockImplementation(async (arg: { blockTag?: string; blockNumber?: bigint }) =>
      arg.blockNumber === undefined
        ? { number: 100_000n - 64n }
        : {
            number: arg.blockNumber,
            timestamp:
              arg.blockNumber >= 99_000n
                ? 1_000_000n - (100_000n - arg.blockNumber)
                : 1_000_000n - 1_000n - (99_000n - arg.blockNumber) * 12n,
          },
    )
    getContractEvents.mockClear()
    const burnAt = 1_000_000 - 1_000 - 600
    await settleSavingsMove(
      move("in"),
      { ...settleDeps, savings: { ...settleDeps.savings, fromBlock: undefined } },
      burnAt * 1000,
    )
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 99_000n - 50n }),
    )
    // Never before the deployment's block, and the chain's start only without a start time.
    getContractEvents.mockClear()
    await settleSavingsMove(move("in"), settleDeps, (1_000_000 - 6_000_000) * 1000)
    expect(getContractEvents).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 5n }))
  })

  it("rebuilds a move from its burn with the cursor the burn's meta carries", async () => {
    const { savingsMoveOfWithdrawal } = await import("../../src/oxide/savingsMoves")
    const record = {
      localId: "w1",
      recipient: "0x00000000000000000000000000000000000000ee",
      amount: "10",
      rawAmount: "10",
      startTime: 1,
      phase: "submitting",
      skyMove: {
        ...move("in"),
        factory: "0xf",
        recoveryCommitment: "0x03",
        relayerTip: "1",
        depositScanFrom: "11850000",
      },
    } as never
    expect(savingsMoveOfWithdrawal(record)?.depositScanFrom).toBe("11850000")
  })

  it("leaves a claimed or recovered move alone", async () => {
    const { settleDeps, getContractEvents } = deps()
    const claimed = move("in", { deposit: { inboxIndex: "1", amount: "1", claimed: true } })
    const recovered = move("out", { recovered: { to: MAIN, txHashes: [] } })
    expect((await settleSavingsMove(claimed, settleDeps)).move).toBe(claimed)
    expect((await settleSavingsMove(recovered, settleDeps)).move).toBe(recovered)
    expect(getContractEvents).not.toHaveBeenCalled()
  })
})
