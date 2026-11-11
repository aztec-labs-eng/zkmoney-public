// @vitest-environment node
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { coinFigure, displayDecimals } from "../../src/ui/coinDecimals"

/** The figure `coinFigure` shows for `amount` of a coin with `decimals`, and the symbol after it. */
const shown = (amount: string, decimals: number, symbol: string) => {
  const [figure, after, ...rest] = coinFigure(parseUnits(amount, decimals), decimals, symbol).split(
    " ",
  )
  expect(after).toBe(symbol)
  expect(rest).toEqual([])
  return figure
}

describe("displayDecimals", () => {
  it("shows ETH and BTC coins to 5 places, any case, and the rest to cents", () => {
    for (const s of ["ETH", "weth", "BTC", "WBTC", "cbBTC", "tBTC"])
      expect(displayDecimals(s)).toBe(5)
    for (const s of ["USDC", "DAI", "USDT", "SHIB"]) expect(displayDecimals(s)).toBe(2)
  })
})

describe("coinFigure", () => {
  it("groups a stablecoin to the cent, rounding half up", () => {
    expect(shown("2499.654", 6, "USDC")).toBe("2,499.65")
    expect(shown("2499.655", 6, "USDC")).toBe("2,499.66")
    expect(shown("2499.5", 6, "USDC")).toBe("2,499.50")
    expect(shown("2500", 18, "DAI")).toBe("2,500")
    expect(shown("0", 18, "DAI")).toBe("0")
  })

  it("shows a fine coin to 5 places, dropping trailing zeros", () => {
    expect(shown("0.0123456", 18, "ETH")).toBe("0.01235")
    expect(shown("1234.5", 8, "WBTC")).toBe("1,234.5")
    expect(shown("0", 18, "ETH")).toBe("0")
  })

  it("never shows dust as zero", () => {
    expect(shown("0.000001", 18, "ETH")).toBe("<0.00001")
    expect(shown("0.000005", 18, "ETH")).toBe("0.00001")
    expect(shown("0.001", 6, "USDC")).toBe("<0.01")
    expect(shown("0.005", 6, "USDC")).toBe("0.01")
  })

  it("keeps every digit past 2^53", () => {
    expect(shown("123456789012345678.12", 18, "DAI")).toBe("123,456,789,012,345,678.12")
  })

  it("shows a coin with fewer decimals than its display places exactly", () => {
    expect(shown("1.5", 1, "ETH")).toBe("1.5")
  })
})
