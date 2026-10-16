import { describe, expect, it, vi } from "vitest"

const chain = vi.hoisted(() => ({ recordCurrent: false }))
vi.mock("../../src/services/metadataMigration.js", async (original) => ({
  ...(await original<typeof import("../../src/services/metadataMigration.js")>()),
  readMetadataUpdateFee: async () => 5n,
  readOrdinaryDepositFee: async () => 2n,
  readMetadataDestinationState: async () => (chain.recordCurrent ? "0xcurrent" : "0xstale"),
}))
vi.mock("@oxide/l1-contracts", async (original) => ({
  ...(await original<typeof import("@oxide/l1-contracts")>()),
  userRecordStateHash: () => "0xcurrent",
}))
vi.mock("../../src/services/claimSponsor.js", () => ({
  claimFpcSubscriptionUses: async () => 1,
  hasClaimFpcSubscription: async () => true,
}))

import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../src/services/MetadataMigrationService.js"

function service(state: "live" | "frozen", recordCurrent: boolean) {
  chain.recordCurrent = recordCurrent
  const quote = vi.fn(async (_minimums: { first: bigint; later: bigint }) => ({
    movable: 1n,
    stranded: 0n,
    waiting: 0n,
  }))
  const source = { state: async () => state, quote } as unknown as MetadataMigrationSource
  return { service: new MetadataMigrationService({ source, registered: {} } as never), quote }
}

// Metadata fee 5, ordinary deposit fee 2, and recurring sponsorship already active.
describe("the first batch a source must fund", () => {
  it("holds a live source to the metadata fee, even once the destination record is current", async () => {
    for (const current of [false, true]) {
      const f = service("live", current)
      await f.service.quote()
      expect(f.quote).toHaveBeenCalledWith({ first: 6n, later: 3n })
    }
  })

  it("holds a frozen source to the ordinary fee only once the destination record is current", async () => {
    let f = service("frozen", false)
    await f.service.quote()
    expect(f.quote).toHaveBeenCalledWith({ first: 6n, later: 3n })
    f = service("frozen", true)
    await f.service.quote()
    expect(f.quote).toHaveBeenCalledWith({ first: 3n, later: 3n })
  })

  it("holds every batch to the ordinary fee once the saved run's first refund has settled", async () => {
    const f = service("frozen", false)
    await f.service.quote({ firstBatchSettled: true })
    expect(f.quote).toHaveBeenCalledWith({ first: 3n, later: 3n })
  })

  it("is movable exactly when the quote moves something", async () => {
    const f = service("live", false)
    expect(await f.service.movable()).toBe(true)
    f.quote.mockResolvedValue({ movable: 0n, stranded: 4n, waiting: 0n })
    expect(await f.service.movable()).toBe(false)
  })
})
