/**
 * What moving funds costs is read off both deployments: the source executor's withdrawal fee, and the
 * new deployment's deposit fee as the relayer sweeps the arrival in. The tip is the burn's own.
 */
import { describe, expect, it, vi } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"

const h = vi.hoisted(() => ({ withdrawalFee: vi.fn(), depositFee: vi.fn() }))

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: h.withdrawalFee,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readDepositFee: h.depositFee,
}))

const { loadMigrationFee, migrationAmounts } = await import(
  "../src/features/migration/migrationFee"
)

const E18 = 10n ** 18n
const address = (byte: string) => `0x${byte.repeat(20)}`
const tuple = (portal: string, forwardingTable: string) =>
  ({ portal: address(portal), forwardingTable: address(forwardingTable), token: address("da") }) as never

describe("loadMigrationFee", () => {
  it("takes the source executor's fee and the new deployment's deposit fee", async () => {
    h.withdrawalFee.mockResolvedValue(5n * 10n ** 16n)
    h.depositFee.mockResolvedValue(25n * 10n ** 16n)
    const current = tuple("0e", "ef")
    const source = tuple("0a", "af")

    const fee = await loadMigrationFee(current, source)

    expect(h.withdrawalFee).toHaveBeenCalledWith(source)
    expect(h.depositFee).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ forwardingTable: address("ef"), token: address("da") }),
    )
    expect(fee).toEqual({
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      withdrawalFee: (5n * 10n ** 16n).toString(),
      arrivalFee: (25n * 10n ** 16n).toString(),
    })
    // 85 less the 0.1 tip, the 0.05 executor fee and the 0.25 arrival fee.
    expect(
      migrationAmounts({
        amount: "85",
        rawAmount: (85n * E18).toString(),
        tokenDecimals: 18,
        ...fee,
      })?.netDisplay,
    ).toBe("84.6")
  })

  it("prices nothing while a fee is missing", () => {
    expect(migrationAmounts({ amount: "85", relayerTip: "1", tokenDecimals: 18 })).toBeUndefined()
  })
})
