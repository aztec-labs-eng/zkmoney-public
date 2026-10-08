import { describe, expect, it } from "vitest"
import {
  nextBroadcast,
  nextRetryAt,
  type BroadcastJob,
} from "../../../src/core/services/broadcasts"

const NOW = 1_000_000

const job = (address: string, over: Partial<BroadcastJob> = {}): BroadcastJob => ({
  address,
  kind: "deposit",
  scope: "acct",
  source: { type: "slot", cacheKey: "k", day: 1, nonce: 0 },
  createdAt: 1,
  state: "queued",
  failures: 0,
  ...over,
})

describe("nextBroadcast", () => {
  it.each<[string, BroadcastJob[], string | undefined]>([
    ["nothing owed", [job("a", { state: "landed" })], undefined],
    [
      "nothing while one is being built or decided",
      [job("a", { state: "proving" }), job("b", { kind: "registration" })],
      undefined,
    ],
    ["nothing while one waits on the chain", [job("a", { state: "sent" }), job("b")], undefined],
    [
      "the registration before anything, even a funded deposit",
      [job("dep", { fundedAt: 5 }), job("reg", { kind: "registration", createdAt: 9 })],
      "reg",
    ],
    [
      "nothing but the registration while it waits to retry",
      [job("reg", { kind: "registration", retryAt: NOW + 1 }), job("dep")],
      undefined,
    ],
    [
      "a funded address before a shown one, and a shown one before the pool",
      [
        job("pool", { kind: "pool" }),
        job("shown", { createdAt: 2 }),
        job("funded", { createdAt: 3, fundedAt: 4 }),
      ],
      "funded",
    ],
    [
      "the user's address before an older pool fill",
      [job("pool", { kind: "pool", createdAt: 1 }), job("shown", { createdAt: 2 })],
      "shown",
    ],
    ["the oldest of a kind", [job("new", { createdAt: 5 }), job("old", { createdAt: 2 })], "old"],
    [
      "not one waiting to retry",
      [job("later", { retryAt: NOW + 1 }), job("now", { createdAt: 9 })],
      "now",
    ],
    [
      "an unfunded address that failed many times, once its retry is due",
      [job("failing", { failures: 9, retryAt: NOW }), job("next", { createdAt: 9 })],
      "failing",
    ],
  ])("picks %s", (_, jobs, expected) => {
    expect(nextBroadcast(jobs, NOW)?.address).toBe(expected)
  })

  it("skips a job no executor can run yet", () => {
    const jobs = [job("old", { createdAt: 1 }), job("new", { createdAt: 2 })]
    expect(nextBroadcast(jobs, NOW, { runnable: (j) => j.address !== "old" })?.address).toBe("new")
  })
})

describe("nextRetryAt", () => {
  it("is the soonest retry among jobs that would otherwise run", () => {
    const jobs = [job("a", { retryAt: NOW + 30 }), job("b", { retryAt: NOW + 10 })]
    expect(nextRetryAt(jobs, NOW)).toBe(NOW + 10)
    expect(
      nextRetryAt(
        [job("reg", { kind: "registration", retryAt: NOW + 50 }), job("b", { retryAt: NOW + 10 })],
        NOW,
      ),
    ).toBe(NOW + 50)
  })
})
