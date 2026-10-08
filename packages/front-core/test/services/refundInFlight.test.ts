import { describe, expect, it, vi } from "vitest"
import {
  isRefundInFlight,
  onRefundInFlightChanged,
  refundInFlightVersion,
  withRefundInFlight,
} from "../../src/core/services/paylink/refundInFlight"

describe("withRefundInFlight", () => {
  it("holds the refund in flight while it runs and tells subscribers at each end", async () => {
    const listener = vi.fn()
    const off = onRefundInFlightChanged(listener)
    const before = refundInFlightVersion()
    let finish!: () => void
    const run = withRefundInFlight("0xsecret", () => new Promise<void>((r) => (finish = r)))
    expect(isRefundInFlight("0xsecret")).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    finish()
    await run
    expect(isRefundInFlight("0xsecret")).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(refundInFlightVersion()).toBe(before + 2)
    off()
  })

  it("clears the refund when it throws", async () => {
    await expect(
      withRefundInFlight("0xfails", () => Promise.reject(new Error("passkey closed"))),
    ).rejects.toThrow("passkey closed")
    expect(isRefundInFlight("0xfails")).toBe(false)
  })

  it("keeps the link in flight until overlapping refunds both end", async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    const first = withRefundInFlight("0xtwice", () => new Promise<void>((r) => (finishFirst = r)))
    const second = withRefundInFlight("0xtwice", () => new Promise<void>((r) => (finishSecond = r)))
    finishFirst()
    await first
    expect(isRefundInFlight("0xtwice")).toBe(true)
    finishSecond()
    await second
    expect(isRefundInFlight("0xtwice")).toBe(false)
  })
})
