import { describe, expect, it } from "vitest"
import {
  canCancelAt,
  formatClaimCountdown,
  isPaylinkNotYetClaimable,
} from "../src/features/paylink/claimWindow"

describe("isPaylinkNotYetClaimable", () => {
  it("is false until both timestamps are known", () => {
    expect(isPaylinkNotYetClaimable(undefined, 100)).toBe(false)
    expect(isPaylinkNotYetClaimable(100, undefined)).toBe(false)
    expect(isPaylinkNotYetClaimable(undefined, undefined)).toBe(false)
  })

  it("is true until from_claimable plus the proving margin, false from there", () => {
    expect(isPaylinkNotYetClaimable(100, 99)).toBe(true)
    expect(isPaylinkNotYetClaimable(100, 100)).toBe(true)
    expect(isPaylinkNotYetClaimable(100, 129)).toBe(true)
    expect(isPaylinkNotYetClaimable(100, 130)).toBe(false)
    expect(isPaylinkNotYetClaimable(100, 131)).toBe(false)
  })
})

describe("canCancelAt", () => {
  it("closes the cancel offer a proving margin before from_claimable", () => {
    expect(canCancelAt(1000, 969)).toBe(true)
    expect(canCancelAt(1000, 970)).toBe(false)
    expect(canCancelAt(1000, 1000)).toBe(false)
  })
})

describe("formatClaimCountdown", () => {
  it("renders m:ss under an hour", () => {
    expect(formatClaimCountdown(0)).toBe("0:00")
    expect(formatClaimCountdown(5)).toBe("0:05")
    expect(formatClaimCountdown(100)).toBe("1:40")
  })

  it("renders h:mm:ss once an hour has elapsed", () => {
    expect(formatClaimCountdown(3661)).toBe("1:01:01")
  })

  it("clamps negative remaining to zero", () => {
    expect(formatClaimCountdown(-12)).toBe("0:00")
  })
})
