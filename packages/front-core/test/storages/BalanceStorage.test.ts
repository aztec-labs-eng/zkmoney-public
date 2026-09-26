import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  BalanceStorage,
  BALANCE_STORAGE_KEY,
  type IStorageAdapter,
} from "../../src/core/storages/index"

const RECORDS_KEY = "@obsidion/balances/records"

class InMemoryStorage implements IStorageAdapter {
  private store = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  // Test-only helpers
  raw(key: string): string | undefined {
    return this.store.get(key)
  }

  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const SCOPE = "sandbox:0xacct"
const SCOPE_B = "testnet:0xacct"
const TOKEN_A = "0x" + "a".repeat(64)
const TOKEN_B = "0x" + "b".repeat(64)

const resetSingletons = () => {
  ;(BalanceStorage as unknown as { instance: BalanceStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorage()
  const balances = BalanceStorage.get(adapter)
  return { adapter, balances }
}

describe("BalanceStorage (record store)", () => {
  beforeEach(() => {
    resetSingletons()
  })

  describe("happy path", () => {
    it("round-trips a balance via updateBalance + getBalance", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBe(100n)
    })

    it("returns undefined for unknown token on a fresh adapter", async () => {
      const { balances } = setup()
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBeUndefined()
    })

    it("supports multiple tokens", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      await balances.updateBalance(SCOPE, TOKEN_B, 200n)
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBe(100n)
      expect(await balances.getBalance(SCOPE, TOKEN_B)).toBe(200n)
    })

    it("overwrites on repeated updateBalance", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      await balances.updateBalance(SCOPE, TOKEN_A, 250n)
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBe(250n)
    })

    it("isolates the same token across scopes (network/account)", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      expect(await balances.getBalance(SCOPE_B, TOKEN_A)).toBeUndefined()
      await balances.updateBalance(SCOPE_B, TOKEN_A, 900n)
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBe(100n)
    })
  })

  describe("CachedRecordSource surface", () => {
    it("lists persisted records after load", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      expect(balances.list()).toEqual([
        { scope: SCOPE, tokenAddress: TOKEN_A, balance: "100", updatedAt: expect.any(Number) },
      ])
    })

    it("stamps the anchor the balance was read at, so a session can tell live from cached", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n, 42)
      expect(balances.list()[0]).toMatchObject({ balance: "100", anchorBlock: 42 })
      expect(balances.list()[0].updatedAt).toBeLessThanOrEqual(Date.now())
    })

    it("ignores a write read at an older anchor than the stored one", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n, 50)
      await balances.updateBalance(SCOPE, TOKEN_A, 40n, 42)
      expect(balances.list()[0]).toMatchObject({ balance: "100", anchorBlock: 50 })
      await balances.updateBalance(SCOPE, TOKEN_A, 120n, 50)
      await balances.updateBalance(SCOPE, TOKEN_A, 130n)
      expect(balances.list()[0]).toMatchObject({ balance: "130" })
    })

    it("notifies list subscribers on every balance write", async () => {
      const { balances } = setup()
      const listener = vi.fn()
      balances.onListChanged(listener)
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      expect(listener).toHaveBeenCalledWith([
        { scope: SCOPE, tokenAddress: TOKEN_A, balance: "100", updatedAt: expect.any(Number) },
      ])
    })

    it("survives a fresh instance over the same adapter (persistence round-trip)", async () => {
      const { balances, adapter } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 42n)
      resetSingletons()
      const revived = BalanceStorage.get(adapter)
      await revived.load()
      expect(revived.list()).toEqual([
        { scope: SCOPE, tokenAddress: TOKEN_A, balance: "42", updatedAt: expect.any(Number) },
      ])
    })
  })

  describe("clear", () => {
    it("removes all balances", async () => {
      const { balances } = setup()
      await balances.updateBalance(SCOPE, TOKEN_A, 100n)
      await balances.updateBalance(SCOPE, TOKEN_B, 200n)
      await balances.clear()
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBeUndefined()
      expect(balances.list()).toEqual([])
    })

    it("also removes an unconsumed legacy blob", async () => {
      const { balances, adapter } = setup()
      adapter.seed(BALANCE_STORAGE_KEY, JSON.stringify({ [`${SCOPE}:${TOKEN_A}`]: "42" }))
      await balances.clear()
      expect(adapter.raw(BALANCE_STORAGE_KEY)).toBeUndefined()
    })
  })

  describe("legacy blob migration", () => {
    it("migrates the flat blob into records and consumes the legacy key", async () => {
      const { balances, adapter } = setup()
      adapter.seed(
        BALANCE_STORAGE_KEY,
        JSON.stringify({ [`${SCOPE}:${TOKEN_A}`]: "42", [`${SCOPE_B}:${TOKEN_B}`]: "7" }),
      )
      await balances.load()
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBe(42n)
      expect(await balances.getBalance(SCOPE_B, TOKEN_B)).toBe(7n)
      expect(adapter.raw(BALANCE_STORAGE_KEY)).toBeUndefined()
    })

    it("a migrated entry never clobbers a record the new store already holds", async () => {
      const { adapter } = setup()
      adapter.seed(
        RECORDS_KEY,
        JSON.stringify({
          [`${SCOPE}:${TOKEN_A}`]: { scope: SCOPE, tokenAddress: TOKEN_A, balance: "999" },
        }),
      )
      adapter.seed(BALANCE_STORAGE_KEY, JSON.stringify({ [`${SCOPE}:${TOKEN_A}`]: "1" }))
      resetSingletons()
      const balances = BalanceStorage.get(adapter)
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBe(999n)
    })

    it("skips non-BigInt and non-string legacy values instead of dropping the rest", async () => {
      const { balances, adapter } = setup()
      adapter.seed(
        BALANCE_STORAGE_KEY,
        JSON.stringify({
          [`${SCOPE}:${TOKEN_A}`]: "1.5",
          [`${SCOPE}:${TOKEN_B}`]: 100,
          [`${SCOPE_B}:${TOKEN_A}`]: "42",
        }),
      )
      await balances.load()
      expect(await balances.getBalance(SCOPE, TOKEN_A)).toBeUndefined()
      expect(await balances.getBalance(SCOPE, TOKEN_B)).toBeUndefined()
      expect(await balances.getBalance(SCOPE_B, TOKEN_A)).toBe(42n)
      expect(adapter.raw(BALANCE_STORAGE_KEY)).toBeUndefined()
    })

    it("consumes a corrupt legacy blob without throwing", async () => {
      const { balances, adapter } = setup()
      adapter.seed(BALANCE_STORAGE_KEY, "{not-json")
      await balances.load()
      expect(balances.list()).toEqual([])
      expect(adapter.raw(BALANCE_STORAGE_KEY)).toBeUndefined()
    })

    it("migrates only once per process (load is memoized)", async () => {
      const { balances, adapter } = setup()
      adapter.seed(BALANCE_STORAGE_KEY, JSON.stringify({ [`${SCOPE}:${TOKEN_A}`]: "42" }))
      await balances.load()
      // A blob written after migration (e.g. by an old tab) is not re-read this session.
      adapter.seed(BALANCE_STORAGE_KEY, JSON.stringify({ [`${SCOPE}:${TOKEN_B}`]: "7" }))
      await balances.load()
      expect(await balances.getBalance(SCOPE, TOKEN_B)).toBeUndefined()
    })
  })
})
