/**
 * Unit spec for `IntraRollupMigrationService.detectMigration` — manifest fetch + cached-tuple
 * diff, no sandbox. The manifest shapes mirror the oxide env registry schema v4.
 */

import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PublicClient } from "viem"
import { describe, expect, it } from "vitest"

import { IntraRollupMigrationService, Network } from "../../src/index.js"

const MANIFEST_URL = "https://example.test/staging.v4.json"

const PORTAL_A = "0x" + "aa".repeat(20)
const PORTAL_B = "0x" + "bb".repeat(20)
const PORTAL_C = "0x" + "ee".repeat(20)
const L2_TOKEN_A = "0x" + "01".repeat(32)
const L2_TOKEN_B = "0x" + "02".repeat(32)
const L2_TOKEN_C = "0x" + "03".repeat(32)

interface Entry {
  portal: string
  l2Token: string
  timestamp: string
  rollupVersion?: string
  /** Absent on an entry published before withdraw-and-execute. */
  plainWithdrawalExecutor?: string | null
}

function deployment(entry: Entry) {
  return {
    schemaVersion: "1",
    label: entry.portal.slice(0, 6),
    portal: entry.portal,
    l2Token: entry.l2Token,
    deployedAt: entry.timestamp,
    updatedAt: entry.timestamp,
    gitSha: "deadbeef",
    rollupVersion: entry.rollupVersion ?? "7",
    chainId: "31337",
    token: "0x" + "cc".repeat(20),
    enclaveUrl: "https://tee.example.test/rpc",
    pcr0: "0x" + "dd".repeat(48),
    ...(entry.plainWithdrawalExecutor === null
      ? {}
      : { plainWithdrawalExecutor: entry.plainWithdrawalExecutor ?? "0x" + "ab".repeat(20) }),
    l2Broadcaster: "0x" + "44".repeat(32),
  }
}

function manifest(...entries: Entry[]) {
  return { schemaVersion: "4", deployments: entries.map(deployment) }
}

function fetchReturning(body: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => body } as Response)) as typeof fetch
}

const DAI = "0x" + "cc".repeat(20)
const SUSDS = "0x" + "5d".repeat(20)

/** L1 reads answering each portal's UNDERLYING; unlisted portals escrow DAI. */
function underlyings(byPortal: Record<string, string> = {}): PublicClient {
  return {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      expect(functionName).toBe("UNDERLYING")
      return byPortal[address] ?? DAI
    },
  } as unknown as PublicClient
}
const sameUnderlying = underlyings()

function mapCache() {
  const map = new Map<string, string>()
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
  }
}

const TUPLE_A = { portal: PORTAL_A, l2Token: L2_TOKEN_A, timestamp: "2026-08-01T00:00:00Z" }
/** Same portal, new L2 token: the roll `detectMigration` reports under a portal pin. */
const TUPLE_A_ROLLED = { portal: PORTAL_A, l2Token: L2_TOKEN_B, timestamp: "2026-08-15T00:00:00Z" }
const TUPLE_B = { portal: PORTAL_B, l2Token: L2_TOKEN_B, timestamp: "2026-08-15T00:00:00Z" }
const TUPLE_C = { portal: PORTAL_C, l2Token: L2_TOKEN_C, timestamp: "2026-08-20T00:00:00Z" }

describe("IntraRollupMigrationService.detectMigration", () => {
  it("baselines silently on first run", async () => {
    const cache = mapCache()
    const detection = await IntraRollupMigrationService.detectMigration({
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_A,
      network: Network.SANDBOX,
      cache,
      fetchImpl: fetchReturning(manifest(TUPLE_A)),
    })
    expect(detection.changed).toBe(false)
    expect(detection.previous).toBeUndefined()
    expect(detection.current.portal).toBe(PORTAL_A)
  })

  it("reports no change while the deployment holds", async () => {
    const cache = mapCache()
    const detect = (timestamp: string) =>
      IntraRollupMigrationService.detectMigration({
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_A,
        network: Network.SANDBOX,
        cache,
        fetchImpl: fetchReturning(manifest({ ...TUPLE_A, timestamp })),
      })
    await detect("2026-08-01T00:00:00Z")
    const second = await detect("2026-08-02T00:00:00Z")
    expect(second.changed).toBe(false)
  })

  it("reports a roll with the retiring coordinates intact until acknowledged", async () => {
    const cache = mapCache()
    const detect = (m: Entry) =>
      IntraRollupMigrationService.detectMigration({
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_A,
        network: Network.SANDBOX,
        cache,
        fetchImpl: fetchReturning(manifest(m)),
      })
    await detect(TUPLE_A)

    const rolled = await detect(TUPLE_A_ROLLED)
    expect(rolled.changed).toBe(true)
    expect(rolled.previous?.portal).toBe(PORTAL_A)
    expect(rolled.previous?.l2Token).toBe(L2_TOKEN_A)
    expect(rolled.current.l2Token).toBe(L2_TOKEN_B)

    // Unacknowledged: a re-detect still reports the roll with the OLD coordinates — the drain's
    // inputs must survive an app restart between detection and migration.
    const again = await detect(TUPLE_A_ROLLED)
    expect(again.changed).toBe(true)
    expect(again.previous?.l2Token).toBe(L2_TOKEN_A)

    await again.acknowledge()
    const after = await detect(TUPLE_A_ROLLED)
    expect(after.changed).toBe(false)
  })

  it("ignores a manifest older than the baseline (stale CDN read)", async () => {
    const cache = mapCache()
    const detect = (m: Entry) =>
      IntraRollupMigrationService.detectMigration({
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_A,
        network: Network.SANDBOX,
        cache,
        fetchImpl: fetchReturning(manifest(m)),
      })
    await detect(TUPLE_A_ROLLED)

    // An old tuple with a DIFFERENT l2Token must not read as a migration.
    const stale = await detect(TUPLE_A)
    expect(stale.changed).toBe(false)
    expect(stale.current.l2Token).toBe(L2_TOKEN_B)

    // And it must not have rolled the baseline backwards.
    const fresh = await detect(TUPLE_A_ROLLED)
    expect(fresh.changed).toBe(false)
  })

  it("throws when the pinned portal is absent from the manifest", async () => {
    await expect(
      IntraRollupMigrationService.detectMigration({
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_B,
        network: Network.SANDBOX,
        cache: mapCache(),
        fetchImpl: fetchReturning(manifest(TUPLE_A)),
      }),
    ).rejects.toThrow(/no deployment for pinned portal/)
  })

  it("throws on a failed fetch", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 } as Response)) as typeof fetch
    await expect(
      IntraRollupMigrationService.detectMigration({
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_A,
        network: Network.SANDBOX,
        cache: mapCache(),
        fetchImpl,
      }),
    ).rejects.toThrow(/manifest fetch failed \(503\)/)
  })
})

describe("IntraRollupMigrationService.detectHistoricDeployments", () => {
  it("returns explicitly selected same-rollup entries, empty when the pin stands alone", async () => {
    const bare = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: sameUnderlying,
      sourcePortals: new Set([PORTAL_A, PORTAL_B]),
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_B,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_B)),
    })
    expect(bare.current.portal).toBe(PORTAL_B)
    expect(bare.historic).toEqual([])

    const rolled = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: sameUnderlying,
      sourcePortals: new Set([PORTAL_A, PORTAL_B]),
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_B,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B)),
    })
    expect(rolled.current.portal).toBe(PORTAL_B)
    expect(rolled.historic).toHaveLength(1)
    expect(rolled.historic[0]!.portal).toBe(PORTAL_A)
    expect(rolled.historic[0]!.l2Token).toBe(L2_TOKEN_A)
  })

  it("keeps every selected source after two rolls (A → B → C)", async () => {
    const twice = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: sameUnderlying,
      sourcePortals: new Set([PORTAL_A, PORTAL_B]),
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_C,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B, TUPLE_C)),
    })
    expect(twice.current.portal).toBe(PORTAL_C)
    // Funds stuck on A must still be probed once the app is on C.
    expect(twice.historic.map((t) => t.portal)).toEqual([PORTAL_A, PORTAL_B])
  })

  it("leaves an unselected deployment on another rollup out", async () => {
    const found = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: sameUnderlying,
      sourcePortals: new Set([PORTAL_A, PORTAL_B]),
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_B,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B, { ...TUPLE_C, rollupVersion: "8" })),
    })
    expect(found.current.version).toBe(PORTAL_B.slice(0, 6))
    expect(found.historic.map((t) => t.portal)).toEqual([PORTAL_A])
  })

  it("leaves an entry without a plain withdrawal executor out", async () => {
    const found = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: sameUnderlying,
      sourcePortals: new Set([PORTAL_A, PORTAL_B]),
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_C,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(
        manifest({ ...TUPLE_A, plainWithdrawalExecutor: null }, TUPLE_B, TUPLE_C),
      ),
    })
    expect(found.historic.map((t) => t.portal)).toEqual([PORTAL_B])
    expect(found.historic[0]!.plainWithdrawalExecutor).toBe("0x" + "ab".repeat(20))
  })

  it("leaves out an entry whose portal escrows another underlying", async () => {
    const found = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: underlyings({ [PORTAL_C]: SUSDS }),
      sourcePortals: new Set([PORTAL_A, PORTAL_C]),
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_B,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B, TUPLE_C)),
    })
    expect(found.historic.map((t) => t.portal)).toEqual([PORTAL_A])
  })

  it("adds another manifest's deployments the caller can reach, once each", async () => {
    const v5 = {
      portal: "0x" + "c5".repeat(20),
      l2Token: L2_TOKEN_C,
      rollupVersion: "5",
      plainWithdrawalExecutor: "0x" + "ab".repeat(20),
    } as OxideEnvTuple
    const unreachable = { ...v5, portal: "0x" + "d5".repeat(20) }
    const noExecutor = { ...v5, portal: "0x" + "e5".repeat(20), plainWithdrawalExecutor: undefined }
    const found = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: sameUnderlying,
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_B,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B)),
      sourcePortals: new Set([v5.portal, noExecutor.portal, PORTAL_A.toLowerCase()]),
      otherSources: [v5, unreachable, noExecutor, { ...v5 }],
    })
    expect(found.historic.map((t) => t.portal)).toEqual([PORTAL_A, v5.portal])
  })

  describe("with a product of another asset on the pinned rollup", () => {
    const savings = { ...TUPLE_C, rollupVersion: "7" }
    const v5 = (portal: string) =>
      ({
        portal,
        l2Token: L2_TOKEN_C,
        rollupVersion: "5",
        plainWithdrawalExecutor: "0x" + "ab".repeat(20),
      }) as OxideEnvTuple
    const V5_DAI = "0x" + "c5".repeat(20)
    const V5_SUSDS = "0x" + "d5".repeat(20)
    const V5_OTHER = "0x" + "f5".repeat(20)

    const detect = async () => {
      const { current } = await IntraRollupMigrationService.detectHistoricDeployments({
        publicClient: sameUnderlying,
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_B,
        network: Network.SANDBOX,
        fetchImpl: fetchReturning(manifest(TUPLE_B)),
      })
      const product = { ...current, portal: PORTAL_C }
      const found = await IntraRollupMigrationService.detectHistoricDeployments({
        publicClient: underlyings({
          [PORTAL_C]: SUSDS,
          [V5_SUSDS]: SUSDS,
          [V5_OTHER]: "0x" + "99".repeat(20),
        }),
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_B,
        network: Network.SANDBOX,
        fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B, savings)),
        sourcePortals: new Set([PORTAL_A, V5_DAI, V5_SUSDS, V5_OTHER]),
        otherSources: [v5(V5_DAI), v5(V5_SUSDS), v5(V5_OTHER)],
        products: [product],
      })
      return { found, product }
    }

    it("moves another rollup's deployment of that asset into the product", async () => {
      const { found, product } = await detect()
      expect(found.historic.map((t) => t.portal)).toEqual([PORTAL_A, V5_DAI, V5_SUSDS])
      expect(found.destinations.get(V5_SUSDS)).toBe(product)
      expect(found.destinations.get(V5_DAI)).toBe(found.current)
      expect(found.destinations.get(PORTAL_A.toLowerCase())).toBe(found.current)
    })

    it("never lists the product, and drops an asset no product holds", async () => {
      const { found } = await detect()
      expect(found.historic.map((t) => t.portal)).not.toContain(PORTAL_C)
      expect(found.historic.map((t) => t.portal)).not.toContain(V5_OTHER)
    })
  })

  it("reads no historical L1 state without profile-selected sources", async () => {
    const noReads = {
      readContract: async () => {
        throw new Error("unexpected L1 read")
      },
    } as unknown as PublicClient
    const found = await IntraRollupMigrationService.detectHistoricDeployments({
      publicClient: noReads,
      manifestUrl: MANIFEST_URL,
      portal: PORTAL_B,
      network: Network.SANDBOX,
      fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B, TUPLE_C)),
    })
    expect(found.historic).toEqual([])
  })

  it("throws when an underlying cannot be read", async () => {
    const failing = {
      readContract: async () => {
        throw new Error("rpc down")
      },
    } as unknown as PublicClient
    await expect(
      IntraRollupMigrationService.detectHistoricDeployments({
        publicClient: failing,
        sourcePortals: new Set([PORTAL_A]),
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_B,
        network: Network.SANDBOX,
        fetchImpl: fetchReturning(manifest(TUPLE_A, TUPLE_B)),
      }),
    ).rejects.toThrow(/rpc down/)
  })

  it("throws on a failed fetch", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 } as Response)) as typeof fetch
    await expect(
      IntraRollupMigrationService.detectHistoricDeployments({
        publicClient: sameUnderlying,
        manifestUrl: MANIFEST_URL,
        portal: PORTAL_A,
        network: Network.SANDBOX,
        fetchImpl,
      }),
    ).rejects.toThrow(/manifest fetch failed \(500\)/)
  })
})

describe("the mainnet gate on the pinned entry", () => {
  const prodEntry = {
    ...deployment(TUPLE_A),
    gitSha: "b".repeat(40),
    nameRegistry: "0x" + "11".repeat(20),
    resolverGatewayUrl: "https://resolver.example/{sender}/{data}.json",
  }
  const args = {
    publicClient: sameUnderlying,
    manifestUrl: MANIFEST_URL,
    portal: PORTAL_A,
    network: Network.MAINNET,
    expectedGitSha: "a".repeat(40),
    fetchImpl: fetchReturning({ schemaVersion: "4", deployments: [prodEntry] }),
  }

  it("accepts a mainnet entry from another cut in both loaders", async () => {
    await expect(IntraRollupMigrationService.detectHistoricDeployments(args)).resolves.toMatchObject({
      current: { portal: PORTAL_A, gitSha: prodEntry.gitSha },
    })
    await expect(
      IntraRollupMigrationService.detectMigration({ ...args, cache: mapCache() }),
    ).resolves.toMatchObject({ current: { portal: PORTAL_A, gitSha: prodEntry.gitSha } })
  })

  it("accepts the expected cut and bare-extracts off mainnet", async () => {
    const pinned = { ...args, expectedGitSha: "b".repeat(40) }
    expect(
      (await IntraRollupMigrationService.detectHistoricDeployments(pinned)).current.gitSha,
    ).toBe("b".repeat(40))
    const sandbox = { ...args, network: Network.SANDBOX }
    expect(
      (await IntraRollupMigrationService.detectHistoricDeployments(sandbox)).current.portal,
    ).toBe(PORTAL_A)
  })
})
