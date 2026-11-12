// @vitest-environment node
/**
 * The add's release is read from the estimator for a burn landing now from this device's history,
 * or for the funding that landed in a given L2 block, and read again at the offer's cadence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BurnDurations, BurnLanding, WithdrawalSpeedupEstimate } from "@obsidion/front-core"
import { backupAddReleases, fundingBlock } from "../../../src/features/backupPasskey/backupAddTime"
import { SWAP_QUOTE_REFRESH_MS } from "../../../src/features/withdraw/swapQuotes"
import { testQuery } from "../../support/query"

const estimate = (standard: number, tipped: number) =>
  ({ standardEtaSeconds: standard, tippedEtaSeconds: tipped } as WithdrawalSpeedupEstimate)

/** This device's burns took 100, 120 and 200 s: a median landing of 120 s. */
const durations = { samples: async () => [200, 100, 120] } as BurnDurations

/** Block `n` was made at second 1_000 + n; the landed estimate's Standard ETA echoes its landing. */
function world(over: { tipped?: () => number; constantsFail?: boolean } = {}) {
  const estimator = {
    estimate: async (landing: BurnLanding) => estimate(600 + landing.expected, 180),
    estimateLanded: async (landedAt: number) => estimate(landedAt, over.tipped?.() ?? 100),
  }
  const node = {
    getL1Constants: async () => {
      if (over.constantsFail) throw new Error("rpc down")
      return { ethereumSlotDuration: 12 }
    },
    getBlockData: async (n: number) => ({
      header: { globalVariables: { timestamp: BigInt(1_000 + n) } },
    }),
  }
  const page = {
    wallet: { ready: async () => ({ node }) },
    speedupEstimator: { ready: async () => estimator },
  } as unknown as ReturnType<Parameters<typeof backupAddReleases>[2]>
  return backupAddReleases(testQuery(), durations, () => page)
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const value = (entry: ReturnType<ReturnType<typeof backupAddReleases>>) => {
  const state = entry.get()
  return state.status === "ready" ? state.value : undefined
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("backupAddReleases", () => {
  it("quotes a burn landing now by the device's history, a landed one by its block's time", async () => {
    const release = world()
    const now = release(undefined)
    const landed = release(234)
    now.subscribe(() => {})
    landed.subscribe(() => {})
    await flush()
    expect(value(now)).toEqual({
      landingSeconds: 120,
      standardEtaSeconds: 720,
      tippedEtaSeconds: 180,
      l1SlotSeconds: 12,
    })
    expect(value(landed)).toEqual({
      landingSeconds: 0,
      landedAt: 1_234,
      standardEtaSeconds: 1_234,
      tippedEtaSeconds: 100,
      l1SlotSeconds: 12,
    })
  })

  it("reads again at the offer's cadence, catching the previous epoch's proof", async () => {
    let tipped = 900
    const entry = world({ tipped: () => tipped })(234)
    entry.subscribe(() => {})
    await flush()
    expect(value(entry)?.tippedEtaSeconds).toBe(900)
    tipped = 180
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS)
    expect(value(entry)?.tippedEtaSeconds).toBe(180)
  })

  it("answers nothing while a read fails", async () => {
    const entry = world({ constantsFail: true })(undefined)
    entry.subscribe(() => {})
    await flush()
    expect(value(entry)).toBeUndefined()
  })
})

describe("fundingBlock", () => {
  it.each([
    ["submitting", undefined],
    ["l2_mined", 234],
    ["awaiting_proven", 234],
    ["finalizing_l1", 234],
    ["done", 234],
    ["failed", undefined],
  ] as const)("keys a %s row's release by %s", (phase, block) => {
    expect(fundingBlock({ phase, blockNumber: 234 })).toBe(block)
  })
})
