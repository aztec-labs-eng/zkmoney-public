/**
 * SIPA resolver-operator discovery — unit tests. Pure L1-read composition, so the
 * PublicClient is a stub dispatching on functionName (plus the
 * `ResolverOperatorUpdated` log scan the candidate set comes from); no network,
 * no PXE. The live acceptance (the real AccountMetadataRegistry on Sepolia against
 * live dev.json) is env-gated behind LIVE_OXIDE=1 so default runs stay network-free.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPublicClient, http, type PublicClient } from "viem"
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"
import {
  fetchSipaResolverOperators,
  fetchHistoricalSipaResolverOperators,
  readAccountResolution,
  resetResolverOperatorHistoryForTests,
  selectManifestResolverOperator,
  type SipaResolverOperatorRecord,
} from "../../src/services/sipaResolverDiscovery.js"

const { readHistory } = vi.hoisted(() => ({ readHistory: vi.fn() }))
vi.mock("@oxide/l1-contracts/resolver_operator_history.js", () => ({
  readResolverOperatorHistory: readHistory,
}))

const LIVE_MANIFEST_URL =
  process.env.OXIDE_MANIFEST_URL ?? "https://d1162cdsa8f9md.cloudfront.net/dev.v4.json"
const LIVE_PORTAL = process.env.OXIDE_PORTAL ?? ""
const METADATA_REGISTRY = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f"
const OWNER_LIVE = "0xf902DF6c3d057230ac8c2FbD7a86aD03AFf2F871"
const OWNER_STALE = "0x1111111111111111111111111111111111111111"
const L2_LIVE = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"
const L2_STALE = "0x1e3946ea94b923f81e234eae1f8428873771588422e4f1002e6cea39162a04db"
const TABLE_LIVE = "0x1DDbB070F55c51b970cba7Ae185A1adC8BcC43DF"
const TABLE_STALE = "0xe49aBA0d10B72b11bd39a2E204f4d3aA9C466f78"
const ZERO = "0x0000000000000000000000000000000000000000"
const RESOLVER_KEY = { x: 1n, y: 2n }

/** resolverOperators(owner) tuple as the AccountMetadataRegistry ABI returns it (positional). */
const RECORDS: Record<string, [unknown, string, string, string]> = {
  [OWNER_LIVE]: [{ x: 1n, y: 2n }, L2_LIVE, "https://gw.live/{sender}/{data}.json", TABLE_LIVE],
  [OWNER_STALE]: [{ x: 3n, y: 4n }, L2_STALE, "https://gw.stale/{sender}/{data}.json", TABLE_STALE],
}

/** What a rate-limited RPC enforces: a numeric window, capped, with no earliest/latest strings. */
const RPC_MAX_RANGE = 50_000n

/** A caller's window. The reader has no default: every caller states the range it wants served. */
const RANGE = { fromBlock: 11_650_012n, toBlock: 11_670_012n }

function assertServedRange(args: { fromBlock?: unknown; toBlock?: unknown }): void {
  const { fromBlock, toBlock } = args
  if (typeof fromBlock !== "bigint" || typeof toBlock !== "bigint") {
    throw new Error(`unbounded log scan: fromBlock=${String(fromBlock)} toBlock=${String(toBlock)}`)
  }
  if (toBlock - fromBlock > RPC_MAX_RANGE) throw new Error("exceed maximum block range: 50000")
}

/**
 * `owners` is the ResolverOperatorUpdated history — repeats are expected (one log per
 * re-registration) and the reader dedupes them.
 */
function stubClient(owners: string[], head = 11_670_012n): PublicClient {
  return {
    getBlockNumber: async () => head,
    getContractEvents: async (args: {
      eventName: string
      fromBlock?: unknown
      toBlock?: unknown
    }) => {
      if (args.eventName !== "ResolverOperatorUpdated") {
        throw new Error(`unexpected event scan: ${args.eventName}`)
      }
      assertServedRange(args)
      return owners.map((owner) => ({ args: { resolverOperator: owner } }))
    },
    readContract: async (args: { functionName: string; args?: unknown[] }) => {
      if (args.functionName === "resolverOperators") {
        const [owner] = args.args as [string]
        // An address with a log but no record reads back zero-initialized (empty url).
        return RECORDS[owner] ?? [{ x: 0n, y: 0n }, `0x${"00".repeat(32)}`, "", ZERO]
      }
      throw new Error(`unexpected read: ${args.functionName}`)
    },
  } as unknown as PublicClient
}

describe("fetchSipaResolverOperators", () => {
  it("maps every logged operator to its current record, deduping repeat registrations", async () => {
    const records = await fetchSipaResolverOperators(
      stubClient([OWNER_LIVE, OWNER_STALE, OWNER_LIVE]),
      METADATA_REGISTRY,
      RANGE,
    )
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({
      owner: OWNER_LIVE,
      l2Address: L2_LIVE,
      url: "https://gw.live/{sender}/{data}.json",
      forwardingTable: TABLE_LIVE,
      // The self-resolve ECDH counterparty; the FPC pins these limbs in its config.
      resolverPublicKey: { x: 1n, y: 2n },
    })
    expect(records[1]!.owner).toBe(OWNER_STALE)
  })

  it("drops an address that has a log but no record (empty url sentinel)", async () => {
    expect(await fetchSipaResolverOperators(stubClient([ZERO]), METADATA_REGISTRY, RANGE)).toEqual(
      [],
    )
  })

  it("returns an empty array when no operator has ever registered", async () => {
    expect(await fetchSipaResolverOperators(stubClient([]), METADATA_REGISTRY, RANGE)).toEqual([])
  })

  it("serves the caller's window in chunks the RPC accepts, covering both ends", async () => {
    const wide = { fromBlock: 11_550_012n, toBlock: 11_670_012n }
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = []
    const client = {
      getContractEvents: async (args: {
        eventName: string
        fromBlock: bigint
        toBlock: bigint
      }) => {
        assertServedRange(args)
        ranges.push({ fromBlock: args.fromBlock, toBlock: args.toBlock })
        return [{ args: { resolverOperator: OWNER_LIVE } }]
      },
      readContract: async () => RECORDS[OWNER_LIVE],
    } as unknown as PublicClient

    const records = await fetchSipaResolverOperators(client, METADATA_REGISTRY, wide)

    expect(records).toHaveLength(1)
    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges[0]!.fromBlock).toBe(wide.fromBlock)
    expect(ranges.at(-1)!.toBlock).toBe(wide.toBlock)
    expect(ranges.every((r) => r.toBlock - r.fromBlock <= RPC_MAX_RANGE)).toBe(true)
  })
})

describe("selectManifestResolverOperator", () => {
  const records: SipaResolverOperatorRecord[] = [
    {
      owner: OWNER_STALE,
      l2Address: L2_STALE,
      url: "https://gw.stale/{sender}/{data}.json",
      forwardingTable: TABLE_STALE,
      resolverPublicKey: RESOLVER_KEY,
    },
    {
      owner: OWNER_LIVE,
      l2Address: L2_LIVE,
      url: "https://gw.live/{sender}/{data}.json",
      forwardingTable: TABLE_LIVE,
      resolverPublicKey: RESOLVER_KEY,
    },
  ]

  it("picks the record matching the manifest forwarding table, skipping stale ones", () => {
    const chosen = selectManifestResolverOperator(records, { forwardingTable: TABLE_LIVE })
    expect(chosen.owner).toBe(OWNER_LIVE)
    expect(chosen.l2Address).toBe(L2_LIVE)
  })

  it("matches case-insensitively (manifest vs checksummed record casing)", () => {
    const chosen = selectManifestResolverOperator(records, {
      forwardingTable: TABLE_LIVE.toLowerCase(),
    })
    expect(chosen.owner).toBe(OWNER_LIVE)
  })

  it("throws when no record matches the live deployment", () => {
    expect(() =>
      selectManifestResolverOperator(records, {
        forwardingTable: "0x9999999999999999999999999999999999999999",
      }),
    ).toThrow(/no resolver-operator record matches/)
  })

  it("also matches the gateway URL when the manifest carries one", () => {
    expect(() =>
      selectManifestResolverOperator(records, {
        forwardingTable: TABLE_LIVE,
        resolverGatewayUrl: "https://gw.other/{sender}/{data}.json",
      }),
    ).toThrow(/no resolver-operator record matches/)
    const chosen = selectManifestResolverOperator(records, {
      forwardingTable: TABLE_LIVE,
      resolverGatewayUrl: "https://gw.live/{sender}/{data}.json",
    })
    expect(chosen.owner).toBe(OWNER_LIVE)
  })

  it("prefers the known operator over an earlier squatter with identical record fields", () => {
    const squatter: SipaResolverOperatorRecord = {
      owner: "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0",
      l2Address: L2_STALE,
      url: "https://gw.live/{sender}/{data}.json",
      forwardingTable: TABLE_LIVE,
      resolverPublicKey: RESOLVER_KEY,
    }
    const chosen = selectManifestResolverOperator([squatter, ...records], {
      forwardingTable: TABLE_LIVE,
      preferredOwner: OWNER_LIVE.toLowerCase(),
    })
    expect(chosen.owner).toBe(OWNER_LIVE)
    // without the preference, ordering would have picked the squatter
    const unpreferred = selectManifestResolverOperator([squatter, ...records], {
      forwardingTable: TABLE_LIVE,
    })
    expect(unpreferred.owner).toBe(squatter.owner)
  })
})

describe("selectManifestResolverOperator — failOnAmbiguousMatch (mainnet fail-closed)", () => {
  const twoMatching: SipaResolverOperatorRecord[] = [
    {
      owner: OWNER_LIVE,
      l2Address: L2_LIVE,
      url: "https://gw.live/{sender}/{data}.json",
      forwardingTable: TABLE_LIVE,
      resolverPublicKey: RESOLVER_KEY,
    },
    {
      owner: "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0",
      l2Address: L2_STALE,
      url: "https://gw.live/{sender}/{data}.json",
      forwardingTable: TABLE_LIVE,
      resolverPublicKey: RESOLVER_KEY,
    },
  ]

  it("fails closed on multiple manifest-matching candidates with no preferred owner", () => {
    expect(() =>
      selectManifestResolverOperator(twoMatching, {
        forwardingTable: TABLE_LIVE,
        failOnAmbiguousMatch: true,
      }),
    ).toThrow(/anti-squatter fail-closed/)
  })

  it("returns the sole candidate under failOnAmbiguousMatch when unambiguous", () => {
    const chosen = selectManifestResolverOperator([twoMatching[0]!], {
      forwardingTable: TABLE_LIVE,
      failOnAmbiguousMatch: true,
    })
    expect(chosen.owner).toBe(OWNER_LIVE)
  })

  it("still honors a matching preferred owner even with failOnAmbiguousMatch set", () => {
    const chosen = selectManifestResolverOperator(twoMatching, {
      forwardingTable: TABLE_LIVE,
      preferredOwner: OWNER_LIVE,
      failOnAmbiguousMatch: true,
    })
    expect(chosen.owner).toBe(OWNER_LIVE)
  })

  it("first-matches (no throw) when failOnAmbiguousMatch is off — testnet behavior", () => {
    const chosen = selectManifestResolverOperator(twoMatching, {
      forwardingTable: TABLE_LIVE,
    })
    expect(chosen.owner).toBe(OWNER_LIVE)
  })
})

describe.runIf(process.env.LIVE_OXIDE === "1")("live dev.json resolver-operator discovery", () => {
  it("selects the Labs operator record consistent with the live manifest", async () => {
    const manifest = await (await fetch(LIVE_MANIFEST_URL)).json()
    const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal: LIVE_PORTAL })
    if (!tuple.accountMetadataRegistry) {
      throw new Error("live dev.json lacks the SIPA surface")
    }

    const client = createPublicClient({
      transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
    }) as PublicClient

    const head = await client.getBlockNumber()
    const fromBlock = BigInt(process.env.OXIDE_REGISTRY_FROM_BLOCK ?? String(head - 50_000n))
    const records = await fetchSipaResolverOperators(
      client,
      tuple.accountMetadataRegistry as never,
      { fromBlock, toBlock: head },
    )
    const chosen = selectManifestResolverOperator(records, {
      forwardingTable: tuple.forwardingTable!,
    })
    // The operator's L2 broadcast account — the registerSender target.
    expect(chosen.l2Address).toBe(L2_LIVE)
    expect(chosen.url).toBe(tuple.resolverGatewayUrl)
  }, 60_000)
})

describe("readAccountResolution", () => {
  const ACCOUNT = "0x4444444444444444444444444444444444444444"
  const USER_L2 = "0x0aa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f"

  function recordClient(hasRecord: boolean): PublicClient {
    return {
      readContract: async (args: { functionName: string; args?: unknown[] }) => {
        if (args.functionName === "hasUserRecord") return hasRecord
        if (args.functionName === "getUserRecord") {
          if (!hasRecord) throw new Error("reverted")
          return {
            l2Address: USER_L2,
            rollupVersion: 4127419662n,
            publicKey: { x: 5n, y: 6n },
            resolverOperator: OWNER_LIVE,
          }
        }
        if (args.functionName === "resolverOperators") return RECORDS[(args.args as [string])[0]]
        throw new Error(`unexpected read: ${args.functionName}`)
      },
    } as unknown as PublicClient
  }

  it("returns the user record with the operator entry it names", async () => {
    const resolution = await readAccountResolution(recordClient(true), METADATA_REGISTRY, ACCOUNT)
    expect(resolution).toEqual({
      l2Address: USER_L2,
      rollupVersion: 4127419662n,
      publicKey: { x: 5n, y: 6n },
      operator: {
        owner: OWNER_LIVE,
        l2Address: L2_LIVE,
        url: "https://gw.live/{sender}/{data}.json",
        forwardingTable: TABLE_LIVE,
        resolverPublicKey: { x: 1n, y: 2n },
      },
    })
  })

  it("is null for an account with no record", async () => {
    expect(await readAccountResolution(recordClient(false), METADATA_REGISTRY, ACCOUNT)).toBeNull()
  })
})

describe("historical resolver senders", () => {
  beforeEach(() => {
    readHistory.mockReset()
    resetResolverOperatorHistoryForTests()
  })

  const record = (owner: string, sender: string, table = TABLE_LIVE, blockNumber = 0n) => ({
    owner,
    blockNumber,
    entry: {
      l2Address: sender,
      oxidePortal: table,
      url: "https://gw.live/{sender}/{data}.json",
      publicKey: RESOLVER_KEY,
    },
  })
  const manifest = {
    forwardingTable: TABLE_LIVE,
    preferredOwner: OWNER_LIVE,
    failOnAmbiguousMatch: true,
  }

  it("recovers rotated source senders after overwrite, excluding other owners and duplicate senders", async () => {
    readHistory.mockResolvedValue([
      record(OWNER_STALE, L2_STALE),
      record(OWNER_LIVE, L2_LIVE),
      record(OWNER_LIVE, L2_STALE),
      record(OWNER_LIVE, L2_LIVE),
      record(OWNER_LIVE, L2_STALE, TABLE_STALE),
    ])
    const result = await fetchHistoricalSipaResolverOperators(
      {} as PublicClient,
      METADATA_REGISTRY,
      RANGE,
      manifest,
    )
    expect(result.map(({ owner, l2Address }) => [owner, l2Address])).toEqual([
      [OWNER_LIVE, L2_LIVE],
      [OWNER_LIVE, L2_STALE],
    ])
  })

  it("rejects competing owners but accepts rotations by one owner under the ambiguity policy", async () => {
    const policy = { forwardingTable: TABLE_LIVE, failOnAmbiguousMatch: true }
    readHistory.mockResolvedValue([record(OWNER_STALE, L2_STALE), record(OWNER_LIVE, L2_LIVE)])
    await expect(
      fetchHistoricalSipaResolverOperators({} as PublicClient, METADATA_REGISTRY, RANGE, policy),
    ).rejects.toThrow(/anti-squatter/)
    resetResolverOperatorHistoryForTests()
    readHistory.mockResolvedValue([record(OWNER_LIVE, L2_LIVE), record(OWNER_LIVE, L2_STALE)])
    const records = await fetchHistoricalSipaResolverOperators(
      {} as PublicClient,
      METADATA_REGISTRY,
      RANGE,
      policy,
    )
    expect(records.map(({ l2Address }) => l2Address)).toEqual([L2_LIVE, L2_STALE])
  })

  it("reads a registry's history once, then only the blocks past it", async () => {
    readHistory.mockResolvedValueOnce([record(OWNER_LIVE, L2_LIVE, TABLE_LIVE, RANGE.fromBlock)])
    const read = (toBlock: bigint) =>
      fetchHistoricalSipaResolverOperators(
        {} as PublicClient,
        METADATA_REGISTRY,
        { ...RANGE, toBlock },
        manifest,
      )
    await Promise.all([read(RANGE.toBlock), read(RANGE.toBlock)])
    expect(readHistory).toHaveBeenCalledTimes(1)

    readHistory.mockResolvedValueOnce([
      record(OWNER_LIVE, L2_STALE, TABLE_LIVE, RANGE.toBlock + 5n),
    ])
    const later = await read(RANGE.toBlock + 10n)
    expect(readHistory).toHaveBeenCalledTimes(2)
    expect(readHistory.mock.calls[1][2]).toEqual({
      fromBlock: RANGE.toBlock + 1n - 128n,
      toBlock: RANGE.toBlock + 10n,
    })
    expect(later.map(({ l2Address }) => l2Address)).toEqual([L2_LIVE, L2_STALE])
    // An earlier head reads nothing and sees only what it covers.
    expect((await read(RANGE.toBlock)).map(({ l2Address }) => l2Address)).toEqual([L2_LIVE])
    expect(readHistory).toHaveBeenCalledTimes(2)
  })

  it("keeps the history read so far when a later read fails", async () => {
    readHistory.mockResolvedValueOnce([record(OWNER_LIVE, L2_LIVE, TABLE_LIVE, RANGE.fromBlock)])
    const read = (toBlock: bigint) =>
      fetchHistoricalSipaResolverOperators(
        {} as PublicClient,
        METADATA_REGISTRY,
        { ...RANGE, toBlock },
        manifest,
      )
    await read(RANGE.toBlock)
    readHistory.mockRejectedValueOnce(new Error("rpc down"))
    await expect(read(RANGE.toBlock + 10n)).rejects.toThrow("rpc down")
    readHistory.mockResolvedValueOnce([])
    await read(RANGE.toBlock + 10n)
    expect(readHistory.mock.calls[2][2].fromBlock).toBe(RANGE.toBlock + 1n - 128n)
  })
})
