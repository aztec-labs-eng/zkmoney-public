import { afterEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { Network } from "@obsidion/core/constants"
import { AccountStorage } from "../../src/core/storages/AccountStorage"

const sdkMocks = vi.hoisted(() => ({
  fetchSipaResolverOperators: vi.fn(),
  selectManifestResolverOperator: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  fetchSipaResolverOperators: sdkMocks.fetchSipaResolverOperators,
  selectManifestResolverOperator: sdkMocks.selectManifestResolverOperator,
}))

import { PREFERRED_RESOLVER_OWNER } from "@obsidion/sdk"
import {
  createOxideL1Reader,
  fetchSignupResolverOperator,
  NO_NAME_PORTAL_RECIPIENT,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
  resolveStoredR1Key,
} from "../../src/oxide/oxideRegistrationDeps"

const FACTORY = "0x0000000000000000000000000000000000000002" as Address

const DEV_TUPLE = {
  rollupVersion: "3",
  registry: "0x0000000000000000000000000000000000000001",
  accountFactory: FACTORY,
  entryPoint: "0x0000000000000000000000000000000000000003",
  ensDomain: "oxidestaging.eth",
  token: "0x0000000000000000000000000000000000000004",
} as unknown as OxideEnvTuple

const RESOLVER = "0xf902DF6c3d057230ac8c2FbD7a86aD03AFf2F871"

describe("oxideEnvFromTuple", () => {
  const OPTS = {
    resolverOperator: RESOLVER,
    l1ChainId: 11155111,
    accountFactory: FACTORY,
    namePortalRecipient: NO_NAME_PORTAL_RECIPIENT,
  }

  it("maps the registration block (supplied factory → factory, string rollupVersion → bigint, token → feeToken)", () => {
    const env = oxideEnvFromTuple(DEV_TUPLE, OPTS)
    expect(env).toEqual({
      registry: "0x0000000000000000000000000000000000000001",
      factory: FACTORY,
      entryPoint: "0x0000000000000000000000000000000000000003",
      ensDomain: "oxidestaging.eth",
      resolverOperator: RESOLVER,
      rollupVersion: 3n,
      l1ChainId: 11155111,
      feeToken: "0x0000000000000000000000000000000000000004",
      namePortalRecipient: NO_NAME_PORTAL_RECIPIENT,
    })
  })

  it("throws when a required field (registry / ensDomain / factory / token) is absent", () => {
    for (const missing of [
      { registry: undefined },
      { ensDomain: undefined },
      { token: undefined },
    ]) {
      const tuple = { ...DEV_TUPLE, ...missing } as unknown as OxideEnvTuple
      expect(() => oxideEnvFromTuple(tuple, OPTS)).toThrow(/registration shared block/)
    }
    // An absent supplied factory (e.g. a staging tuple with no accountFactory) also throws.
    expect(() =>
      oxideEnvFromTuple(DEV_TUPLE, { ...OPTS, accountFactory: undefined as unknown as Address }),
    ).toThrow(/registration shared block/)
  })

  it("throws on a missing or non-numeric rollupVersion instead of coercing to 0", () => {
    for (const rollupVersion of ["", "abc", undefined]) {
      const tuple = { ...DEV_TUPLE, rollupVersion } as unknown as OxideEnvTuple
      expect(() => oxideEnvFromTuple(tuple, OPTS)).toThrow(/rollupVersion/)
    }
  })
})

describe("resolveOxideAccountFactory", () => {
  it("returns the tuple's factory, validated, on every network", () => {
    expect(resolveOxideAccountFactory({ tuple: DEV_TUPLE })).toBe(FACTORY)
  })

  it("throws on an absent / zero / malformed tuple factory", () => {
    for (const accountFactory of [undefined, "", `0x${"0".repeat(40)}`, "0x1234"]) {
      const tuple = { ...DEV_TUPLE, accountFactory } as unknown as OxideEnvTuple
      expect(() => resolveOxideAccountFactory({ tuple })).toThrow(/accountFactory/)
    }
  })
})

describe("fetchSignupResolverOperator", () => {
  afterEach(() => vi.resetAllMocks())

  const DEPLOY_BLOCK = 900n
  const HEAD = 1_000n
  const BLOCK_SEC = 12

  const LIVE_TUPLE = {
    accountMetadataRegistry: "0x0000000000000000000000000000000000000011",
    resolverGatewayUrl: "https://gw.example",
    portal: "0x0000000000000000000000000000000000000012",
    deployedAt: new Date(Number(DEPLOY_BLOCK) * BLOCK_SEC * 1000).toISOString(),
  } as unknown as OxideEnvTuple

  const client = {
    getBlockNumber: async () => HEAD,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: BigInt(blockNumber) * BigInt(BLOCK_SEC),
    }),
  } as never

  it("selects the manifest-matched record (preferring the known operator) and records its owner", async () => {
    const records = [{ owner: "0xdead" }]
    sdkMocks.fetchSipaResolverOperators.mockResolvedValue(records)
    sdkMocks.selectManifestResolverOperator.mockReturnValue({ owner: RESOLVER })

    const owner = await fetchSignupResolverOperator(client, LIVE_TUPLE, Network.TESTNET)

    expect(owner).toBe(RESOLVER)
    expect(sdkMocks.fetchSipaResolverOperators).toHaveBeenCalledWith(
      client,
      LIVE_TUPLE.accountMetadataRegistry,
      { fromBlock: DEPLOY_BLOCK, toBlock: HEAD },
    )
    expect(sdkMocks.selectManifestResolverOperator).toHaveBeenCalledWith(records, {
      portal: LIVE_TUPLE.portal,
      resolverGatewayUrl: LIVE_TUPLE.resolverGatewayUrl,
      preferredOwner: PREFERRED_RESOLVER_OWNER,
      failOnAmbiguousMatch: false,
    })
  })

  it("throws before any read when the manifest lacks the resolver-selection surface", async () => {
    const tuple = { ...LIVE_TUPLE, portal: undefined } as unknown as OxideEnvTuple
    await expect(fetchSignupResolverOperator({} as never, tuple, Network.TESTNET)).rejects.toThrow(
      /resolver-selection surface/,
    )
    expect(sdkMocks.fetchSipaResolverOperators).not.toHaveBeenCalled()
  })
})

describe("resolveStoredR1Key", () => {
  afterEach(() => vi.restoreAllMocks())

  const stubStorage = (data: { pubkey: string } | null) =>
    vi
      .spyOn(AccountStorage, "get")
      .mockReturnValue({ getWebAuthnDataForCurrentAccount: async () => data } as never)

  it("maps a stored passkey public key to an oxide r1 key (no ceremony)", async () => {
    stubStorage({ pubkey: `0x${"ab".repeat(32)}${"cd".repeat(32)}` })
    expect(await resolveStoredR1Key()).toEqual({
      qx: `0x${"ab".repeat(32)}`,
      qy: `0x${"cd".repeat(32)}`,
    })
  })

  it("returns undefined when no passkey is stored (k1-only onboarding)", async () => {
    stubStorage(null)
    expect(await resolveStoredR1Key()).toBeUndefined()
  })
})

describe("createOxideL1Reader.readAuthKeys", () => {
  const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address
  const entry = (n: number) => ({
    key: { qx: `0x${n.toString(16).padStart(64, "0")}`, qy: `0x${"00".repeat(32)}` },
    metadata: "0x",
  })

  function clientWith(count: number, all: unknown[]) {
    const calls: { functionName: string; args?: unknown[] }[] = []
    const readContract = vi.fn(async (params: { functionName: string; args?: unknown[] }) => {
      calls.push({ functionName: params.functionName, args: params.args })
      if (params.functionName === "authKeyCount") return BigInt(count)
      if (params.functionName === "getAuthKeys") return all
      if (params.functionName === "getAuthKey") return all[Number(params.args![0])]
      throw new Error(`unexpected read: ${params.functionName}`)
    })
    return { client: { readContract } as never, calls }
  }

  it("no keys: one read, nothing fetched", async () => {
    const { client, calls } = clientWith(0, [])
    expect(await createOxideL1Reader(client).readAuthKeys(ACCOUNT, 8)).toEqual([])
    expect(calls.map((c) => c.functionName)).toEqual(["authKeyCount"])
  })

  it("keys within the bound: the whole array in one read", async () => {
    const all = [entry(1), entry(2)]
    const { client, calls } = clientWith(2, all)
    expect(await createOxideL1Reader(client).readAuthKeys(ACCOUNT, 8)).toEqual(all)
    expect(calls.map((c) => c.functionName)).toEqual(["authKeyCount", "getAuthKeys"])
  })

  it("a whole array that grew past the bound between the reads is capped, and counted by its own length", async () => {
    const all = Array.from({ length: 9 }, (_, i) => entry(i + 1))
    const { client } = clientWith(8, all)
    const read = await createOxideL1Reader(client).readAuthKeysCounted(ACCOUNT, 8)
    expect(read.entries).toEqual(all.slice(0, 8))
    expect(read.authKeyCount).toBe(9)
  })

  it("more keys than the bound: only the first `max`, by index", async () => {
    const all = Array.from({ length: 12 }, (_, i) => entry(i + 1))
    const { client, calls } = clientWith(12, all)
    expect(await createOxideL1Reader(client).readAuthKeys(ACCOUNT, 8)).toEqual(all.slice(0, 8))
    expect(calls.filter((c) => c.functionName === "getAuthKeys")).toHaveLength(0)
    expect(calls.filter((c) => c.functionName === "getAuthKey").map((c) => c.args)).toEqual(
      Array.from({ length: 8 }, (_, i) => [BigInt(i)]),
    )
  })
})
