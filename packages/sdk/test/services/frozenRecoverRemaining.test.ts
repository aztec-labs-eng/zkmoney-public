import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { L1OperationCondition } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import { WITHDRAW_RELAYER_TIP as TIP } from "@obsidion/core/constants"
import type { MigrationFundingBatch } from "@obsidion/core/types"

const chain = vi.hoisted(() => ({
  draws: [] as { day: number; nonce: number }[],
  next: 0,
  /** Whether the rail claimed a batch's whole direct deposit. */
  received: vi.fn(async (_commitment: string) => false),
}))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
}))
vi.mock("../../src/services/migrationDeposit.js", () => ({
  migrationSipaCoordinates: () => chain.draws.shift() ?? { day: 1, nonce: ++chain.next },
  migrationDirectCommitment: async (_c: unknown, day: number, nonce: number) => ({
    recipientCommitment: `0x${String(day * 1000 + nonce).padStart(64, "0")}`,
    sharedSecret: BigInt(day * 1000 + nonce),
  }),
  migrationDirectAnnouncementCalls: async (_c: unknown, _day: number, nonce: number) => [{ nonce }],
}))
vi.mock("@oxide/oxide-client/broadcaster_calls.js", () => ({
  broadcastL1Operation: () => ({ request: async () => ({ calls: [] }) }),
}))
vi.mock("../../src/feePaymentMethod/claimSponsoredCall.js", () => ({
  buildClaimSponsorPayload: async ({ innerCalls }: { innerCalls: unknown[] }) => ({ innerCalls }),
}))
vi.mock("../../src/feePaymentMethod/claimFpcBatchGas.js", () => ({
  claimFpcSponsoredFee: () => ({}),
}))

const {
  FrozenMetadataMigrationSource,
  MAX_MIGRATION_RESENDS,
  MIGRATION_RESEND_AFTER_MS,
  MigrationSubsidyNotReadyError,
} = await import("../../src/services/FrozenMetadataMigrationSource.js")
const { ApprovalNeededError, ApprovalSavedError, MigrationHaltedError } = await import(
  "../../src/services/metadataMigration.js"
)

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
/** The hash of the fixture's `n`th send. */
const hash = (n: number) => `0x${String(n).padStart(64, "0")}`
const ROUTE = {
  executor: addr("e1"),
  subsidy: addr("5b"),
  payoutToken: addr("da"),
  sourcePortal: addr("51"),
  destinationPortal: addr("de"),
  operationExecutor: addr("0e"),
}

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
) {
  const saved = new Map<string, MigrationFundingBatch>()
  const order: string[] = []
  const spent = new Set<string>()
  const build = vi.fn(async ({ ids }: { ids: string[] }, _recipient: unknown) => {
    order.push(`build ${ids.join(",")} after ${saved.size} saved`)
    return {
      amount: ids.reduce(
        (sum, id) => sum + BigInt(candidates.find((c) => c.id === id)!.amount),
        0n,
      ),
      operation: {
        target: EthAddress.fromString(ROUTE.subsidy),
        payoutToken: EthAddress.fromString(ROUTE.payoutToken),
        calldata: Buffer.from("1234", "hex"),
        condition: L1OperationCondition.immediate(),
      },
    }
  })
  const sendTx = vi.fn(
    async (_payload: unknown, opts: { onTxHash(hash: string): Promise<void> }) => {
      await opts.onTxHash(hash(sendTx.mock.calls.length))
    },
  )
  const receipt = vi.fn(
    async (_hash: {
      toString(): string
    }): Promise<{ status?: TxStatus; executionResult?: TxExecutionResult }> => ({
      executionResult: TxExecutionResult.SUCCESS,
    }),
  )
  const runtime = {
    identity: "frozen",
    migration: ROUTE,
    minimumMigratedAmount: async () => 3n,
    assertMigrationReady: vi.fn(async () => {}),
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
    // The rail claimed every batch's whole amount, or nothing.
    directDepositClaimed: async (commitment: string) =>
      (await chain.received(commitment)) ? 10n ** 30n : 0n,
    owner: "0x000000000000000000000000000000000000000a",
    runtime,
    destinationAsset: "0x0000000000000000000000000000000000000001",
    destination: { portal: "0x01", factory: "0x01", rollupVersion: 5n },
    registered: { user: AztecAddress.ZERO, policy: {} },
    client: {
      getBlockNumber: async () => 1n,
      call: async () => ({}),
      readContract: async () => 10n ** 30n,
    },
    wallet: { node: { getTxReceipt: receipt }, sendTx },
    batches: {
      get: async (id: string) => saved.get(id),
      set: async (id: string, batch: MigrationFundingBatch) => {
        saved.set(id, structuredClone(batch))
      },
    },
  } as never
  const make = (extra: object = {}) =>
    new FrozenMetadataMigrationSource({ ...(options as object), ...extra } as never)
  /**
   * The first `times` sends of each batch drawn with a nonce in `nonces` save their hash, then fail
   * with `failed` as their receipt.
   */
  const fail = (
    nonces: number[],
    failed: { status?: TxStatus; executionResult?: TxExecutionResult },
    times = Infinity,
  ) => {
    const left = new Map(nonces.map((nonce) => [nonce, times]))
    const hashes = new Set<string>()
    receipt.mockImplementation(async (tx) =>
      hashes.has(tx.toString()) ? failed : { executionResult: TxExecutionResult.SUCCESS },
    )
    sendTx.mockImplementation(async (payload, opts) => {
      const tx = hash(sendTx.mock.calls.length)
      const nonce = (payload as { innerCalls: { nonce?: number }[] }).innerCalls[0]?.nonce ?? 0
      const failing = (left.get(nonce) ?? 0) > 0
      if (failing) {
        left.set(nonce, left.get(nonce)! - 1)
        hashes.add(tx)
      }
      await opts.onTxHash(tx)
      if (failing) throw new Error(`Transaction ${tx} failed`)
    })
  }
  return { make, saved, order, build, sendTx, receipt, runtime, spent, candidates, fail }
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  chain.draws = []
  chain.next = 0
  chain.received.mockReset()
  chain.received.mockResolvedValue(false)
})

describe("proving every later batch up front", () => {
  it("saves every batch with its coordinates before any approval, then proves each", async () => {
    const f = fixture()

    await f.make().prepareRemaining()

    expect(f.order).toEqual([
      "build a after 3 saved",
      "build b after 3 saved",
      "build c after 3 saved",
    ])
    expect([...f.saved.values()].every((b) => b.approved && b.direct?.day !== undefined)).toBe(true)
  })

  it("records that no batch pays a deposit fee or a tip", async () => {
    const f = fixture()

    await f.make().prepareRemaining()

    expect([...f.saved.values()].map((b) => [b.depositFee, b.exitFee])).toEqual([
      ["0", "0"],
      ["0", "0"],
      ["0", "0"],
    ])
  })

  it("resumes a refused approval with the same batches, unapproved ones first", async () => {
    const f = fixture()
    f.build.mockImplementationOnce(async ({ ids }: { ids: string[] }) => {
      f.order.push(`refused ${ids.join(",")}`)
      throw new Error("The operation either timed out or was not allowed")
    })
    await expect(f.make().prepareRemaining()).rejects.toThrow("not allowed")
    const recipients = [...f.saved.values()].map((b) => b.recipient)
    f.order.length = 0

    await f.make().prepareRemaining()

    expect([...f.saved.values()].map((b) => b.recipient)).toEqual(recipients)
    expect(f.order.map((o) => o.split(" ")[1])).toEqual(["a", "b", "c"])
    expect(chain.next).toBe(3)
  })

  it("rebuilds approved batches after the ones still to approve", async () => {
    const f = fixture()
    await f.make().prepareRemaining()
    const b = f.saved.get("remaining-1")!
    f.saved.set("remaining-1", { ...b, approved: undefined })
    f.order.length = 0

    await f.make().prepareRemaining()

    expect(f.order.map((o) => o.split(" ")[1])).toEqual(["b", "a", "c"])
  })

  it("draws again when coordinates collide with a saved batch's", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    chain.draws = [
      { day: 1, nonce: 7 },
      { day: 1, nonce: 7 },
      { day: 1, nonce: 8 },
    ]

    await f.make().prepareRemaining()

    expect([...f.saved.values()].map((b) => b.direct?.nonce)).toEqual([7, 8])
  })

  it("abandons a planned batch whose funds were refunded elsewhere", async () => {
    const f = fixture()
    await f.make().prepareRemaining()
    f.saved.set("remaining-1", { ...f.saved.get("remaining-1")!, approved: undefined })
    f.spent.add("b")

    await f.make().prepareRemaining()

    expect(f.saved.get("remaining-1")).toMatchObject({ abandoned: true })
    expect([...f.saved.keys()]).toEqual(["remaining-0", "remaining-1", "remaining-2"])
  })
})

describe("asking every approval before any proof", () => {
  /** A signer that stops each build of an approval pass once it signed, as the host's does. */
  function approvals(f: ReturnType<typeof fixture>, approvalsOnly = false) {
    let passing = false
    f.build.mockImplementation(async ({ ids }: { ids: string[] }) => {
      if (passing) {
        f.order.push(`approve ${ids.join(",")}`)
        throw new ApprovalSavedError()
      }
      f.order.push(`prove ${ids.join(",")}`)
      return {
        amount: 20n * TIP,
        operation: {
          target: EthAddress.fromString(ROUTE.subsidy),
          payoutToken: EthAddress.fromString(ROUTE.payoutToken),
          calldata: Buffer.from("1234", "hex"),
          condition: L1OperationCondition.immediate(),
        },
      }
    })
    return {
      approvalPass: async <T>(step: () => Promise<T>) => {
        passing = true
        try {
          return await step()
        } finally {
          passing = false
        }
      },
      approvalsOnly: () => approvalsOnly,
    }
  }

  it("approves every batch, then proves every batch", async () => {
    const f = fixture()
    const progress: [number, number][] = []

    await f.make(approvals(f)).prepareRemaining({
      onApproval: async (approved, total) => void progress.push([approved, total]),
    })

    expect(f.order).toEqual([
      "approve a",
      "approve b",
      "approve c",
      "prove a",
      "prove b",
      "prove c",
    ])
    expect(progress.slice(0, 4)).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it("an approvals-only pass proves nothing, and the next pass asks for nothing", async () => {
    const f = fixture([deposit("a"), deposit("b"), link("l")])

    await f.make(approvals(f, true)).prepareRemaining()
    expect(f.order).toEqual(["approve a", "approve b"])
    expect(f.saved.get("remaining-2")!.approved).toBeUndefined()

    f.order.length = 0
    await f.make(approvals(f)).prepareRemaining()
    expect(f.order).toEqual(["prove a", "prove b", "prove l"])
  })
})

describe("keeping saved batches disjoint and complete", () => {
  const note = (id: string) => ({ id, amount: String(20n * TIP), kind: "note" as const })

  it("plans again what is left of a batch whose selection lost an id", async () => {
    const f = fixture([note("n1"), note("n2")])
    await f.make().prepareRemaining()
    expect(f.saved.get("remaining-0")!.sourceSelection).toEqual(["n1", "n2"])
    f.saved.set("remaining-0", { ...f.saved.get("remaining-0")!, approved: undefined })
    f.spent.add("n1")
    const progress: [number, number][] = []

    await f.make().prepareRemaining({
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

    await f.make().prepareRemaining({ onApproval })
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [1, 1],
    ])

    progress.length = 0
    const empty = fixture([])
    await empty.make().prepareRemaining({ onApproval })
    expect(progress).toEqual([[0, 0]])
  })
})

describe("sending the planned batches", () => {
  it("sends every planned batch in one pass, without waiting for any refund", async () => {
    const f = fixture()
    const source = f.make()
    await source.prepareRemaining()

    await source.recoverRemaining()

    expect(f.sendTx).toHaveBeenCalledTimes(3)
    expect([...f.saved.values()].every((b) => b.broadcastTx)).toBe(true)
    expect(await source.remainingSent()).toBe(true)
    expect(f.build).toHaveBeenCalledTimes(3)
  })

  it("sends nothing more while an earlier saved carrier is not yet included", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    await f.make().prepareRemaining()
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
    await f.make().prepareRemaining()
    f.saved.set("remaining-0", {
      ...f.saved.get("remaining-0")!,
      broadcastTx: `0x${"0a".repeat(32)}`,
    })
    f.receipt.mockResolvedValue({ status: TxStatus.DROPPED })
    f.spent.add("a")

    await f.make().recoverRemaining()

    expect(f.saved.get("remaining-0")).toMatchObject({ refunded: true })
    expect(f.saved.get("remaining-1")!.broadcastTx).toBeDefined()
  })

  it.each([
    ["reverted", { executionResult: TxExecutionResult.REVERTED }],
    ["dropped", { status: TxStatus.DROPPED }],
  ])(
    "sends the batches after a %s carrier, then that carrier again, in one pass",
    async (_, failed) => {
      const f = fixture()
      const source = f.make()
      await source.prepareRemaining()
      f.fail([2], failed, 1)

      await source.recoverRemaining()

      expect(f.sendTx).toHaveBeenCalledTimes(4)
      expect(f.build).toHaveBeenCalledTimes(3)
      expect(f.saved.get("remaining-1")).toMatchObject({ broadcastTx: hash(4), resends: 1 })
      expect(f.saved.get("remaining-2")!.broadcastTx).toBe(hash(3))
    },
  )

  it("sends every other batch in one pass while two carriers fail every send, then stops for the user", async () => {
    const f = fixture()
    const source = f.make()
    await source.prepareRemaining()
    f.fail([1, 2], { executionResult: TxExecutionResult.REVERTED })

    await expect(source.recoverRemaining()).rejects.toMatchObject({ halt: "reverted" })

    expect(f.saved.get("remaining-2")!.broadcastTx).toBe(hash(3))
    expect(f.saved.get("remaining-0")).toMatchObject({ resends: MAX_MIGRATION_RESENDS })
    expect(f.saved.get("remaining-1")).toMatchObject({ resends: MAX_MIGRATION_RESENDS })
    expect(f.sendTx).toHaveBeenCalledTimes(3 + 2 * MAX_MIGRATION_RESENDS)
    await expect(source.reconcileRemaining()).rejects.toBeInstanceOf(MigrationHaltedError)
    expect(f.sendTx).toHaveBeenCalledTimes(3 + 2 * MAX_MIGRATION_RESENDS)
  })

  it("sends no failed carrier again while a later one is not yet included", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()
    f.receipt.mockImplementation(async (tx) =>
      tx.toString() === hash(1) ? { status: TxStatus.DROPPED } : { executionResult: undefined },
    )

    await source.reconcileRemaining()

    expect(f.sendTx).toHaveBeenCalledTimes(2)
  })

  it("waits for a carrier a reorg returned to the pool, then sends again the one it dropped", async () => {
    const f = fixture()
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()
    // A prune returns the first carrier to the pool and drops the second, sent on top of it.
    const pruned = new Map<string, { status: TxStatus }>([
      [hash(1), { status: TxStatus.PENDING }],
      [hash(2), { status: TxStatus.DROPPED }],
    ])
    f.receipt.mockImplementation(
      async (tx) => pruned.get(tx.toString()) ?? { executionResult: TxExecutionResult.SUCCESS },
    )

    await source.recoverRemaining()
    await source.reconcileRemaining()
    expect(f.sendTx).toHaveBeenCalledTimes(3)

    pruned.delete(hash(1))
    await source.reconcileRemaining()

    expect(f.sendTx).toHaveBeenCalledTimes(4)
    expect(f.saved.get("remaining-0")!.broadcastTx).toBe(hash(1))
    expect(f.saved.get("remaining-1")).toMatchObject({ broadcastTx: hash(4), resends: 1 })
    expect(f.saved.get("remaining-2")!.broadcastTx).toBe(hash(3))
  })

  it("sends nothing while a refunded batch's replacement carrier is not yet included", async () => {
    const f = fixture()
    const source = f.make()
    await source.prepareRemaining()
    const replacement = `0x${"0b".repeat(32)}`
    f.saved.set("remaining-0", { ...f.saved.get("remaining-0")!, broadcastTx: replacement })
    f.saved.set("remaining-1", { ...f.saved.get("remaining-1")!, broadcastTx: hash(9) })
    f.spent.add("a")
    f.receipt.mockImplementation(async (tx) =>
      tx.toString() === replacement
        ? { status: TxStatus.PENDING }
        : { executionResult: TxExecutionResult.REVERTED },
    )

    await source.recoverRemaining()
    await source.reconcileRemaining()

    expect(f.saved.get("remaining-0")).toMatchObject({ refunded: true })
    expect(f.sendTx).not.toHaveBeenCalled()
  })

  it.each([
    [0, "recoverRemaining"],
    [1, "recoverRemaining"],
    [0, "reconcileRemaining"],
    [1, "reconcileRemaining"],
  ] as const)(
    "stops for the user on batch %i's failed carrier with no send left while the subsidy holds up the other (%s)",
    async (failedIndex, pass) => {
      const f = fixture([deposit("a"), deposit("b")])
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
      const source = f.make()
      await source.prepareRemaining()
      await source.recoverRemaining()
      const failed = `remaining-${failedIndex}`
      f.saved.set(failed, { ...f.saved.get(failed)!, resends: MAX_MIGRATION_RESENDS })
      f.receipt.mockImplementation(async (tx) => ({
        executionResult:
          tx.toString() === f.saved.get(failed)!.broadcastTx
            ? TxExecutionResult.REVERTED
            : TxExecutionResult.SUCCESS,
      }))
      f.runtime.assertMigrationReady.mockRejectedValue(
        new MigrationSubsidyNotReadyError(["The price feed answer is stale"]),
      )
      now.mockReturnValue(1_000 + MIGRATION_RESEND_AFTER_MS)

      await expect(source[pass]()).rejects.toMatchObject({ halt: "reverted" })
      expect(f.sendTx).toHaveBeenCalledTimes(2)
    },
  )

  it("never plans a batch itself: uncovered funds wait for the user's approval", async () => {
    const f = fixture([deposit("late")])

    await expect(f.make().recoverRemaining()).rejects.toBeInstanceOf(ApprovalNeededError)

    expect(f.build).not.toHaveBeenCalled()
    expect(f.saved.size).toBe(0)
  })

  it("stops once cancelled while a failed send's receipt is read", async () => {
    const f = fixture([deposit("a"), deposit("b")])
    const source = f.make()
    await source.prepareRemaining()
    const cancel = new AbortController()
    f.sendTx.mockImplementationOnce(async (_payload, opts) => {
      await opts.onTxHash(hash(1))
      throw new Error("Timeout awaiting isMined")
    })
    f.receipt.mockImplementation(async () => {
      cancel.abort()
      return { executionResult: undefined }
    })

    await expect(source.recoverRemaining(cancel.signal)).rejects.toThrow()
    expect(f.sendTx).toHaveBeenCalledOnce()
  })

  it("records no hash, so submits nothing, once cancelled while a batch is proven", async () => {
    const f = fixture([deposit("a")])
    await f.make().prepareRemaining()
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
    await expect(f.make().prepareRemaining()).rejects.toThrow("source node down")
    f.candidates.push(deposit("a"))
    const progress: [number, number][] = []

    await f.make().prepareRemaining({
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
    await f.make().prepareRemaining()
    expect(f.saved.get("remaining-0")).toMatchObject({ approved: true })
    f.candidates.push(deposit("a"))
    const progress: [number, number][] = []
    const onApproval = async (approved: number, total: number) =>
      void progress.push([approved, total])

    await f.make().prepareRemaining({ onApproval })
    f.spent.add("l")
    await f.make().prepareRemaining({ onApproval })

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
    await source.prepareRemaining()
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
    await source.prepareRemaining()
    await source.recoverRemaining()
    f.spent.add("a")
    chain.received.mockResolvedValue(true)
    f.candidates.push(deposit("late"))
    const sends = f.sendTx.mock.calls.length

    await expect(source.reconcileRemaining()).rejects.toBeInstanceOf(ApprovalNeededError)

    expect(f.sendTx).toHaveBeenCalledTimes(sends)
  })

  it("sends a reverted carrier again from the background reconcile, with its saved proof", async () => {
    const f = fixture([deposit("a")])
    const source = f.make()
    await source.prepareRemaining()
    await source.recoverRemaining()
    f.receipt.mockImplementation(async (tx) => ({
      executionResult:
        tx.toString() === hash(1) ? TxExecutionResult.REVERTED : TxExecutionResult.SUCCESS,
    }))

    await source.reconcileRemaining()

    expect(f.sendTx).toHaveBeenCalledTimes(2)
    expect(f.build).toHaveBeenCalledTimes(1)
    expect(f.saved.get("remaining-0")).toMatchObject({ broadcastTx: hash(2), resends: 1 })
  })
})

describe("counting what the source holds", () => {
  it("counts every refundable fund and waiting deposit", async () => {
    const f = fixture([deposit("a"), deposit("dust", TIP)])

    expect(await f.make().holdings()).toBe(21n * TIP + 7n)
  })
})
