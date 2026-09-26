import { describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PublicClient } from "viem"
import { deploymentScanRange, findBlockAtTime } from "../../src/oxide/deploymentScanRange"

const GENESIS_SEC = 1_700_000_000n
const BLOCK_SEC = 12n

const at = (block: bigint) => Number(GENESIS_SEC + block * BLOCK_SEC)
const iso = (block: bigint) => new Date(at(block) * 1000).toISOString()

function chain(head = 25_000n) {
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
    timestamp: GENESIS_SEC + blockNumber * BLOCK_SEC,
  }))
  const getBlockNumber = vi.fn(async () => head)
  return { client: { getBlock, getBlockNumber } as unknown as PublicClient, getBlock }
}

/** The search cache outlives one test, so each tuple takes its own chain unless it says otherwise. */
let chains = 0
const tuple = (over: Partial<OxideEnvTuple> = {}): OxideEnvTuple =>
  ({
    portal: "0x" + "aa".repeat(20),
    chainId: String(++chains),
    deployedAt: iso(12_000n),
    timestamp: iso(24_000n),
    ...over,
  } as OxideEnvTuple)

describe("findBlockAtTime", () => {
  it.each([0n, 1n, 12_000n, 24_999n, 25_000n])(
    "finds the first block at or after a timestamp landing on block %s",
    async (block) => {
      const { client } = chain()
      await expect(findBlockAtTime(client, at(block), 25_000n)).resolves.toBe(block)
    },
  )

  it("returns the first block after a timestamp that falls between two blocks", async () => {
    const { client } = chain()
    await expect(findBlockAtTime(client, at(500n) - 1, 25_000n)).resolves.toBe(500n)
  })

  it("costs about log2(head) header reads and never reads state", async () => {
    const { client, getBlock } = chain()
    await findBlockAtTime(client, at(11_650_462n), 11_670_012n)
    expect(getBlock.mock.calls.length).toBeLessThanOrEqual(26)
  })

  it("throws when no header can be read, rather than guessing a window", async () => {
    const client = {
      getBlock: async () => Promise.reject(new Error("pruned history unavailable")),
    } as unknown as PublicClient
    await expect(findBlockAtTime(client, at(10n), 25_000n)).rejects.toThrow(/pruned history/)
  })

  it("throws when one midpoint read fails, rather than moving the bound past it", async () => {
    const { client, getBlock } = chain()
    getBlock.mockImplementationOnce(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: GENESIS_SEC + blockNumber * BLOCK_SEC,
    }))
    getBlock.mockImplementationOnce(async () => Promise.reject(new Error("rate limited")))
    await expect(findBlockAtTime(client, at(10n), 25_000n)).rejects.toThrow(/rate limited/)
  })

  it("answers undefined when the chain has not reached the target, and does not throw", async () => {
    const { client } = chain()
    await expect(findBlockAtTime(client, at(30_000n), 25_000n)).resolves.toBeUndefined()
  })
})

describe("deploymentScanRange", () => {
  it("takes the manifest's deployedAtBlock without reading a single header", async () => {
    const { client, getBlock } = chain()
    await expect(
      deploymentScanRange(client, tuple({ deployedAtBlock: "9876" }), 25_000n),
    ).resolves.toEqual({ fromBlock: 9_876n, toBlock: 25_000n })
    expect(getBlock).not.toHaveBeenCalled()
  })

  it("collapses onto the head rather than inverting when deployedAtBlock is above it", async () => {
    // An RPC behind a freshly published manifest. An inverted range is skipped whole by
    // chunkedContractEvents, which reads as a clean scan that found nothing.
    const { client } = chain()
    await expect(
      deploymentScanRange(client, tuple({ deployedAtBlock: "30000" }), 25_000n),
    ).resolves.toEqual({ fromBlock: 25_000n, toBlock: 25_000n })
  })

  it("falls back to the block of deployedAt, not of the later updatedAt", async () => {
    const { client } = chain()
    await expect(deploymentScanRange(client, tuple(), 25_000n)).resolves.toEqual({
      fromBlock: 12_000n,
      toBlock: 25_000n,
    })
  })

  it("reads the head itself when the caller has none", async () => {
    const { client } = chain()
    await expect(deploymentScanRange(client, tuple())).resolves.toMatchObject({
      toBlock: 25_000n,
    })
  })

  it("searches once per chain and deployment, across separate clients", async () => {
    const shared = tuple()
    const first = chain()
    await deploymentScanRange(first.client, shared, 25_000n)
    expect(first.getBlock.mock.calls.length).toBeGreaterThan(0)

    const second = chain()
    await expect(deploymentScanRange(second.client, shared, 25_000n)).resolves.toMatchObject({
      fromBlock: 12_000n,
    })
    expect(second.getBlock).not.toHaveBeenCalled()
  })

  it("does not cache a failed search", async () => {
    const shared = tuple()
    const { client, getBlock } = chain()
    getBlock.mockImplementationOnce(async () => Promise.reject(new Error("rate limited")))
    await expect(deploymentScanRange(client, shared, 25_000n)).rejects.toThrow(/rate limited/)
    await expect(deploymentScanRange(client, shared, 25_000n)).resolves.toMatchObject({
      fromBlock: 12_000n,
    })
  })

  it("holds only the head while no block has reached deployedAt, and re-searches once one has", async () => {
    const unborn = tuple({ deployedAt: iso(30_000n) })
    const early = chain()
    await expect(deploymentScanRange(early.client, unborn, 25_000n)).resolves.toEqual({
      fromBlock: 25_000n,
      toBlock: 25_000n,
    })

    const later = chain(35_000n)
    await expect(deploymentScanRange(later.client, unborn)).resolves.toEqual({
      fromBlock: 30_000n,
      toBlock: 35_000n,
    })
  })
})
