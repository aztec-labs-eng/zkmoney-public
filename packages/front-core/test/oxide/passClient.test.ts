import { describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"
import { passClient } from "../../src/oxide/sipaClaims"

function client() {
  const getBlock = vi.fn(async (args?: { blockNumber?: bigint }) => ({
    number: args?.blockNumber,
    timestamp: 1n,
  }))
  const getBlockNumber = vi.fn(async () => 10n)
  return {
    raw: { getBlock, getBlockNumber } as unknown as PublicClient,
    getBlock,
    getBlockNumber,
  }
}

describe("passClient", () => {
  it("reads a block once for every caller in the pass", async () => {
    const c = client()
    const pass = passClient(c.raw)

    await Promise.all([pass.getBlock({ blockNumber: 5n }), pass.getBlock({ blockNumber: 5n })])

    expect(c.getBlock).toHaveBeenCalledTimes(1)
  })

  it("reads a block again after a failed read", async () => {
    const c = client()
    c.getBlock.mockRejectedValueOnce(new Error("rpc down"))
    const pass = passClient(c.raw)

    await expect(pass.getBlock({ blockNumber: 5n })).rejects.toThrow("rpc down")
    await expect(pass.getBlock({ blockNumber: 5n })).resolves.toMatchObject({ number: 5n })
    expect(c.getBlock).toHaveBeenCalledTimes(2)
  })

  it("passes through reads it does not cache: the latest block and the other actions", async () => {
    const c = client()
    const pass = passClient(c.raw)

    await pass.getBlock()
    await pass.getBlock()
    await pass.getBlockNumber()

    expect(c.getBlock).toHaveBeenCalledTimes(2)
    expect(c.getBlockNumber).toHaveBeenCalledTimes(1)
  })
})
