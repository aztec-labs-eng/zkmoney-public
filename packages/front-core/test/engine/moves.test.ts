// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Hex } from "viem"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createMoveStore } from "../../src/engine/moves"
import type { BuiltMove } from "../../src/engine/moveTransition"

const built: BuiltMove = {
  id: "wdraw_a",
  holdingId: "sky",
  rail: "executor",
  direction: "out",
  amount: 12_345_678_901_234_567_890n,
  quote: {
    routed: 98n,
    relayerTip: 2n,
    conversionOut: 98n,
    conversionMinOut: 97n,
    expectedOut: 96n,
    minOut: 95n,
    withdrawalFee: 0n,
  },
  withdrawalLocalId: "wdraw_a",
  nonce: `0x${"01".repeat(32)}` as Hex,
  recipientCommitment: `0x${"0c".repeat(32)}` as Hex,
  scanFrom: 7n,
  startTime: 1_000,
}
const BUILT = { type: "built", record: built } as const

const seeded = (entries: Record<string, string>) => {
  const backend = memoryBackend(new Map(Object.entries(entries)))
  return { backend, db: openDatabase(backend) }
}

describe("createMoveStore: versions", () => {
  it("refuses a version it does not know, leaving its records as they are", async () => {
    const saved = { "acct/meta/moves": "2", "acct/moves/wdraw_new": "{}" }
    const { backend, db } = seeded(saved)
    await expect(createMoveStore(db).ready).rejects.toMatchObject({ code: "invariant" })
    expect(Object.fromEntries(backend.entries)).toEqual(saved)
  })
})

describe("createMoveStore", () => {
  it("writes each event through the transition, amounts exact across a reopen", async () => {
    const backend = memoryBackend()
    const moves = createMoveStore(openDatabase(backend))
    expect((await moves.apply(built.id, BUILT))?.phase).toBe("burning")
    expect((await moves.apply(built.id, { type: "burnMined" }))?.phase).toBe("burned")
    expect(backend.entries.get("acct/moves/wdraw_a")).toContain(`"${built.amount}"`)
    expect(backend.entries.get("acct/meta/moves")).toBe("1")

    const reopened = createMoveStore(openDatabase(backend))
    expect(await reopened.get(built.id)).toMatchObject({
      phase: "burned",
      amount: built.amount,
      scanFrom: 7n,
    })
  })

  it("writes nothing for an event the transition refuses", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const moves = createMoveStore(db)
    await moves.apply(built.id, BUILT)
    const saved = backend.entries.get("acct/moves/wdraw_a")
    let commits = 0
    db.onCommit(() => commits++)

    expect(await moves.apply(built.id, { type: "claimed", at: 2_000 })).toBeUndefined()
    expect(await moves.apply(built.id, BUILT)).toBeUndefined()
    expect(await moves.apply("wdraw_b", { type: "burnMined" })).toBeUndefined()
    expect(commits).toBe(0)
    expect(backend.entries.get("acct/moves/wdraw_a")).toBe(saved)
    expect(backend.entries.has("acct/moves/wdraw_b")).toBe(false)
  })

  it("commits a move with its cursor in the caller's transaction, or neither", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const moves = createMoveStore(db)
    await moves.apply(built.id, BUILT)
    const scanned = { type: "scanned", to: 50n } as const

    await expect(
      db.write(async (w) => {
        await moves.apply(built.id, scanned, w)
        w.put("acct/cursor", "50")
        throw new Error("crash")
      }),
    ).rejects.toThrow("crash")
    expect((await moves.get(built.id))?.scannedTo).toBeUndefined()
    expect(backend.entries.has("acct/cursor")).toBe(false)

    await db.write(async (w) => {
      await moves.apply(built.id, scanned, w)
      w.put("acct/cursor", "50")
    })
    expect((await moves.get(built.id))?.scannedTo).toBe(50n)
    expect(backend.entries.get("acct/cursor")).toBe("50")
  })

  it("lists a move as open until it settles", async () => {
    const moves = createMoveStore(openDatabase(memoryBackend()))
    await moves.apply(built.id, BUILT)
    expect((await moves.open()).map((r) => r.id)).toEqual([built.id])

    await moves.apply(built.id, { type: "failed", failure: { code: "withdrawal.dropped" }, at: 2 })
    expect(await moves.open()).toEqual([])
    expect(moves.view.get().records.map((r) => r.phase)).toEqual(["failed"])
  })

  it("fails to list open moves when the read fails", async () => {
    const backend = memoryBackend()
    backend.failing.reads = true
    const moves = createMoveStore(openDatabase(backend))
    await expect(moves.ready).rejects.toMatchObject({ code: "unknown" })
    await expect(moves.open()).rejects.toMatchObject({ code: "unknown" })
  })
})
