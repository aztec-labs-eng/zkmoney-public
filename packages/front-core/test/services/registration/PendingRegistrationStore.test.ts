import { beforeEach, describe, expect, it, vi } from "vitest"

import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import type { IStorageAdapter } from "../../../src/core/storages/adapter"
import {
  ESCALATION_MAX_AGE_MS,
  ESCALATION_MAX_RETRIES,
  PendingRegistrationStore,
  isRegistrationEscalated,
  registrationUiState,
  type PendingRegistrationRecord,
} from "../../../src/core/services/registration"

const ACCOUNT = "0x" + "aa".repeat(20)
const STORAGE_KEY = "@obsidion/pending-registration/records"

function fallback(
  over: Partial<PendingRegistrationRecord> = {},
): Omit<PendingRegistrationRecord, "account"> {
  return {
    tag: "alice",
    nameHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
    l2Address: ("0x" + "11".repeat(32)) as `0x${string}`,
    r1Key: {
      qx: ("0x" + "22".repeat(32)) as `0x${string}`,
      qy: ("0x" + "33".repeat(32)) as `0x${string}`,
    },
    l1ChainId: 11155111,
    sipaAddress: "0x" + "5a".repeat(20),
    depositToken: ("0x" + "bb".repeat(20)) as `0x${string}`,
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  }
}

function freshStore(adapter: IStorageAdapter = new InMemoryStorageAdapter()): PendingRegistrationStore {
  resetSingleton(PendingRegistrationStore as unknown as { instance: PendingRegistrationStore | null })
  return PendingRegistrationStore.get(adapter)
}

beforeEach(() => {
  resetSingleton(PendingRegistrationStore as unknown as { instance: PendingRegistrationStore | null })
})

describe("PendingRegistrationStore", () => {
  it("accepts a plain (non-encrypted) adapter", async () => {
    const store = freshStore(new InMemoryStorageAdapter())
    await store.upsert(ACCOUNT, {}, fallback())
    expect(store.current()?.tag).toBe("alice")
  })

  it("round-trips a full record through JSON and a second store instance", async () => {
    const adapter = new InMemoryStorageAdapter()
    const store = freshStore(adapter)
    const written = await store.upsert(ACCOUNT, {}, fallback())

    const reloaded = freshStore(adapter)
    await reloaded.load()
    expect(reloaded.get(ACCOUNT)).toEqual(written)
  })

  it("reload picks up records written behind its back and drops removed ones", async () => {
    const adapter = new InMemoryStorageAdapter()
    const store = freshStore(adapter)
    await store.load()
    const changed = vi.fn()
    store.onListChanged(changed)

    const otherTab = freshStore(adapter)
    await otherTab.upsert(ACCOUNT, {}, fallback())
    expect(store.current()).toBeNull()
    await store.reload()
    expect(store.current()?.tag).toBe("alice")
    expect(changed).toHaveBeenCalledTimes(1)

    await otherTab.remove(ACCOUNT)
    await store.reload()
    expect(store.current()).toBeNull()
  })

  it("deserializes a versioned fixture identically across adapter instances", async () => {
    // The persisted schema pin: every field, JSON-portable (no bigints anywhere).
    const record = { ...fallback({ startTime: 1_700_000_000_000 }), account: ACCOUNT }
    const fixture = JSON.stringify({ [ACCOUNT.toLowerCase()]: record })

    // Two independent string-based adapters seeded with the same serialized payload.
    for (const adapter of [new InMemoryStorageAdapter(), new InMemoryStorageAdapter()]) {
      await adapter.setItem(STORAGE_KEY, fixture)
      const store = freshStore(adapter)
      await store.load()
      expect(store.get(ACCOUNT)).toEqual(record)
    }
  })

  it("patch merges onto the existing record; upsert-with-fallback creates", async () => {
    const store = freshStore()
    await store.upsert(ACCOUNT, {}, fallback())
    const patched = await store.upsert(ACCOUNT, { retries: 2 })
    expect(patched.retries).toBe(2)
    expect(patched.tag).toBe("alice")
  })

  it("terminal records are excluded from current()", async () => {
    const store = freshStore()
    await store.upsert(ACCOUNT, {}, fallback())
    await store.close(ACCOUNT, "confirmed")
    expect(store.current()).toBeNull()
  })

  it("current() and latestFailed() return the most recent record, not the oldest", async () => {
    const store = freshStore()
    const A = "0x" + "a1".repeat(20)
    const B = "0x" + "b2".repeat(20)
    await store.upsert(A, {}, fallback({ tag: "older", startTime: 1000 }))
    await store.upsert(B, {}, fallback({ tag: "newer", startTime: 2000 }))
    expect(store.current()?.tag).toBe("newer")

    await store.close(A, "failed_taken")
    await store.close(B, "failed_terminal")
    expect(store.latestFailed()?.tag).toBe("newer")
  })

  it("current() and latestFailed() scope to a wallet's l2Address when one is passed", async () => {
    const store = freshStore()
    const A = "0x" + "a1".repeat(20)
    const B = "0x" + "b2".repeat(20)
    const WALLET_A = ("0x" + "0a".repeat(32)) as `0x${string}`
    const WALLET_B = ("0x" + "0b".repeat(32)) as `0x${string}`
    await store.upsert(A, {}, fallback({ tag: "a-tag", l2Address: WALLET_A, startTime: 1000 }))
    await store.upsert(B, {}, fallback({ tag: "b-tag", l2Address: WALLET_B, startTime: 2000 }))

    expect(store.current()?.tag).toBe("b-tag")
    expect(store.current(WALLET_A)?.tag).toBe("a-tag")
    expect(store.current(WALLET_A.toUpperCase())?.tag).toBe("a-tag")
    expect(store.current(("0x" + "0c".repeat(32)) as string)).toBeNull()

    await store.close(A, "failed_taken")
    expect(store.latestFailed(WALLET_A)?.tag).toBe("a-tag")
    expect(store.latestFailed(WALLET_B)).toBeNull()
  })

  it("funded is a non-terminal phase visible to current()", async () => {
    const store = freshStore()
    await store.upsert(ACCOUNT, {}, fallback({ phase: "funded" }))
    expect(store.current()?.phase).toBe("funded")
    expect(registrationUiState(store.current())).toBe("pending")
  })

  describe("terminal lifecycle", () => {
    it("a close stamps endTime and the terminal phase, keeping the record's identity", async () => {
      const store = freshStore()
      await store.upsert(ACCOUNT, {}, fallback())
      const closed = await store.close(ACCOUNT, "confirmed")

      expect(closed.endTime).toBeGreaterThan(0)
      expect(closed.phase).toBe("confirmed")
      expect(closed.tag).toBe("alice")
      expect(closed.sipaAddress).toBe(fallback().sipaAddress)
    })

    it("a failed_* close leaves the record discoverable through latestFailed()", async () => {
      const store = freshStore()
      await store.upsert(ACCOUNT, {}, fallback())
      const closed = await store.close(ACCOUNT, "failed_taken")

      expect(closed.phase).toBe("failed_taken")
      expect(store.latestFailed()?.phase).toBe("failed_taken")
    })

    it("a reclaim reopens the terminal record in place", async () => {
      const store = freshStore()
      await store.upsert(ACCOUNT, {}, fallback())
      await store.close(ACCOUNT, "failed_taken")

      const reopened = await store.upsert(ACCOUNT, { phase: "awaiting_deposit", tag: "fresh" })
      expect(reopened.phase).toBe("awaiting_deposit")
      expect(reopened.tag).toBe("fresh")
      expect(store.latestFailed()).toBeNull()
    })
  })

  it("strips the claim and FPC-setup keys a prior schema persisted", async () => {
    // Terminal records are never pruned, so a client that upgraded mid-registration would otherwise
    // keep both keys in storage forever — untyping them is not enough. `load()` alone has to clear
    // them at rest: a record that never mutates again is exactly the one holding the second copy.
    const adapter = new InMemoryStorageAdapter()
    const legacy = {
      ...fallback(),
      account: ACCOUNT,
      claim: { signature: "0x" + "cc".repeat(65), nonce: "1", deadline: "1700021600" },
      l2SetupComplete: true,
    }
    await adapter.setItem(STORAGE_KEY, JSON.stringify({ [ACCOUNT.toLowerCase()]: legacy }))

    const store = freshStore(adapter)
    await store.load()
    const loaded = store.get(ACCOUNT)!
    expect(loaded).not.toHaveProperty("claim")
    expect(loaded).not.toHaveProperty("l2SetupComplete")
    expect(loaded.tag).toBe("alice")

    const persisted = JSON.parse((await adapter.getItem(STORAGE_KEY))!) as Record<string, unknown>
    expect(persisted[ACCOUNT.toLowerCase()]).not.toHaveProperty("claim")
    expect(persisted[ACCOUNT.toLowerCase()]).not.toHaveProperty("l2SetupComplete")
  })

  it("leaves storage untouched when nothing needed normalizing", async () => {
    const adapter = new InMemoryStorageAdapter()
    await adapter.setItem(
      STORAGE_KEY,
      JSON.stringify({ [ACCOUNT.toLowerCase()]: { ...fallback(), account: ACCOUNT } }),
    )
    const writes = vi.spyOn(adapter, "setItem")

    await freshStore(adapter).load()
    expect(writes).not.toHaveBeenCalled()
  })

  describe("strict writes", () => {
    it("surfaces the adapter write error instead of swallowing it", async () => {
      const failing: IStorageAdapter = {
        getItem: async () => null,
        setItem: async () => {
          throw new Error("disk full")
        },
        removeItem: async () => {},
        clear: async () => {},
      }
      const store = freshStore(failing)
      await expect(store.upsert(ACCOUNT, {}, fallback())).rejects.toThrow("disk full")
    })

    it("leaves no trace of a rejected write — a later successful write cannot resurrect it", async () => {
      // The abort-before-spend guarantee: a failed pre-POST stamp must not linger in memory and
      // get committed by the next write, or the machine polls a hash that was never submitted.
      let failNext = false
      const backing = new InMemoryStorageAdapter()
      const flaky: IStorageAdapter = {
        getItem: (k) => backing.getItem(k),
        setItem: async (k, v) => {
          if (failNext) throw new Error("transient")
          return backing.setItem(k, v)
        },
        removeItem: (k) => backing.removeItem(k),
        clear: () => backing.clear(),
      }
      const store = freshStore(flaky)
      await store.upsert(ACCOUNT, {}, fallback())

      failNext = true
      await expect(
        store.upsert(ACCOUNT, { fundingTxHash: ("0x" + "77".repeat(32)) as `0x${string}` }),
      ).rejects.toThrow("transient")

      failNext = false
      await store.upsert(ACCOUNT, { retries: 1 })
      const persisted = freshStore(flaky)
      await persisted.load()
      expect(persisted.get(ACCOUNT)?.fundingTxHash).toBeUndefined()
      expect(persisted.get(ACCOUNT)?.retries).toBe(1)
    })
  })
})

describe("registrationUiState", () => {
  const base = { ...fallback(), account: ACCOUNT } as PendingRegistrationRecord

  it("projects the phases to none / pending / failed", () => {
    expect(registrationUiState(null)).toBe("none")
    expect(registrationUiState({ ...base, phase: "confirmed" })).toBe("none")
    expect(registrationUiState({ ...base, phase: "awaiting_deposit" })).toBe("pending")
    expect(registrationUiState({ ...base, phase: "failed_taken" })).toBe("failed")
    expect(registrationUiState({ ...base, phase: "failed_terminal" })).toBe("failed")
  })

  it("escalates after repeated armed re-signs or too long pending", () => {
    expect(registrationUiState({ ...base, retries: ESCALATION_MAX_RETRIES })).toBe("escalated")
    const old = { ...base, startTime: Date.now() - ESCALATION_MAX_AGE_MS - 1 }
    expect(registrationUiState(old)).toBe("escalated")
  })

  it("isRegistrationEscalated matches the projection bounds", () => {
    const now = Date.now()
    expect(isRegistrationEscalated({ retries: 0, startTime: now }, now)).toBe(false)
    expect(isRegistrationEscalated({ retries: ESCALATION_MAX_RETRIES, startTime: now }, now)).toBe(true)
    expect(
      isRegistrationEscalated({ retries: 0, startTime: now - ESCALATION_MAX_AGE_MS - 1 }, now),
    ).toBe(true)
  })
})
