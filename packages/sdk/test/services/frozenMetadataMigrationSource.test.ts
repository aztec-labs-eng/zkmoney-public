import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"

const ORDINARY_FEE = vi.hoisted(() => 2n)
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
  readOrdinaryDepositFee: async () => ORDINARY_FEE,
}))

const { FrozenMetadataMigrationSource, selectFrozenBatch } = await import(
  "../../src/services/FrozenMetadataMigrationSource.js"
)
type Runtime = import("../../src/services/FrozenMetadataMigrationSource.js").FrozenMigrationRuntime
type Candidate = import("../../src/services/FrozenMetadataMigrationSource.js").FrozenRefundCandidate

const AMOUNTS: Record<string, bigint> = {
  small: TIP,
  medium: 8n * TIP,
  large: 20n * TIP,
  deposit: 30n * TIP,
}
const note = (id: string, amount = AMOUNTS[id]!): Candidate => ({
  id,
  amount: String(amount),
  kind: "note",
})

function fixture(candidates: Candidate[] = [note("small"), note("medium"), note("large")]) {
  const recipient = "0x0000000000000000000000000000000000000001" as const
  const saved = new Map<string, MigrationFundingBatch>()
  const runtime: Runtime = {
    identity: "isolated-source-toolchain-and-deployment",
    validate: vi.fn(async () => {}),
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates,
    })),
    build: vi.fn(async ({ ids }) => ({
      amount: ids.reduce((sum, id) => sum + (AMOUNTS[id] ?? 0n), 0n),
      operation: { target: recipient, payoutToken: recipient, calldata: "0x1234" as const },
    })),
    refunded: vi.fn(async () => false),
  }
  const options = {
    runtime,
    destinationAsset: recipient,
    destination: { portal: recipient, factory: recipient, rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO },
    client: { getBlockNumber: async () => 1n, call: vi.fn(async () => ({})) },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
  } as unknown as ConstructorParameters<typeof FrozenMetadataMigrationSource>[0]
  const make = () => new FrozenMetadataMigrationSource(options)
  return { runtime, recipient, saved, make, client: options.client }
}

/** Runs selection to exhaustion, as successive recoveries do; returns the batches and what is left. */
function partition(
  amounts: bigint[],
  need: bigint,
  maxNotesPerBatch = 10,
  maxBatchAmount = 10_000n,
) {
  let left = amounts.map((amount, i) => note(`n${i}`, amount))
  const batches: bigint[] = []
  for (;;) {
    const batch = selectFrozenBatch({
      candidates: left,
      maxNotesPerBatch,
      maxBatchAmount,
      minimumNetAmount: need,
      tip: 0n,
    })
    if (!batch) return { batches, left: left.reduce((sum, c) => sum + BigInt(c.amount), 0n) }
    batches.push(batch.amount)
    left = left.filter((c) => !batch.ids.includes(c.id))
  }
}

const ones = (n: number) => Array.from({ length: n }, () => 1n)

describe("frozen refund batch selection", () => {
  it.each([
    ["60,60,40,40 and 16 dust", [60n, 60n, 40n, 40n, ...ones(16)]],
    ["70,60,45,25 and 16 dust", [70n, 60n, 45n, 25n, ...ones(16)]],
  ])("leaves no affordable value behind for %s", (_, amounts) => {
    const { batches, left } = partition(amounts, 100n)
    expect(batches).toHaveLength(2)
    expect(batches.every((amount) => amount >= 100n)).toBe(true)
    expect(left).toBe(0n)
  })

  it("lets dust ride along up to the note limit", () => {
    expect(partition([150n, ...ones(12)], 100n, 10)).toEqual({ batches: [159n], left: 3n })
  })

  it("nets strictly more than the fee after the tip", () => {
    const at = (amount: bigint) =>
      selectFrozenBatch({
        candidates: [{ id: "d", amount: String(amount), kind: "frozen-deposit" }],
        maxNotesPerBatch: 10,
        maxBatchAmount: 10_000n * TIP,
        minimumNetAmount: 5n + 1n,
        tip: TIP,
      })
    expect(at(5n + TIP)).toBeUndefined()
    expect(at(5n + TIP + 1n)?.ids).toEqual(["d"])
  })

  it("keeps a note batch within the portal's amount cap", () => {
    expect(partition([60n, 50n, 45n], 50n, 10, 95n).batches).toEqual([95n, 60n])
    expect(partition([60n, 50n, 45n], 50n, 10, 94n).batches).toEqual([50n, 60n])
  })

  it("refunds a deposit alone and never with notes", () => {
    const candidates: Candidate[] = [
      note("medium"),
      { id: "deposit", amount: String(AMOUNTS.deposit), kind: "frozen-deposit" },
    ]
    const select = (minimumNetAmount: bigint) =>
      selectFrozenBatch({
        candidates,
        maxNotesPerBatch: 10,
        maxBatchAmount: 1000n * TIP,
        minimumNetAmount,
        tip: TIP,
      })
    expect(select(1n)).toMatchObject({ kind: "note", ids: ["medium"] })
    expect(select(10n * TIP)).toMatchObject({ kind: "frozen-deposit", ids: ["deposit"] })
  })
})

describe("frozen migration batch selection and restart", () => {
  it("selects a sufficient batch within the source limit before proving and rebuilds that selection", async () => {
    const f = fixture()
    const prepared = await f.make().prepare(f.recipient, 15n * TIP)
    expect(prepared.netAmount).toBe(20n * TIP)
    expect(f.runtime.build).toHaveBeenCalledWith(
      { kind: "note", ids: ["large", "small"] },
      f.recipient,
      TIP,
    )
    vi.mocked(f.runtime.candidates).mockResolvedValue({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates: [note("new", 100n * TIP), note("large"), note("small")],
    })
    await f.make().restore(prepared.id, f.recipient)
    expect(f.runtime.build).toHaveBeenLastCalledWith(
      { kind: "note", ids: ["large", "small"] },
      f.recipient,
      TIP,
    )
    expect(f.saved.get(prepared.id)).toMatchObject({
      sourceSelection: ["large", "small"],
      sourceKind: "note",
    })
  })

  it("takes a remainder too small to refund alone, and fills free slots with the smallest notes", async () => {
    const f = fixture()
    const notes = (...ids: Array<"small" | "medium" | "large">) =>
      vi.mocked(f.runtime.candidates).mockResolvedValue({
        maxNotesPerBatch: 2,
        maxBatchAmount: 1000n * TIP,
        candidates: ids.map((id) => note(id)),
      })
    notes("small")
    await expect(f.make().prepare(f.recipient, 1n)).rejects.toThrow("No single frozen batch")
    notes("small", "large")
    expect((await f.make().prepare(f.recipient, 15n * TIP)).netAmount).toBe(20n * TIP)
    expect(f.runtime.build).toHaveBeenLastCalledWith(
      { kind: "note", ids: ["large", "small"] },
      f.recipient,
      TIP,
    )
    // One batch is a tip, a deposit fee, a proof and a passkey prompt, so a free slot is filled.
    notes("medium", "large")
    await f.make().prepare(f.recipient, 15n * TIP)
    expect(f.runtime.build).toHaveBeenLastCalledWith(
      { kind: "note", ids: ["large", "medium"] },
      f.recipient,
      TIP,
    )
  })

  it("rejects insufficient batches before generating a proof", async () => {
    const f = fixture()
    await expect(f.make().prepare(f.recipient, 28n * TIP)).rejects.toThrow("No single frozen batch")
    expect(f.runtime.build).not.toHaveBeenCalled()
    expect(f.saved.size).toBe(0)
  })

  it("rejects a proof that the deployed source verifier cannot execute before saving a plan", async () => {
    const f = fixture()
    vi.mocked(f.client.call).mockRejectedValue(new Error("source verifier rejected refund"))
    await expect(f.make().prepare(f.recipient, 15n * TIP)).rejects.toThrow(
      "source verifier rejected",
    )
    expect(f.saved.size).toBe(0)
  })

  it("rejects a changed recipient and a batch already refunded on L1", async () => {
    const f = fixture()
    const first = await f.make().prepare(f.recipient, 15n * TIP)
    await expect(
      f.make().restore(first.id, "0x0000000000000000000000000000000000000002"),
    ).rejects.toThrow("does not match")
    vi.mocked(f.runtime.refunded).mockResolvedValue(true)
    await expect(f.make().restore(first.id, f.recipient)).rejects.toThrow("already been refunded")
  })

  it("rejects a partially refunded selection even when its proof is cached", async () => {
    const f = fixture()
    const source = f.make()
    const first = await source.prepare(f.recipient, 24n * TIP)
    expect(f.runtime.build).toHaveBeenCalledWith(
      { kind: "note", ids: ["large", "medium"] },
      f.recipient,
      TIP,
    )
    vi.mocked(f.runtime.candidates).mockResolvedValue({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates: [note("medium")],
    })
    await expect(source.restore(first.id, f.recipient)).rejects.toThrow("no longer refundable")
    expect(f.runtime.build).toHaveBeenCalledTimes(1)
  })

  it("reuses the proof for a selection stored under another batch id", async () => {
    const f = fixture()
    const source = f.make()
    const first = await source.prepare(f.recipient, 15n * TIP)
    f.saved.set("remaining-0", f.saved.get(first.id)!)
    await source.restore("remaining-0", f.recipient)
    await source.restore(first.id, f.recipient)
    expect(f.runtime.build).toHaveBeenCalledTimes(1)
  })

  it("restores a record written before deposit refunds as notes, and refuses a kind mismatch", async () => {
    const f = fixture()
    const batch = {
      binding: f.make().identity,
      recipient: f.recipient,
      amount: String(20n * TIP),
      exitFee: String(TIP),
      fromBlock: "1",
      sourceSelection: ["large"],
    }
    f.saved.set("old", batch)
    await f.make().restore("old", f.recipient)
    expect(f.runtime.build).toHaveBeenLastCalledWith(
      { kind: "note", ids: ["large"] },
      f.recipient,
      TIP,
    )
    f.saved.set("mismatch", { ...batch, sourceKind: "frozen-deposit" })
    await expect(f.make().restore("mismatch", f.recipient)).rejects.toThrow("no longer refundable")
  })

  it("migrates a source holding only a deposit", async () => {
    const f = fixture([{ id: "deposit", amount: String(AMOUNTS.deposit), kind: "frozen-deposit" }])
    expect(await f.make().state()).toBe("frozen")
    const prepared = await f.make().prepare(f.recipient, 15n * TIP)
    expect(f.runtime.build).toHaveBeenCalledWith(
      { kind: "frozen-deposit", ids: ["deposit"] },
      f.recipient,
      TIP,
    )
    expect(f.saved.get(prepared.id)).toMatchObject({ sourceKind: "frozen-deposit" })
  })

  it("does not declare completion while a published remainder lacks a destination receipt", async () => {
    const f = fixture([])
    f.saved.set("remaining-0", {
      binding: f.make().identity,
      recipient: f.recipient,
      amount: String(20n * TIP),
      exitFee: String(TIP),
      fromBlock: "1",
      broadcastTx: "unknown",
      sourceSelection: ["large"],
    })
    expect(await f.make().remainingComplete()).toBe(false)
    f.saved.get("remaining-0")!.received = true
    expect(await f.make().remainingComplete()).toBe(true)
  })

  it("settles with a stranded residual that no affordable batch can take, after a fresh scan", async () => {
    const f = fixture([note("dust", ORDINARY_FEE + TIP)])
    const source = f.make()
    await source.recoverRemaining()
    expect(f.runtime.build).not.toHaveBeenCalled()
    expect(f.saved.size).toBe(0)
    expect(await source.remainingComplete()).toBe(true)
    expect(f.runtime.candidates).toHaveBeenLastCalledWith({ fresh: true })
    expect(await source.movable(ORDINARY_FEE)).toBe(true)
  })
})

describe("frozen migration quote", () => {
  const minimums = { first: 15n * TIP, later: ORDINARY_FEE + 1n }

  it("quotes every batch a run takes, and leaves what none can afford stranded", async () => {
    // Two notes per batch: dust rides along with the large note; the rest can't pay a batch.
    const f = fixture([note("large"), note("d1", 1n), note("d2", 1n), note("d3", 1n)])
    expect(await f.make().quote(minimums)).toEqual({
      movable: AMOUNTS.large! + 1n,
      stranded: 2n,
      waiting: 0n,
    })
  })

  it("splits notes above the portal's amount cap across batches", async () => {
    const f = fixture([note("a", 600n * TIP), note("b", 600n * TIP)])
    expect((await f.make().quote(minimums)).movable).toBe(1200n * TIP)
  })

  it("moves nothing when the first batch can't fund the migration, even if later ones could", async () => {
    const f = fixture([note("medium")])
    expect(await f.make().quote(minimums)).toEqual({
      movable: 0n,
      stranded: AMOUNTS.medium,
      waiting: 0n,
    })
    expect((await f.make().quote({ first: minimums.later, later: minimums.later })).movable).toBe(
      AMOUNTS.medium,
    )
  })

  it("counts a deposit by itself, and the runtime's waiting deposits apart", async () => {
    const f = fixture([
      note("small"),
      { id: "deposit", amount: String(AMOUNTS.deposit), kind: "frozen-deposit" },
    ])
    vi.mocked(f.runtime.candidates).mockResolvedValue({
      maxNotesPerBatch: 2,
      maxBatchAmount: 1000n * TIP,
      candidates: [
        note("small"),
        { id: "deposit", amount: String(AMOUNTS.deposit), kind: "frozen-deposit" },
      ],
      waiting: 7n * TIP,
    })
    expect(await f.make().quote(minimums)).toEqual({
      movable: AMOUNTS.deposit,
      stranded: AMOUNTS.small,
      waiting: 7n * TIP,
    })
  })
})
