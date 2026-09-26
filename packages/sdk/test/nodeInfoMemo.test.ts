import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import type { AztecNode } from "@aztec/aztec.js/node"

const h = vi.hoisted(() => ({ createAztecNodeClient: vi.fn() }))
vi.mock("@aztec/aztec.js/node", () => ({ createAztecNodeClient: h.createAztecNodeClient }))

const { createNode, NODE_INFO_TTL_MS } = await import("../src/node/createNode.js")

/** A client counting `getNodeInfo` reads, with one other method to prove pass-through. */
function fakeClient(info: () => Promise<unknown> = async () => ({ rollupVersion: 1 })) {
  const calls = { getNodeInfo: 0, getBlockNumber: 0 }
  const client = {
    getNodeInfo: () => {
      calls.getNodeInfo++
      return info()
    },
    getBlockNumber: async () => {
      calls.getBlockNumber++
      return 7
    },
  }
  h.createAztecNodeClient.mockReturnValue(client as unknown as AztecNode)
  return calls
}

describe("createNode getNodeInfo memo", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("answers repeated reads from one round-trip", async () => {
    const calls = fakeClient()
    const node = createNode("http://node.invalid")

    await Promise.all([node.getNodeInfo(), node.getNodeInfo(), node.getNodeInfo()])
    await node.getNodeInfo()

    expect(calls.getNodeInfo).toBe(1)
  })

  it("re-reads once the answer is older than the ttl", async () => {
    const calls = fakeClient()
    const node = createNode("http://node.invalid")

    await node.getNodeInfo()
    vi.setSystemTime(Date.now() + NODE_INFO_TTL_MS + 1)
    await node.getNodeInfo()

    expect(calls.getNodeInfo).toBe(2)
  })

  it("does not remember a failed read", async () => {
    let attempt = 0
    const calls = fakeClient(async () => {
      if (++attempt === 1) throw new Error("node unreachable")
      return { rollupVersion: 1 }
    })
    const node = createNode("http://node.invalid")

    await expect(node.getNodeInfo()).rejects.toThrow("node unreachable")
    await expect(node.getNodeInfo()).resolves.toEqual({ rollupVersion: 1 })
    expect(calls.getNodeInfo).toBe(2)
  })

  it("passes every other method through untouched", async () => {
    const calls = fakeClient()
    const node = createNode("http://node.invalid")

    await node.getBlockNumber()
    await node.getBlockNumber()

    expect(calls.getBlockNumber).toBe(2)
  })
})
