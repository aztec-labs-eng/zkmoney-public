import { describe, expect, it } from "vitest"
import { isWalletTokenSymbol, selectWalletAsset } from "../../src/utils/tokenIdentity"
import type { Asset } from "../../src/types/tokens"

const asset = (over: Partial<Asset>): Asset => ({
  name: "DAI",
  symbol: "DAI",
  address: "0xaaa",
  decimals: 18,
  balance: 0,
  publicBalance: 0,
  privateBalance: 0,
  balanceAtomic: 0n,
  price: 1,
  change: 0,
  changeAmount: 0,
  logo: "dai.png",
  ...over,
})

describe("isWalletTokenSymbol", () => {
  it("accepts the wallet's token symbol", () => {
    expect(isWalletTokenSymbol("DAI")).toBe(true)
  })

  it("is case-insensitive, matching the existing asset-key scan", () => {
    expect(isWalletTokenSymbol("dai")).toBe(true)
    expect(isWalletTokenSymbol("Dai")).toBe(true)
  })

  it("rejects symbols that are not this token", () => {
    expect(isWalletTokenSymbol("BOLD")).toBe(false)
    expect(isWalletTokenSymbol("ETH")).toBe(false)
    expect(isWalletTokenSymbol("??")).toBe(false)
    expect(isWalletTokenSymbol("")).toBe(false)
  })
})

describe("selectWalletAsset", () => {
  it("returns the row at the active address even when another row shares its symbol", () => {
    // The property that survives canonicalization: once display fields are
    // canonical, symbol comparison stops telling the two rows apart.
    const stale = asset({ address: "0xstale", balance: 999 })
    const live = asset({ address: "0xlive", balance: 5 })

    expect(selectWalletAsset([stale, live], "0xlive")).toBe(live)
  })

  it("matches the active address case-insensitively", () => {
    const live = asset({ address: "0xAbC" })
    expect(selectWalletAsset([live], "0xabc")).toBe(live)
  })

  it("returns the sole candidate when no active address is known", () => {
    const live = asset({ address: "0xlive" })
    expect(selectWalletAsset([live], null)).toBe(live)
  })

  it("returns null rather than guessing when the cache is ambiguous", () => {
    // Cold start: balances hydrate before the wallet knows its token address. Two
    // canonical rows are indistinguishable, and picking one can surface a stale
    // balance indefinitely if initialization then fails.
    const stale = asset({ address: "0xstale", balance: 999 })
    const live = asset({ address: "0xlive", balance: 5 })

    expect(selectWalletAsset([stale, live], null)).toBeNull()
  })

  it("ignores assets that are not this token", () => {
    const eth = asset({ symbol: "ETH", address: "0xeth" })
    const live = asset({ address: "0xlive" })

    expect(selectWalletAsset([eth, live], null)).toBe(live)
    expect(selectWalletAsset([eth], null)).toBeNull()
  })

  it("returns null for an empty or missing list", () => {
    expect(selectWalletAsset([], "0xlive")).toBeNull()
    expect(selectWalletAsset(null, "0xlive")).toBeNull()
  })
})
