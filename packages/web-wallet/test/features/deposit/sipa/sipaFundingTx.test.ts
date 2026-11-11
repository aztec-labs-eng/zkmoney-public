import { describe, expect, it } from "vitest"
import { formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { depositWindowError } from "../../../../src/features/deposit/fundDeposit"

const TX_AMOUNT_CAP = 5166n * 10n ** 18n

/**
 * The gate every funding path runs through, including the desktop bridge. The bridge has no form of
 * its own, so this gate is all that stands between a browser-approved transfer and a stranded
 * deposit.
 */
describe("depositWindowError", () => {
  const CAP = formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS)
  const dai = (display: string) => parseUnits(display, 18)
  const FEE = dai("0.25")

  it("refuses a send at or below the quoted fee, naming the fee in the sent token", () => {
    const refusal = depositWindowError(FEE, FEE, 18, "USDC", TX_AMOUNT_CAP, 18)
    expect(refusal).toMatchObject({
      code: "deposit.belowFee",
      data: { fee: "0.25", symbol: "USDC" },
    })
    expect(depositWindowError(dai("0.24"), FEE, 18, "DAI", TX_AMOUNT_CAP, 18)?.code).toBe(
      "deposit.belowFee",
    )
  })

  it("measures a send to a 6-decimal row against that row's own cap", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.25")
    const cap = usdc("1000")
    expect(depositWindowError(usdc("1000") + fee, fee, 6, "USDC", cap, 6)).toBeUndefined()
    expect(depositWindowError(usdc("1000") + fee + 1n, fee, 6, "USDC", cap, 6)?.code).toBe(
      "deposit.overCap",
    )
  })

  it("measures a 6-decimal token swapped into an 18-decimal row in its own units", () => {
    const usdc = (display: string) => parseUnits(display, 6)
    const fee = usdc("0.25")
    expect(depositWindowError(usdc("100"), fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee, fee, 6, "USDC", TX_AMOUNT_CAP, 18)).toBeUndefined()
    expect(depositWindowError(usdc(CAP) + fee + 1n, fee, 6, "USDC", TX_AMOUNT_CAP, 18)?.code).toBe(
      "deposit.overCap",
    )
  })
})
