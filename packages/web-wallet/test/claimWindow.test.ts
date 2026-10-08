import { describe, expect, it } from "vitest"
import {
  canCancelAt,
  claimWaitSeconds,
  secondsToOpeningBlock,
  formatClaimCountdown,
  withExpiry,
} from "../src/features/paylink/claimWindow"
import type { PaymentLink } from "../src/features/paylink/types"

describe("withExpiry", () => {
  const link = (over: Partial<PaymentLink> = {}): PaymentLink => ({
    url: "",
    fragment: "",
    flavor: "direct",
    status: "unclaimed",
    claimableUntil: 100,
    ...over,
  })
  const status = (l: PaymentLink, now?: number) => withExpiry(l, now).status

  it("is open through until_claimable and while the tip or window is unknown", () => {
    expect(status(link(), 100)).toBe("unclaimed")
    expect(status(link(), 101)).toBe("expired")
    expect(status(link())).toBe("unclaimed")
    expect(status(link({ claimableUntil: undefined }), 101)).toBe("unclaimed")
  })

  it("leaves a spent link spent", () => {
    expect(status(link({ status: "claimed" }), 101)).toBe("claimed")
  })
})

describe("claimWaitSeconds", () => {
  it("is unknown until both timestamps are known", () => {
    expect(claimWaitSeconds(undefined, 100)).toBeUndefined()
    expect(claimWaitSeconds(100, undefined)).toBeUndefined()
    expect(claimWaitSeconds(undefined, undefined)).toBeUndefined()
  })

  it("counts down to from_claimable plus the proving margin, then is 0", () => {
    expect(claimWaitSeconds(100, 99)).toBe(31)
    expect(claimWaitSeconds(100, 129)).toBe(1)
    expect(claimWaitSeconds(100, 130)).toBe(0)
    expect(claimWaitSeconds(100, 131)).toBe(0)
  })
})

describe("secondsToOpeningBlock", () => {
  // Testnet as sampled: 72s slots, a block landing 28s before its own timestamp.
  const grid = { genesis: 1_783_773_972, slotDuration: 72 }
  const slot = (k: number) => grid.genesis + k * 72

  it("counts to the landing of the first block at or after the target", () => {
    // Target mid-slot: slot k+2 opens it, landing 28s before its timestamp.
    expect(secondsToOpeningBlock(slot(10) + 100, slot(10), grid, 28)).toBe(144 - 28)
    // Target exactly on a boundary: that slot's block opens it.
    expect(secondsToOpeningBlock(slot(12), slot(10), grid, 28)).toBe(144 - 28)
  })

  it("is at most zero once the opening block is due", () => {
    expect(secondsToOpeningBlock(slot(11), slot(11) - 28, grid, 28)).toBe(0)
    expect(secondsToOpeningBlock(slot(11), slot(11), grid, 28)).toBeLessThan(0)
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
