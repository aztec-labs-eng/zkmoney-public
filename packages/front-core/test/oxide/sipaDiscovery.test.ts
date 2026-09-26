import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"

const { fetchRecordsMock, selectResolverMock, FAKE_ARTIFACT } = vi.hoisted(() => ({
  fetchRecordsMock: vi.fn(),
  selectResolverMock: vi.fn(),
  FAKE_ARTIFACT: { name: "Broadcaster", functions: [] },
}))

// package; the bundled artifact loader needs no real artifact here. AztecAddress
// gets a minimal fromString/toString fake, the per-network policy is stubbed so
// the test pins that discovery THREADS it into the resolver selection, and the
// canonical generation stack is pinned to v4 so the combined-registration branch
// is what's asserted.
vi.mock("@obsidion/sdk", () => ({
  fetchSipaResolverOperators: fetchRecordsMock,
  selectManifestResolverOperator: selectResolverMock,
  resolverSelectionPolicy: (network: string) =>
    network === "mainnet"
      ? { failOnAmbiguousMatch: true }
      : {
          preferredOwner: "0xe959F1c4F84C55c10114f3FA46a8DcFB51ab8d30",
          failOnAmbiguousMatch: false,
        },
  Network: { TESTNET: "testnet", SANDBOX: "sandbox", MAINNET: "mainnet" },
}))
vi.mock("@aztec/aztec.js/addresses", () => ({
  AztecAddress: {
    fromStringUnsafe: (value: string) => ({ toString: () => value.toLowerCase() }),
  },
}))
// Pin the canonical generation stack to v4 so the combined-registration branch is
// exercised; the v5 split (registerContractClass + registerContract(instance)) is
// the other branch. The artifact loader is stubbed to a fake — the branch, not the
// artifact bytes, is what's under test.
vi.mock("src/core", () => ({
  canonicalGenerationStack: () => "v4",
}))
vi.mock("../../src/oxide/generationBroadcasterArtifact", () => ({
  getGenerationBroadcasterArtifact: () => FAKE_ARTIFACT,
}))
import { Network } from "@obsidion/sdk"
import { setupSipaDiscovery } from "../../src/oxide/sipaDiscovery"

const PREFERRED_RESOLVER_OWNER = "0xe959F1c4F84C55c10114f3FA46a8DcFB51ab8d30"

const DEPLOY_BLOCK = 900n
const HEAD = 1_000n
const BLOCK_SEC = 12
const DEPLOYED_AT = new Date(Number(DEPLOY_BLOCK) * BLOCK_SEC * 1000).toISOString()

const TUPLE = {
  deployedAt: DEPLOYED_AT,
  portal: "0x2c5a54e7fff0593778371ee02a8b31e39c0cf8fc",
  registry: "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f",
  accountMetadataRegistry: "0x1c903b955dbc0c97252f1ce9e43f8c26e8f5635f",
  l2Broadcaster: "0x29c4d02a2e26828eb5efb19467719a8430b7993ce18f4a6506f79f6ce072f796",
} as unknown as OxideEnvTuple

const RESOLVER_RECORD = {
  owner: "0xf902DF6c3d057230ac8c2FbD7a86aD03AFf2F871",
  l2Address: "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456",
  url: "https://gw.example/{sender}/{data}.json",
  oxidePortal: "0x2c5a54e7fff0593778371ee02a8b31e39c0cf8fc",
}

const INSTANCE = { address: "instance-marker" }
const CLIENT = {
  readContract: vi.fn(),
  getBlockNumber: async () => HEAD,
  getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
    timestamp: BigInt(blockNumber) * BigInt(BLOCK_SEC),
  }),
} as never
const SANDBOX = Network.SANDBOX

function makePxe() {
  return {
    registerSender: vi.fn(async (sender: unknown) => sender),
    registerContractClass: vi.fn(async () => undefined),
    registerContract: vi.fn(async () => undefined),
  }
}

function makeNode(instance: unknown = INSTANCE) {
  return { getContract: vi.fn(async () => instance as never) }
}

beforeEach(() => {
  fetchRecordsMock.mockReset().mockResolvedValue([RESOLVER_RECORD])
  selectResolverMock.mockReset().mockReturnValue(RESOLVER_RECORD)
})

describe("setupSipaDiscovery", () => {
  it("registers the selected resolver's L2 sender, then the Broadcaster instance + artifact", async () => {
    const pxe = makePxe()
    const node = makeNode()

    const result = await setupSipaDiscovery({
      pxe,
      node,
      publicClient: CLIENT,
      tuple: TUPLE,
      network: SANDBOX,
    })

    expect(fetchRecordsMock).toHaveBeenCalledWith(CLIENT, TUPLE.accountMetadataRegistry, {
      fromBlock: DEPLOY_BLOCK,
      toBlock: HEAD,
    })
    expect(selectResolverMock).toHaveBeenCalledWith([RESOLVER_RECORD], {
      portal: TUPLE.portal,
      resolverGatewayUrl: TUPLE.resolverGatewayUrl,
      preferredOwner: PREFERRED_RESOLVER_OWNER,
      failOnAmbiguousMatch: false,
    })

    expect(pxe.registerSender).toHaveBeenCalledTimes(1)
    const sender = pxe.registerSender.mock.calls[0]![0] as { toString(): string }
    expect(sender.toString()).toBe(RESOLVER_RECORD.l2Address)

    expect(node.getContract).toHaveBeenCalledTimes(1)
    expect((node.getContract.mock.calls[0]![0] as { toString(): string }).toString()).toBe(
      TUPLE.l2Broadcaster,
    )
    // canonical stack is v4 here -> the combined 4.3.0 registration shape; the v5
    // split (registerContractClass + registerContract(instance)) is the other branch.
    expect(pxe.registerContractClass).not.toHaveBeenCalled()
    expect(pxe.registerContract).toHaveBeenCalledWith({
      instance: INSTANCE,
      artifact: FAKE_ARTIFACT,
    })

    expect(result.resolver).toBe(RESOLVER_RECORD)
    expect(result.broadcaster.toString()).toBe(TUPLE.l2Broadcaster)
  })

  it("bounds the operator scan by the caller's head, so one probe reads against one tip", async () => {
    const getBlockNumber = vi.fn(async () => HEAD)
    const client = {
      readContract: vi.fn(),
      getBlockNumber,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: BigInt(blockNumber) * BigInt(BLOCK_SEC),
      }),
    } as never

    await setupSipaDiscovery({
      pxe: makePxe(),
      node: makeNode(),
      publicClient: client,
      tuple: TUPLE,
      network: SANDBOX,
      scanHead: 980n,
    })

    expect(fetchRecordsMock).toHaveBeenCalledWith(client, TUPLE.accountMetadataRegistry, {
      fromBlock: DEPLOY_BLOCK,
      toBlock: 980n,
    })
    expect(getBlockNumber).not.toHaveBeenCalled()
  })

  it("falls back to the live tuple's resolver when none matches a retired tuple", async () => {
    const live = { ...TUPLE, portal: "0x" + "bb".repeat(20) } as unknown as OxideEnvTuple
    selectResolverMock
      .mockImplementationOnce(() => {
        throw new Error("no resolver record matches the manifest portal")
      })
      .mockReturnValueOnce(RESOLVER_RECORD)

    const result = await setupSipaDiscovery({
      pxe: makePxe(),
      node: makeNode(),
      publicClient: CLIENT,
      tuple: TUPLE,
      network: SANDBOX,
      resolverFallbackTuple: live,
    })

    expect(selectResolverMock).toHaveBeenCalledTimes(2)
    expect(selectResolverMock.mock.calls[1]![1]).toMatchObject({ portal: live.portal })
    expect(result.resolver).toBe(RESOLVER_RECORD)
    // Discovery still targets the RETIRED deployment's Broadcaster.
    expect(result.broadcaster.toString()).toBe(TUPLE.l2Broadcaster)
  })

  it("without a fallback, a non-matching tuple still throws", async () => {
    selectResolverMock.mockImplementation(() => {
      throw new Error("no resolver record matches the manifest portal")
    })
    await expect(
      setupSipaDiscovery({
        pxe: makePxe(),
        node: makeNode(),
        publicClient: CLIENT,
        tuple: TUPLE,
        network: SANDBOX,
      }),
    ).rejects.toThrow(/no resolver record/)
  })

  it("throws on a staging-shaped tuple (no SIPA surface) before any PXE call", async () => {
    for (const missing of ["accountMetadataRegistry", "portal", "l2Broadcaster"]) {
      const pxe = makePxe()
      const tuple = { ...TUPLE, [missing]: undefined } as unknown as OxideEnvTuple
      await expect(
        setupSipaDiscovery({
          pxe,
          node: makeNode(),
          publicClient: CLIENT,
          tuple,
          network: SANDBOX,
        }),
      ).rejects.toThrow(/SIPA surface/)
      expect(pxe.registerSender).not.toHaveBeenCalled()
      expect(pxe.registerContract).not.toHaveBeenCalled()
    }
  })

  it("throws when the node has no instance at l2Broadcaster; the Broadcaster stays unregistered", async () => {
    const pxe = makePxe()
    await expect(
      setupSipaDiscovery({
        pxe,
        node: makeNode(null),
        publicClient: CLIENT,
        tuple: TUPLE,
        network: SANDBOX,
      }),
    ).rejects.toThrow(/Broadcaster instance not found/)
    expect(pxe.registerContract).not.toHaveBeenCalled()
  })
})
