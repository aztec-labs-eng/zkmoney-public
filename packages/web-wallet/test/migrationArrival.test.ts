/**
 * A migration's arrival address is published before its burn, as a child operation of the
 * migration under the migration's own summary. The gateway's publish resolves once the chain
 * includes it, and a publish that fails throws, so the burn never goes out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ broadcast: vi.fn(), runOperation: vi.fn() }))

vi.mock("../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({ broadcastResolvedSipa: h.broadcast }),
}))
vi.mock("../src/features/operations/operations", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/features/operations/operations")>()
  h.runOperation.mockImplementation(real.runOperation)
  return { ...real, runOperation: h.runOperation }
})

const { migrationSummary, publishMigrationArrival } = await import(
  "../src/features/migration/migrationArrival"
)

const sipa = {
  sipaAddress: `0x${"5a".repeat(20)}`,
  resolution: { day: 1, nonce: 3 },
} as never
const deps = { wallet: {} as never, contractService: {} as never }

beforeEach(() => {
  h.broadcast.mockReset()
  h.runOperation.mockClear()
})

describe("publishMigrationArrival", () => {
  it("publishes inside the migration, under the migration's summary", async () => {
    h.broadcast.mockResolvedValue(undefined)
    await publishMigrationArrival(deps, sipa, migrationSummary("85"), "migration_parent")
    expect(h.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "migration-arrival",
        parent: "migration_parent",
        summary: "$85.00 to the new version",
      }),
      expect.any(Function),
    )
    const [{ operationId }] = h.runOperation.mock.lastCall!
    expect(h.broadcast).toHaveBeenCalledWith(deps.wallet, deps.contractService, sipa, operationId)
  })

  it("throws what the publish threw", async () => {
    h.broadcast.mockRejectedValue(new Error("derived deposit address changed"))
    await expect(
      publishMigrationArrival(deps, sipa, migrationSummary("85"), "migration_parent"),
    ).rejects.toThrow("derived deposit address changed")
  })
})
