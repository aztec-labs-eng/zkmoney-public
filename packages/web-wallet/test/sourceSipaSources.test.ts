import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  sender: "0x" + "12".repeat(32),
  deriveSources: vi.fn(() => []),
  history: vi.fn(),
  range: vi.fn(async () => ({ fromBlock: 1n, toBlock: 42n })),
}))

vi.mock("@obsidion/front-core", () => ({
  createRefundDepositL1Reads: vi.fn(),
  deploymentScanRange: h.range,
  deriveBootstrapKey: vi.fn(),
  deriveRefundableSipaSources: h.deriveSources,
  deriveStealthKey: () => ({ publicKey: { x: 3n, y: 4n } }),
  scanSweptDeposits: vi.fn(),
  setupSipaDiscovery: vi.fn(),
}))
vi.mock("@obsidion/sdk", () => ({
  fetchSipaEvents: vi.fn(),
  predictAccountAddress: vi.fn(),
  fetchHistoricalSipaResolverOperators: h.history,
  resolverSelectionPolicy: () => ({ failOnAmbiguousMatch: true }),
}))
vi.mock("../src/config/classArtifacts", () => ({ getWebBroadcasterArtifact: vi.fn() }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))

const { sourceSipaSources } = await import("../src/features/migration/sourceSipaSources")

describe("sourceSipaSources", () => {
  it.each([
    { forwardingTable: "table", expectedTarget: "table" },
    { forwardingTable: undefined, expectedTarget: "0xabc" },
  ])(
    "passes historical senders with resolver target $expectedTarget",
    async ({ forwardingTable, expectedTarget }) => {
      h.history.mockResolvedValue([{ l2Address: h.sender }, { l2Address: "rotated" }])
      const sipaSources = vi.fn(async () => [])
      const tuple = {
        portal: "0xabc",
        accountMetadataRegistry: "registry",
        depositSIPAImplementation: "0xdef",
        forwardingTable,
      } as never
      const publicClient = {} as never
      await sourceSipaSources({
        chain: { kind: "generation", session: { address: "account", sipaSources } as never },
        tuple,
        publicClient,
        masterSecret: {} as never,
        scanHead: 42n,
      })
      expect(sipaSources).toHaveBeenCalledWith(
        expect.objectContaining({ resolverL2Addresses: [h.sender, "rotated"] }),
      )
      expect(h.history).toHaveBeenCalledWith(
        publicClient,
        "registry",
        { fromBlock: 1n, toBlock: 42n },
        expect.objectContaining({ forwardingTable: expectedTarget }),
      )
    },
  )
  it("finds no SIPAs on a deployment without SIPA implementations", async () => {
    h.history.mockClear()
    const sipaSources = vi.fn(async () => [])
    await expect(
      sourceSipaSources({
        chain: { kind: "generation", session: { address: "account", sipaSources } as never },
        tuple: { portal: "0xabc", accountMetadataRegistry: "registry" } as never,
        publicClient: {} as never,
        masterSecret: {} as never,
        scanHead: 42n,
      }),
    ).resolves.toEqual([])
    expect(h.history).not.toHaveBeenCalled()
    expect(sipaSources).not.toHaveBeenCalled()
  })
})
