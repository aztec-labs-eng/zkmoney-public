// @vitest-environment node
/**
 * What a pass reads and asks for, and how often: the overdue republish, the held balance, the
 * L1-only pass, the in-flight count the cadence follows, and the request budget.
 */
import { describe, expect, it } from "vitest"
import {
  isUnfundedSipaDeposit,
  sipaCursorKey,
  type SipaDeposit,
} from "../../../src/engine/sipaDeposits"
import { DAI, FEE, PORTAL, pipelineWorld, RECIPIENT, type PipelineWorld } from "./world"

const ONE = 10n ** 18n
const HOUR = 3_600_000

const setCursor = (w: PipelineWorld, block: bigint) =>
  w.db.write(async (tx) => tx.put(sipaCursorKey(PORTAL, RECIPIENT.toString()), String(block)))

async function observed(w: PipelineWorld, n: number, over: Partial<SipaDeposit> = {}) {
  const sipa = await w.announced(n)
  await w.saved(sipa, {
    phase: "broadcast",
    observedFrom: (w.l1.head - 1_000n).toString(),
    ...over,
  })
  return sipa
}

describe("the overdue republish", () => {
  it("owes an address the relayer left unswept its broadcast again, once a day", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { phase: "sweeping", startTime: Date.now() - 2 * HOUR })
    w.pay(sipa.address, ONE)

    expect(await w.scan()).toMatchObject({ republished: 1 })
    expect(await w.get(sipa.address)).toMatchObject({
      republishAskedAt: expect.any(Number),
      broadcast: {
        kind: "deposit",
        source: { type: "slot" },
        state: "queued",
        republishSince: w.l2.block,
      },
    })
    await w.store.apply(sipa.address, { type: "broadcastLanded" })
    expect(await w.scan()).toMatchObject({ republished: 0 })
    expect((await w.get(sipa.address))?.broadcast?.state).toBe("landed")
  })

  it("owes nothing in a pass over another account's history, and leaves the ask for one that can", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { phase: "sweeping", startTime: Date.now() - 2 * HOUR })
    w.pay(sipa.address, ONE)

    expect(await w.scan({ republishes: false })).toMatchObject({ republished: 0 })
    const held = await w.get(sipa.address)
    expect(held?.broadcast).toBeUndefined()
    expect(held?.republishAskedAt).toBeUndefined()
    expect(await w.scan()).toMatchObject({ republished: 1 })
  })

  it("asks once a day for an address with nothing to rebuild, owing nothing", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await w.announced(1, { resweepable: false })
    await w.saved(sipa, {
      phase: "sweeping",
      startTime: Date.now() - 2 * HOUR,
      observedFrom: (w.l1.head - 1_000n).toString(),
    })
    w.pay(sipa.address, ONE)

    await w.scan()
    const asked = (await w.get(sipa.address))?.republishAskedAt
    await w.scan()

    expect(asked).toEqual(expect.any(Number))
    expect(await w.get(sipa.address)).toMatchObject({ republishAskedAt: asked })
    expect((await w.get(sipa.address))?.broadcast).toBeUndefined()
  })

  it("owes an overdue address's broadcast in the pass that found it", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)

    await w.scan()

    expect((await w.get(sipa.address))?.broadcast).toMatchObject({ republishSince: w.l2.block })
  })

  it("asks again on the next pass when the L2 head does not read", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { phase: "sweeping", startTime: Date.now() - 2 * HOUR })
    w.pay(sipa.address, ONE)
    w.l2.headError = new Error("node down")

    expect(await w.scan()).toMatchObject({ failed: 0, complete: false, republished: 0 })
    expect((await w.get(sipa.address))?.republishAskedAt).toBeUndefined()
    w.l2.headError = undefined
    await w.scan()
    expect((await w.get(sipa.address))?.broadcast).toMatchObject({ state: "queued" })
  })

  it("leaves a SIPA funded within the hour to the relayer", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { phase: "sweeping", startTime: Date.now() - 60_000 })
    // No funding log to date it: the record's own clock stands.
    w.l1.setBalance(sipa.address, DAI, ONE)

    await w.scan()

    const record = await w.get(sipa.address)
    expect(record?.republishAskedAt).toBeUndefined()
    expect(record?.broadcast).toBeUndefined()
  })
})

describe("the held balance", () => {
  it("records the balance it observed, in fee-token units", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1)
    w.pay(sipa.address, ONE)

    await w.scan()

    expect((await w.get(sipa.address))?.heldBalance).toBe(ONE.toString())
  })

  it("records the emptied balance on an L1-only pass that sees the sweep", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { heldBalance: ONE.toString() })
    w.pay(sipa.address, ONE)
    const { tx } = w.sweep(sipa, 7n, { block: w.l1.head - 5n })

    await w.scan({ discover: false })

    expect(await w.get(sipa.address)).toMatchObject({ heldBalance: "0", sweepTxHash: tx })
  })
})

describe("an L1-only pass", () => {
  it("reads no events and claims nothing, keeping the sweep's claim inputs", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "broadcast" })
    w.pay(sipa.address, ONE)
    const { tx } = w.sweep(sipa, 7n, { block: w.l1.head - 5n })

    await w.scan({ discover: false })

    expect(w.l2.eventReads).toBe(0)
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "pendingClaim",
      sweepTxHash: tx,
      pendingSweeps: [expect.objectContaining({ inboxIndex: "7" })],
    })
  })

  it("reads a funded deposit address as funded, with its balance, token and clock", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { phase: "resolved", startTime: 1 })
    w.l1.setBalance(sipa.address, DAI, ONE)

    await w.scan({ discover: false })

    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ heldBalance: ONE.toString(), tokenAddress: DAI })
    expect(isUnfundedSipaDeposit(record)).toBe(false)
    // Its clock starts at the funds, not at the hand-out.
    expect(record.startTime).toBeGreaterThan(1)
  })

  it("dates a funded address by its funding transfer", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1, { phase: "resolved", startTime: 1 })
    w.pay(sipa.address, ONE, DAI, w.l1.head - 20n)

    await w.scan({ discover: false })

    expect((await w.get(sipa.address))?.startTime).toBe(Number(w.l1.timeOf(w.l1.head - 20n)) * 1000)
  })

  it("reports new funds and a new sweep once each, and the full pass then claims", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head - 1n)
    const sipa = await observed(w, 1)
    w.pay(sipa.address, ONE)
    expect(await w.scan({ discover: false })).toMatchObject({ found: 1 })
    w.l1.head += 1n
    expect(await w.scan({ discover: false })).toMatchObject({ found: 0 })

    w.l1.head += 1n
    w.sweep(sipa, 7n, { block: w.l1.head - 5n })
    expect(await w.scan({ discover: false })).toMatchObject({ found: 1 })
    w.l1.head += 1n
    expect(await w.scan({ discover: false })).toMatchObject({ found: 0 })

    expect((await w.pass()).claimed).toMatchObject({ claimed: 1 })
    expect((await w.get(sipa.address))?.phase).toBe("claimed")
  })

  it("reads only the head while the head has not passed the cursor", async () => {
    const w = await pipelineWorld()
    await setCursor(w, w.l1.head)
    const sipa = await observed(w, 1)

    await w.scan({ discover: false })
    expect(w.l1.calls.map((c) => c.method)).toEqual(["eth_call", "eth_blockNumber"])

    await w.store.apply(sipa.address, {
      type: "observed",
      fields: { rescanFrom: (w.l1.head - 50n).toString() },
    })
    await w.scan({ discover: false })
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(3)
  })
})

describe("the in-flight count", () => {
  it("counts an in-flight sweep as active however old the record is", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "sweeping", startTime: 1, amount: "1" })
    w.pay(sipa.address, ONE)

    expect(await w.scan()).toMatchObject({ active: 1 })
  })

  it.each([
    ["an unfunded SIPA past its fresh window", { startTime: 1 }, 0],
    ["a replayed unfunded address", { startTime: Date.now(), replayed: true }, 0],
    ["a self-initiated record inside its fresh window", { startTime: Date.now() }, 1],
  ])("counts %s as active: %s", async (_label, fields, active) => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "broadcast", amount: "0", ...fields })

    expect(await w.scan()).toMatchObject({ active })
  })

  it("reports a pass that finds events with no record here as replaying, and only that one", async () => {
    const w = await pipelineWorld()
    await w.announced(1)
    expect(await w.scan()).toMatchObject({ replaying: true })
    w.l1.head += 1n
    expect(await w.scan()).toMatchObject({ replaying: false })
  })
})

describe("the request budget", () => {
  it("reads the head, the fee floor and the cap once a pass however many SIPAs it probes", async () => {
    const w = await pipelineWorld()
    for (const n of [1, 2, 3]) w.pay((await w.announced(n)).address, ONE)

    await w.scan()

    expect(w.l1.count({ method: "eth_blockNumber" })).toBe(1)
    expect(w.l1.count({ fn: "rowFor" })).toBe(1)
    // One for the window, one inside the fee read.
    expect(w.l1.count({ fn: "TX_AMOUNT_CAP" })).toBe(2)
    expect(w.l1.count({ method: "eth_getLogs" })).toBe(3)
    expect(w.l1.count({ fn: "aggregate3" })).toBe(1)
  })

  it("prices a claimed sweep off its own row once a pass, and reads no cap", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, {
      phase: "claimed",
      startTime: 1,
      endTime: 1,
      amount: "0.99",
      fee: FEE.toString(),
    })
    for (const index of [7n, 8n]) {
      w.pay(sipa.address, ONE)
      w.sweep(sipa, index)
    }

    await w.pass()

    expect(w.l1.count({ fn: "rowFor" })).toBe(1)
    expect((await w.get(sipa.address))!.sweeps!.map((s) => s.fee)).toEqual([
      FEE.toString(),
      FEE.toString(),
    ])
  })

  it("reports the head's time from the balance read it already makes", async () => {
    const w = await pipelineWorld()
    w.pay((await w.announced(1)).address, ONE)

    const result = await w.scan()

    expect(result.chainTime).toBe(Number(w.l1.timeOf(w.l1.head)) * 1000)
    expect(w.l1.count({ fn: "aggregate3" })).toBe(1)
  })
})
