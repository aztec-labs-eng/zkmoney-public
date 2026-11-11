// @vitest-environment node
/**
 * A page's resolver-operator records: one read per chain, registry and deployment start, kept 5
 * minutes, saved with the block it reached so a later read scans only past it.
 */
import { createPace } from "@obsidion/core/cadence"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, PublicClient } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openDatabase, type Database } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { queries } from "../../src/engine/query"
import { memoryStore } from "../../src/engine/store"
import {
  deploymentScans,
  OPERATOR_SCAN_REORG_MARGIN,
  RESOLVER_RECORDS_REUSE_MS,
} from "../../src/oxide/resolverOperatorRecords"

const REGISTRY = `0x${"1c".repeat(20)}` as Address
const START = 900n
const TUPLE = {
  chainId: "1",
  deployedAtBlock: String(START),
  portal: `0x${"aa".repeat(20)}`,
} as OxideEnvTuple
const OWNER = `0x${"0a".repeat(20)}` as Address
const OTHER = `0x${"0b".repeat(20)}` as Address

const entry = (url: string) => ({
  publicKey: { x: 1n, y: 2n },
  l2Address: `0x${"22".repeat(32)}`,
  url,
  oxidePortal: `0x${"fb".repeat(20)}`,
})

/** The page's L1: its operator writes, filtered by the window each scan asks for. */
function l1(head = 1_000n) {
  const writes: { owner: Address; url: string; block: bigint }[] = []
  const chain = { head }
  const getContractEvents = vi.fn(
    async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      writes
        .filter((w) => w.block >= fromBlock && w.block <= toBlock)
        .map((w, logIndex) => ({
          args: { resolverOperator: w.owner, entry: entry(w.url) },
          blockNumber: w.block,
          logIndex,
          removed: false,
        })),
  )
  const getBlockNumber = vi.fn(async () => chain.head)
  const readContract = vi.fn(async () => {
    throw new Error("no per-operator read")
  })
  const client = { getContractEvents, getBlockNumber, readContract } as unknown as PublicClient
  return { client, writes, chain, getContractEvents, getBlockNumber, readContract }
}

/** One page's scans over `client`, saved in `db`. */
const page = (client: PublicClient, db: Database) =>
  deploymentScans(
    queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() }),
    () => client,
    db,
  )

const urls = async (scans: ReturnType<typeof page>, tuple = TUPLE) =>
  (await scans.operatorRecords(REGISTRY, tuple).read()).map((r) => [r.owner, r.url])

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }))
afterEach(() => vi.useRealTimers())

describe("operatorRecords", () => {
  it("builds the records from the events, with no per-operator read", async () => {
    const node = l1()
    node.writes.push(
      { owner: OWNER, url: "a", block: 950n },
      { owner: OTHER, url: "b", block: 960n },
    )
    expect(await urls(page(node.client, openDatabase(memoryBackend())))).toEqual([
      [OWNER, "a"],
      [OTHER, "b"],
    ])
    expect(node.readContract).not.toHaveBeenCalled()
    expect(node.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: START, toBlock: 1_000n }),
    )
  })

  it("lets an operator's later event replace its record", async () => {
    const node = l1()
    node.writes.push(
      { owner: OWNER, url: "a", block: 950n },
      { owner: OWNER, url: "a2", block: 990n },
    )
    expect(await urls(page(node.client, openDatabase(memoryBackend())))).toEqual([[OWNER, "a2"]])
  })

  it("scans a later session only from its saved block, less the reorg margin", async () => {
    const db = openDatabase(memoryBackend())
    const node = l1(10_000n)
    node.writes.push({ owner: OWNER, url: "a", block: 950n })
    await urls(page(node.client, db))
    node.chain.head = 10_500n
    node.writes.push({ owner: OTHER, url: "b", block: 10_400n })
    expect(await urls(page(node.client, db))).toEqual([
      [OWNER, "a"],
      [OTHER, "b"],
    ])
    expect(node.getContractEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fromBlock: 10_001n - OPERATOR_SCAN_REORG_MARGIN,
        toBlock: 10_500n,
      }),
    )
  })

  it("corrects an event a reorg dropped within the margin", async () => {
    const db = openDatabase(memoryBackend())
    const node = l1(10_000n)
    node.writes.push(
      { owner: OWNER, url: "a", block: 950n },
      { owner: OWNER, url: "dropped", block: 9_990n },
    )
    expect(await urls(page(node.client, db))).toEqual([[OWNER, "dropped"]])
    node.writes.pop()
    node.chain.head = 10_010n
    expect(await urls(page(node.client, db))).toEqual([[OWNER, "a"]])
  })

  it("shares one read for 5 minutes, then reads again", async () => {
    const node = l1()
    const scans = page(node.client, openDatabase(memoryBackend()))
    await urls(scans)
    await urls(scans, { ...TUPLE, portal: `0x${"bb".repeat(20)}` } as OxideEnvTuple)
    expect(node.getContractEvents).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + RESOLVER_RECORDS_REUSE_MS)
    await urls(scans)
    expect(node.getContractEvents).toHaveBeenCalledTimes(2)
  })

  it("fails with a config error, and reads nothing, for an entry naming no deployedAtBlock", async () => {
    const node = l1()
    const scans = page(node.client, openDatabase(memoryBackend()))
    const unplaced = { ...TUPLE, deployedAtBlock: undefined } as OxideEnvTuple
    await expect(async () =>
      scans.operatorRecords(REGISTRY, unplaced).read(),
    ).rejects.toMatchObject({
      code: "config.invalid",
    })
    expect(node.getBlockNumber).not.toHaveBeenCalled()
  })
})
