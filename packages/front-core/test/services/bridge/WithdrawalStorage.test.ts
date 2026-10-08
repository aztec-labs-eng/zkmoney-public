import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hash } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import type { WithdrawalPhase, WithdrawalRecord } from "../../../src/core/services/bridge/types"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"

const VALID_RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678" as Address
// 0x + 64 hex chars = 66-char valid 32-byte hash (viem isHash requirement).
const VALID_TX_MIXED = "0xAAbbCCdd" + "11".repeat(28)
const VALID_TX = VALID_TX_MIXED.toLowerCase() as Hash
const OTHER_TX = ("0x" + "ee".repeat(32)) as Hash
const FINALIZE_TX = ("0x" + "f1".repeat(32)) as Hash
/** 0.1 token at 18 decimals — the flat relayer tip, in the raw units the record holds. */
const TIP = "100000000000000000"

type OverrideableFields = Partial<Omit<WithdrawalRecord, "phase">> & {
  phase?: WithdrawalPhase
}

function makeRecord(overrides: OverrideableFields = {}): WithdrawalRecord {
  return {
    localId: "local-1",
    recipient: VALID_RECIPIENT,
    recipientProvenance: "saved-recipient",
    amount: "1.0",
    tokenSymbol: "DAI",
    phase: "submitting",
    startTime: 1_700_000_000_000,
    ...overrides,
  }
}

async function newStore(): Promise<WithdrawalStorage> {
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  const adapter = new InMemoryStorageAdapter()
  const store = WithdrawalStorage.get(adapter)
  await store.load()
  return store
}

describe("WithdrawalStorage", () => {
  beforeEach(() => {
    resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  })

  describe("create", () => {
    it("inserts a fresh submitting-phase record fetchable by localId with no endTime", async () => {
      const store = await newStore()
      const record = makeRecord()

      await store.create(record)

      const fetched = store.get("local-1")
      expect(fetched).not.toBeNull()
      expect(fetched?.phase).toBe("submitting")
      expect(fetched?.endTime).toBeUndefined()
      expect(store.list()).toEqual([fetched])
    })

    it("stamps endTime when the caller supplies a record already in a terminal phase", async () => {
      const store = await newStore()
      const before = Date.now()

      await store.create(makeRecord({ phase: "failed", error: "nope" }))

      const fetched = store.get("local-1")
      expect(fetched?.endTime).toBeGreaterThanOrEqual(before)
    })
  })

  describe("get / getByL2TxHash", () => {
    it("resolves to the lowercased record when the caller passes the key in mixed case", async () => {
      const store = await newStore()
      await store.create(makeRecord({ localId: "Mixed-Case-Id" }))

      expect(store.get("MIXED-case-id")).not.toBeNull()
      expect(store.get("mixed-case-id")).not.toBeNull()
    })

    it("resolves to the mined record when getByL2TxHash receives mixed case", async () => {
      const store = await newStore()
      await store.create(makeRecord())
      await store.markMined("local-1", VALID_TX_MIXED, 100, "1000000")

      const byLower = store.getByL2TxHash(VALID_TX)
      const byMixed = store.getByL2TxHash(VALID_TX_MIXED)
      const byUpper = store.getByL2TxHash(VALID_TX_MIXED.toUpperCase())

      // All three lookups resolve to the same record (case-insensitive hash lookup).
      expect(byLower).not.toBeNull()
      expect(byMixed).not.toBeNull()
      expect(byUpper).not.toBeNull()
      expect(byMixed).toBe(byLower)
      expect(byUpper).toBe(byLower)
    })

    it("returns null when no record matches", async () => {
      const store = await newStore()
      expect(store.get("nope")).toBeNull()
      expect(store.getByL2TxHash(OTHER_TX)).toBeNull()
    })
  })

  describe("patch", () => {
    it("shallow-merges an existing record and emits updated", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      const updated = vi.fn()
      store.onUpdated(updated)

      const next = await store.patch("local-1", { phase: "submitting", error: "network" })

      expect(next.error).toBe("network")
      expect(store.get("local-1")?.error).toBe("network")
      expect(updated).toHaveBeenCalledWith(next)
    })

    it("throws with a descriptive message when the key is unknown", async () => {
      const store = await newStore()

      await expect(store.patch("missing", { phase: "submitting" })).rejects.toThrow(
        /no record for key missing/,
      )
    })

    it("stamps endTime when patching into a terminal phase", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      const before = Date.now()
      const patched = await store.patch("local-1", { phase: "failed", error: "boom" })

      expect(patched.endTime).toBeGreaterThanOrEqual(before)
    })

    it("preserves an existing endTime when patching into the same terminal phase (idempotence)", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "failed", endTime: 42 }))

      const patched = await store.patch("local-1", { phase: "failed", error: "updated" })

      expect(patched.endTime).toBe(42)
    })
  })

  describe("markMined", () => {
    it("keeps localId as the key, populates fields, sets l2_mined phase", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      await store.markMined("local-1", VALID_TX_MIXED, 100, "1000000")

      expect(store.get("local-1")).not.toBeNull()
      const byHash = store.getByL2TxHash(VALID_TX)
      expect(byHash).not.toBeNull()
      expect(byHash).toBe(store.get("local-1"))
      expect(byHash?.phase).toBe("l2_mined")
      // Stored field preserves the caller's original case; lookup is case-insensitive.
      expect(byHash?.l2TxHash?.toLowerCase()).toBe(VALID_TX)
      expect(byHash?.blockNumber).toBe(100)
      expect(byHash?.rawAmount).toBe("1000000")
    })

    it("records the tip the burn offered alongside the amount it burned", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      const mined = await store.markMined("local-1", VALID_TX, 100, "1000000", TIP)

      expect(mined.rawAmount).toBe("1000000")
      expect(mined.relayerTip).toBe(TIP)
    })

    it("leaves the tip unset for a caller that does not know it", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      const mined = await store.markMined("local-1", VALID_TX, 100, "1000000")

      expect(mined.relayerTip).toBeUndefined()
    })

    it("throws when called with an unknown localId, does not mutate storage", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      await expect(store.markMined("nope", VALID_TX, 100, "1000000")).rejects.toThrow(
        /no record for localId nope/,
      )

      // Original record untouched.
      expect(store.get("local-1")?.phase).toBe("submitting")
    })

    it("throws when the l2TxHash is not a valid 32-byte hex hash", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      await expect(store.markMined("local-1", "abc123", 100, "1000000")).rejects.toThrow(
        /not a valid 32-byte hex hash/,
      )

      expect(store.get("local-1")?.phase).toBe("submitting")
    })

    it("resolves by l2TxHash in any case while preserving localId identity", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      await store.markMined("local-1", VALID_TX_MIXED, 100, "1000000")

      expect(store.get(VALID_TX_MIXED)).not.toBeNull()
      expect(store.get(VALID_TX_MIXED.toUpperCase())).not.toBeNull()
      expect(store.get(VALID_TX)).not.toBeNull()
      expect(store.get("local-1")).not.toBeNull()
    })
  })

  describe("merge on load", () => {
    it("keeps the further phase and the self-finalize marker when two keys collapse to one", async () => {
      resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
      const adapter = new InMemoryStorageAdapter()
      await adapter.setItem(
        "@obsidion/withdrawals/records",
        JSON.stringify({
          "LOCAL-1": makeRecord({
            phase: "finalizing_l1",
            l2TxHash: VALID_TX,
            finalizeTxHash: FINALIZE_TX,
          }),
          "local-1": makeRecord({ phase: "l2_mined", l2TxHash: VALID_TX }),
        }),
      )
      const store = WithdrawalStorage.get(adapter)
      await store.load()

      const merged = store.get("local-1")!
      expect(merged.phase).toBe("finalizing_l1")
      // A submitted self-finalize is never unset by a record that predates it.
      expect(merged.finalizeTxHash).toBe(FINALIZE_TX)
    })

    it("keeps the recorded tip when the other key never carried one", async () => {
      resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
      const adapter = new InMemoryStorageAdapter()
      await adapter.setItem(
        "@obsidion/withdrawals/records",
        JSON.stringify({
          "LOCAL-1": makeRecord({ phase: "l2_mined", l2TxHash: VALID_TX, relayerTip: TIP }),
          "local-1": makeRecord({ phase: "finalizing_l1", l2TxHash: VALID_TX }),
        }),
      )
      const store = WithdrawalStorage.get(adapter)
      await store.load()

      expect(store.get("local-1")?.relayerTip).toBe(TIP)
    })
  })

  describe("stampTerminal idempotence", () => {
    it("preserves existing endTime across subsequent terminal-phase patches", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "done", endTime: 1234, l2TxHash: VALID_TX }))

      const after1 = await store.patch(VALID_TX, { phase: "done", l1TxHash: "0xabc" })
      const after2 = await store.patch(VALID_TX, { phase: "done", error: undefined })

      expect(after1.endTime).toBe(1234)
      expect(after2.endTime).toBe(1234)
    })

    it("leaves endTime unset when writing a non-terminal phase", async () => {
      const store = await newStore()
      await store.create(makeRecord())
      const patched = await store.patch("local-1", {
        phase: "awaiting_proven",
        withdrawalId: ("0x" + "ab".repeat(32)) as `0x${string}`,
      })

      expect(patched.endTime).toBeUndefined()
      expect(patched.withdrawalId).toBe(("0x" + "ab".repeat(32)) as `0x${string}`)
    })
  })


  describe("delegation smoke", () => {
    it("remove deletes an existing record", async () => {
      const store = await newStore()
      await store.create(makeRecord())

      await store.remove("local-1")

      expect(store.get("local-1")).toBeNull()
      expect(store.list()).toEqual([])
    })

    it("clearAll empties the store", async () => {
      const store = await newStore()
      await store.create(makeRecord({ localId: "a" }))
      await store.create(makeRecord({ localId: "b" }))

      await store.clearAll()

      expect(store.list()).toEqual([])
    })
  })

  describe("demote (reorg)", () => {
    it("awaiting_proven demotes to l2_mined with epoch bump and cleared endTime", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "awaiting_proven", l2TxHash: VALID_TX }))

      const demoted = await store.demote("local-1")

      expect(demoted.phase).toBe("l2_mined")
      expect(demoted.reorgEpoch).toBe(1)
      expect(demoted.endTime).toBeUndefined()
      expect(demoted.l2TxHash).toBe(VALID_TX) // anchor preserved
    })

    it("finalizing_l1 demotes one step to awaiting_proven", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "finalizing_l1", l2TxHash: VALID_TX }))
      const demoted = await store.demote("local-1")
      expect(demoted.phase).toBe("awaiting_proven")
      expect(demoted.reorgEpoch).toBe(1)
    })

    it("drops the finalization hash, which named a release of the reorged-out burn", async () => {
      const store = await newStore()
      await store.create(
        makeRecord({ phase: "finalizing_l1", l2TxHash: VALID_TX, finalizeTxHash: FINALIZE_TX }),
      )
      expect((await store.demote("local-1")).finalizeTxHash).toBeUndefined()

      await store.create(
        makeRecord({
          localId: "local-2",
          phase: "l2_mined",
          l2TxHash: OTHER_TX,
          finalizeTxHash: FINALIZE_TX,
        }),
      )
      expect((await store.demote("local-2", { droppedBurn: true })).finalizeTxHash).toBeUndefined()
    })

    it("dropped burn → failed terminally with epoch bump (reorg exception)", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "l2_mined", l2TxHash: VALID_TX }))

      const failed = await store.demote("local-1", { droppedBurn: true })

      expect(failed.phase).toBe("failed")
      expect(failed.reorgEpoch).toBe(1)
      expect(failed.endTime).toBeDefined()
      expect(failed.error).toMatch(/reorg/i)
      expect(failed.cancelReason).toBeUndefined()
    })

    it("done refuses demote", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "done", l2TxHash: VALID_TX, endTime: 999 }))
      const unchanged = await store.demote("local-1")
      expect(unchanged.phase).toBe("done")
      expect(unchanged.reorgEpoch).toBeUndefined()
      expect(unchanged.endTime).toBe(999)
    })

    it("pre-mine and failed records refuse demote", async () => {
      const store = await newStore()
      await store.create(makeRecord({ localId: "sub", phase: "submitting" }))
      await store.create(makeRecord({ localId: "fail", phase: "failed" }))
      expect((await store.demote("sub")).phase).toBe("submitting")
      expect((await store.demote("fail")).phase).toBe("failed")
    })

    it("stale forward patch (no epoch) after demote is a no-op; matching epoch re-advances", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "awaiting_proven", l2TxHash: VALID_TX }))
      await store.demote("local-1") // → l2_mined, epoch 1

      const blocked = await store.patch("local-1", { phase: "finalizing_l1" })
      expect(blocked.phase).toBe("l2_mined")

      const advanced = await store.patch("local-1", { phase: "finalizing_l1", reorgEpoch: 1 })
      expect(advanced.phase).toBe("finalizing_l1")
      expect(advanced.reorgEpoch).toBe(1)
    })

  })

  describe("reviveDroppedBurn", () => {
    it("returns a dropped-burn failure to l2_mined with the failure cleared", async () => {
      const store = await newStore()
      await store.create(
        makeRecord({ phase: "awaiting_proven", l2TxHash: VALID_TX, phaseEnteredAt: 5 }),
      )
      await store.demote("local-1", { droppedBurn: true })
      const before = Date.now()

      const revived = await store.reviveDroppedBurn("local-1")

      expect(revived).toBe(store.get("local-1"))
      expect(revived?.phase).toBe("l2_mined")
      expect(revived?.reorgEpoch).toBe(2)
      expect(revived?.phaseEnteredAt).toBeGreaterThanOrEqual(before)
      expect(revived?.endTime).toBeUndefined()
      expect(revived?.error).toBeUndefined()
      expect(revived?.droppedBurn).toBeUndefined()
      expect(revived?.l2TxHash).toBe(VALID_TX)
    })

    it("refuses any record that is not a dropped-burn failure", async () => {
      const store = await newStore()
      await store.create(makeRecord({ localId: "fail", phase: "failed", error: "nope" }))
      await store.create(
        makeRecord({ localId: "live", phase: "l2_mined", l2TxHash: VALID_TX, droppedBurn: true }),
      )
      const failed = store.get("fail")
      const live = store.get("live")

      expect(await store.reviveDroppedBurn("fail")).toBeNull()
      expect(await store.reviveDroppedBurn("live")).toBeNull()
      expect(store.get("fail")).toBe(failed)
      expect(store.get("live")).toBe(live)
    })

    it("fences a write that carries the failure's epoch", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "l2_mined", l2TxHash: VALID_TX }))
      await store.demote("local-1", { droppedBurn: true }) // epoch 1
      await store.reviveDroppedBurn("local-1") // epoch 2

      const blocked = await store.patch("local-1", { phase: "finalizing_l1", reorgEpoch: 1 })
      expect(blocked.phase).toBe("l2_mined")

      const advanced = await store.patch("local-1", { phase: "awaiting_proven", reorgEpoch: 2 })
      expect(advanced.phase).toBe("awaiting_proven")
    })
  })

  describe("setBurnDroppedAt", () => {
    it("records the time and nothing else, on a record behind the epoch fence", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "finalizing_l1", l2TxHash: VALID_TX }))
      const demoted = await store.demote("local-1") // epoch 1

      const recorded = await store.setBurnDroppedAt("local-1", 1234)

      expect(recorded).toBe(store.get("local-1"))
      expect(recorded).toEqual({ ...demoted, burnDroppedAt: 1234 })
    })

    it("keeps the first time recorded", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "l2_mined", l2TxHash: VALID_TX }))
      await store.setBurnDroppedAt("local-1", 100)

      expect((await store.setBurnDroppedAt("local-1", 200)).burnDroppedAt).toBe(100)
    })

    it("clears with undefined, in any phase", async () => {
      const store = await newStore()
      await store.create(makeRecord({ phase: "swapping", l2TxHash: VALID_TX, burnDroppedAt: 100 }))

      const cleared = await store.setBurnDroppedAt("local-1", undefined)

      expect(cleared.burnDroppedAt).toBeUndefined()
      expect(cleared.phase).toBe("swapping")
    })

    it.each(["submitting", "swapping", "recoverable", "recovered", "done", "failed"] as const)(
      "records nothing on a %s record",
      async (phase) => {
        const store = await newStore()
        await store.create(makeRecord({ phase, l2TxHash: VALID_TX }))
        const before = store.get("local-1")

        expect(await store.setBurnDroppedAt("local-1", 1234)).toBe(before)
      },
    )

    type Write = (store: WithdrawalStorage) => Promise<WithdrawalRecord | null>
    const demote: Write = (store) => store.demote("local-1")
    const fail: Write = (store) => store.demote("local-1", { droppedBurn: true })
    const revive: Write = (store) => store.reviveDroppedBurn("local-1")

    it.each([
      ["a demote", "awaiting_proven", demote],
      ["a failure", "awaiting_proven", fail],
      ["a revival", "failed", revive],
    ] as const)("%s clears it", async (_, phase, write) => {
      const store = await newStore()
      await store.create(
        makeRecord({ phase, l2TxHash: VALID_TX, droppedBurn: true, burnDroppedAt: 100 }),
      )

      const written = await write(store)

      expect(written?.phase).not.toBe(phase)
      expect(written?.burnDroppedAt).toBeUndefined()
    })
  })
})

describe("failInterruptedSubmissions", () => {
  const NOW = 1_700_000_000_000
  const HOUR = 60 * 60 * 1000

  it("fails only pre-mine rows older than the timeout", async () => {
    const store = await newStore()
    await store.create(makeRecord({ localId: "stale", startTime: NOW - 2 * HOUR }))
    await store.create(makeRecord({ localId: "fresh", startTime: NOW - 60_000 }))
    await store.create(
      makeRecord({
        localId: "mined",
        phase: "l2_mined",
        startTime: NOW - 2 * HOUR,
        l2TxHash: VALID_TX,
      }),
    )

    const failed = await store.failInterruptedSubmissions(NOW)

    expect(failed.map((r) => r.localId)).toEqual(["stale"])
    expect(store.get("stale")?.phase).toBe("failed")
    expect(store.get("stale")?.error).toMatch(/interrupted/)
    expect(store.get("fresh")?.phase).toBe("submitting")
    expect(store.get("mined")?.phase).toBe("l2_mined")
  })

  it("is idempotent", async () => {
    const store = await newStore()
    await store.create(makeRecord({ localId: "stale", startTime: NOW - 2 * HOUR }))
    await store.failInterruptedSubmissions(NOW)
    expect(await store.failInterruptedSubmissions(NOW)).toEqual([])
  })
})
