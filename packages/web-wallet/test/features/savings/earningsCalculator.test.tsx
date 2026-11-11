// @vitest-environment node
/** The calculator's figures: the start amount, the typed rate, and the steps and bars it shows. */
import { describe, expect, it } from "vitest"
import {
  barsThatFit,
  calculatorStart,
  calculatorSteps,
  groupSteps,
  parseApyPercent,
} from "../../../src/features/savings/EarningsCalculator"

describe("EarningsCalculator", () => {
  it("reads a typed rate leniently, clamped to 0–100%", () => {
    // Lenient: a percent sign, a comma, junk; and clamped to 0–100.
    expect(parseApyPercent("3.8%")).toBe(0.038)
    expect(parseApyPercent("3,8")).toBe(0.038)
    expect(parseApyPercent("abc")).toBe(0)
    expect(parseApyPercent("")).toBe(0)
    expect(parseApyPercent("-4")).toBe(0)
    expect(parseApyPercent("250%")).toBe(1)
  })

  it("starts from the Savings balance to the cent, else Main's DAI, else the default", () => {
    const ONE = 10n ** 18n
    expect(calculatorStart({ savings: 714287899390558444472n, main: 50n * ONE })).toBe(714.28)
    // Dust or no Savings: Main's DAI, the same way.
    expect(calculatorStart({ savings: ONE / 2n, main: 1284_5n * 10n ** 17n })).toBe(1284.5)
    expect(calculatorStart({ savings: 0n, main: 50n * ONE + 999n })).toBe(50)
    // Dust everywhere, or nothing known yet: today's default.
    expect(calculatorStart({ savings: ONE / 2n, main: ONE - 1n })).toBe(500)
    expect(calculatorStart({})).toBe(500)
    expect(calculatorStart()).toBe(500)
  })

  it("groups steps to the bars the width holds, each group ending at its last step and the last at the horizon", () => {
    const rows = (years: number) =>
      Array.from({ length: years }, (_, i) => ({
        year: i + 1,
        added: 0,
        earned: 0,
        balance: i + 1,
      }))
    const ends = (years: number, maxBars: number) =>
      groupSteps(rows(years), maxBars).map((r) => r.year)
    expect(ends(10, 5)).toEqual([2, 4, 6, 8, 10])
    expect(ends(10, 9)).toEqual([2, 4, 6, 8, 10])
    expect(ends(10, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(ends(10, 4)).toEqual([4, 8, 10])
    expect(ends(10, 1)).toEqual([10])
    expect(ends(7, 2)).toEqual([4, 7])
    expect(ends(5, 5)).toEqual([1, 2, 3, 4, 5])
    expect(ends(1, 5)).toEqual([1])
    for (const [years, maxBars] of [
      [10, 5],
      [10, 3],
      [10, 2],
      [7, 2],
    ] as const) {
      expect(ends(years, maxBars).length).toBeLessThanOrEqual(maxBars)
      expect(ends(years, maxBars).at(-1)).toBe(years)
    }
    // A 342 px chart (a 390 px screen minus the sheet's padding) holds five bars; a 576 px desktop sheet nine.
    expect(barsThatFit(342)).toBe(5)
    expect(barsThatFit(327)).toBe(5)
    expect(barsThatFit(576)).toBe(9)
    expect(barsThatFit(0)).toBe(1)
    // Months need only their three letters: a 342 px chart holds nine, a 576 px desktop sheet twelve.
    expect(barsThatFit(342, 28)).toBe(9)
    expect(barsThatFit(576, 28)).toBe(16)
  })

  it("breaks one year into months named from next month, whose twelfth is the year's figure", () => {
    const NOV_2026 = Date.UTC(2026, 10, 15)
    const months = calculatorSteps(500, 50, 1, 0.055, NOV_2026)
    expect(months.map((m) => m.label)).toEqual([
      "Dec",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
    ])
    const [year] = calculatorSteps(500, 50, 5, 0.055, NOV_2026)
    expect(year.label).toBe("Year 1")
    expect(months[11].balance).toBe(year.balance)
    expect(months[11].added).toBe(year.added)
    expect(months[5].balance).toBeGreaterThan(months[4].balance)
    expect(calculatorSteps(500, 50, 5, 0.055, NOV_2026).map((s) => s.label)).toEqual([
      "Year 1",
      "Year 2",
      "Year 3",
      "Year 4",
      "Year 5",
    ])
  })
})
