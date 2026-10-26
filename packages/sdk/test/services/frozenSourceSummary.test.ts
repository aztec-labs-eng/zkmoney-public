import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec/aztec.js/fields"

vi.mock("@oxide/l1-contracts", () => ({
  OxidePortalContract: class {
    isFrozen = async () => true
    getRollupVersion = async () => 1n
    getInbox = async () => "0x" + "03".repeat(20)
  },
}))
const { getRefundableFrozenNotes } = vi.hoisted(() => ({
  getRefundableFrozenNotes: vi.fn(async (): Promise<never[]> => []),
}))
vi.mock("@oxide/oxide-client/frozen_notes.js", () => ({ getRefundableFrozenNotes }))
vi.mock("../../src/services/TokenService.js", () => ({
  TokenService: { create: async () => ({ getTokenContract: async () => ({}) }) },
}))

const { frozenSourceSummary } = await import("../../src/services/FrozenRefundMigrationRuntime.js")

const summaryOf = (
  o: Pick<Parameters<typeof frozenSourceSummary>[0], "depositDescriptors" | "escrows">,
) =>
  frozenSourceSummary({
    client: {},
    wallet: {
      node: { getBlockNumber: async () => 10 },
      pxe: {
        sync: async () => {},
        getSyncedBlockHeader: async () => ({
          globalVariables: { blockNumber: 10, version: new Fr(1n) },
        }),
      },
    } as never,
    account: {
      getAddress: () => ({}),
      makeSpendMetadataResolver: async () => vi.fn(),
      makeDepositSpendMetadataResolver: async () => async () => ({}),
    } as never,
    tuple: { portal: "0x" + "01".repeat(20), l2Token: "0x" + "02".repeat(32) } as never,
    ...o,
  })

describe("frozenSourceSummary", () => {
  it("never reads a failed payment link read as no links", async () => {
    const summary = summaryOf({
      depositDescriptors: async () => [],
      escrows: async () => {
        throw new Error("transfer scan failed")
      },
    })
    await expect(summary).rejects.toThrow("transfer scan failed")
  })

  it("leaves no note read unhandled when the deposit scan fails", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      getRefundableFrozenNotes.mockRejectedValueOnce(new Error("history pruned"))
      const summary = summaryOf({
        depositDescriptors: async () => {
          throw new Error("no resolver-operator record")
        },
        escrows: async () => [],
      })
      await expect(summary).rejects.toThrow("no resolver-operator record")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})
