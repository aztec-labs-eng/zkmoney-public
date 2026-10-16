import { describe, expect, it } from "vitest"
import {
  SHARE,
  apyFromSsr,
  projectSavings,
  projectSavingsMonthly,
  projectValueAtomic,
  savingsPaybackYears,
  savingsValue,
} from "../../../src/core/services/savings/savingsMath"

describe("apyFromSsr", () => {
  it("compounds Sky's per-second ray over a year", () => {
    // 1.000000001547125957863212448e27 is the ray Sky publishes for a 5% rate.
    expect(apyFromSsr(1000000001547125957863212448n)).toBeCloseTo(0.05, 4)
    expect(apyFromSsr(10n ** 27n)).toBe(0)
  })
})

describe("savingsValue", () => {
  it("prices shares at the vault's assets per share", () => {
    const price = (107n * SHARE) / 100n
    expect(savingsValue((232492n * SHARE) / 10000n, price)).toBe((24876644n * SHARE) / 1000000n)
    expect(savingsValue(0n, price)).toBe(0n)
    expect(savingsValue(5n * SHARE, SHARE)).toBe(5n * SHARE)
  })
})

describe("projectValueAtomic", () => {
  it("carries a value forward at the rate, and leaves it alone with no time, no value or no rate", () => {
    const YEAR = 365 * 24 * 3600 * 1000
    const value = 1000n * SHARE
    const readAt = 1_700_000_000_000
    const later = projectValueAtomic(value, readAt, readAt + YEAR, 0.055)
    expect(Number(later) / 1e18).toBeCloseTo(1055, 6)
    expect(projectValueAtomic(value, readAt, readAt + 1000, 0.055)).toBeGreaterThan(value)
    expect(projectValueAtomic(value, readAt, readAt, 0.055)).toBe(value)
    expect(projectValueAtomic(value, readAt, readAt - 1000, 0.055)).toBe(value)
    expect(projectValueAtomic(0n, readAt, readAt + YEAR, 0.055)).toBe(0n)
    expect(projectValueAtomic(value, readAt, readAt + YEAR, 0)).toBe(value)
    expect(projectValueAtomic(value, readAt, readAt + YEAR, Number.NaN)).toBe(value)
  })
})

describe("projectSavingsMonthly", () => {
  it("steps a month at a time, and its twelfth month is the first year", () => {
    const months = projectSavingsMonthly(500, 50, 12, 0.055)
    const [year] = projectSavings(500, 50, 1, 0.055)
    expect(months).toHaveLength(12)
    expect(months[11]).toEqual({
      month: 12,
      added: year.added,
      earned: year.earned,
      balance: year.balance,
    })
    // Each month compounds the last and adds the top-up.
    const rate = Math.expm1(Math.log1p(0.055) / 12)
    expect(months[0].balance).toBeCloseTo(500 * (1 + rate) + 50, 9)
    expect(months[1].balance).toBeCloseTo(months[0].balance * (1 + rate) + 50, 9)
    expect(months.map((m) => m.added)).toEqual(months.map((_, i) => 500 + 50 * (i + 1)))
    expect(projectSavingsMonthly(100, 0, 3, 0)).toEqual([
      { month: 1, added: 100, earned: 0, balance: 100 },
      { month: 2, added: 100, earned: 0, balance: 100 },
      { month: 3, added: 100, earned: 0, balance: 100 },
    ])
  })
})

describe("savingsPaybackYears", () => {
  it("solves the years until the net earns the fee back at the rate", () => {
    // $100 earning back $5.10 at 4.5%: a shade over a year.
    const years = savingsPaybackYears(100n * SHARE, (510n * SHARE) / 100n, 0.045)
    expect(100 * ((1 + 0.045) ** years - 1)).toBeCloseTo(5.1, 9)
    expect(years).toBeGreaterThan(1)
    expect(years * 12).toBeCloseTo(13.6, 0)
    expect(savingsPaybackYears(1000n * SHARE, 3n * SHARE, 0.055)).toBeLessThan(0.1)
    expect(savingsPaybackYears(100n * SHARE, 0n, 0.045)).toBe(0)
    expect(savingsPaybackYears(100n * SHARE, SHARE, 0)).toBe(Infinity)
    expect(savingsPaybackYears(100n * SHARE, SHARE, Number.NaN)).toBe(Infinity)
    expect(savingsPaybackYears(0n, SHARE, 0.045)).toBe(Infinity)
  })
})

describe("projectSavings", () => {
  it("adds the monthly top-up and compounds the balance, one row per year", () => {
    const rows = projectSavings(500, 50, 5, 0.055)
    expect(rows).toHaveLength(5)
    expect(rows[0].added).toBe(1100)
    expect(rows[4].added).toBe(3500)
    expect(rows[0].balance).toBeGreaterThan(1140)
    expect(rows[0].balance).toBeLessThan(1150)
    expect(rows[4].earned).toBeGreaterThan(570)
    expect(rows[4].earned).toBeLessThan(600)
    expect(rows[4].balance).toBeCloseTo(rows[4].added + rows[4].earned, 6)
  })

  it("grows nothing at a zero rate", () => {
    const [row] = projectSavings(100, 10, 1, 0)
    expect(row).toEqual({ year: 1, added: 220, earned: 0, balance: 220 })
  })
})
