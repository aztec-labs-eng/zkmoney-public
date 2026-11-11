// @vitest-environment node
/** The claim countdown's format, and its clock, which ticks only while a wait is set. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClock } from "@obsidion/front-core"
import { countdownClock, formatClaimCountdown } from "../../../src/features/paylink/claimWindow"

describe("formatClaimCountdown", () => {
  it("pads seconds under an hour and drops the fraction", () => {
    expect(formatClaimCountdown(65.9)).toBe("1:05")
    expect(formatClaimCountdown(3599)).toBe("59:59")
  })

  it("shows hours once an hour is left", () => {
    expect(formatClaimCountdown(3600)).toBe("1:00:00")
    expect(formatClaimCountdown(3 * 3600 + 7 * 60 + 9)).toBe("3:07:09")
  })

  it("reads a negative remainder as zero", () => {
    expect(formatClaimCountdown(-5)).toBe("0:00")
  })
})

describe("countdownClock", () => {
  beforeEach(() => vi.useFakeTimers({ now: 10_000 }))
  afterEach(() => vi.useRealTimers())

  it("ticks the page clock each second while a wait is set, and stops it once unread", () => {
    const seconds = createClock(1000, () => Date.now())
    const seen: number[] = []
    const clock = countdownClock(30, seconds)
    const off = clock.subscribe(() => seen.push(clock.get()))
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([11_000, 12_000])
    off()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never starts the page clock without a wait", () => {
    const seconds = createClock(1000, () => Date.now())
    const ticks = vi.fn()
    countdownClock(undefined, seconds).subscribe(ticks)
    countdownClock(0, seconds).subscribe(ticks)
    vi.advanceTimersByTime(3000)
    expect(ticks).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
