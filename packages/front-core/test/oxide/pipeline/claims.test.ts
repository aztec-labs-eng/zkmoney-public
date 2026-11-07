// @vitest-environment node
/** The claim half: the pending sweeps the scan half left, claimed with no L1 read of its own. */
import { describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import { arrivingFunds } from "../../../src/engine/activityFeed"
import { sipaSweepsReceived } from "../../../src/engine/sipaDeposits"
import { FEE, L2_TOKEN, pipelineWorld } from "./world"

const ONE = 10n ** 18n

/** One address swept twice, at inbox 7 and 9, observed and not yet claimed. */
async function twoSweeps(settle = true) {
  const w = await pipelineWorld()
  const sipa = await w.announced(1)
  w.pay(sipa.address, ONE)
  const first = w.sweep(sipa, 7n, { block: w.l1.head - 60n })
  w.pay(sipa.address, ONE, undefined, w.l1.head - 55n)
  const second = w.sweep(sipa, 9n)
  await w.scan()
  if (settle) for (const { key } of [first, second]) w.l2.settle(key)
  return { w, sipa, first, second }
}

describe("claims", () => {
  it("claims from the record alone: the claim run reads nothing on L1", async () => {
    const { w } = await twoSweeps()
    const calls = w.l1.calls.length

    expect(await w.claim()).toMatchObject({ claimed: 2, failed: 0, complete: true })
    expect(w.l1.calls.length).toBe(calls)
  })

  it("leaves an unsettled sweep pendingClaim and claims nothing yet", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    await w.scan()

    expect(await w.claim()).toMatchObject({ claimed: 0, pendingSettlement: 1 })
    expect(w.l2.claims).toEqual([])
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "7",
      netAmount: (ONE - FEE).toString(),
      amount: "0.9",
    })
  })

  it("skips inbox indexes already claimed; a new sweep on the same SIPA claims on its own", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "claimed", claimedInboxIndexes: ["7"], endTime: 1 })
    w.pay(sipa.address, ONE, undefined, w.l1.head - 70n)
    w.sweep(sipa, 7n, { block: w.l1.head - 60n })
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 9n)

    const { claimed } = await w.pass()

    expect(claimed.claimed).toBe(1)
    expect(w.l2.claims.map((c) => c.inboxIndex)).toEqual([9n])
    expect(await w.get(sipa.address)).toMatchObject({ claimedInboxIndexes: ["7", "9"] })
  })

  it("reconciles a deposit the PXE already holds instead of wedging the SIPA's later sweeps", async () => {
    const { w, sipa } = await twoSweeps()
    w.l2.claimError = (index) =>
      index === 7n ? new Error("Assertion failed: deposit already stored") : undefined

    expect(await w.claim()).toMatchObject({ reconciled: 1, claimed: 1, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
    })
  })

  it("isolates a failing sweep so the SIPA's other sweeps still claim", async () => {
    const { w, sipa } = await twoSweeps()
    w.l2.claimError = (index) => (index === 7n ? new Error("pxe hiccup") : undefined)

    expect(await w.claim()).toMatchObject({ claimed: 1, failed: 1, complete: false })
    expect(await w.get(sipa.address)).toMatchObject({ claimedInboxIndexes: ["9"] })
    w.l2.claimError = () => undefined
    expect(await w.claim()).toMatchObject({ claimed: 1, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({ claimedInboxIndexes: ["9", "7"] })
  })

  it("keeps a newer sweep pending when an older one on the same SIPA claims in the run", async () => {
    const { w, sipa, first } = await twoSweeps(false)
    w.l2.settle(first.key)

    expect(await w.claim()).toMatchObject({ claimed: 1, pendingSettlement: 1 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "9",
      netAmount: (ONE - FEE).toString(),
      claimedInboxIndexes: ["7"],
    })
  })

  it("reads as received for a migration only once every sweep is claimed", async () => {
    const { w, sipa, first, second } = await twoSweeps(false)
    w.l2.settle(first.key)
    await w.claim()
    expect(sipaSweepsReceived(await w.get(sipa.address))).toBe(false)

    w.l2.settle(second.key)
    await w.claim()
    expect(sipaSweepsReceived(await w.get(sipa.address))).toBe(true)
  })

  it("reads every sweep's readiness at once, before the first claim", async () => {
    const { w } = await twoSweeps()
    const readiness = w.l2.node.getL1ToL2MessageIndex
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    let reading = 0
    w.l2.node.getL1ToL2MessageIndex = async (hash) => {
      reading += 1
      await gate
      return readiness(hash)
    }

    const run = w.claim()
    await vi.waitFor(() => expect(reading).toBe(2))
    expect(w.l2.claims).toEqual([])
    open()

    expect(await run).toMatchObject({ claimed: 2, failed: 0 })
  })
})

describe("the balance refresh", () => {
  it("runs once after the run's claims, and the records read claimed only once it landed", async () => {
    const w = await pipelineWorld()
    const keys: Hex[] = []
    for (const n of [1, 2]) {
      const sipa = await w.announced(n)
      w.pay(sipa.address, ONE)
      keys.push(w.sweep(sipa, BigInt(6 + n)).key)
    }
    await w.scan()
    for (const key of keys) w.l2.settle(key)
    let land: () => void = () => {}
    const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

    const run = w.claim({ refreshBalance })
    await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))
    expect(w.l2.claims).toHaveLength(2)
    expect((await w.records()).map((r) => r.phase)).toEqual(["pendingClaim", "pendingClaim"])
    // A read resolved after the claim landed holds the deposit: arriving funds stop counting it.
    for (const r of await w.records())
      expect(r.claimLanded).toMatchObject({ at: expect.any(Number) })

    land()

    expect(await run).toMatchObject({ claimed: 2, complete: true })
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect((await w.records()).map((r) => r.phase)).toEqual(["claimed", "claimed"])
  })

  it("reads a deposit the PXE already stored before its record reads claimed", async () => {
    const { w } = await twoSweeps()
    w.l2.claimError = () => new Error("Assertion failed: deposit already stored")
    let land: () => void = () => {}
    const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

    const run = w.claim({ refreshBalance })
    await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))
    for (const r of await w.records())
      expect(r).toMatchObject({ phase: "pendingClaim", claimLanded: { at: expect.any(Number) } })
    land()

    expect(await run).toMatchObject({ reconciled: 2, claimed: 0, complete: true })
    expect((await w.records()).map((r) => r.phase)).toEqual(["claimed"])
  })

  it("saves the claims when the refresh rejects, and leaves the run incomplete", async () => {
    const { w, sipa } = await twoSweeps()
    const refreshBalance = vi.fn(async () => {
      throw new Error("node unreachable")
    })

    expect(await w.claim({ refreshBalance })).toMatchObject({
      claimed: 2,
      failed: 0,
      complete: false,
    })
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed" })
  })

  it("reports a run whose claims did not save, and claims them again as reconciled", async () => {
    const { w, sipa } = await twoSweeps()
    const applyAll = w.store.applyAll
    w.store.applyAll = async (events, tx) => {
      if (events.some(([, e]) => e.type === "claimed")) throw new Error("tab closed")
      return applyAll(events, tx)
    }

    expect(await w.claim()).toMatchObject({ claimed: 2, failed: 1, complete: false })
    expect((await w.get(sipa.address))?.claimedInboxIndexes).toBeUndefined()

    w.store.applyAll = applyAll
    w.l2.claimError = () => new Error("deposit already stored")
    expect(await w.claim()).toMatchObject({ reconciled: 2, failed: 0 })
    expect(await w.get(sipa.address)).toMatchObject({ claimedInboxIndexes: ["7", "9"] })
  })
})

describe("spent sweeps", () => {
  /** One address swept twice; another device claimed and spent the first before this one observed. */
  async function spentFirst() {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const first = w.sweep(sipa, 7n, { block: w.l1.head - 60n })
    w.pay(sipa.address, ONE, undefined, w.l1.head - 55n)
    const second = w.sweep(sipa, 9n)
    w.l2.spend(L2_TOKEN, first.key)
    return { w, sipa, first, second }
  }

  it("marks a spent sweep on scan, in one lookup, and the claim run settles it unclaimed", async () => {
    const { w, sipa, first, second } = await spentFirst()
    const lookups = vi.spyOn(w.l2, "readConsumed")
    await w.scan()
    expect(lookups).toHaveBeenCalledOnce()
    for (const { key } of [first, second]) w.l2.settle(key)
    const readiness = vi.spyOn(w.l2.node, "getL1ToL2MessageIndex")

    expect(await w.claim()).toMatchObject({ claimed: 1, reconciled: 1, failed: 0 })
    expect(lookups).toHaveBeenCalledOnce()
    expect(readiness).toHaveBeenCalledOnce()
    expect(w.l2.claims.map((c) => c.inboxIndex)).toEqual([9n])
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
    })
  })

  it("reads no balance for a run that settles only spent sweeps", async () => {
    const { w, second } = await spentFirst()
    w.l2.spend(L2_TOKEN, second.key)
    await w.scan()
    const refreshBalance = vi.fn(async () => {})

    expect(await w.claim({ refreshBalance })).toMatchObject({ reconciled: 2, claimed: 0 })
    expect(refreshBalance).not.toHaveBeenCalled()
  })

  it("never counts a replayed spent deposit as arriving", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const sweep = w.sweep(sipa, 7n)
    w.l2.spend(L2_TOKEN, sweep.key)
    await w.scan()

    const records = await w.records()
    expect(records[0]).toMatchObject({ phase: "pendingClaim" })
    expect(arrivingFunds({ deposits: records, burns: [], moves: [], rows: [] }).main).toBe(0n)
  })

  it("keeps a confirmed spent sweep when a later pass's lookup fails", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const sweep = w.sweep(sipa, 7n)
    w.l2.spend(L2_TOKEN, sweep.key)
    await w.scan()
    w.l2.readConsumed = async () => {
      throw new Error("node down")
    }
    w.l1.head += 10n
    await w.scan()

    const records = await w.records()
    expect(records[0]!.pendingSweeps).toEqual([expect.objectContaining({ spent: true })])
    expect(arrivingFunds({ deposits: records, burns: [], moves: [], rows: [] }).main).toBe(0n)
  })

  it("leaves every sweep to its claim when the lookup fails", async () => {
    const { w, first, second } = await spentFirst()
    w.l2.readConsumed = async () => {
      throw new Error("node down")
    }
    await w.scan()
    for (const { key } of [first, second]) w.l2.settle(key)

    expect(await w.claim()).toMatchObject({ claimed: 2, failed: 0 })
  })
})
