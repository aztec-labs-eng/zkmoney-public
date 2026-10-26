import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { TxExecutionResult } from "@aztec/stdlib/tx"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"

const chain = vi.hoisted(() => ({
  draws: [] as { day: number; nonce: number }[],
  next: 0,
  received: vi.fn(async () => false),
}))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
  readOrdinaryDepositFee: async () => 2n,
}))
vi.mock("../../src/services/migrationDeposit.js", () => ({
  migrationSipaCoordinates: () => chain.draws.shift() ?? { day: 1, nonce: ++chain.next },
  resolveMigrationDeposit: async (_c: unknown, day: number, nonce: number) => ({
    sipaAddress: `0x${String(day * 1000 + nonce).padStart(40, "0")}`,
    resolution: { messageSecret: { day, nonce } },
  }),
  migrationDepositCalls: async () => [],
}))
vi.mock("@oxide/oxide-client/broadcaster_calls.js", () => ({
  broadcastL1Operation: () => ({ request: async () => ({ calls: [] }) }),
}))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSponsorPayload: async () => ({}),
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))

const { FrozenMetadataMigrationSource } = await import(
  "../../src/services/FrozenMetadataMigrationSource.js"
)
const { ApprovalNeededError } = await import("../../src/services/metadataMigration.js")

const deposit = (id: string, amount = 20n * TIP) => ({
  id,
  amount: String(amount),
  kind: "frozen-deposit" as const,
})

const link = (id: string) => ({
  id,
  amount: String(20n * TIP),
  kind: "escrow-note" as const,
  owner: "0x0a",
})

function fixture(
  candidates: {
    id: string
    amount: string
    kind: "note" | "frozen-deposit" | "escrow-note"
    owner?: string
  }[] = [deposit("a"), deposit("b"), deposit("c")],
  hooks: { depositSettled?(recipient: string): Promise<boolean> } = {},
) {
  const saved = new Map<string, MigrationFundingBatch>()
  const order: string[] = []
  const spent = new Set<string>()
  const build = vi.fn(async ({ ids }: { ids: string[] }, recipient: string) => {
    order.push(`build ${ids.join(",")} after ${saved.size} saved`)
    return {
      amount: ids.reduce(
        (sum, id) => sum + BigInt(candidates.find((c) => c.id === id)!.amount),
        0n,
      ),
      operation: { target: recipient, payoutToken: recipient, calldata: "0x1234" as const },
    }
  })
  const sendTx = vi.fn(
    async (_payload: unknown, opts: { onTxHash(hash: string): Promise<void> }) => {
      await opts.onTxHash(`0x${String(sendTx.mock.calls.length).padStart(64, "0")}`)
    },
  )
  const receipt = vi.fn(async () => ({ executionResult: TxExecutionResult.SUCCESS }))
  const runtime = {
    identity: "frozen",
    validate: async () => {},
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates: candidates.filter((c) => !spent.has(c.id)),
      waiting: 7n,
    })),
    build,
    refunded: vi.fn(async (ids: string[]) => ids.every((id) => spent.has(id))),
  }
  const options = {
    received: chain.received,
    ...hooks,
    runtime,
    destinationAsset: "0x0000000000000000000000000000000000000001",
    destination: { portal: "0x01", factory: "0x01", rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO, policy: {} },
    client: { getBlockNumber: async () => 1n, call: async () => ({}) },
    wallet: { node: { getTxReceipt: receipt }, sendTx },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
  } as never
  const make = () => new FrozenMetadataMigrationSource(options)
  return { make, saved, order, build, sendTx, receipt, runtime, spent, candidates }
}

beforeEach(() => {
  chain.draws = []
  chain.next = 0
  chain.received.mockReset()
  chain.received.mockResolvedValue(false)
})

describe("proving every later batch up front", () => {
  it("saves every batch with its coordinates before any approval, then proves each", async () => {
    const f = fixture()

    await f.make().prepareRemaining(3n)

    expect(f.order).toEqual([
      "build a after 3 saved",
      "build b after 3 saved",
      "build c after 3 saved",
    ])
    expect([...f.saved.values()].every((b) => b.approved && b.day !== undefined)).toBe(true)
  })

  it("records what each batch's deposit pays on the destination", async () => {
    const f = fixture()

    await f.make().prepareRemaining(3n, { depositFee: 2n })

    expect([...f.saved.values()].map((b) => b.depositFee)).toEqual(["2", "2", "2"])
  })

  it("resumes a refused approval with the same batches, unapproved ones first", async () => {
    const f = fixture()
    f.build.mockImplementationOnce(async ({ ids }: { ids: string[] }) => {
      f.order.push(`refused ${ids.join(",")}`)
      throw new Error("The operation either timed out or was not allowed")
    })
    await expect(f.make().prepareRemaining(3n)).rejects.toThrow("not allowed")
    const recipients = [...f.saved.values()].map((b) => b.recipient)
    f.order.length = 0

    await f.make().prepareRemaining(3n)

    expect([...f.saved.values()].map((b) => b.recipient)).toEqual(recipients)
    expect(f.order.map((o) => o.split(" ")[1])).toEqual(["a", "b", "c"])
    expect(chain.next).toBe(3)
  })

  it("rebuilds approved batches after the ones still to approve", async () => {
    const f = fixture()
    await f.make().prepareRemaining(3n)
    const b = f.saved.get("remaining-1")!
    f.saved.set("remaining-1", { ...b, approved: undefined })
    f.order.length = 0

    await f.make().prepareRemaining(3n)

    expect(f.order.map((o) => o.split(" ")[1])).toEqual(["b", "a", "c"])
  })

  it("draws again when coordinates collide with a saved batch's", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    chain.draws = [
      { day: 1, nonce: 7 },
      { day: 1, nonce: 7 },
      { day: 1, nonce: 8 },
    ]

    await f.make().prepareRemaining(3n)

    expect([...f.saved.values()].map((b) => b.nonce)).toEqual([7, 8])
  })

  it("leaves out the first batch's selection", async () => {
    const f = fixture()
    const source = f.make()
    const first = await source.prepare("0x0000000000000000000000000000000000000009", 3n)

    await source.prepareRemaining(3n, { exclude: first.id })

    const later = [...f.saved.entries()].filter(([id]) => id.startsWith("remaining-"))
    expect(later.map(([, b]) => b.sourceSelection)).toEqual([["b"], ["c"]])
  })

  it("abandons a planned batch whose funds were refunded elsewhere", async () => {
    const f = fixture()
    await f.make().prepareRemaining(3n)
    f.saved.set("remaining-1", { ...f.saved.get("remaining-1")!, approved: undefined })
    f.spent.add("b")

    await f.make().prepareRemaining(3n)

    expect(f.saved.get("remaining-1")).toMatchObject({ abandoned: true })
    expect([...f.saved.keys()]).toEqual(["remaining-0", "remaining-1", "remaining-2"])
  })
})

describe("keeping saved batches disjoint and complete", () => {
  const note = (id: string) => ({ id, amount: String(20n * TIP), kind: "note" as const })

  it("plans again what is left of a batch whose selection lost an id", async () => {
    const f = fixture([note("n1"), note("n2")])
    await f.make().prepareRemaining(3n)
    expect(f.saved.get("remaining-0")!.sourceSelection).toEqual(["n1", "n2"])
    f.saved.set("remaining-0", { ...f.saved.get("remaining-0")!, approved: undefined })
    f.spent.add("n1")
    const progress: [number, number][] = []

    await f.make().prepareRemaining(3n, {
      onApproval: async (approved, total) => void progress.push([approved, total]),
    })

    expect(f.saved.get("remaining-0")).toMatchObject({ abandoned: true })
    expect(f.saved.get("remaining-1")).toMatchObject({ sourceSelection: ["n2"], approved: true })
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ])
  })

  it("reports progress before the first approval, again once a batch is abandoned, and zero when none is open", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    const progress: [number, number][] = []
    const onApproval = async (approved: number, total: number) =>
      void progress.push([approved, total])
    vi.mocked(f.runtime.refunded).mockImplementation(
      async (ids: string[]) => progress.length > 0 && ids.includes("b"),
    )

    await f.make().prepareRemaining(3n, { onApproval })
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [1, 1],
    ])

    progress.length = 0
    const empty = fixture([])
    await empty.make().prepareRemaining(3n, { onApproval })
    expect(progress).toEqual([[0, 0]])
  })

  it("plans again a saved batch that overlaps a replaced first batch", async () => {
    const f = fixture()
    await f.make().prepareRemaining(3n)
    const source = f.make()
    // The first batch was replaced by "a", which remaining-0 had already reserved.
    const first = await source.prepare("0x0000000000000000000000000000000000000009", 3n)
    expect(f.saved.get(first.id)!.sourceSelection).toEqual(["a"])

    await source.prepareRemaining(3n, { exclude: first.id })

    expect(f.saved.get("remaining-0")).toMatchObject({ abandoned: true })
    const live = [...f.saved.entries()].filter(
      ([id, b]) => id.startsWith("remaining-") && !b.abandoned,
    )
    expect(live.flatMap(([, b]) => b.sourceSelection)).toEqual(["b", "c"])
  })
})

describe("sending the planned batches", () => {
  it("sends every planned batch in one pass, without waiting for any refund", async () => {
    const f = fixture()
    const source = f.make()
    await source.prepareRemaining(3n)

    await source.recoverRemaining()

    expect(f.sendTx).toHaveBeenCalledTimes(3)
    expect([...f.saved.values()].every((b) => b.broadcastTx)).toBe(true)
    expect(await source.remainingSent()).toBe(true)
    expect(f.build).toHaveBeenCalledTimes(3)
  })

  it("sends nothing more while an earlier saved carrier is not yet included", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    await f.make().prepareRemaining(3n)
    f.saved.set("remaining-0", {
      ...f.saved.get("remaining-0")!,
      broadcastTx: `0x${"0a".repeat(32)}`,
    })
    f.receipt.mockResolvedValue({ executionResult: undefined } as never)

    await f.make().recoverRemaining()
    expect(f.sendTx).not.toHaveBeenCalled()

    f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.SUCCESS })
    await f.make().recoverRemaining()
    expect(f.sendTx).toHaveBeenCalledOnce()
    expect(f.saved.get("remaining-1")!.broadcastTx).toBeDefined()
  })

  it("sends on past an earlier batch refunded on L1 whose carrier receipt is gone", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    await f.make().prepareRemaining(3n)
    f.saved.set("remaining-0", {
      ...f.saved.get("remaining-0")!,
      broadcastTx: `0x${"0a".repeat(32)}`,
    })
    f.receipt.mockResolvedValue({ executionResult: undefined } as never)
    f.spent.add("a")

    await f.make().recoverRemaining()

    expect(f.saved.get("remaining-0")).toMatchObject({ refunded: true })
    expect(f.saved.get("remaining-1")!.broadcastTx).toBeDefined()
  })

  it("never plans a batch itself: uncovered funds wait for the user's approval", async () => {
    const f = fixture([deposit("late")])

    await expect(f.make().recoverRemaining()).rejects.toBeInstanceOf(ApprovalNeededError)

    expect(f.build).not.toHaveBeenCalled()
    expect(f.saved.size).toBe(0)
  })

  it("records no hash, so submits nothing, once cancelled while a batch is proven", async () => {
    const f = fixture([deposit("a")])
    await f.make().prepareRemaining(3n)
    const cancel = new AbortController()
    f.sendTx.mockImplementationOnce(async (_payload, opts) => {
      cancel.abort()
      await opts.onTxHash("0xproven")
    })

    await expect(f.make().recoverRemaining(cancel.signal)).rejects.toThrow()

    expect(f.saved.get("remaining-0")!.broadcastTx).toBeUndefined()
  })
})

describe("payment links", () => {
  it("counts no approval for a link's batch, and proves it after the account's", async () => {
    const f = fixture([link("l")])
    f.build.mockRejectedValueOnce(new Error("source node down"))
    await expect(f.make().prepareRemaining(3n)).rejects.toThrow("source node down")
    f.candidates.push(deposit("a"))
    const progress: [number, number][] = []

    await f.make().prepareRemaining(3n, {
      onApproval: async (approved, total) => void progress.push([approved, total]),
    })

    expect(f.order.map((o) => o.split(" ")[1])).toEqual(["a", "l"])
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
      [1, 1],
    ])
  })

  it("counts only the account's approvals beside a proven link batch, and once it is abandoned", async () => {
    const f = fixture([link("l")])
    await f.make().prepareRemaining(3n)
    expect(f.saved.get("remaining-0")).toMatchObject({ approved: true })
    f.candidates.push(deposit("a"))
    const progress: [number, number][] = []
    const onApproval = async (approved: number, total: number) =>
      void progress.push([approved, total])

    await f.make().prepareRemaining(3n, { onApproval })
    f.spent.add("l")
    await f.make().prepareRemaining(3n, { onApproval })

    expect(f.saved.get("remaining-0")).toMatchObject({ abandoned: true })
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ])
  })
})

describe("reconciling sent batches", () => {
  it("takes a spent refund nullifier as the refund, even after its carrier reverted", async () => {
    const f = fixture([deposit("a")])
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.REVERTED })
    f.spent.add("a")
    const sends = f.sendTx.mock.calls.length

    await source.reconcileRemaining()
    chain.received.mockResolvedValue(true)
    await source.reconcileRemaining()

    expect(f.saved.get("remaining-0")).toMatchObject({ refunded: true, received: true })
    expect(f.sendTx).toHaveBeenCalledTimes(sends)
    expect(await source.remainingComplete()).toBe(true)
  })

  it("asks for the user's approval when funds reach the source after every batch arrived", async () => {
    const f = fixture([deposit("a")])
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.spent.add("a")
    chain.received.mockResolvedValue(true)
    f.candidates.push(deposit("late"))
    const sends = f.sendTx.mock.calls.length

    await expect(source.reconcileRemaining()).rejects.toBeInstanceOf(ApprovalNeededError)

    expect(f.sendTx).toHaveBeenCalledTimes(sends)
  })

  it("reports a reverted carrier whose refund never executed", async () => {
    const f = fixture([deposit("a")])
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.receipt.mockResolvedValue({ executionResult: TxExecutionResult.REVERTED })

    await expect(source.reconcileRemaining()).rejects.toThrow("reverted")
  })
})

describe("counting what the source holds", () => {
  it("counts every refundable fund and waiting deposit", async () => {
    const f = fixture([deposit("a"), deposit("dust", TIP)])

    expect(await f.make().holdings()).toBe(21n * TIP + 7n)
  })
})

describe("settling a batch whose deposit is not credited", () => {
  function recovering(candidates = [deposit("a")]) {
    const recovered = new Set<string>()
    const f = fixture(candidates, { depositSettled: async (r) => recovered.has(r) })
    const recover = (id: string) => recovered.add(f.saved.get(id)!.recipient)
    return { ...f, recover }
  }

  it("completes once a refunded batch's deposit was recovered to Ethereum", async () => {
    const f = recovering()
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.spent.add("a")
    f.recover("remaining-0")

    await source.reconcileRemaining()

    expect(await source.remainingComplete()).toBe(true)
    expect(chain.received).not.toHaveBeenCalled()
    expect(f.saved.get("remaining-0")!.received).toBeUndefined()
  })

  it("asks for the user's approval when funds reach the source after a recovered batch", async () => {
    const f = recovering()
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.spent.add("a")
    f.recover("remaining-0")
    f.candidates.push(deposit("late"))
    const sends = f.sendTx.mock.calls.length

    await expect(f.make().recoverRemaining()).rejects.toBeInstanceOf(ApprovalNeededError)

    expect(f.sendTx).toHaveBeenCalledTimes(sends)
  })

  it("completes on a deposit settled only after its refund was seen", async () => {
    const f = recovering()
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.spent.add("a")

    await source.reconcileRemaining()
    expect(await source.remainingComplete()).toBe(false)

    f.recover("remaining-0")
    await source.reconcileRemaining()
    expect(await source.remainingComplete()).toBe(true)
  })

  it("never takes a settled deposit for a batch whose refund has not executed", async () => {
    const f = recovering()
    const source = f.make()
    await source.prepareRemaining(3n)
    await source.recoverRemaining()
    f.recover("remaining-0")

    await source.reconcileRemaining()

    expect(await source.remainingComplete()).toBe(false)
  })
})
