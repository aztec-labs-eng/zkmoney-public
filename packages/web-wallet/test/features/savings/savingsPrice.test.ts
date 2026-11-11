// @vitest-environment node
/**
 * The Savings share price is a session query: read after the first balance, then on each poll
 * while subscribed, or on a read once a minute old. A failed read keeps the last price.
 */
import { describe, expect, it, vi } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import { memoryStore, queries, type SavingsPrice } from "@obsidion/front-core"
import {
  SAVINGS_PRICE_INTERVAL_MS,
  exitSharePrice,
  savingsPrices,
} from "../../../src/features/savings/savingsTasks"

const ONE = 10n ** 18n
const ASSET = `0x${"5d".repeat(20)}`
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness() {
  const pace = createPace({ signalled: true })
  let reached!: (ok: boolean) => void
  const firstBalance = new Promise<boolean>((resolve) => (reached = resolve))
  const milestones = { after: () => firstBalance }
  const answers: (SavingsPrice | Error)[] = []
  let reads = 0
  const read = async () => {
    reads++
    const next = answers.shift() ?? { sharePrice: ONE, readAt: reads }
    if (next instanceof Error) throw next
    return { ...next, asset: ASSET }
  }
  const price = savingsPrices(
    queries({ pace, visible: memoryStore(true).readonly, now: () => Date.now() }),
    milestones,
    read,
  )
  return { pace, price, answers, reached, reads: () => reads }
}

describe("savingsPrices", () => {
  it("reads nothing before the first balance", async () => {
    const p = harness()
    const off = p.price.subscribe(() => {})
    await settle()
    expect(p.reads()).toBe(0)
    expect(p.price.get()).toEqual({ status: "pending" })
    p.reached(true)
    await settle()
    expect(p.reads()).toBe(1)
    expect(p.price.get()).toMatchObject({ status: "ready", value: { sharePrice: ONE } })
    off()
  })

  it("polls only while subscribed", async () => {
    const p = harness()
    p.reached(true)
    const off = p.price.subscribe(() => {})
    await settle()
    p.pace.wake()
    await settle()
    expect(p.reads()).toBe(2)
    off()
    p.pace.wake()
    await settle()
    expect(p.reads()).toBe(2)
  })

  it("keeps the last price through a failed read", async () => {
    const p = harness()
    p.reached(true)
    p.answers.push({ sharePrice: 2n * ONE, readAt: 1 }, new Error("rpc down"))
    const off = p.price.subscribe(() => {})
    await settle()
    p.pace.wake()
    await settle()
    expect(p.reads()).toBe(2)
    expect(p.price.get()).toMatchObject({ status: "ready", value: { sharePrice: 2n * ONE } })
    off()
  })

  it("reads again for a reader once the price is a minute old", async () => {
    const p = harness()
    p.reached(true)
    await p.price.read()
    await p.price.read()
    expect(p.reads()).toBe(1)
    vi.setSystemTime(Date.now() + SAVINGS_PRICE_INTERVAL_MS)
    await p.price.read()
    expect(p.reads()).toBe(2)
    vi.useRealTimers()
  })
})

describe("exitSharePrice", () => {
  it("names the share price, and names none after a failed read", async () => {
    expect(await exitSharePrice({ read: async () => ({ sharePrice: ONE, readAt: 1 }) })).toBe(ONE)
    expect(
      await exitSharePrice({
        read: async () => {
          throw new Error("rpc down")
        },
      }),
    ).toBeUndefined()
  })
})
