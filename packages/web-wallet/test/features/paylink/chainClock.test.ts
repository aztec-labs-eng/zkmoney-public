// @vitest-environment node
/** The page's chain clock: a subscriber gets a value once a read lands, and polls stop with it. */
import { describe, expect, it } from "vitest"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { createPace } from "@obsidion/core/cadence"
import { fixed, memoryStore, queries } from "@obsidion/front-core"
import { chainClock } from "../../../src/features/paylink/chainClock"

const TIP = { block: 31, seconds: 1_794_004_842 }

/** A node at `TIP` whose reads wait for `release` while `held`, and fail while `down`. */
function fakeNode() {
  const node = {
    held: false,
    down: false,
    blockReads: 0,
    waiting: [] as (() => void)[],
    release() {
      for (const done of node.waiting.splice(0)) done()
    },
    async getBlockNumber() {
      node.blockReads++
      if (node.held) await new Promise<void>((resolve) => node.waiting.push(resolve))
      if (node.down) throw new Error("node down")
      return TIP.block
    },
    async getBlockData() {
      return {
        header: { globalVariables: { blockNumber: TIP.block, timestamp: BigInt(TIP.seconds) } },
      }
    },
  }
  return node
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Signalled, as in a test world: a poll reads only on a wake. */
function clockOf(node: ReturnType<typeof fakeNode>, now = () => Date.now()) {
  const pace = createPace({ signalled: true })
  const query = queries({ pace, visible: memoryStore(true).readonly, now })
  return { pace, clock: chainClock(query, fixed("wallet", { node: node as unknown as AztecNode })) }
}

describe("chainClock", () => {
  it("reads again for a subscriber that arrives while an earlier read is still out", async () => {
    const node = fakeNode()
    node.held = true
    const { clock } = clockOf(node)

    const offFirst = clock.subscribe(() => {})
    await settle()
    // The view that read the value leaves as it lands, and the next one opens: the clock goes
    // unsubscribed and is subscribed again before the read in flight has returned.
    let offNext = () => {}
    const swap = clock.subscribe(() => {
      if (clock.get() === undefined) return
      swap()
      offFirst()
      offNext = clock.subscribe(() => {})
    })
    node.held = false
    node.release()
    await settle()

    expect(clock.get()).toBe(TIP.seconds)
    offNext()
  })

  it.each([
    ["a read in flight", { held: true, down: false }],
    ["a failed read", { held: false, down: true }],
  ])("withholds the last tip from a subscriber after a gap, through %s", async (_, after) => {
    let now = 1_000_000
    const node = fakeNode()
    const { pace, clock } = clockOf(node, () => now)
    const off = clock.subscribe(() => {})
    await settle()
    expect(clock.get()).toBe(TIP.seconds)
    off()

    now += 60_000
    Object.assign(node, after)
    const offAgain = clock.subscribe(() => {})
    await settle()
    expect(clock.get()).toBeUndefined()
    // The next read succeeds: the one held, or the poll after the failure.
    Object.assign(node, { down: false })
    node.release()
    pace.wake()
    await settle()
    expect(clock.get()).toBe(TIP.seconds)
    offAgain()
  })

  it("withholds the tip once a poll fails, until a read lands", async () => {
    const node = fakeNode()
    const { pace, clock } = clockOf(node)
    const off = clock.subscribe(() => {})
    await settle()
    expect(clock.get()).toBe(TIP.seconds)
    node.down = true
    pace.wake()
    await settle()
    expect(clock.get()).toBeUndefined()
    node.down = false
    pace.wake()
    await settle()
    expect(clock.get()).toBe(TIP.seconds)
    off()
  })

  it("polls the node while subscribed and stops when the last subscriber leaves", async () => {
    const node = fakeNode()
    const { pace, clock } = clockOf(node)
    const off = clock.subscribe(() => {})
    await settle()
    pace.wake()
    await settle()
    expect(node.blockReads).toBe(2)

    off()
    pace.wake()
    await settle()
    expect(node.blockReads).toBe(2)
  })
})
