// @vitest-environment node
/** Each payment to an address paid more than once, as the feed lists it from the record. */
import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { sipaCredits } from "../../../src/core/services/deposits/sipaCredits"
import { isStuckSweep, STUCK_SWEEP_MS } from "../../../src/core/services/deposits/sipaStuck"
import { DAI, L2_TOKEN, RECOVERY_ACCOUNT, pipelineWorld, type PipelineWorld } from "./world"

const ONE = 10n ** 18n
const NET_1 = (975n * ONE) / 100n
const NET_2 = (675n * ONE) / 100n

/** The address's payments: the past sweep each splits out, or "own", with its amount and phase. */
async function payments(w: PipelineWorld, address: Address) {
  return sipaCredits((await w.get(address))!).map(({ payment, record }) => [
    payment ?? "own",
    record.amount,
    record.phase,
  ])
}

describe("an address paid twice", () => {
  it("keeps the first payment as its own once the address is paid and claimed again", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, 10n * ONE, DAI, w.l1.head - 1_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 1_000n, credit: NET_1 })
    await w.pass()
    expect(await payments(w, sipa.address)).toEqual([["own", "9.75", "claimed"]])

    w.l1.head += 10n
    const paidAt = w.l1.head - 5n
    w.pay(sipa.address, 7n * ONE, DAI, paidAt)
    expect(await w.scan()).toMatchObject({ republished: 1 })
    expect(await payments(w, sipa.address)).toEqual([
      ["7", "9.75", "claimed"],
      ["own", "7", "sweeping"],
    ])
    expect((await w.get(sipa.address))!.startTime).toBe(Number(w.l1.timeOf(paidAt)) * 1000)

    w.l1.head += 10n
    w.sweep(sipa, 8n, { block: w.l1.head - 5n, credit: NET_2 })
    await w.pass()
    expect(await payments(w, sipa.address)).toEqual([
      ["7", "9.75", "claimed"],
      ["own", "6.75", "claimed"],
    ])
  })

  it("runs a payment found late on the stuck clock from the republish that asks for its sweep", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, 10n * ONE, DAI, w.l1.head - 1_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 1_000n, credit: NET_1 })
    await w.pass()

    w.l1.head += 10n
    w.pay(sipa.address, 7n * ONE, DAI, w.l1.head - 5n)
    const asked = Date.now()
    expect(await w.scan()).toMatchObject({ republished: 1 })
    // The fake chain dates the payment years back; no relayer could sweep it before this pass.
    const record = (await w.get(sipa.address))!
    expect(record.startTime).toBeLessThan(asked - STUCK_SWEEP_MS)
    expect(isStuckSweep(record, asked)).toBe(false)
    expect(isStuckSweep(record, record.republishAskedAt! + STUCK_SWEEP_MS)).toBe(true)
  })

  it("reads a second payment too small to sweep as its own, through its recovery", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    w.pay(sipa.address, 10n * ONE, DAI, w.l1.head - 1_010n)
    w.sweep(sipa, 7n, { block: w.l1.head - 1_000n, credit: NET_1 })
    await w.pass()

    w.l1.head += 10n
    w.pay(sipa.address, ONE / 20n, DAI, w.l1.head - 5n)
    expect(await w.scan()).toMatchObject({ recoverable: 1 })
    expect(await payments(w, sipa.address)).toEqual([
      ["7", "9.75", "claimed"],
      ["own", "0.05", "recoverable"],
    ])
    const record = (await w.get(sipa.address))!
    expect([record.netAmount, record.sweepTxHash, record.endTime]).toEqual([
      undefined,
      undefined,
      undefined,
    ])

    w.l1.head += 10n
    const recovery = w.l1.transfer(DAI, sipa.address, RECOVERY_ACCOUNT, ONE / 20n, w.l1.head - 5n)
    await w.scan()
    expect(await payments(w, sipa.address)).toEqual([
      ["7", "9.75", "claimed"],
      ["own", "0.05", "recovered"],
    ])
    expect(await w.get(sipa.address)).toMatchObject({ recoveryTxHash: recovery })
  })

  it("rebuilds both payments on a fresh device, each dated by its sweep", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1, { resweepable: true })
    const firstAt = w.l1.head - 400n
    const secondAt = w.l1.head - 200n
    w.pay(sipa.address, 10n * ONE, DAI, firstAt - 10n)
    const first = w.sweep(sipa, 7n, { block: firstAt, credit: NET_1 })
    w.pay(sipa.address, 7n * ONE, DAI, secondAt - 10n)
    const second = w.sweep(sipa, 8n, { block: secondAt, credit: NET_2 })
    // The first device claimed both, so both deposits are spent.
    w.l2.spend(L2_TOKEN, first.key)
    w.l2.spend(L2_TOKEN, second.key)

    await w.pass()

    expect(w.l2.claims).toEqual([])
    expect(await payments(w, sipa.address)).toEqual([
      ["7", "9.75", "claimed"],
      ["own", "6.75", "claimed"],
    ])
    const dates = sipaCredits((await w.get(sipa.address))!).map(({ record }) => record.startTime)
    expect(dates).toEqual([firstAt, secondAt].map((block) => Number(w.l1.timeOf(block)) * 1000))
  })
})
