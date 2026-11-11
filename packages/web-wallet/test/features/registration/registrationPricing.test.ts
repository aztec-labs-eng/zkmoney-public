// The sweep fee and the schedule as session queries: read once something asks, retried on their
// backoff while subscribed or at once, and built for a visitor's session too.
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import { memoryStore, queries } from "@obsidion/front-core"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import {
  registrationPricing,
  retryPricing,
} from "../../../src/features/registration/registrationPricing"
import { closeSession, namespaceOf, switchSession } from "../../../src/session/session"
import { testPage } from "../../support/page"
import { PAID } from "../../support/registrationPrices"
import { fakeClock, flush } from "../../../../front-core/test/engine/taskTable"
fakeClock()
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
  closeSession()
})

function pricing(schedule: RegistrationSchedule = PAID) {
  const reads = { sweepFee: vi.fn(async () => 5n), schedule: vi.fn(async () => schedule) }
  const query = queries({
    pace: createPace({ signalled: false }),
    visible: memoryStore(true),
    now: () => Date.now(),
  })
  const built = registrationPricing(query, reads)
  return { ...built, reads }
}

describe("registrationPricing", () => {
  it("reads nothing until asked, and the fee once for the schedule too", async () => {
    const p = pricing()
    await flush()
    expect(p.reads.sweepFee).not.toHaveBeenCalled()
    expect(await p.registrationSchedule.read()).toEqual(PAID)
    expect(await p.sweepFee.read()).toBe(5n)
    expect(p.reads.sweepFee).toHaveBeenCalledTimes(1)
    expect(p.reads.schedule).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["prices zero", { min: 0n, fee: 0n }],
    ["prices a fee under the sweep fee", { min: PAID.min, fee: 4n }],
  ])("takes no registration where the deployment %s", async (_, schedule) => {
    expect(await pricing(schedule).registrationSchedule.read()).toBeNull()
  })

  it("reads a failed fee again after 2 s, doubling to 30 s", async () => {
    const p = pricing()
    p.reads.sweepFee.mockRejectedValue(new Error("rpc"))
    ends.push(p.sweepFee.subscribe(() => {}))
    await flush()
    for (const [i, wait] of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(p.reads.sweepFee).toHaveBeenCalledTimes(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(p.reads.sweepFee).toHaveBeenCalledTimes(i + 2)
    }
  })

  it("reads a failed fee again at once on retry, and leaves a read one alone", async () => {
    const p = pricing()
    p.reads.sweepFee.mockRejectedValueOnce(new Error("rpc"))
    ends.push(p.sweepFee.subscribe(() => {}))
    await flush()
    expect(p.sweepFee.get().status).toBe("failed")
    retryPricing(p)
    await flush()
    expect(p.sweepFee.get()).toEqual({ status: "ready", value: 5n, refreshing: false })
    retryPricing(p)
    await flush()
    expect(p.reads.sweepFee).toHaveBeenCalledTimes(2)
  })

  it("is a visitor's session's too, unread until asked", () => {
    const visitor = switchSession(namespaceOf(null), pageSessionDeps(testPage()))
    expect(visitor.sweepFee.get().status).toBe("pending")
    expect(visitor.registrationSchedule.get().status).toBe("pending")
  })
})
