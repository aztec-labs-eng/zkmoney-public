// @vitest-environment node
/** The claim ledger: each claimed sweep's entry, and fees a pass lost. */
import { describe, expect, it } from "vitest"
import { DAI, FEE, pipelineWorld } from "./world"

const ONE = 10n ** 18n

describe("the claim ledger", () => {
  it("ledgers the sweeps of a record claimed before the ledger existed, from the history start, claiming nothing", async () => {
    const w = await pipelineWorld()
    const start = w.l1.head - 400_000n
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE, DAI, start + 1n)
    const first = w.sweep(sipa, 7n, { block: start + 5n })
    w.pay(sipa.address, 4n * ONE, DAI, start + 40n)
    const second = w.sweep(sipa, 9n, { block: start + 50n })
    await w.saved(sipa, {
      phase: "claimed",
      inboxIndex: "9",
      claimedInboxIndexes: ["7", "9"],
      netAmount: (4n * ONE - FEE).toString(),
      sweepTxHash: second.tx,
      endTime: 1,
    })

    await w.pass({ scan: { historyStartBlock: async () => start } })

    expect(w.l1.calls.some((c) => c.range?.[0] === start)).toBe(true)
    expect(w.l2.claims).toEqual([])
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
      netAmount: (4n * ONE - FEE).toString(),
      sweeps: [
        expect.objectContaining({
          inboxIndex: "7",
          sweepTxHash: first.tx,
          settledAt: Number(w.l1.timeOf(start + 5n)) * 1000,
          grossAmount: ONE.toString(),
        }),
        expect.objectContaining({
          inboxIndex: "9",
          sweepTxHash: second.tx,
          settledAt: Number(w.l1.timeOf(start + 50n)) * 1000,
          grossAmount: (4n * ONE).toString(),
        }),
      ],
    })

    // Ledgered: the next pass rides the cursor.
    w.l1.head += 10n
    const calls = w.l1.calls.length
    await w.scan({ historyStartBlock: async () => start })
    expect(w.l1.calls.slice(calls).every((c) => !c.range || c.range[0] > start)).toBe(true)
  })

  it("dates a replayed deposit claimed passes later at its sweep", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const block = w.l1.head - 40n
    const sweep = w.sweep(sipa, 7n, { block })
    await w.scan()
    w.l1.head += 10n
    await w.scan()
    w.l2.settle(sweep.key)

    expect(await w.claim()).toMatchObject({ claimed: 1 })
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      endTime: Number(w.l1.timeOf(block)) * 1000,
    })
  })

  it("prices a claimed record whose fee never landed, and reads nothing once it has", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    await w.saved(sipa, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      netAmount: (ONE - FEE).toString(),
      amount: "0.9",
      endTime: 1,
    })

    await w.pass()
    expect(w.l2.claims).toEqual([])
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed", fee: FEE.toString() })

    w.l1.head += 10n
    const reads = w.l1.count({ fn: "rowFor" })
    await w.scan()
    expect(w.l1.count({ fn: "rowFor" })).toBe(reads)
  })

  it("backfills a fee the claiming pass lost on a later pass that reads no sweep", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE, DAI, w.l1.head - 1_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 1_000n })
    let failures = 1
    w.l1.failing = (c) => c.fn === "rowFor" && failures-- > 0

    await w.pass()
    const claimed = (await w.get(sipa.address))!
    expect(claimed).toMatchObject({ phase: "claimed", observedFrom: w.l1.head.toString() })
    expect(claimed.fee).toBeUndefined()

    // The cursor sits past the sweep: only the per-pass backfill can land the fee.
    w.l1.head += 2_000n
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({ phase: "claimed", fee: FEE.toString() })
  })
})
