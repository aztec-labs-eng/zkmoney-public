import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { AZTEC_NODE_URL } from "@obsidion/core/constants"

const h = vi.hoisted(() => ({
  ready: vi.fn(),
  debug: vi.fn(),
  warp: vi.fn(),
  warpTo: vi.fn(),
  blockData: vi.fn(),
}))
vi.mock("@aztec-labs/aztec.js/messaging", () => ({ isL1ToL2MessageReady: h.ready }))
vi.mock("@aztec-labs/stdlib/interfaces/client", () => ({ createAztecNodeDebugClient: h.debug }))

const { waitForSandboxL1ToL2Message, warpSandboxTimeTo } = await import("../../src/utils/helper.js")

const node = { getBlockData: h.blockData } as unknown as AztecNode
const wait = (timeoutSeconds = 5) => waitForSandboxL1ToL2Message(node, Fr.ZERO, { timeoutSeconds })
const lostSlot = () =>
  new Error(
    "Checkpoint or block for slot 34 is expired: L1 synced to 2 which is past the next slot start 1.",
  )
const atTime = (timestamp: bigint) => ({ header: { globalVariables: { timestamp } } })

beforeEach(() => {
  h.debug.mockReturnValue({ warpL2TimeAtLeastBy: h.warp, warpL2TimeAtLeastTo: h.warpTo })
  h.warp.mockResolvedValue(undefined)
  h.warpTo.mockResolvedValue(undefined)
})
afterEach(() => vi.resetAllMocks())

describe("waitForSandboxL1ToL2Message", () => {
  it("mines nothing for a message that is already consumable", async () => {
    h.ready.mockResolvedValue(true)
    await wait()
    expect(h.warp).not.toHaveBeenCalled()
  })

  it("warps one block at a time until the message is consumable", async () => {
    h.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
    await wait()
    expect(h.debug).toHaveBeenCalledWith(AZTEC_NODE_URL)
    expect(h.warp.mock.calls).toEqual([[1], [1]])
  })

  it("warps the node at nodeUrl", async () => {
    h.ready.mockResolvedValueOnce(false).mockResolvedValue(true)
    await waitForSandboxL1ToL2Message(node, Fr.ZERO, { nodeUrl: "http://localhost:8081" })
    expect(h.debug).toHaveBeenCalledWith("http://localhost:8081")
  })

  it("tries again when a warp loses the slot to a concurrent block", async () => {
    h.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
    h.warp.mockRejectedValueOnce(lostSlot())
    await wait()
    expect(h.warp).toHaveBeenCalledTimes(2)
  })

  it("fails on any other warp error", async () => {
    h.ready.mockResolvedValue(false)
    h.warp.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8080"))
    await expect(wait()).rejects.toThrow(/ECONNREFUSED/)
  })

  it("fails when the message is not consumable in time", async () => {
    h.ready.mockResolvedValue(false)
    await expect(wait(1)).rejects.toThrow(/Timeout awaiting L1→L2 message/)
  })
})

describe("warpSandboxTimeTo", () => {
  it("warps once to the target time", async () => {
    h.blockData.mockResolvedValue(atTime(1800n))
    await warpSandboxTimeTo(node, 1800)
    expect(h.warpTo.mock.calls).toEqual([[1800]])
    expect(h.warp).not.toHaveBeenCalled()
  })

  it("makes single blocks after a lost slot until the clock reaches the target", async () => {
    h.warpTo.mockRejectedValueOnce(lostSlot())
    h.blockData.mockResolvedValueOnce(atTime(100n)).mockResolvedValue(atTime(1872n))
    await warpSandboxTimeTo(node, 1800, { timeoutSeconds: 5 })
    expect(h.warpTo.mock.calls).toEqual([[1800]])
    expect(h.warp.mock.calls).toEqual([[1]])
  })

  it("fails on any other warp error", async () => {
    h.warpTo.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8080"))
    await expect(warpSandboxTimeTo(node, 1800)).rejects.toThrow(/ECONNREFUSED/)
  })
})
