import { describe, expect, it } from "vitest"
import type { HoldingPrice } from "@obsidion/front-core"
import { fmt } from "../../../src/lib/fmt"
import { moveSummary } from "../../../src/features/savings/moveSummary"
import copy from "../../../src/features/savings/moveSummary.copy"

describe("moveSummary", () => {
  const ONE = 10n ** 18n
  const at = (sharePrice: bigint, assetDecimals = 18): HoldingPrice => ({
    sharePrice,
    shareDecimals: 18,
    assetDecimals,
    readAt: 0,
  })
  const priced = (value: string, to: string) => fmt(copy.priced, { value, to })
  it("names a move by its dollar value and route, pricing a move out's shares at the vault", () => {
    expect(moveSummary("in", 25n * ONE)).toBe(priced("$25.00", copy.savings))
    expect(moveSummary("in", 25n * ONE + 5n * 10n ** 17n)).toBe(priced("$25.50", copy.savings))
    // A move out of 255.178858708317111766 shares at a 1.07 share price is $273.04, not the share count.
    const price = (107n * ONE) / 100n
    expect(moveSummary("out", 255_178858708317111766n, at(price))).toBe(
      priced("$273.04", copy.main),
    )
    // MAX out burns every share: the summary is the position's value.
    const shares = 700n * ONE
    expect(moveSummary("out", shares, at(714287899390558444472n / 700n))).toBe(
      priced("$714.28", copy.main),
    )
    expect(moveSummary("out", shares)).toBe(fmt(copy.unpriced, { to: copy.main }))
  })

  it("prices a move out of a vault of a 6-decimal asset in dollars", () => {
    // 760 shares at 1.05 USDC each.
    expect(moveSummary("out", 760n * ONE, at(1_050_000n, 6))).toBe(priced("$798.00", copy.main))
  })
})
