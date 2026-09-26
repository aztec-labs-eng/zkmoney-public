import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, Hash } from "viem"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import {
  SIPADepositStore,
  isUnfundedSipaDeposit,
  type SIPADepositPhase,
  type SIPADepositRecord,
} from "../../../src/core/services/deposits/SIPADepositStore"

const SIPA_ADDR = "0xAbCdEf0123456789abcdef0123456789abcdef01" as Address
const RECIPIENT = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"

function makeFallback(): Omit<SIPADepositRecord, "sipaAddress" | "phase"> {
  return {
    recipientL2Address: RECIPIENT,
    messageSecret: "0x" + "11".repeat(32),
    recipientHash: "0x" + "22".repeat(32),
    recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
    l1ChainId: 11155111,
    amount: "12.5",
    tokenSymbol: "DAI",
    startTime: 1000,
  }
}

function freshStore(): SIPADepositStore {
  resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
  return SIPADepositStore.get(new InMemoryStorageAdapter())
}

describe("SIPADepositStore", () => {
  let store: SIPADepositStore

  beforeEach(() => {
    store = freshStore()
  })

  it("creates via fallback, keys lowercased, and reads back", async () => {
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    const record = store.get(SIPA_ADDR.toLowerCase() as Address)
    expect(record?.sipaAddress).toBe(SIPA_ADDR)
    expect(record?.phase).toBe("broadcast")
    expect(store.list()).toHaveLength(1)
  })

  it("throws when patching a missing record without a fallback", async () => {
    await expect(store.upsert(SIPA_ADDR, { phase: "sweeping" })).rejects.toThrow(/no existing/)
  })

  it("shallow-merges patches onto the existing record", async () => {
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    await store.upsert(SIPA_ADDR, {
      phase: "pendingClaim",
      inboxIndex: "42",
      netAmount: "12400000",
    })
    const record = store.get(SIPA_ADDR)
    expect(record?.phase).toBe("pendingClaim")
    expect(record?.inboxIndex).toBe("42")
    expect(record?.messageSecret).toBe(makeFallback().messageSecret)
  })

  it("round-trips the raw-units fee field", async () => {
    await store.upsert(SIPA_ADDR, { phase: "funded", fee: "250000000000000000" }, makeFallback())
    expect(store.get(SIPA_ADDR)?.fee).toBe("250000000000000000")
  })

  it("leaves fee undefined when unstamped", async () => {
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    expect(store.get(SIPA_ADDR)?.fee).toBeUndefined()
  })

  it("stamps endTime exactly on the terminal phases {claimed, failed, recovered}", async () => {
    const terminal: SIPADepositPhase[] = ["claimed", "failed", "recovered"]
    const nonTerminal: SIPADepositPhase[] = [
      "resolved",
      "funded",
      "broadcast",
      "sweeping",
      "pendingClaim",
      "recoverable",
    ]
    for (const [i, phase] of nonTerminal.entries()) {
      const addr = `0x${String(i).padStart(2, "0")}${"00".repeat(19)}` as Address
      await store.upsert(addr, { phase }, makeFallback())
      expect(store.get(addr)?.endTime).toBeUndefined()
    }
    for (const [i, phase] of terminal.entries()) {
      const addr = `0xff${String(i).padStart(2, "0")}${"00".repeat(18)}` as Address
      await store.upsert(addr, { phase }, makeFallback())
      expect(store.get(addr)?.endTime).toBeGreaterThan(0)
    }
  })

  it("notifies list listeners on upsert", async () => {
    const snapshots: SIPADepositRecord[][] = []
    store.onListChanged((records) => snapshots.push(records))
    await store.upsert(SIPA_ADDR, { phase: "broadcast" }, makeFallback())
    expect(snapshots.at(-1)).toHaveLength(1)
    expect(snapshots.at(-1)?.[0]?.phase).toBe("broadcast")
  })

  describe("demote (reorg)", () => {
    it("claimed (L2-derived) demotes to pendingClaim: endTime cleared, epoch bumped, claim anchor kept", async () => {
      await store.upsert(
        SIPA_ADDR,
        { phase: "claimed", claimTxHash: "0x" + "aa".repeat(32) },
        makeFallback(),
      )

      const demoted = await store.demote(SIPA_ADDR, "pendingClaim")

      expect(demoted?.phase).toBe("pendingClaim")
      expect(demoted?.endTime).toBeUndefined()
      expect(demoted?.reorgEpoch).toBe(1)
      expect(demoted?.claimTxHash).toBe("0x" + "aa".repeat(32))
    })

    it("L1-derived terminals (recovered, failed) refuse demote", async () => {
      await store.upsert(SIPA_ADDR, { phase: "recovered" }, makeFallback())
      const unchanged = await store.demote(SIPA_ADDR, "recoverable")
      expect(unchanged?.phase).toBe("recovered")
      expect(unchanged?.reorgEpoch).toBeUndefined()

      const addr2 = ("0x" + "bb".repeat(20)) as Address
      await store.upsert(addr2, { phase: "failed" }, makeFallback())
      expect((await store.demote(addr2, "pendingClaim"))?.phase).toBe("failed")
    })

    it("L1-derived non-terminal phases refuse demote", async () => {
      await store.upsert(SIPA_ADDR, { phase: "pendingClaim" }, makeFallback())
      expect((await store.demote(SIPA_ADDR, "sweeping"))?.phase).toBe("pendingClaim")
    })

    it("returns null for an unknown record", async () => {
      expect(await store.demote(SIPA_ADDR, "pendingClaim")).toBeNull()
    })

    it("drops the demoted inbox index from the dedup set so a rescan re-claims", async () => {
      await store.upsert(
        SIPA_ADDR,
        { phase: "claimed", inboxIndex: "7", claimedInboxIndexes: ["3", "7"] },
        makeFallback(),
      )

      const demoted = await store.demote(SIPA_ADDR, "pendingClaim")
      expect(demoted?.claimedInboxIndexes).toEqual(["3"])

      // Scan seam: dedup no longer skips index 7, and the re-claim upsert
      // carries the record's fresh epoch (what markClaimed now threads).
      await store.upsert(SIPA_ADDR, {
        phase: "claimed",
        inboxIndex: "7",
        claimedInboxIndexes: ["3", "7"],
        reorgEpoch: demoted?.reorgEpoch,
      })
      const reclaimed = store.get(SIPA_ADDR)
      expect(reclaimed?.phase).toBe("claimed")
      expect(reclaimed?.claimedInboxIndexes).toEqual(["3", "7"])
    })

    it("stale forward upsert (no epoch) after demote is a no-op; matching epoch re-advances", async () => {
      await store.upsert(SIPA_ADDR, { phase: "claimed" }, makeFallback())
      await store.demote(SIPA_ADDR, "pendingClaim") // epoch 1

      await store.upsert(SIPA_ADDR, { phase: "claimed" })
      expect(store.get(SIPA_ADDR)?.phase).toBe("pendingClaim")

      await store.upsert(SIPA_ADDR, { phase: "claimed", reorgEpoch: 1 })
      expect(store.get(SIPA_ADDR)?.phase).toBe("claimed")
      expect(store.get(SIPA_ADDR)?.endTime).toBeGreaterThan(0)
    })
  })
})

// The scan, the reorg monitor and the wallet's registration sync all write the same records.
describe("SIPADepositStore concurrent writers", () => {
  const HASH = ("0x" + "5e".repeat(32)) as Hash
  let store: SIPADepositStore

  beforeEach(async () => {
    store = freshStore()
    await store.upsert(SIPA_ADDR, { phase: "broadcast", amount: "0" }, makeFallback())
  })

  it("keep each other's fields", async () => {
    await Promise.all([
      store.upsert(SIPA_ADDR, { phase: "sweeping", sweepTxHash: HASH }),
      store.upsert(SIPA_ADDR, { phase: "sweeping", lastScanAt: 5 }),
    ])
    expect(store.get(SIPA_ADDR)).toMatchObject({
      phase: "sweeping",
      sweepTxHash: HASH,
      lastScanAt: 5,
    })
  })

  it("keep a sweep under way when another writer echoes the phase it read", async () => {
    const sweep = store.update(SIPA_ADDR, () => ({ phase: "sweeping", sweepTxHash: HASH }))
    const echo = store.upsert(SIPA_ADDR, { phase: store.get(SIPA_ADDR)!.phase, lastScanAt: 5 })
    await Promise.all([sweep, echo])
    expect(store.get(SIPA_ADDR)).toMatchObject({
      phase: "sweeping",
      sweepTxHash: HASH,
      lastScanAt: 5,
    })
  })

  it("update decides on the record as it stands at the write", async () => {
    const funded = (current: SIPADepositRecord) =>
      isUnfundedSipaDeposit(current) ? { phase: current.phase, amount: "15" } : null
    await Promise.all([
      store.upsert(SIPA_ADDR, { phase: "sweeping", sweepTxHash: HASH }),
      store.update(SIPA_ADDR, funded),
    ])
    expect(store.get(SIPA_ADDR)).toMatchObject({
      phase: "sweeping",
      sweepTxHash: HASH,
      amount: "0",
    })
  })

  it("update writes nothing for a null patch or a missing record", async () => {
    const listener = vi.fn()
    store.onListChanged(listener)
    expect(await store.update(SIPA_ADDR, () => null)).toMatchObject({ phase: "broadcast" })
    const other = ("0x" + "bb".repeat(20)) as Address
    expect(await store.update(other, () => ({ phase: "sweeping" }))).toBeNull()
    expect(store.get(other)).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it("update keeps the reorg-epoch guard", async () => {
    await store.upsert(SIPA_ADDR, { phase: "claimed" })
    await store.demote(SIPA_ADDR, "pendingClaim")
    await store.update(SIPA_ADDR, () => ({ phase: "claimed" }))
    expect(store.get(SIPA_ADDR)?.phase).toBe("pendingClaim")
  })
})

describe("isUnfundedSipaDeposit", () => {
  const record = (patch: Partial<SIPADepositRecord>): SIPADepositRecord =>
    ({
      ...makeFallback(),
      sipaAddress: SIPA_ADDR,
      amount: "0",
      phase: "broadcast",
      ...patch,
    } as SIPADepositRecord)

  it("hides a broadcast address nobody paid", () => {
    expect(isUnfundedSipaDeposit(record({}))).toBe(true)
    expect(isUnfundedSipaDeposit(record({ phase: "resolved" }))).toBe(true)
  })

  it("shows anything with evidence funds arrived", () => {
    expect(isUnfundedSipaDeposit(record({ amount: "5" }))).toBe(false)
    expect(isUnfundedSipaDeposit(record({ phase: "sweeping" }))).toBe(false)
    expect(isUnfundedSipaDeposit(record({ phase: "claimed", amount: "5" }))).toBe(false)
    // A sweep landed but the claim keeps failing: the phase never advances, and hiding it would
    // hide real money sitting on L1.
    expect(isUnfundedSipaDeposit(record({ sweepTxHash: "0xfeed" as `0x${string}` }))).toBe(false)
    expect(isUnfundedSipaDeposit(record({ inboxIndex: "7" }))).toBe(false)
  })
})
