import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AztecNode } from "@aztec/aztec.js/node"
import { CHAIN_POLL_MS, usePolledChainSeconds } from "../src/features/paylink/chainTime"

/**
 * A node whose tip only advances when the test says so, counting each read: the clock's whole job
 * is to ask for block data less often than it asks for the tip.
 */
function fakeNode() {
  let block = 7
  let timestamp = 1000
  const calls = { getBlockNumber: 0, getBlockData: 0 }
  const node = {
    getBlockNumber: async () => {
      calls.getBlockNumber++
      return block
    },
    getBlockData: async () => {
      calls.getBlockData++
      return { header: { globalVariables: { blockNumber: block, timestamp } } }
    },
  } as unknown as AztecNode
  return {
    node,
    calls,
    mine(seconds: number) {
      block++
      timestamp = seconds
    },
  }
}

/** Mount one surface reading the clock; `current()` is the latest value it rendered with. */
function mountSurface(node: AztecNode) {
  const seen: (number | undefined)[] = []
  const Probe = () => {
    seen.push(usePolledChainSeconds(node))
    return null
  }
  const root = createRoot(document.createElement("div"))
  act(() => root.render(<Probe />))
  return {
    current: () => seen[seen.length - 1],
    unmount: () => act(() => root.unmount()),
  }
}

/** Run the pending timer and let the read's promise chain settle. */
const tick = (ms = CHAIN_POLL_MS) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

describe("usePolledChainSeconds", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("reads block data only when the tip moves", async () => {
    const chain = fakeNode()
    const surface = mountSurface(chain.node)

    await tick(0)
    expect(surface.current()).toBe(1000)
    expect(chain.calls.getBlockData).toBe(1)

    // Three ticks on a still chain cost three tip probes and no block data.
    await tick()
    await tick()
    await tick()
    expect(chain.calls.getBlockData).toBe(1)

    chain.mine(1072)
    await tick()
    expect(surface.current()).toBe(1072)
    expect(chain.calls.getBlockData).toBe(2)
  })

  it("polls once for any number of mounted surfaces", async () => {
    const chain = fakeNode()
    const surfaces = [mountSurface(chain.node), mountSurface(chain.node), mountSurface(chain.node)]

    await tick(0)
    const afterFirstRead = chain.calls.getBlockNumber
    await tick()
    // One poller, not three: the tip is probed once per interval however many surfaces are up.
    expect(chain.calls.getBlockNumber).toBe(afterFirstRead + 1)

    chain.mine(1072)
    await tick()
    for (const s of surfaces) expect(s.current()).toBe(1072)
  })

  it("reports the tip to a surface that mounts after the last one left", async () => {
    const chain = fakeNode()
    const first = mountSurface(chain.node)
    await tick(0)
    expect(first.current()).toBe(1000)
    first.unmount()

    // The chain has not moved between the two mounts, so the tip probe alone tells the new surface
    // nothing; it still has to learn the time it is gating on.
    const second = mountSurface(chain.node)
    await tick(0)
    expect(second.current()).toBe(1000)
  })

  it("stops polling once the last surface unmounts", async () => {
    const chain = fakeNode()
    const first = mountSurface(chain.node)
    const second = mountSurface(chain.node)
    await tick(0)

    first.unmount()
    await tick()
    const whileOneRemains = chain.calls.getBlockNumber
    expect(whileOneRemains).toBeGreaterThan(0)

    second.unmount()
    await tick()
    await tick()
    expect(chain.calls.getBlockNumber).toBe(whileOneRemains)
  })
})
