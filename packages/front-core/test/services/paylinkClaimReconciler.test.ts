import { describe, it, expect, vi } from "vitest"
import {
  demotePaylinkClaim,
  markPaylinkMigrated,
  sweepLinks,
  type CheckSpent,
} from "../../src/core/services/paylink/PaylinkClaimReconciler"
import type { Transfers } from "../../src/engine/transfers"
import { createOperations, type Operations } from "../../src/engine/operations"
import { seededActivity } from "../utils/transferFixture"
import { loadRecords } from "../../src/engine/persistentStore"
import type { PaylinkTransaction, Transaction } from "../../src/types"

const NET = "0xnet"

const row = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
    networkId: NET,
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    timestamp: Date.now(),
    status: "success",
    txHash: "0xrow",
    payToEmailSecret: "0xsecret",
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    fromClaimable: 1000,
    untilClaimable: 2000,
    ...overrides,
  } as PaylinkTransaction)

/** The ids each store was seeded with, in order. */
const seeded = new WeakMap<Transfers, string[]>()
const makeStorage = (rows: Transaction[]) => {
  const storage = seededActivity(rows)
  seeded.set(
    storage,
    rows.map((r, i) => r.id ?? (r.txHash ? r.txHash.toLowerCase() : `row-${i}`)),
  )
  return storage
}
const at = async (storage: Transfers, i: number) =>
  (await storage.get(seeded.get(storage)![i])) as PaylinkTransaction

// Resolves spent=true for any row whose txHash is in `spent`.
const spentCheck = (spent: string[]) =>
  vi.fn(
    async (rows: PaylinkTransaction[]) =>
      new Map(rows.map((r) => [r.txHash, spent.includes(r.txHash)])),
  )

const sweep = (
  storage: ReturnType<typeof makeStorage>,
  checkSpent: CheckSpent,
  operations: Operations = createOperations({ db: storage.db, now: () => Date.now() }),
  signal?: AbortSignal,
) =>
  sweepLinks({ checkSpent, links: storage.paylinks, operations, transfers: storage }, NET, signal)

describe("PaylinkClaimReconciler", () => {
  it("flips isClaimed on a genuine claim", async () => {
    const storage = makeStorage([row()])
    await sweep(storage, spentCheck(["0xrow"]))
    expect((await at(storage, 0)).isClaimed).toBe(true)
  })

  it("writes nothing once its pass is aborted during the spend check", async () => {
    const storage = makeStorage([row(), row({ txHash: "0xold", isClaimed: true })])
    const pass = new AbortController()
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      pass.abort()
      return new Map(rows.map((r) => [r.txHash, r.txHash === "0xrow"]))
    })
    await sweep(storage, checkSpent, undefined, pass.signal)
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
    expect((await at(storage, 1)).isClaimed).toBe(true)
  })

  it("does not flip when the note is not spent", async () => {
    const storage = makeStorage([row()])
    await sweep(storage, spentCheck([]))
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
  })

  it("P0: a mid-flight self-refund (spent, isRefunded false, in-flight) is not a claim", async () => {
    const storage = makeStorage([row()])
    const operations = createOperations({ db: storage.db, now: () => Date.now() })
    const [link] = await loadRecords(storage.paylinks.view)
    await operations.begin({ operationId: "refund", flow: "paylink-reclaim", summary: "" })
    const token = { address: "0xt", name: "DAI", symbol: "DAI", decimals: 6, logo: "", amount: 1 }
    const payload = { networkId: NET, token, amountAtomic: "1", flavor: "direct" as const }
    await operations.apply("refund", {
      type: "transfer",
      transfer: { kind: "paylink-refund", payload: { ...payload, linkId: link.id } },
    })
    await sweep(storage, spentCheck(["0xrow"]), operations)
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
  })

  it("a completed refund (paylink scrubbed) is filtered out before classification", async () => {
    const storage = makeStorage([row({ isRefunded: true, paylink: undefined })])
    const checkSpent = spentCheck(["0xrow"])
    await sweep(storage, checkSpent)
    expect(checkSpent).not.toHaveBeenCalled()
  })

  it("an already-claimed row stays claimed", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    const checkSpent = spentCheck(["0xrow"])
    await sweep(storage, checkSpent)
    expect((await at(storage, 0)).isClaimed).toBe(true)
  })

  it("skips a row with a blank txHash (no colliding dedup id)", async () => {
    const storage = makeStorage([row({ txHash: "" })])
    const checkSpent = spentCheck([""])
    await sweep(storage, checkSpent)
    expect(checkSpent).not.toHaveBeenCalled()
  })

  it("skips legacy rows missing fallbackSecret or paylink", async () => {
    const storage = makeStorage([
      row({ txHash: "0xa", payToEmailSecret: "0xa", fallbackSecret: undefined }),
      row({ txHash: "0xb", payToEmailSecret: "0xb", paylink: undefined }),
    ])
    const checkSpent = spentCheck(["0xa", "0xb"])
    await sweep(storage, checkSpent)
    expect(checkSpent).not.toHaveBeenCalled()
  })

  it("fails the pass and leaves every link unchanged when the batched read fails", async () => {
    const storage = makeStorage([row()])
    const down = new Error("rpc down")
    const checkSpent = vi.fn(async () => {
      throw down
    })
    await expect(sweep(storage, checkSpent)).rejects.toBe(down)
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
  })

  // A migrated row is never a claim candidate and never flips, even with a spent nullifier.
  it("a migrated row is not a candidate and never flips to claimed", async () => {
    const storage = makeStorage([row({ isMigrated: true })])
    const checkSpent = spentCheck(["0xrow"])
    await sweep(storage, checkSpent)
    expect(checkSpent).not.toHaveBeenCalled()
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
  })

  it("the claim write-predicate aborts on a row migrated mid-sweep", async () => {
    const storage = makeStorage([row()])
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      // Migration flips the row between the candidate read and the write loop.
      await markPaylinkMigrated("0xrow", storage.paylinks)
      return new Map(rows.map((r) => [r.txHash, true]))
    })
    await sweep(storage, checkSpent)
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
  })
})

describe("markPaylinkMigrated", () => {
  it("flips exactly once", async () => {
    const storage = makeStorage([row()])
    expect(await markPaylinkMigrated("0xrow", storage.paylinks)).toBe(true)
    expect((await at(storage, 0)).isMigrated).toBe(true)
    expect(await markPaylinkMigrated("0xrow", storage.paylinks)).toBe(false)
  })

  it("refuses to flip a row already claimed or refunded", async () => {
    const storage = makeStorage([
      row({ txHash: "0xa", isClaimed: true }),
      row({ txHash: "0xb", isRefunded: true }),
    ])
    expect(await markPaylinkMigrated("0xa", storage.paylinks)).toBe(false)
    expect(await markPaylinkMigrated("0xb", storage.paylinks)).toBe(false)
    expect((await at(storage, 0)).isMigrated).toBeUndefined()
    expect((await at(storage, 1)).isMigrated).toBeUndefined()
  })
})

describe("demotePaylinkClaim (reorg)", () => {
  it("flips isClaimed back to false and bumps the row's reorgEpoch", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    expect(await demotePaylinkClaim("0xrow", storage.paylinks)).toBe(true)
    const demotedRow = await at(storage, 0)
    expect(demotedRow.isClaimed).toBe(false)
    expect(demotedRow.reorgEpoch).toBe(1)
  })

  it("is a no-op on an unclaimed row", async () => {
    const storage = makeStorage([row()])
    expect(await demotePaylinkClaim("0xrow", storage.paylinks)).toBe(false)
    expect((await at(storage, 0)).reorgEpoch).toBeUndefined()
  })

  it("a stale sweep (rows read pre-demote) cannot re-flip a demoted claim", async () => {
    const storage = makeStorage([row()])
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      // Reorg demote lands between the candidate read and the write loop.
      await storage.apply("0xrow", {
        type: "claimed",
        at: 1,
        refundInFlight: false,
        by: "chain",
      })
      await demotePaylinkClaim("0xrow", storage.paylinks)
      return new Map(rows.map((r) => [r.txHash, true]))
    })
    await sweep(storage, checkSpent)
    expect((await at(storage, 0)).isClaimed).toBe(false)
  })

  it("a fresh reconcile after demote re-flips when the note is still spent on-chain", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    await demotePaylinkClaim("0xrow", storage.paylinks)
    await sweep(storage, spentCheck(["0xrow"]))
    expect((await at(storage, 0)).isClaimed).toBe(true)
  })
})

describe("reverse leg — reconcile rechecks claimed rows", () => {
  it("demotes a claimed row whose note reads UNSPENT", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    await sweep(storage, spentCheck([]))
    const r = await at(storage, 0)
    expect(r.isClaimed).toBe(false)
    expect(r.reorgEpoch).toBe(1)
  })

  it("rechecks only the claimed rows stamped with the run's network, in any case", async () => {
    const storage = makeStorage([
      row({ txHash: "0xmixed", payToEmailSecret: "0x1", isClaimed: true, networkId: "0xNET" }),
      row({ txHash: "0xother", payToEmailSecret: "0x2", isClaimed: true, networkId: "0xother" }),
      row({
        txHash: "0xunstamped",
        payToEmailSecret: "0x3",
        isClaimed: true,
        networkId: undefined,
      }),
    ])
    await sweep(storage, spentCheck([]))
    const rows = await Promise.all([0, 1, 2].map((i) => at(storage, i)))
    expect(rows.map((r) => r.isClaimed)).toEqual([false, true, true])
  })

  it("leaves a claimed row untouched when the note is still spent", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    await sweep(storage, spentCheck(["0xrow"]))
    expect((await at(storage, 0)).isClaimed).toBe(true)
  })

  it("does not demote a claimed row the checkSpent result did not cover", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    const checkSpent = vi.fn(async () => new Map<string, boolean>())
    await sweep(storage, checkSpent)
    expect((await at(storage, 0)).isClaimed).toBe(true)
  })

  it("a stale UNSPENT observation cannot demote a row re-claimed at a newer epoch", async () => {
    const storage = makeStorage([row({ isClaimed: true })]) // epoch 0 at read
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      // A reorg undoes the claim mid-read and a later pass claims it again, at the next epoch.
      await demotePaylinkClaim("0xrow", storage.paylinks)
      const link = (await storage.paylinks.byHash("0xrow"))!
      await storage.paylinks.apply(link.id, {
        type: "claimed",
        at: 1,
        epoch: 1,
        refundInFlight: false,
        by: "chain",
      })
      return new Map(rows.map((r) => [r.txHash, false]))
    })
    await sweep(storage, checkSpent)
    expect((await at(storage, 0)).isClaimed).toBe(true)
  })
})

// A refund whose tab closed after submit leaves only its hash on the creator row.
describe("PaylinkClaimReconciler — refund submitted before a reload", () => {
  const refundRow = (status: Transaction["status"]) =>
    ({ timestamp: Date.now(), status, txHash: "0xrefund" } as Transaction)

  it("never reads the spent note as a recipient's claim", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" }), refundRow("pending")])
    await sweep(storage, spentCheck(["0xrow"]))
    expect((await at(storage, 0)).isClaimed).toBeUndefined()
  })

  it("marks the link refunded once the refund lands", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" }), refundRow("success")])
    await sweep(storage, spentCheck(["0xrow"]))
    const creator = await at(storage, 0)
    expect(creator.isRefunded).toBe(true)
    expect(creator.paylink).toBeUndefined()
    expect(creator.isClaimed).toBeUndefined()
  })

  it("waits, and never reads a claim, while the refund's own row is missing", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" })])
    await sweep(storage, spentCheck(["0xrow"]))
    const creator = await at(storage, 0)
    expect(creator.refundTxHash).toBe("0xrefund")
    expect(creator.isRefunded).toBeUndefined()
    expect(creator.isClaimed).toBeUndefined()
  })

  it.each([
    ["settled", true, "0xrefund"],
    ["failed", undefined, undefined],
    ["sent", undefined, "0xrefund"],
  ] as const)("settles the link off its refund's %s operation", async (state, refunded, hash) => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund", refundKind: "cancel" })])
    const ops = createOperations({ db: storage.db, now: () => Date.now() })
    await ops.begin({ operationId: "op-r", flow: "paylink-reclaim", summary: "" })
    await ops.apply("op-r", { type: "sent", txHash: "0xrefund" })
    if (state !== "sent") await ops.apply("op-r", { type: state, at: 1 })
    await sweep(storage, spentCheck(["0xrow"]))
    const creator = await at(storage, 0)
    expect([creator.isRefunded, creator.refundTxHash, creator.isClaimed]).toEqual([
      refunded,
      hash,
      undefined,
    ])
  })

  it("makes the link refundable again when the refund failed", async () => {
    const storage = makeStorage([
      row({ refundTxHash: "0xrefund", refundKind: "cancel" }),
      refundRow("failed"),
    ])
    await sweep(storage, spentCheck([]))
    const creator = await at(storage, 0)
    expect(creator.refundTxHash).toBeUndefined()
    expect(creator.refundKind).toBeUndefined()
    expect(creator.isRefunded).toBeUndefined()
    expect(creator.paylink).toBe("https://x/#frag")
  })
})
