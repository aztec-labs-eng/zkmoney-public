import { beforeEach, describe, expect, it } from "vitest"
import {
  TokenStorage,
  TOKENS_LOCAL_STORAGE_KEY,
  type IStorageAdapter,
} from "../../src/index.js"

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

  raw(key: string): string | undefined {
    return this.store.get(key)
  }

  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const ADDR_A = "0x" + "a".repeat(64)
const ADDR_B = "0x" + "b".repeat(64)

const tokenA = {
  address: ADDR_A,
  name: "Token A",
  symbol: "TKA",
  decimals: 18,
}

const tokenB = {
  address: ADDR_B,
  name: "Token B",
  symbol: "TKB",
  decimals: 6,
  logo: "https://example.com/b.png",
}

const resetSingletons = () => {
  ;(TokenStorage as unknown as { instance: TokenStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorage()
  const tokens = TokenStorage.get(adapter)
  return { adapter, tokens }
}

describe("TokenStorage (flat per-network-removed shape)", () => {
  beforeEach(() => {
    resetSingletons()
  })

  describe("happy path", () => {
    it("addToken + getTokens round-trip", async () => {
      const { tokens } = setup()
      await tokens.addToken(tokenA)
      const result = await tokens.getTokens()
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(tokenA)
    })

    it("supports multiple tokens", async () => {
      const { tokens } = setup()
      await tokens.addToken(tokenA)
      await tokens.addToken(tokenB)
      const result = await tokens.getTokens()
      expect(result).toHaveLength(2)
      expect(result.map((t) => t.address).sort()).toEqual([ADDR_A, ADDR_B].sort())
    })

    it("re-adding the same address overwrites", async () => {
      const { tokens } = setup()
      await tokens.addToken(tokenA)
      await tokens.addToken({ ...tokenA, name: "Renamed" })
      const result = await tokens.getTokens()
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe("Renamed")
    })

    it("removeToken removes the token", async () => {
      const { tokens } = setup()
      await tokens.addToken(tokenA)
      await tokens.addToken(tokenB)
      await tokens.removeToken(ADDR_A)
      const result = await tokens.getTokens()
      expect(result).toHaveLength(1)
      expect(result[0]!.address).toBe(ADDR_B)
    })

    it("getTokens on a fresh adapter returns []", async () => {
      const { tokens } = setup()
      expect(await tokens.getTokens()).toEqual([])
    })

    it("addToken accepts a 0-decimals token", async () => {
      const { tokens } = setup()
      await tokens.addToken({ ...tokenA, decimals: 0 })
      expect((await tokens.getTokens())[0]?.decimals).toBe(0)
    })

    it("addToken rejects fractional decimals", async () => {
      const { tokens } = setup()
      await expect(tokens.addToken({ ...tokenA, decimals: 1.5 })).rejects.toThrow()
    })

    it("addToken rejects negative decimals", async () => {
      const { tokens } = setup()
      await expect(tokens.addToken({ ...tokenA, decimals: -1 })).rejects.toThrow()
    })

    it("addToken normalizes away duplicate persisted entries for the same address", async () => {
      // Seed two valid entries for the same tuple key (this can't happen via
      // addToken, but a manually persisted/migrated state could). After
      // addToken, getTokens() must return only the freshly added value, not
      // a stale later duplicate.
      const { tokens, adapter } = setup()
      const stale = { ...tokenA, name: "Stale" }
      const olderStale = { ...tokenA, name: "Older Stale" }
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([
          [ADDR_A, olderStale],
          [ADDR_A, stale],
        ]),
      )

      const fresh = { ...tokenA, name: "Fresh" }
      await tokens.addToken(fresh)

      const result = await tokens.getTokens()
      expect(result).toHaveLength(1)
      expect(result[0]?.name).toBe("Fresh")
    })
  })

  describe("clear", () => {
    it("removes all tokens", async () => {
      const { tokens, adapter } = setup()
      await tokens.addToken(tokenA)
      await tokens.clear()
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })
  })

  describe("validate-and-clear", () => {
    it("clears the key when persisted JSON is null", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(TOKENS_LOCAL_STORAGE_KEY, "null")
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when shape is the old per-network record", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify({ testnet: [[ADDR_A, tokenA]] }),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when JSON is corrupt", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(TOKENS_LOCAL_STORAGE_KEY, "{not-json")
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when an entry is not a 2-tuple", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(TOKENS_LOCAL_STORAGE_KEY, JSON.stringify([[ADDR_A]]))
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when token is missing required fields", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_A, { address: ADDR_A, symbol: "TKA" }]]),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when decimals is a string", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_A, { ...tokenA, decimals: "18" }]]),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when decimals is negative", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_A, { ...tokenA, decimals: -1 }]]),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when decimals is fractional", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_A, { ...tokenA, decimals: 1.5 }]]),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when tuple key does not match token.address", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_B, tokenA]]),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when logo is wrong type", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_A, { ...tokenA, logo: 42 }]]),
      )
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBeUndefined()
    })

    it("preserves an empty array as valid empty state", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(TOKENS_LOCAL_STORAGE_KEY, "[]")
      expect(await tokens.getTokens()).toEqual([])
      expect(adapter.raw(TOKENS_LOCAL_STORAGE_KEY)).toBe("[]")
    })

    it("hydrates a valid persisted shape", async () => {
      const { tokens, adapter } = setup()
      adapter.seed(
        TOKENS_LOCAL_STORAGE_KEY,
        JSON.stringify([[ADDR_A, tokenA]]),
      )
      const result = await tokens.getTokens()
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(tokenA)
    })

    it("hydrates multiple valid tokens with optional logo across a fresh singleton", async () => {
      const { tokens, adapter } = setup()
      await tokens.addToken(tokenA)
      await tokens.addToken(tokenB)

      // Reset the singleton but keep the same adapter — simulates a fresh app
      // start reading the previously-persisted data.
      resetSingletons()
      const fresh = TokenStorage.get(adapter)
      const result = await fresh.getTokens()
      expect(result.map((t) => t.address).sort()).toEqual([ADDR_A, ADDR_B].sort())
    })
  })
})
