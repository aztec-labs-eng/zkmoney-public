// @vitest-environment node
/** The Savings figure: its cents, the digits that tick beneath them, and its carry at the rate. */
import { describe, expect, it } from "vitest"
import type { SavingsPosition } from "@obsidion/front-core"
import {
  selectSavingsEstimate,
  splitTicking,
  tickingDigits,
} from "../../../src/features/savings/savingsEstimate"
import { usdAtomicFloor } from "../../../src/ui/format"

const WAD = 10n ** 18n
const T0 = 1_700_000_000_000

describe("splitTicking", () => {
  it("splits a value into the cents figure and the digits that tick beneath it, flooring", () => {
    expect(splitTicking(1000_001183_000000000000n)).toEqual({ whole: "$1,000.00", ticking: "1183" })
    expect(splitTicking(1000_009999_999999999999n)).toEqual({ whole: "$1,000.00", ticking: "9999" })
    expect(splitTicking(25_000_150000_000000000000n)).toEqual({
      whole: "$25,000.15",
      ticking: "0000",
    })
    expect(splitTicking(-5n * WAD)).toEqual({ whole: "$0.00", ticking: "0000000" })
  })

  it("ticks more digits under a smaller value, so the last one turns about once a second", () => {
    // 3% APY grows a value by 9.5e-10 of itself a second: the last digit turns within ~1.1 s.
    expect(tickingDigits(1000n * WAD)).toBe(4)
    expect(tickingDigits(999n * WAD)).toBe(5)
    expect(tickingDigits(100n * WAD)).toBe(5)
    expect(tickingDigits(10n * WAD)).toBe(6)
    expect(tickingDigits(1n * WAD)).toBe(7)
    expect(tickingDigits(WAD / 2n)).toBe(7)
    expect(tickingDigits(0n)).toBe(7)
    for (const dollars of [1n, 10n, 100n, 1000n, 10_000n]) {
      const unit = 10 ** -(2 + tickingDigits(dollars * WAD))
      const perSecond = (Number(dollars) * 0.03) / 31_536_000
      expect(unit / perSecond).toBeLessThanOrEqual(1.1)
    }
    expect(splitTicking(493_150000_000000000000n)).toEqual({ whole: "$493.15", ticking: "00000" })
    expect(splitTicking(10_123456_789000000000n)).toEqual({ whole: "$10.12", ticking: "345678" })
    expect(splitTicking(1_000000_012000000000n)).toEqual({ whole: "$1.00", ticking: "0000012" })
    expect(splitTicking(0n)).toEqual({ whole: "$0.00", ticking: "0000000" })
  })

  it("truncates every Savings figure to cents the way the ticking balance does", () => {
    expect(usdAtomicFloor(254_715245n * 10n ** 12n)).toBe("$254.71")
    expect(usdAtomicFloor(1234_567n * 10n ** 15n)).toBe("$1,234.56")
    expect(usdAtomicFloor(-15n * 10n ** 17n)).toBe("-$1.50")
    expect(usdAtomicFloor(-4n * 10n ** 15n)).toBe("$0.00")
  })
})

describe("selectSavingsEstimate", () => {
  const position: SavingsPosition = {
    shares: 900n * WAD,
    value: 1000n * WAD,
    sharePrice: WAD,
    apy: 0.055,
    readAt: T0,
  }
  const at = (ms: number) => selectSavingsEstimate(position, true, T0 + ms)

  it("carries the value forward at the rate while funded with a rate", () => {
    expect(at(0)).toEqual({ value: 1000n * WAD, ticking: true })
    expect(at(1_200).value!).toBeGreaterThan(1000n * WAD)
    expect(at(2_400).value!).toBeGreaterThan(at(1_200).value!)
  })

  it("reads plain while off, unfunded or without a rate, and unknown without a position", () => {
    expect(selectSavingsEstimate(position, false, T0 + 1_200)).toEqual({
      value: 1000n * WAD,
      ticking: false,
    })
    const unfunded = { ...position, shares: 0n, value: 0n }
    expect(selectSavingsEstimate(unfunded, true, T0 + 1_200)).toEqual({ value: 0n, ticking: false })
    const unrated = { ...position, apy: undefined }
    expect(selectSavingsEstimate(unrated, true, T0)).toEqual({ value: 1000n * WAD, ticking: false })
    expect(selectSavingsEstimate(null, true, T0)).toEqual({ value: undefined, ticking: false })
  })
})
