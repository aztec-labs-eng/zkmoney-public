// @vitest-environment node
/** An aborted pass ends at its next step and commits nothing, so the next pass starts clean. */
import { describe, expect, it } from "vitest"
import { pipelineWorld } from "./world"

const ONE = 10n ** 18n

describe("an aborted pass", () => {
  it("scans: it saves no record and no cursor", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)
    const stop = new AbortController()

    await expect(
      w.scan({
        signal: stop.signal,
        historyStartBlock: async () => {
          stop.abort()
          return w.l1.head - 100_000n
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" })

    expect(await w.records()).toEqual([])
    expect(await w.cursor()).toBeUndefined()
    expect(await w.scan()).toMatchObject({ complete: true })
    expect(await w.get(sipa.address)).toMatchObject({ phase: "pendingClaim" })
  })

  it("claims: the sweeps stay pending until a run that is not aborted", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    const first = w.sweep(sipa, 7n, { block: w.l1.head - 60n })
    w.pay(sipa.address, ONE, undefined, w.l1.head - 55n)
    const second = w.sweep(sipa, 9n)
    await w.scan()
    for (const { key } of [first, second]) w.l2.settle(key)
    const stop = new AbortController()
    w.l2.claimError = () => {
      stop.abort()
      return undefined
    }

    await expect(w.claim({ signal: stop.signal })).rejects.toMatchObject({ code: "aborted" })

    expect(w.l2.claims.map((c) => c.inboxIndex)).toEqual([7n])
    expect(await w.get(sipa.address)).toMatchObject({ phase: "pendingClaim" })
    expect((await w.get(sipa.address))?.claimedInboxIndexes ?? []).toEqual([])
    w.l2.claimError = () => undefined
    expect(await w.claim()).toMatchObject({ claimed: 2, complete: true })
    expect(await w.get(sipa.address)).toMatchObject({ claimedInboxIndexes: ["7", "9"] })
  })
})
