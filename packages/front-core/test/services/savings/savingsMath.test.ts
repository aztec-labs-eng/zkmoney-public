import { describe, expect, it } from "vitest"
import {
  SHARE,
  projectSavings,
  projectSavingsMonthly,
  projectValueAtomic,
  savingsPaybackYears,
  savingsValue,
} from "../../../src/core/services/savings/savingsMath"

/** 5.5% and 4.5% a year, at `RATE_SCALE`. */
const RATE = 55n * 10n ** 15n
const LOW_RATE = 45n * 10n ** 15n

describe("savingsValue", () => {
  it("prices shares at the vault's assets per share", () => {
    const price = (107n * SHARE) / 100n
    expect(savingsValue((232492n * SHARE) / 10000n, price)).toBe((24876644n * SHARE) / 1000000n)
    expect(savingsValue(0n, price)).toBe(0n)
    expect(savingsValue(5n * SHARE, SHARE)).toBe(5n * SHARE)
  })
})

describe("projectValueAtomic", () => {
  it("carries a value forward at the rate, and leaves it alone with no time, no value or a zero rate", () => {
    const YEAR = 365 * 24 * 3600 * 1000
    const value = 1000n * SHARE
    const readAt = 1_700_000_000_000
    const later = projectValueAtomic(value, readAt, readAt + YEAR, RATE)
    expect(Number(later) / 1e18).toBeCloseTo(1055, 6)
    expect(projectValueAtomic(value, readAt, readAt + 1000, RATE)).toBeGreaterThan(value)
    expect(projectValueAtomic(value, readAt, readAt, RATE)).toBe(value)
    expect(projectValueAtomic(value, readAt, readAt - 1000, RATE)).toBe(value)
    expect(projectValueAtomic(0n, readAt, readAt + YEAR, RATE)).toBe(0n)
    expect(projectValueAtomic(value, readAt, readAt + YEAR, 0n)).toBe(value)
  })
})

describe("projectSavingsMonthly", () => {
  it("steps a month at a time, and its twelfth month is the first year", () => {
    const months = projectSavingsMonthly(500, 50, 12, RATE)
    const [year] = projectSavings(500, 50, 1, RATE)
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
    expect(projectSavingsMonthly(100, 0, 3, 0n)).toEqual([
      { month: 1, added: 100, earned: 0, balance: 100 },
      { month: 2, added: 100, earned: 0, balance: 100 },
      { month: 3, added: 100, earned: 0, balance: 100 },
    ])
  })
})

describe("savingsPaybackYears", () => {
  it("solves the years until the net earns the fee back at the rate", () => {
    // $100 earning back $5.10 at 4.5%: a shade over a year.
    const years = savingsPaybackYears(100n * SHARE, (510n * SHARE) / 100n, LOW_RATE)
    expect(100 * ((1 + 0.045) ** years - 1)).toBeCloseTo(5.1, 9)
    expect(years).toBeGreaterThan(1)
    expect(years * 12).toBeCloseTo(13.6, 0)
    expect(savingsPaybackYears(1000n * SHARE, 3n * SHARE, RATE)).toBeLessThan(0.1)
    expect(savingsPaybackYears(100n * SHARE, 0n, LOW_RATE)).toBe(0)
    expect(savingsPaybackYears(100n * SHARE, SHARE, 0n)).toBe(Infinity)
    expect(savingsPaybackYears(0n, SHARE, LOW_RATE)).toBe(Infinity)
  })
})

describe("projectSavings", () => {
  it("adds the monthly top-up and compounds the balance, one row per year", () => {
    const rows = projectSavings(500, 50, 5, RATE)
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
    const [row] = projectSavings(100, 10, 1, 0n)
    expect(row).toEqual({ year: 1, added: 220, earned: 0, balance: 220 })
  })
})
