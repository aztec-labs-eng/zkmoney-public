import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxExecutionResult } from "@aztec-labs/stdlib/tx"
import type { MigrationFundingBatch } from "@obsidion/core/types"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { provingProgress } from "@obsidion/proving-progress"
import {
  computeL1OperationId,
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"

const commitment = (day: number, nonce: number) =>
  `0x${String(day * 1000 + nonce).padStart(64, "0")}` as `0x${string}`

const chain = vi.hoisted(() => ({
  next: 0,
  depositCalls: vi.fn(async () => [{ sipa: true }]),
  broadcastOperations: [] as unknown[],
  resolveDeposit: vi.fn(async (_c: unknown, day: number, nonce: number) => ({
    sipaAddress: `0x${String(day * 1000 + nonce).padStart(40, "0")}`,
    resolution: { messageSecret: { day, nonce } },
  })),
}))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
}))
vi.mock("../../src/services/migrationDeposit.js", () => ({
  migrationSipaCoordinates: () => ({ day: 1, nonce: ++chain.next }),
  resolveMigrationDeposit: chain.resolveDeposit,
  migrationDirectCommitment: async (_c: unknown, day: number, nonce: number) => ({
    recipientCommitment: commitment(day, nonce),
    sharedSecret: BigInt(day * 1000 + nonce),
  }),
  migrationDepositCalls: chain.depositCalls,
  migrationDirectAnnouncementCalls: async (
    _c: unknown,
    day: number,
    nonce: number,
    recipientCommitment: string,
  ) => [{ announce: recipientCommitment, day, nonce }],
}))
vi.mock("@oxide/oxide-client/broadcaster_calls.js", () => ({
  broadcastL1Operation: (_b: unknown, operation: unknown) => ({
    request: async () => {
      chain.broadcastOperations.push(operation)
      return { calls: [{ broadcast: true }] }
    },
  }),
}))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSponsorPayload: async (o: { innerCalls: unknown[] }) => ({ innerCalls: o.innerCalls }),
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))

const {
  FrozenMetadataMigrationSource,
  MigrationSubsidyNotReadyError,
  MIGRATION_RESEND_AFTER_MS,
  MAX_MIGRATION_RESENDS,
} = await import("../../src/services/FrozenMetadataMigrationSource.js")
const { StalePlanError } = await import("../../src/services/metadataMigration.js")

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const OWNER = addr("0a")
const ROUTE = {
  executor: addr("e1"),
  subsidy: addr("5b"),
  payoutToken: addr("da"),
  sourcePortal: addr("51"),
  destinationPortal: addr("de"),
  operationExecutor: addr("0e"),
}

type Candidate = { id: string; amount: string; kind: "frozen-deposit" | "note" }

const deposit = (id: string, amount = 1_000n): Candidate => ({
  id,
  amount: String(amount),
  kind: "frozen-deposit",
})

const note = (id: string, amount = 1_000n): Candidate => ({
  id,
  amount: String(amount),
  kind: "note",
})

function fixture(
  o: {
    minimumMigrated?: bigint
    claimed?: boolean
    candidates?: Candidate[]
    destinationCap?: bigint
    /** The coordinates the account's other runs saved. */
    reserved?: () => Promise<{ day: number; nonce: number }[]>
  } = {},
) {
  const candidates = o.candidates ?? [deposit("a"), deposit("b"), deposit("c", 150n)]
  const saved = new Map<string, MigrationFundingBatch>()
  const spent = new Set<string>()
  const build = vi.fn(async ({ ids }: { ids: string[] }, recipient: unknown, tip: bigint) => ({
    amount: ids.reduce((sum, id) => sum + BigInt(candidates.find((c) => c.id === id)!.amount), 0n),
    // Each proof differs, as a real rebuild's does.
    operation: {
      target: EthAddress.fromString(ROUTE.subsidy),
      payoutToken: EthAddress.fromString(ROUTE.payoutToken),
      calldata: Buffer.from(`1234${String(build.mock.calls.length).padStart(4, "0")}`, "hex"),
      condition: L1OperationCondition.immediate(),
      recipient,
      tip,
    },
  }))
  const assertMigrationReady = vi.fn(async () => {})
  const runtime = {
    identity: "frozen",
    migration: ROUTE,
    validate: async () => {},
    candidates: vi.fn(async () => ({
      maxNotesPerBatch: 2,
      maxBatchAmount: 10_000n,
      candidates: candidates.filter((c) => !spent.has(c.id)),
    })),
    build,
    refunded: vi.fn(async (ids: string[]) => ids.every((id) => spent.has(id))),
    assertMigrationReady,
    minimumMigratedAmount: vi.fn(async (_opts?: { fresh?: boolean }) => o.minimumMigrated ?? 0n),
  }
  const sendTx = vi.fn(
    async (_payload: unknown, opts: { onTxHash(hash: string): Promise<void> }) => {
      await opts.onTxHash(`0x${String(sendTx.mock.calls.length).padStart(64, "0")}`)
    },
  )
  const call = vi.fn(async () => ({}))
  const readContract = vi.fn(async (_: { functionName: string }) => o.destinationCap ?? 10n ** 30n)
  const client = { getBlockNumber: async () => 40n, call, readContract }
  /**
   * What the rail claimed under each commitment: each sent batch's whole amount once `full`, and
   * `extra` besides, as from another sender.
   */
  const claim = { full: o.claimed ?? true, extra: new Map<string, bigint>() }
  const amountOf = (commitment: string) =>
    BigInt(
      [...saved.values()].find((b) => b.direct?.recipientCommitment === commitment)?.amount ?? 0,
    )
  const directDepositClaimed = vi.fn(
    async (commitment: string) =>
      (claim.full ? amountOf(commitment) : 0n) + (claim.extra.get(commitment) ?? 0n),
  )
  const options = {
    received: vi.fn(async () => false),
    runtime,
    owner: OWNER,
    destinationAsset: addr("55"),
    destination: { portal: ROUTE.destinationPortal, factory: "0x01", rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO, policy: {} },
    client,
    wallet: {
      node: { getTxReceipt: async () => ({ executionResult: TxExecutionResult.SUCCESS }) },
      sendTx,
    },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
    directDepositClaimed,
    reservedCoordinates: o.reserved,
  } as never
  /**
   * A source over the same saved batches whose destination publishes `route`, or none. Its proofs
   * call that route's subsidy, as a real runtime's do.
   */
  const make = (route: typeof ROUTE | null = ROUTE) =>
    new FrozenMetadataMigrationSource({
      ...(options as object),
      runtime: {
        ...runtime,
        migration: route ?? undefined,
        build: async (...args: Parameters<typeof build>) => {
          const built = await build(...args)
          if (!route || !sameAddress(built.operation.target.toString(), ROUTE.subsidy)) return built
          return {
            ...built,
            operation: { ...built.operation, target: EthAddress.fromString(route.subsidy) },
          }
        },
      },
    } as never)
  return {
    make,
    saved,
    build,
    sendTx,
    runtime,
    spent,
    call,
    client,
    readContract,
    options: o,
    claim,
    directDepositClaimed,
    assertMigrationReady,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  chain.resolveDeposit.mockClear()
  chain.next = 0
  chain.depositCalls.mockClear()
  chain.broadcastOperations = []
})

describe("a source on the migration executor route", () => {
  it("moves only funds", async () => {
    const f = fixture()
    const source = f.make()
    expect(source.fundsOnly).toBe(true)
    expect(f.build).not.toHaveBeenCalled()
  })

  it("saves each batch as a direct deposit under its commitment, with no tip and no SIPA", async () => {
    const f = fixture()
    await f.make().prepareRemaining()

    expect(chain.resolveDeposit).not.toHaveBeenCalled()
    const batches = [...f.saved.values()]
    expect(batches).toHaveLength(3)
    for (const [i, batch] of batches.entries()) {
      const nonce = i + 1
      expect(batch).toMatchObject({
        recipient: commitment(1, nonce),
        exitFee: "0",
        fromBlock: "40",
        approved: true,
        direct: {
          executor: ROUTE.executor,
          subsidy: ROUTE.subsidy,
          day: 1,
          nonce,
          recipientCommitment: commitment(1, nonce),
        },
      })
      expect(batch).not.toHaveProperty("day")
      expect(batch).not.toHaveProperty("nonce")
    }
    // The runtime proves each batch for its commitment with no tip.
    expect(f.build.mock.calls.map(([, recipient, tip]) => [recipient, tip])).toEqual(
      [1, 2, 3].map((nonce) => [{ recipientCommitment: commitment(1, nonce) }, 0n]),
    )
    // The proof is checked against the old portal the subsidy forwards to.
    expect(f.call).toHaveBeenCalledWith(
      expect.objectContaining({ account: OWNER, to: ROUTE.sourcePortal }),
    )
  })

  it("leaves a batch below the subsidy's minimum migrated amount on the source", async () => {
    const f = fixture({ minimumMigrated: 500n })
    const source = f.make()
    await source.prepareRemaining()
    expect([...f.saved.values()].map((b) => b.sourceSelection)).toEqual([["a"], ["b"]])
    expect(await source.quote()).toMatchObject({ movable: 2_000n, stranded: 150n })
  })

  it("sends only the refund's broadcast, after a fresh readiness check", async () => {
    const f = fixture({ claimed: false })
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()

    expect(f.sendTx).toHaveBeenCalledTimes(3)
    // The deposit's L2 announcement rides the refund's carrier, before its broadcast.
    expect(f.sendTx.mock.calls[0]![0]).toEqual({
      innerCalls: [{ announce: commitment(1, 1), day: 1, nonce: 1 }, { broadcast: true }],
    })
    expect(chain.depositCalls).not.toHaveBeenCalled()
    expect(f.assertMigrationReady).toHaveBeenCalledTimes(3)
    expect(f.assertMigrationReady).toHaveBeenCalledWith(
      { kind: "frozen-deposit", ids: ["a"] },
      1_000n,
    )
  })

  it("sends nothing while the subsidy would not pay, and surfaces its reasons", async () => {
    const f = fixture()
    const source = f.make()
    await source.prepareRemaining()
    f.assertMigrationReady.mockRejectedValueOnce(
      new MigrationSubsidyNotReadyError([
        "The price feed answer is stale, so the subsidy pays nothing.",
      ]),
    )
    await expect(source.recoverRemaining()).rejects.toThrow(
      "Price data is out of date. Try again later.",
    )
    expect(f.sendTx).not.toHaveBeenCalled()
  })

  it("settles a batch on the rail's claim alone, and marks it received, with no log read", async () => {
    const f = fixture({ claimed: false })
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()
    for (const id of ["a", "b", "c"]) f.spent.add(id)

    await source.reconcileRemaining()
    expect(await source.remainingComplete()).toBe(false)
    expect(f.directDepositClaimed).toHaveBeenCalledWith(commitment(1, 1))
    expect([...f.saved.values()].every((b) => b.refunded && !b.received)).toBe(true)

    f.claim.full = true
    f.runtime.refunded.mockClear()
    await source.reconcileRemaining()
    expect([...f.saved.values()].every((b) => b.refunded && b.received)).toBe(true)
    expect(await source.remainingComplete()).toBe(true)
    // The client has no getLogs: settlement reads no L1 log.
    expect(f.client).not.toHaveProperty("getLogs")
  })

  it("takes the rail's claim as the refund, without reading its nullifier", async () => {
    const f = fixture({ claimed: false })
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()
    for (const id of ["a", "b", "c"]) f.spent.add(id)
    f.claim.full = true
    f.runtime.refunded.mockClear()

    await source.reconcileRemaining()
    expect(f.runtime.refunded).not.toHaveBeenCalled()
    expect([...f.saved.values()].every((b) => b.refunded && b.received)).toBe(true)
    expect(await source.remainingComplete()).toBe(true)
  })

  it("never settles a batch the rail has not claimed", async () => {
    const f = fixture({ claimed: false })
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()

    await source.reconcileRemaining()
    expect([...f.saved.values()].some((b) => b.received)).toBe(false)
    expect(await source.remainingComplete()).toBe(false)
  })

  it("moves and completes amounts below the SIPA fee's minimum", async () => {
    // The ordinary deposit fee is 2, so a SIPA batch needs at least 3; a direct one needs 1.
    const f = fixture({ candidates: [deposit("x", 2n), deposit("y", 1n)], claimed: false })
    const source = f.make()
    expect(await source.movable()).toBe(true)
    expect(await source.quote()).toMatchObject({ movable: 3n, stranded: 0n, batches: 2 })

    await source.prepareRemaining()
    expect([...f.saved.values()].map((b) => [b.sourceSelection, b.depositFee])).toEqual([
      [["x"], "0"],
      [["y"], "0"],
    ])
    await source.recoverRemaining()
    for (const id of ["x", "y"]) f.spent.add(id)
    f.claim.full = true
    await source.reconcileRemaining()
    expect(await source.remainingComplete()).toBe(true)
  })

  it("keeps sent batches and re-plans unsent ones when the route changes between prepare and restore", async () => {
    const f = fixture()
    await f.make().prepareRemaining()
    // remaining-0 was sent on the first route.
    f.saved.set("remaining-0", { ...f.saved.get("remaining-0")!, broadcastTx: "0x01", sentAt: 1 })
    const moved = { ...ROUTE, executor: addr("e2"), subsidy: addr("5c") }
    const next = f.make(moved)
    // The same binding: nothing halts the run.
    expect(next.identity).toBe(f.make().identity)
    await expect(next.restore("remaining-1", commitment(1, 2))).rejects.toBeInstanceOf(
      StalePlanError,
    )

    await next.prepareRemaining()
    expect(f.saved.get("remaining-0")).toMatchObject({ broadcastTx: "0x01" })
    expect(f.saved.get("remaining-0")!.abandoned).toBeUndefined()
    expect(f.saved.get("remaining-1")!.abandoned).toBe(true)
    expect(f.saved.get("remaining-2")!.abandoned).toBe(true)
    const replanned = [...f.saved.entries()].filter(([id]) =>
      ["remaining-3", "remaining-4"].includes(id),
    )
    expect(replanned.map(([, b]) => [b.sourceSelection, b.direct?.subsidy])).toEqual([
      [["b"], moved.subsidy],
      [["c"], moved.subsidy],
    ])
  })

  it("refuses to run once the destination drops the route", () => {
    const f = fixture()
    expect(() => f.make(null)).toThrow(
      "A frozen source moves funds only through the destination's migration executor",
    )
  })

  it("abandons and re-plans a saved batch below a raised subsidy floor", async () => {
    const f = fixture()
    await f.make().prepareRemaining()
    expect(f.saved.get("remaining-2")!.sourceSelection).toEqual(["c"])
    f.options.minimumMigrated = 500n
    await f.make().prepareRemaining()

    expect(f.runtime.minimumMigratedAmount).toHaveBeenCalledWith({ fresh: true })
    expect(f.saved.get("remaining-2")!.abandoned).toBe(true)
    // c alone is below the floor now and stays on the source.
    expect([...f.saved.values()].filter((b) => !b.abandoned).map((b) => b.sourceSelection)).toEqual(
      [["a"], ["b"]],
    )
  })

  it("keeps each batch within the destination portal's per-transaction cap, read once", async () => {
    const f = fixture({ candidates: [note("n1"), note("n2")], destinationCap: 1_500n })
    const source = f.make()
    expect(await source.quote()).toMatchObject({ batches: 2, movable: 2_000n })
    await source.prepareRemaining()
    expect([...f.saved.values()].map((b) => b.sourceSelection)).toEqual([["n1"], ["n2"]])
    expect(f.readContract).toHaveBeenCalledTimes(1)
    expect(f.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: ROUTE.destinationPortal, functionName: "TX_AMOUNT_CAP" }),
    )
    // Without the destination cap both notes ride in one batch.
    const wide = fixture({ candidates: [note("n1"), note("n2")] })
    await wide.make().prepareRemaining()
    expect([...wide.saved.values()].map((b) => b.sourceSelection)).toEqual([["n1", "n2"]])
  })

  it("sends a direct broadcast again once its refund is still unspent after the window", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    await source.prepareRemaining()
    await source.recoverRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_000 + MIGRATION_RESEND_AFTER_MS - 1)
    await source.recoverRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_000 + MIGRATION_RESEND_AFTER_MS)
    await source.recoverRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(2)
    expect(f.saved.get("remaining-0")).toMatchObject({
      resends: 1,
      resentAt: 1_000 + MIGRATION_RESEND_AFTER_MS,
      sentAt: 1_000,
      broadcastTx: `0x${"2".padStart(64, "0")}`,
    })
    // The window counts from the last send.
    await source.recoverRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(2)
  })

  it("sends again the identical operation and the same announcement, never a fresh proof", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    await source.prepareRemaining()
    await source.recoverRemaining()
    const builds = f.build.mock.calls.length
    now.mockReturnValue(1_000 + MIGRATION_RESEND_AFTER_MS)
    await source.recoverRemaining()

    expect(f.build).toHaveBeenCalledTimes(builds)
    const [first, again] = chain.broadcastOperations as BroadcastL1Operation[]
    expect(again!.calldata.equals(first!.calldata)).toBe(true)
    expect(computeL1OperationId(again!)).toBe(computeL1OperationId(first!))
    expect(f.sendTx.mock.calls[1]![0]).toEqual({
      innerCalls: [{ announce: commitment(1, 1), day: 1, nonce: 1 }, { broadcast: true }],
    })
    expect(f.saved.get("remaining-0")!.operation).toMatchObject({
      target: expect.stringMatching(new RegExp(ROUTE.subsidy, "i")),
      calldata: `0x${first!.calldata.toString("hex")}`,
    })
  })

  it("rebuilds the operation of a batch sent before operations were saved", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    await source.prepareRemaining()
    await source.recoverRemaining()
    const { operation: _, ...older } = f.saved.get("remaining-0")!
    f.saved.set("remaining-0", older)
    const builds = f.build.mock.calls.length
    now.mockReturnValue(1_000 + MIGRATION_RESEND_AFTER_MS)
    await f.make().recoverRemaining()
    expect(f.build).toHaveBeenCalledTimes(builds + 1)
    expect(f.sendTx).toHaveBeenCalledTimes(2)
  })

  it("sends a broadcast again at most a bounded number of times", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    let t = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => t)
    await source.prepareRemaining()
    await source.recoverRemaining()
    for (let i = 0; i < MAX_MIGRATION_RESENDS + 2; i++) {
      t += MIGRATION_RESEND_AFTER_MS
      await source.recoverRemaining()
    }
    expect(f.sendTx).toHaveBeenCalledTimes(1 + MAX_MIGRATION_RESENDS)
  })

  it("never sends again a batch whose refund executed", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
    await source.prepareRemaining()
    await source.recoverRemaining()
    f.spent.add("a")
    now.mockReturnValue(1_000 + 10 * MIGRATION_RESEND_AFTER_MS)
    await source.recoverRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(1)
    expect(f.saved.get("remaining-0")).toMatchObject({ refunded: true })
  })

  it("plans again a saved batch that is not on the current route", async () => {
    const f = fixture()
    f.saved.set("remaining-0", {
      binding: f.make().identity,
      recipient: commitment(1, 9),
      amount: "1000",
      exitFee: "0",
      sourceSelection: ["a"],
      sourceKind: "frozen-deposit",
      fromBlock: "1",
      direct: {
        executor: ROUTE.executor,
        subsidy: addr("01"),
        day: 1,
        nonce: 9,
        recipientCommitment: commitment(1, 9),
      },
    })
    await f.make().prepareRemaining()

    expect(f.saved.get("remaining-0")!.abandoned).toBe(true)
    expect([...f.saved.values()].filter((b) => !b.abandoned).map((b) => b.sourceSelection)).toEqual(
      [["a"], ["b"], ["c"]],
    )
    await expect(f.make().restore("remaining-0", commitment(1, 9))).rejects.toBeInstanceOf(
      StalePlanError,
    )
  })

  it("never settles a batch on a smaller deposit under its public commitment", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()
    // Another sender deposits 1 under the commitment first, and the rail claims it.
    f.claim.extra.set(commitment(1, 1), 1n)

    await source.reconcileRemaining()
    expect(f.saved.get("remaining-0")!.received).toBeUndefined()
    expect(await source.remainingComplete()).toBe(false)

    // The executor's deposit lands and the rail claims it too.
    f.spent.add("a")
    f.claim.full = true
    await source.reconcileRemaining()
    expect(f.saved.get("remaining-0")).toMatchObject({ received: true, refunded: true })
    expect(await source.remainingComplete()).toBe(true)
  })

  it("sends a due broadcast again from the background reconcile, byte for byte", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    const source = f.make()
    let t = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => t)
    await source.prepareRemaining()
    await source.recoverRemaining()
    const builds = f.build.mock.calls.length

    await f.make().reconcileRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(1)

    t += MIGRATION_RESEND_AFTER_MS
    await f.make().reconcileRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(2)
    expect(f.build).toHaveBeenCalledTimes(builds)
    const [first, again] = chain.broadcastOperations as BroadcastL1Operation[]
    expect(computeL1OperationId(again!)).toBe(computeL1OperationId(first!))
    expect(f.saved.get("remaining-0")).toMatchObject({ resends: 1, resentAt: t, sentAt: 1_000 })

    for (let i = 0; i < MAX_MIGRATION_RESENDS + 2; i++) {
      t += MIGRATION_RESEND_AFTER_MS
      await f.make().reconcileRemaining()
    }
    expect(f.sendTx).toHaveBeenCalledTimes(1 + MAX_MIGRATION_RESENDS)
  })

  it("stops before a background re-send records its hash once cancelled", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    let t = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => t)
    await f.make().prepareRemaining()
    await f.make().recoverRemaining()
    const sent = f.saved.get("remaining-0")!.broadcastTx
    t += MIGRATION_RESEND_AFTER_MS
    const cancel = new AbortController()
    f.sendTx.mockImplementationOnce(async (_payload, opts) => {
      cancel.abort()
      await opts.onTxHash("0xagain")
    })

    await expect(f.make().reconcileRemaining(cancel.signal)).rejects.toThrow()
    expect(f.saved.get("remaining-0")).toMatchObject({ broadcastTx: sent })
    expect(f.saved.get("remaining-0")!.resends).toBeUndefined()
  })

  it("sends each batch, and saves its hash, inside the gate, as the operation the gate names", async () => {
    const f = fixture({ candidates: [deposit("a"), deposit("b")], claimed: false })
    let t = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => t)
    const saved = vi.fn()
    const emitted = vi.spyOn(provingProgress, "emitTxHashSaved")
    let open: string | undefined
    let ids = 0
    const gate = vi.fn(async <T>(step: (operationId?: string) => Promise<T>) => {
      open = `op-${++ids}`
      try {
        return await step(open)
      } finally {
        open = undefined
      }
    })
    f.sendTx.mockImplementation(async (_payload, opts) => {
      expect(open).toBeDefined()
      expect((opts as { operationId?: string }).operationId).toBe(open)
      await opts.onTxHash(`0x${String(f.sendTx.mock.calls.length).padStart(64, "0")}`)
      saved(open)
    })
    await f.make().prepareRemaining()
    await f.make().recoverRemaining(undefined, gate)
    const sends = f.sendTx.mock.calls.length
    expect(sends).toBeGreaterThan(0)
    expect(gate).toHaveBeenCalledTimes(sends)
    expect(saved.mock.calls.map(([id]) => id)).toEqual(
      gate.mock.results.map((_, i) => `op-${i + 1}`),
    )
    expect(emitted).toHaveBeenCalledWith("op-1", expect.any(String))

    // A background re-send waits its turn the same way.
    t += MIGRATION_RESEND_AFTER_MS
    await f.make().reconcileRemaining(undefined, gate)
    expect(f.sendTx.mock.calls.length).toBeGreaterThan(sends)
    expect(gate).toHaveBeenCalledTimes(f.sendTx.mock.calls.length)
  })

  it("never sends a batch that was cancelled while it waited in the gate", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    await f.make().prepareRemaining()
    const cancel = new AbortController()
    const gate = async <T>(step: (operationId?: string) => Promise<T>) => {
      cancel.abort()
      return step()
    }
    await expect(f.make().recoverRemaining(cancel.signal, gate)).rejects.toThrow()
    expect(f.sendTx).not.toHaveBeenCalled()
    expect(f.saved.get("remaining-0")!.broadcastTx).toBeUndefined()
  })

  it("asks nothing in the background: it never rebuilds a batch, and waits while the subsidy would not pay", async () => {
    const f = fixture({ candidates: [deposit("a")], claimed: false })
    let t = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => t)
    await f.make().prepareRemaining()
    await f.make().recoverRemaining()
    t += MIGRATION_RESEND_AFTER_MS

    f.assertMigrationReady.mockRejectedValueOnce(
      new MigrationSubsidyNotReadyError(["The price feed answer is stale"]),
    )
    await f.make().reconcileRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(1)

    // A batch sent before operations were saved needs a new proof: only the user's recovery sends it again.
    const { operation: _, ...older } = f.saved.get("remaining-0")!
    f.saved.set("remaining-0", older)
    const builds = f.build.mock.calls.length
    await f.make().reconcileRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(1)
    expect(f.build).toHaveBeenCalledTimes(builds)
  })

  it("never draws coordinates another run of the account saved", async () => {
    const dai = fixture({ candidates: [deposit("a"), deposit("b")] })
    await dai.make().prepareRemaining()
    const daiCoordinates = [...dai.saved.values()].map((b) => b.direct!)
    // The sUSDS run draws the same coordinates first.
    chain.next = 0
    const reserved = vi.fn(async () => daiCoordinates.map(({ day, nonce }) => ({ day, nonce })))
    const susds = fixture({ candidates: [deposit("x"), deposit("y")], reserved })

    await susds.make().prepareRemaining()

    expect(reserved).toHaveBeenCalled()
    const daiCommitments = new Set(daiCoordinates.map((d) => d.recipientCommitment))
    const susdsBatches = [...susds.saved.values()]
    expect(susdsBatches.map((b) => b.direct!.nonce)).toEqual([3, 4])
    expect(susdsBatches.some((b) => daiCommitments.has(b.direct!.recipientCommitment))).toBe(false)
  })

  it("refuses a proof whose operation does not call the route's subsidy in its payout token", async () => {
    for (const [field, message] of [
      ["target", "does not call the route's migration subsidy"],
      ["payoutToken", "does not pay out in the route's payout token"],
    ] as const) {
      const f = fixture({ candidates: [deposit("a")] })
      f.build.mockResolvedValueOnce({
        amount: 1_000n,
        operation: {
          target: EthAddress.fromString(ROUTE.subsidy),
          payoutToken: EthAddress.fromString(ROUTE.payoutToken),
          calldata: Buffer.from("1234", "hex"),
          condition: L1OperationCondition.immediate(),
          [field]: EthAddress.fromString(addr("77")),
        } as never,
      })
      await expect(f.make().prepareRemaining()).rejects.toThrow(message)
      expect(f.call).not.toHaveBeenCalled()
    }
  })
})
