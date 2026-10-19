import { describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"
import { passClient } from "../../src/oxide/sipaClaims"

const HASH = `0x${"ab".repeat(32)}` as const

function client() {
  const getTransactionReceipt = vi.fn(async () => ({ logs: [] }))
  const getBlock = vi.fn(async (args?: { blockNumber?: bigint }) => ({
    number: args?.blockNumber,
    timestamp: 1n,
  }))
  const getBlockNumber = vi.fn(async () => 10n)
  return {
    raw: { getTransactionReceipt, getBlock, getBlockNumber } as unknown as PublicClient,
    getTransactionReceipt,
    getBlock,
    getBlockNumber,
  }
}

describe("passClient", () => {
  it("reads a receipt and a block once for every caller in the pass", async () => {
    const c = client()
    const pass = passClient(c.raw)

    await Promise.all([
      pass.getTransactionReceipt({ hash: HASH }),
      pass.getTransactionReceipt({ hash: HASH.toUpperCase().replace("0X", "0x") as `0x${string}` }),
      pass.getBlock({ blockNumber: 5n }),
      pass.getBlock({ blockNumber: 5n }),
    ])

    expect(c.getTransactionReceipt).toHaveBeenCalledTimes(1)
    expect(c.getBlock).toHaveBeenCalledTimes(1)
  })

  it("reads a receipt again after a failed read", async () => {
    const c = client()
    c.getTransactionReceipt.mockRejectedValueOnce(new Error("rpc down"))
    const pass = passClient(c.raw)

    await expect(pass.getTransactionReceipt({ hash: HASH })).rejects.toThrow("rpc down")
    await expect(pass.getTransactionReceipt({ hash: HASH })).resolves.toEqual({ logs: [] })
    expect(c.getTransactionReceipt).toHaveBeenCalledTimes(2)
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
