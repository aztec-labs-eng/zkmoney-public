import { describe, expect, it, vi } from "vitest"
import { TxExecutionResult } from "@aztec/stdlib/tx"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { TX_AMOUNT_CAP } from "@oxide/oxide-lib/oxide_constants.gen.js"

const SIPA = "0x00000000000000000000000000000000000000aa"
const sweeps = vi.hoisted(() => ({ received: vi.fn(async () => false) }))
vi.mock("../../src/services/migrationDeposit.js", () => ({
  migrationSipaCoordinates: () => ({ day: 3, nonce: 4 }),
  resolveMigrationDeposit: async () => ({ sipaAddress: SIPA, resolution: {} }),
  migrationDepositCalls: async () => [],
}))
vi.mock("../../src/services/sipaIntents.js", () => ({
  readDepositSIPAImplementation: async () => SIPA,
}))
vi.mock("../../src/services/metadataMigration.js", () => ({ readQuotedDepositFee: async () => 1n }))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSponsorPayload: async () => ({}),
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))

import {
  LiveMetadataMigrationSource,
  type LiveMetadataMigrationSourceOptions,
} from "../../src/services/LiveMetadataMigrationSource.js"

function fixture() {
  const recipient = "0x0000000000000000000000000000000000000001" as const
  const txHash = `0x${"11".repeat(32)}`
  const account = { getAddress: () => AztecAddress.ZERO }
  let stored: MigrationFundingBatch
  const batches = {
    get: vi.fn(
      async (_id?: string): Promise<MigrationFundingBatch | undefined> =>
        JSON.parse(JSON.stringify(stored)),
    ),
    set: vi.fn(async (_id: string, next: MigrationFundingBatch) => {
      stored = JSON.parse(JSON.stringify(next))
    }),
  }
  const withdraw = vi.fn(async (_recipient, _amount, _sponsor, options) => {
    await options.onTxHash(txHash)
    expect(stored.burnTx).toBe(txHash)
    throw new Error("RPC response lost")
  })
  const receipt = vi.fn(async () => ({
    executionResult: undefined as TxExecutionResult | undefined,
  }))
  // The source portal's funding cut; the exit fee is the relayer tip plus this.
  const cut = vi.fn(async () => 5n)
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "FPC_FUNDING_CUT" ? cut() : false,
  )
  const balance = vi.fn(async () => 0n)
  const sendTx = vi.fn()
  const options = {
    received: sweeps.received,
    client: { readContract, getBlockNumber: async () => 7n },
    wallet: { node: { getTxReceipt: receipt }, sendTx },
    account,
    source: {
      tuple: { portal: recipient },
      tokenService: {
        tokenAddress: AztecAddress.ZERO,
        exitToL1PrivateSponsored: withdraw,
        getBalance: balance,
      },
    },
    destination: { portal: recipient, factory: recipient, rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO },
    batches,
    sourceSponsor: async () => ({}),
  } as unknown as LiveMetadataMigrationSourceOptions
  const make = () => {
    const source = new LiveMetadataMigrationSource(options)
    vi.spyOn(source, "state").mockResolvedValue("live")
    return source
  }
  const source = make()
  stored = {
    binding: source.identity,
    recipient,
    amount: String(20n * WITHDRAW_RELAYER_TIP),
    exitFee: String(WITHDRAW_RELAYER_TIP + 5n),
    fromBlock: "1",
  }
  return { source, make, recipient, txHash, withdraw, receipt, cut, batches, balance, sendTx }
}

describe("live migration withdrawal durability", () => {
  it("does not burn again after restart when the submission response was lost", async () => {
    const f = fixture()
    await expect(f.source.fund("first", f.recipient)).rejects.toThrow("RPC response lost")
    await expect(f.make().fund("first", f.recipient)).rejects.toThrow("awaiting confirmation")
    f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.SUCCESS })
    await f.make().fund("first", f.recipient)
    expect(f.withdraw).toHaveBeenCalledTimes(1)
  })

  it("fails before submission when saving the burn hash fails", async () => {
    const f = fixture()
    const sent = vi.fn()
    f.batches.set.mockRejectedValue(new Error("storage unavailable"))
    f.withdraw.mockImplementation(async (_recipient, _amount, _sponsor, options) => {
      await options.onTxHash(f.txHash)
      sent()
      throw new Error("unreachable")
    })
    await expect(f.source.fund("first", f.recipient)).rejects.toThrow("storage unavailable")
    expect(sent).not.toHaveBeenCalled()
  })

  it("records no burn, so submits nothing, once a remaining batch's recovery is cancelled", async () => {
    const f = fixture()
    const later = { ...(await f.batches.get())!, day: 3, nonce: 4, broadcastTx: f.txHash }
    const saved = new Map<string, MigrationFundingBatch>([["remaining", later]])
    f.batches.get.mockImplementation(async (id?: string) => saved.get(id!))
    f.batches.set.mockImplementation(async (id: string, next: MigrationFundingBatch) => {
      saved.set(id, JSON.parse(JSON.stringify(next)))
    })
    f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.SUCCESS })
    const cancel = new AbortController()
    f.withdraw.mockImplementation(async (_recipient, _amount, _sponsor, options) => {
      cancel.abort()
      await options.onTxHash(f.txHash)
    })
    await expect(f.source.recoverRemaining(cancel.signal)).rejects.toThrow()
    expect(saved.get("remaining")!.burnTx).toBeUndefined()
  })

  it("refuses a changed recipient or a source exit fee above the prepared one", async () => {
    const f = fixture()
    await expect(
      f.source.fund("first", "0x0000000000000000000000000000000000000002"),
    ).rejects.toThrow("does not match")
    f.cut.mockResolvedValue(6n)
    await expect(f.source.fund("first", f.recipient)).rejects.toThrow("exit fee increased")
    expect(f.withdraw).not.toHaveBeenCalled()
  })

  it("resumes a later batch without repeating a completed withdrawal", async () => {
    const f = fixture()
    const first = { ...(await f.batches.get())!, received: true }
    const later = { ...first, received: false, burnTx: f.txHash }
    f.batches.get.mockImplementation(async (id?: string) =>
      id === "remaining" ? first : id === "remaining-1" ? later : undefined,
    )
    expect(await f.source.remainingComplete()).toBe(false)
    f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.SUCCESS })
    await f.source.fund("remaining-1", f.recipient)
    expect(f.withdraw).not.toHaveBeenCalled()
    later.received = true
    vi.mocked(f.source.state).mockResolvedValue("empty")
    expect(await f.source.remainingComplete()).toBe(true)
  })

  it("starts the next batch from the balance left after a received one", async () => {
    const f = fixture()
    const first = { ...(await f.batches.get())!, received: true, broadcastTx: f.txHash }
    const saved = new Map<string, MigrationFundingBatch>([["remaining", first]])
    f.batches.get.mockImplementation(async (id?: string) => saved.get(id!))
    f.batches.set.mockImplementation(async (id: string, next: MigrationFundingBatch) => {
      saved.set(id, JSON.parse(JSON.stringify(next)))
    })
    const left = 10n * WITHDRAW_RELAYER_TIP
    f.balance.mockResolvedValue(left)
    const broadcast = `0x${"22".repeat(32)}`
    f.sendTx.mockImplementation(async (_payload, options) => options.onTxHash(broadcast))
    await f.source.recoverRemaining()
    expect(saved.get("remaining")).toEqual(first)
    expect(saved.get("remaining-1")).toMatchObject({
      recipient: SIPA,
      amount: String(left),
      exitFee: String(WITHDRAW_RELAYER_TIP + 5n),
      fromBlock: "7",
      day: 3,
      nonce: 4,
      broadcastTx: broadcast,
    })
    // The burn waits for the broadcast to be included.
    expect(f.withdraw).not.toHaveBeenCalled()
  })

  it.each([
    [
      "two full batches and the rest",
      2n * TX_AMOUNT_CAP + 100n * WITHDRAW_RELAYER_TIP,
      [TX_AMOUNT_CAP, TX_AMOUNT_CAP, 100n * WITHDRAW_RELAYER_TIP],
    ],
    // A remainder of one tip can't pay its own exit and deposit, so the first batch leaves more.
    [
      "a short batch that leaves a movable remainder",
      TX_AMOUNT_CAP + WITHDRAW_RELAYER_TIP,
      [TX_AMOUNT_CAP - 7n, WITHDRAW_RELAYER_TIP + 7n],
    ],
  ])(
    "recovers a balance above the withdrawal cap in %s until the source is empty",
    async (_, start, expected) => {
      const f = fixture()
      const saved = new Map<string, MigrationFundingBatch>()
      f.batches.get.mockImplementation(async (id?: string) => saved.get(id!))
      f.batches.set.mockImplementation(async (id: string, next: MigrationFundingBatch) => {
        saved.set(id, JSON.parse(JSON.stringify(next)))
      })
      let balance = start
      f.balance.mockImplementation(async () => balance)
      vi.mocked(f.source.state).mockImplementation(async () => (balance > 0n ? "live" : "empty"))
      f.sendTx.mockImplementation(async (_payload, options) =>
        options.onTxHash(`0x${"22".repeat(32)}`),
      )
      f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.SUCCESS })
      const withdrawn: bigint[] = []
      f.withdraw.mockImplementation(async (_recipient, amount, _sponsor, options) => {
        await options.onTxHash(f.txHash)
        withdrawn.push(BigInt(amount))
        balance -= BigInt(amount)
      })
      sweeps.received.mockResolvedValue(true)
      for (let step = 0; !(await f.source.remainingComplete()); step++) {
        expect(step).toBeLessThan(3 * expected.length)
        await f.source.recoverRemaining()
      }
      expect(withdrawn).toEqual(expected)
      expect(withdrawn.every((amount) => amount <= TX_AMOUNT_CAP)).toBe(true)
      expect(balance).toBe(0n)
    },
  )
})

describe("live migration quote", () => {
  // The fixture's exit is the relayer tip plus a funding cut of 5.
  const exit = WITHDRAW_RELAYER_TIP + 5n
  const minimums = { first: 100n, later: 2n }

  it("quotes the whole balance exactly when prepare can take a first batch", async () => {
    const f = fixture()
    const saved: MigrationFundingBatch[] = []
    f.batches.get.mockResolvedValue(undefined)
    f.batches.set.mockImplementation(async (_id: string, next: MigrationFundingBatch) => {
      saved.push(next)
    })
    vi.spyOn(f.source, "restore").mockResolvedValue({ netAmount: 100n })
    f.balance.mockResolvedValue(100n + exit)
    expect(await f.source.quote(minimums)).toEqual({
      movable: 100n + exit,
      stranded: 0n,
      waiting: 0n,
    })
    await f.source.prepare(f.recipient, 100n)
    expect(BigInt(saved[0]!.amount) - BigInt(saved[0]!.exitFee)).toBe(100n)
    f.balance.mockResolvedValue(99n + exit)
    expect(await f.source.quote(minimums)).toEqual({
      movable: 0n,
      stranded: 99n + exit,
      waiting: 0n,
    })
    await expect(f.source.prepare(f.recipient, 100n)).rejects.toThrow("do not cover")
  })

  it("quotes a balance above the withdrawal cap in full", async () => {
    const f = fixture()
    f.balance.mockResolvedValue(3n * TX_AMOUNT_CAP)
    expect((await f.source.quote(minimums)).movable).toBe(3n * TX_AMOUNT_CAP)
  })

  it("quotes nothing once empty", async () => {
    const f = fixture()
    vi.mocked(f.source.state).mockResolvedValue("empty")
    f.balance.mockResolvedValue(10n * exit)
    expect(await f.source.quote(minimums)).toEqual({ movable: 0n, stranded: 0n, waiting: 0n })
  })
})
