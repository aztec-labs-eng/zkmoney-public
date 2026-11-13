// @vitest-environment node
/** A rotated wallet's old account: what the sign-in's history pass and a later check do with it. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { STUCK_SWEEP_MS } from "../../../src/core/services/deposits/sipaStuck"
import { selectFeed, type FeedSources } from "../../../src/engine/activityFeed"
import type { SipaDeposit } from "../../../src/engine/sipaDeposits"
import { DAI, pipelineWorld, RECIPIENT } from "./world"

const ONE = 10n ** 18n

const feed = (deposit: SipaDeposit, now: number) => {
  const sources: FeedSources = {
    rows: { records: [], loaded: true, failed: false },
    links: { records: [], loaded: true, failed: false },
    operations: { records: [], loaded: true, failed: false },
    requests: [],
    deposits: { records: [deposit], loaded: true, failed: false },
    withdrawals: { records: [], hydrated: true },
    bridgeIns: { records: [], hydrated: true },
    upgrades: { items: [], recipients: new Set(), loaded: true },
    moves: { records: [], loaded: true, failed: false },
    movesReplayed: true,
    oldVersionWithdrawals: [],
    processing: new Map(),
    catchingUp: false,
    now,
  }
  return selectFeed(sources, {
    contacts: { rows: [], hydrated: true, failed: false },
    registrations: { records: [] },
    previousAccount: RECIPIENT.toString(),
  }).items
}

afterEach(() => vi.useRealTimers())

describe("a payment to the old account while signed out", () => {
  it("stays claimed through the sign-in's history pass, so the next check republishes it", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, ONE, DAI, w.l1.head - 1_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 1_000n })
    await w.pass()
    w.l1.head += 10n
    w.l1.setBalance(sipa.address, DAI, ONE / 2n)

    // The sign-in's history pass publishes nothing and claims with no token service.
    expect(await w.scan({ republishes: false })).toMatchObject({ republished: 0 })
    await w.claim({ tokenServiceFor: undefined })
    const kept = (await w.get(sipa.address))!
    expect(kept).toMatchObject({ phase: "claimed", amount: "0.9" })
    const later = Date.now() + STUCK_SWEEP_MS
    // A replayed deposit shows once the bridge-in rebuild has read its funding receipt.
    expect(feed({ ...kept, funding: "transfer" }, later)).toMatchObject([
      { kind: "deposit", offer: null },
    ])

    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(later)
    w.l1.head += 1n
    expect(await w.scan()).toMatchObject({ republished: 1 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "sweeping",
      amount: "0.5",
      broadcast: { state: "queued" },
    })
  })
})
