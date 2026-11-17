// @vitest-environment node
/** The Savings figure: its cents, the digits that tick beneath them, and its carry at the rate. */
import { describe, expect, it } from "vitest"
import { RATE_SCALE, type HoldingLedger, type HoldingLine } from "@obsidion/front-core"
import {
  selectSavingsEstimate,
  splitTicking,
  tickingDigits,
} from "../../../src/features/savings/savingsEstimate"
import type {
  SavingsLine,
  SavingsLineFigures,
  SavingsPosition,
} from "../../../src/features/savings/savingsLine"
import { usdAtomicFloor } from "../../../src/ui/format"

const WAD = 10n ** 18n
const NO_READS: ReadonlyMap<string, number> = new Map()
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
    rate: (55n * RATE_SCALE) / 1000n,
    readAt: T0,
    shareDecimals: 18,
    assetDecimals: 18,
  }
  /** The 900 shares went in for 950. */
  const ledger: HoldingLedger = { basis: 950n * WAD, counted: 1, shares: 900n * WAD, excluded: [] }
  const line = (id: string, held: SavingsPosition | null = position): SavingsLineFigures => ({
    line: { id } as HoldingLine,
    ...(held ? { shares: held.shares } : {}),
    position: held,
    ledger: held ? { ...ledger, shares: held.shares } : { ...ledger, counted: 0, shares: 0n },
  })
  const one = (held: SavingsPosition | null = position): SavingsLine => ({
    lines: [line("sky", held)],
    hydrated: true,
    sharesReadAt: NO_READS,
  })
  const at = (ms: number, savings = one()) => selectSavingsEstimate(savings, true, T0 + ms)

  it("carries the value forward at the rate while funded with a rate, and Earned with it", () => {
    expect(at(0)).toEqual({ value: 1000n * WAD, earned: 50n * WAD, ticking: true })
    expect(at(1_200).value!).toBeGreaterThan(1000n * WAD)
    expect(at(2_400).value!).toBeGreaterThan(at(1_200).value!)
    expect(at(1_200).earned).toBe(at(1_200).value! - 950n * WAD)
  })

  it("reads plain while off, unfunded or without a rate, and unknown without a position", () => {
    expect(selectSavingsEstimate(one(), false, T0 + 1_200)).toMatchObject({
      value: 1000n * WAD,
      ticking: false,
    })
    const unfunded = { ...position, shares: 0n, value: 0n }
    expect(at(1_200, one(unfunded))).toMatchObject({ value: 0n, ticking: false })
    const { rate: _, ...unrated } = position
    expect(at(1_200, one(unrated))).toMatchObject({ value: 1000n * WAD, ticking: false })
    expect(at(0, one(null))).toEqual({ value: undefined, earned: undefined, ticking: false })
  })

  it("carries each line at its own rate, in dollars, and leaves a line without one as read", () => {
    const { rate: _, ...unrated } = position
    // 500 of a six-decimal asset at twice the rate.
    const usdc = {
      ...position,
      value: 500n * 10n ** 6n,
      assetDecimals: 6,
      rate: position.rate! * 2n,
    }
    const savings = {
      lines: [line("flat", unrated), line("usdc", usdc)],
      hydrated: true,
      sharesReadAt: NO_READS,
    }
    expect(at(0, savings).value).toBe(1500n * WAD)
    const later = at(1_200, savings).value!
    const alone = at(1_200, { lines: [line("usdc", usdc)], hydrated: true, sharesReadAt: NO_READS })
      .value!
    expect(alone).toBeGreaterThan(500n * WAD)
    expect(later).toBe(1000n * WAD + alone)
  })

  it("stays still while the total is unknown, though a line could tick", () => {
    const unread: SavingsLine = {
      lines: [line("sky"), line("vault", null)],
      hydrated: false,
      sharesReadAt: NO_READS,
    }
    expect(at(1_200, unread)).toEqual({ value: undefined, earned: undefined, ticking: false })
  })
})
