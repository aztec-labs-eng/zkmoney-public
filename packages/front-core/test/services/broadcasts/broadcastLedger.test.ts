import { describe, expect, it } from "vitest"
import { BroadcastLedger, type NewBroadcastJob } from "../../../src/core/services/broadcasts"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"

const A = "0x00000000000000000000000000000000000000aA"
const B = "0x00000000000000000000000000000000000000bb"
const slot = (address: string, kind: NewBroadcastJob["kind"] = "deposit"): NewBroadcastJob => ({
  address,
  kind,
  scope: "acct",
  source: { type: "slot", cacheKey: "k", day: 1, nonce: 0 },
})

describe("BroadcastLedger", () => {
  it("survives a reload: a send whose hash was known goes to the chain, any other is owed again", async () => {
    const storage = new InMemoryStorageAdapter()
    const before = new BroadcastLedger(storage)
    await before.enqueue(slot(A), 1)
    await before.enqueue(slot(B), 2)
    await before.markProving(A)
    await before.noteTxHash(A, "0xhash")
    await before.markProving(B)

    const after = new BroadcastLedger(storage)
    await after.recoverInterrupted()
    expect(after.get(A)).toMatchObject({ state: "sent", txHash: "0xhash", failures: 0 })
    expect(after.get(B)).toMatchObject({ state: "queued", failures: 0 })
  })

  it("keeps a job's progress when it is owed again, and only gains urgency; a shown pool job starts afresh", async () => {
    const ledger = new BroadcastLedger(new InMemoryStorageAdapter())
    await ledger.enqueue(slot(A, "pool"), 1)
    await ledger.markProving(A)
    await ledger.markFailed(A, "offline", 10)

    await ledger.enqueue({ ...slot(A, "pool"), shownAt: 20 }, 30)
    expect(ledger.get(A)).toMatchObject({
      kind: "deposit",
      shownAt: 20,
      createdAt: 1,
      failures: 0,
      state: "queued",
      retryAt: undefined,
    })
    await ledger.markShown(A, 40)
    expect(ledger.get(A)?.shownAt).toBe(20)
  })

  it("never moves a landed job again", async () => {
    const ledger = new BroadcastLedger(new InMemoryStorageAdapter())
    await ledger.enqueue(slot(A), 1)
    await ledger.markLanded(A, 5)
    await ledger.markFailed(A, "late", 6)
    await ledger.markProving(A)
    await ledger.defer(A, 100, "locked")
    expect(ledger.get(A)).toMatchObject({ state: "landed", landedAt: 5, failures: 0 })
  })

  it("owes a landed job again once its address is paid again, and only a landed one", async () => {
    const ledger = new BroadcastLedger(new InMemoryStorageAdapter())
    await ledger.enqueue(slot(A), 1)
    await ledger.enqueue(slot(B), 2)
    await ledger.setOperation(A, "op-1")
    await ledger.markSent(A, "0xfirst")
    await ledger.markLanded(A, 5)

    expect(await ledger.republish(B, 40, 50)).toBe(false)
    expect(await ledger.republish(A, 40, 50)).toBe(true)
    expect(ledger.get(A)).toMatchObject({
      state: "queued",
      republishSince: 40,
      fundedAt: 50,
      txHash: undefined,
      operationId: undefined,
      landedAt: undefined,
    })
    expect(await ledger.republish(A, 41, 60)).toBe(false)
  })

  it("finds a job by address whatever its case", async () => {
    const ledger = new BroadcastLedger(new InMemoryStorageAdapter())
    await ledger.enqueue(slot(A), 1)
    expect(ledger.get(A.toLowerCase())?.address).toBe(A.toLowerCase())
    expect(ledger.get(A.toUpperCase().replace("0X", "0x"))).not.toBeNull()
  })
})
