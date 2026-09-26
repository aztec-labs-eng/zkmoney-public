import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  PaylinkClaimReconciler,
  demotePaylinkClaim,
  markPaylinkMigrated,
  type ReconcilerStorage,
} from "../../src/core/services/paylink/PaylinkClaimReconciler"
import { markRefundInFlight, clearRefundInFlight } from "../../src/core/services/paylink/refundInFlight"
import { globalEventEmitter } from "../../src/core/services/GlobalEventEmitter"
import type { PaylinkTransaction, Transaction } from "../../src/types"

const row = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
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
  }) as PaylinkTransaction

// In-memory storage mirroring TransactionStorage.updateTransaction semantics:
// find-by-predicate, mutate in place, return whether a row matched.
function makeStorage(rows: Transaction[]): ReconcilerStorage & { rows: Transaction[] } {
  return {
    rows,
    async getTransactions() {
      return rows
    },
    async updateTransaction(predicate, updater) {
      const idx = rows.findIndex(predicate)
      if (idx < 0) return false
      updater(rows[idx])
      return true
    },
  }
}

// Resolves spent=true for any row whose txHash is in `spent`.
const spentCheck = (spent: string[]) =>
  vi.fn(async (rows: PaylinkTransaction[]) => new Map(rows.map((r) => [r.txHash, spent.includes(r.txHash)])))

let claimed: string[]
let demoted: string[]
const capture = (d: { txHash: string }) => claimed.push(d.txHash)
const captureDemoted = (d: { txHash: string }) => demoted.push(d.txHash)

beforeEach(() => {
  claimed = []
  demoted = []
  globalEventEmitter.onPaylinkClaimed(capture)
  globalEventEmitter.onPaylinkClaimDemoted(captureDemoted)
})
afterEach(() => {
  globalEventEmitter.offPaylinkClaimed(capture)
  globalEventEmitter.offPaylinkClaimDemoted(captureDemoted)
  clearRefundInFlight("0xsecret")
})

describe("PaylinkClaimReconciler", () => {
  it("flips isClaimed and emits once on a genuine claim", async () => {
    const storage = makeStorage([row()])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect(claimed).toEqual(["0xrow"])
  })

  it("does not flip or emit when the note is not spent", async () => {
    const storage = makeStorage([row()])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck([]), storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("P0: a mid-flight self-refund (spent, isRefunded false, in-flight) is not a claim", async () => {
    markRefundInFlight("0xsecret")
    const storage = makeStorage([row()])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("a completed refund (paylink scrubbed) is filtered out before classification", async () => {
    const storage = makeStorage([row({ isRefunded: true, paylink: undefined })])
    const checkSpent = spentCheck(["0xrow"])
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect(checkSpent).not.toHaveBeenCalled()
    expect(claimed).toEqual([])
  })

  it("an already-claimed row is not re-emitted (fire-once)", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    const checkSpent = spentCheck(["0xrow"])
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect(claimed).toEqual([])
  })

  it("skips a row with a blank txHash (no colliding dedup id)", async () => {
    const storage = makeStorage([row({ txHash: "" })])
    const checkSpent = spentCheck([""])
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect(checkSpent).not.toHaveBeenCalled()
    expect(claimed).toEqual([])
  })

  it("skips legacy rows missing fallbackSecret or paylink", async () => {
    const storage = makeStorage([
      row({ txHash: "0xa", fallbackSecret: undefined }),
      row({ txHash: "0xb", paylink: undefined }),
    ])
    const checkSpent = spentCheck(["0xa", "0xb"])
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect(checkSpent).not.toHaveBeenCalled()
    expect(claimed).toEqual([])
  })

  it("leaves all rows unchanged when the batched read fails", async () => {
    const storage = makeStorage([row()])
    const checkSpent = vi.fn(async () => {
      throw new Error("rpc down")
    })
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("does not write after the active account changed mid-sweep", async () => {
    const storage = makeStorage([row()])
    let account = "A"
    await new PaylinkClaimReconciler({
      checkSpent: spentCheck(["0xrow"]),
      storage,
      getActiveAccount: () => account,
    }).reconcile()
    // sanity: with a stable account it would have flipped; assert the guard by switching
    // before the post-read loop is exercised via a second run with a switching getter.
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)

    const storage2 = makeStorage([row()])
    const switching = vi.fn(() => account)
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      account = "B" // account switches during the read, before the write loop
      return new Map(rows.map((r) => [r.txHash, true]))
    })
    claimed = []
    await new PaylinkClaimReconciler({
      checkSpent,
      storage: storage2,
      getActiveAccount: switching,
    }).reconcile()
    expect((storage2.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("reconcileTxHash rechecks only the targeted row", async () => {
    const storage = makeStorage([row({ txHash: "0xa" }), row({ txHash: "0xb" })])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xa", "0xb"]), storage }).reconcileTxHash(
      "0xa",
    )
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect((storage.rows[1] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual(["0xa"])
  })

  // A migrated row is never a claim candidate and never flips, even with a spent nullifier.
  it("a migrated row is not a candidate and never flips to claimed", async () => {
    const storage = makeStorage([row({ isMigrated: true })])
    const checkSpent = spentCheck(["0xrow"])
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect(checkSpent).not.toHaveBeenCalled()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("the claim write-predicate aborts on a row migrated mid-sweep", async () => {
    const storage = makeStorage([row()])
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      // Migration flips the row between the candidate read and the write loop.
      ;(storage.rows[0] as PaylinkTransaction).isMigrated = true
      return new Map(rows.map((r) => [r.txHash, true]))
    })
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })
})

describe("markPaylinkMigrated", () => {
  it("flips exactly once and emits no paylinkClaimed", async () => {
    const storage = makeStorage([row()])
    expect(await markPaylinkMigrated("0xrow", storage)).toBe(true)
    expect((storage.rows[0] as PaylinkTransaction).isMigrated).toBe(true)
    expect(await markPaylinkMigrated("0xrow", storage)).toBe(false)
    expect(claimed).toEqual([])
  })

  it("refuses to flip a row already claimed or refunded", async () => {
    const storage = makeStorage([row({ txHash: "0xa", isClaimed: true }), row({ txHash: "0xb", isRefunded: true })])
    expect(await markPaylinkMigrated("0xa", storage)).toBe(false)
    expect(await markPaylinkMigrated("0xb", storage)).toBe(false)
    expect((storage.rows[0] as PaylinkTransaction).isMigrated).toBeUndefined()
    expect((storage.rows[1] as PaylinkTransaction).isMigrated).toBeUndefined()
  })
})

describe("demotePaylinkClaim (reorg)", () => {
  it("flips isClaimed back to false, bumps the row's reorgEpoch, and emits paylinkClaimDemoted", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    expect(await demotePaylinkClaim("0xrow", storage)).toBe(true)
    const demotedRow = storage.rows[0] as PaylinkTransaction
    expect(demotedRow.isClaimed).toBe(false)
    expect(demotedRow.reorgEpoch).toBe(1)
    expect(demoted).toEqual(["0xrow"])
  })

  it("is a no-op on an unclaimed row and emits nothing", async () => {
    const storage = makeStorage([row()])
    expect(await demotePaylinkClaim("0xrow", storage)).toBe(false)
    expect((storage.rows[0] as PaylinkTransaction).reorgEpoch).toBeUndefined()
    expect(demoted).toEqual([])
  })

  it("a stale sweep (rows read pre-demote) cannot re-flip a demoted claim", async () => {
    const storage = makeStorage([row()])
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      // Reorg demote lands between the candidate read and the write loop.
      ;(storage.rows[0] as PaylinkTransaction).isClaimed = true
      await demotePaylinkClaim("0xrow", storage)
      return new Map(rows.map((r) => [r.txHash, true]))
    })
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(false)
    expect(claimed).toEqual([])
  })

  it("a fresh reconcile after demote re-flips when the note is still spent on-chain", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    await demotePaylinkClaim("0xrow", storage)
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect(claimed).toEqual(["0xrow"])
  })
})

describe("reverse leg — reconcile rechecks claimed rows", () => {
  it("demotes a claimed row whose note reads UNSPENT and emits paylinkClaimDemoted", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck([]), storage }).reconcile()
    const r = storage.rows[0] as PaylinkTransaction
    expect(r.isClaimed).toBe(false)
    expect(r.reorgEpoch).toBe(1)
    expect(demoted).toEqual(["0xrow"])
    expect(claimed).toEqual([])
  })

  it("leaves a claimed row untouched when the note is still spent", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect(demoted).toEqual([])
  })

  it("does not demote a claimed row the checkSpent result did not cover", async () => {
    const storage = makeStorage([row({ isClaimed: true })])
    const checkSpent = vi.fn(async () => new Map<string, boolean>())
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect(demoted).toEqual([])
  })

  it("a stale UNSPENT observation cannot demote a row re-claimed at a newer epoch", async () => {
    const storage = makeStorage([row({ isClaimed: true })]) // epoch 0 at read
    const checkSpent = vi.fn(async (rows: PaylinkTransaction[]) => {
      // A demote + re-claim cycle lands mid-read: epoch bumps, claim stands.
      ;(storage.rows[0] as PaylinkTransaction).reorgEpoch = 1
      return new Map(rows.map((r) => [r.txHash, false]))
    })
    await new PaylinkClaimReconciler({ checkSpent, storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBe(true)
    expect(demoted).toEqual([])
  })
})

// A refund whose tab closed after submit leaves only its hash on the creator row.
describe("PaylinkClaimReconciler — refund submitted before a reload", () => {
  const refundRow = (status: Transaction["status"]) =>
    ({ timestamp: Date.now(), status, txHash: "0xrefund" }) as Transaction

  it("never reads the spent note as a recipient's claim", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" }), refundRow("pending")])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    expect((storage.rows[0] as PaylinkTransaction).isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("marks the link refunded once the refund lands", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" }), refundRow("success")])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    const creator = storage.rows[0] as PaylinkTransaction
    expect(creator.isRefunded).toBe(true)
    expect(creator.paylink).toBeUndefined()
    expect(creator.isClaimed).toBeUndefined()
  })

  it("waits, and never reads a claim, while the refund's own row is missing", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" })])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck(["0xrow"]), storage }).reconcile()
    const creator = storage.rows[0] as PaylinkTransaction
    expect(creator.refundTxHash).toBe("0xrefund")
    expect(creator.isRefunded).toBeUndefined()
    expect(creator.isClaimed).toBeUndefined()
    expect(claimed).toEqual([])
  })

  it("makes the link refundable again when the refund failed", async () => {
    const storage = makeStorage([row({ refundTxHash: "0xrefund" }), refundRow("failed")])
    await new PaylinkClaimReconciler({ checkSpent: spentCheck([]), storage }).reconcile()
    const creator = storage.rows[0] as PaylinkTransaction
    expect(creator.refundTxHash).toBeUndefined()
    expect(creator.isRefunded).toBeUndefined()
    expect(creator.paylink).toBe("https://x/#frag")
  })
})
