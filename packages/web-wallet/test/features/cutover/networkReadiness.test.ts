// @vitest-environment node
/** The network's readiness polls only while subscribed, and stops for good once proven. */
import { describe, expect, it } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import { fixed, memoryStore, queries } from "@obsidion/front-core"
import { networkReadiness } from "../../../src/features/cutover/networkReadiness"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const node = {
    proven: 0,
    reads: 0,
    async getCheckpointNumber() {
      node.reads++
      return node.proven
    },
  }
  const pace = createPace({ signalled: true })
  const entry = networkReadiness(
    queries({ pace, visible: memoryStore(true).readonly, now: () => Date.now() }),
    fixed("wallet", { node }),
  )
  const ready = () => {
    const s = entry.get()
    return s.status === "ready" && s.value
  }
  return { node, pace, entry, ready }
}

describe("networkReadiness", () => {
  it("stops polling when the last subscriber leaves", async () => {
    const { node, pace, entry, ready } = setup()
    const off = entry.subscribe(() => {})
    await settle()
    pace.wake()
    await settle()
    expect([node.reads, ready()]).toEqual([2, false])

    off()
    pace.wake()
    await settle()
    expect(node.reads).toBe(2)
  })

  it("stops polling once the network has proven a checkpoint", async () => {
    const { node, pace, entry, ready } = setup()
    node.proven = 1
    const off = entry.subscribe(() => {})
    await settle()
    pace.wake()
    await settle()
    expect([node.reads, ready()]).toEqual([1, true])
    off()
  })
})
