import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ readTerms: vi.fn(), readState: vi.fn() }))
vi.mock("@oxide/l1-contracts/migration.js", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts/migration.js")>()),
  readMigrationSubsidyTerms: h.readTerms,
  readMigrationSubsidyState: h.readState,
}))

const { MigrationSubsidyReader } = await import("../../src/services/migrationSubsidy.js")

const SUBSIDY = "0x" + "aa".repeat(20)
const terms = {
  subsidy: SUBSIDY,
  token: "0x" + "bb".repeat(20),
  sourcePortal: "0x" + "cc".repeat(20),
  priceFeed: { address: "0x" + "dd".repeat(20), decimals: 8 },
}
const state = {
  balance: 1n,
  config: { targetRelayerProfit: 0n, maxSubsidyPerOperation: 0n, minMigratedAmount: 0n },
  sourceFrozen: true,
  priceFeed: { answer: 1n, updatedAt: 1n },
}

function client(chain: object | undefined) {
  return {
    readContract: vi.fn(),
    multicall: vi.fn(),
    getBlock: vi.fn(),
    getGasPrice: vi.fn(),
    getCode: vi.fn(),
    chain,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.readTerms.mockResolvedValue(terms)
  h.readState.mockResolvedValue(state)
})

describe("MigrationSubsidyReader's state read", () => {
  it("multicalls on a chain that carries a Multicall3 address", async () => {
    const c = client({ contracts: { multicall3: { address: "0x" + "ee".repeat(20) } } })
    await new MigrationSubsidyReader(c as never, SUBSIDY as never).fresh()
    expect(h.readState.mock.calls[0]![0]).toBe(c)
  })

  it("reads value by value on a chain without one, such as viem's foundry", async () => {
    const c = client({ id: 31337, contracts: {} })
    await new MigrationSubsidyReader(c as never, SUBSIDY as never).fresh()
    const passed = h.readState.mock.calls[0]![0] as { multicall?: unknown; readContract: unknown }
    expect(passed).not.toBe(c)
    expect(passed.multicall).toBeUndefined()
    await passed.readContract({ address: SUBSIDY, abi: [], functionName: "x" } as never)
    expect(c.readContract).toHaveBeenCalledTimes(1)
  })
})
