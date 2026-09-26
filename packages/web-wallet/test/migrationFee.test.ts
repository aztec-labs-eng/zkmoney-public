/**
 * What moving funds costs is read off both deployments: the old portal's funding cut on the
 * release, and the new deployment's deposit fee and funding cut as the relayer sweeps the arrival
 * in. The tip is the burn's own.
 */
import { describe, expect, it, vi } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"

const h = vi.hoisted(() => ({ cut: vi.fn(), implementation: vi.fn(), depositFee: vi.fn() }))

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../src/features/fees/fpcFundingCut", () => ({ fpcFundingCut: h.cut }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  depositSipaImplementation: h.implementation,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readDepositFee: h.depositFee,
}))

const { loadMigrationFee, migrationAmounts } = await import(
  "../src/features/migration/migrationFee"
)

const E18 = 10n ** 18n
const tuple = (portal: string) =>
  ({ portal, sipaFactory: `${portal}-factory` }) as never

describe("loadMigrationFee", () => {
  it("takes the old portal's cut, and the new deployment's deposit fee plus its cut", async () => {
    h.cut.mockImplementation(async (_c: unknown, portal: string) =>
      portal === "0xold" ? 5n * 10n ** 16n : 10n ** 17n,
    )
    h.implementation.mockResolvedValue("0ximpl")
    h.depositFee.mockResolvedValue(25n * 10n ** 16n)

    const fee = await loadMigrationFee(tuple("0xold"), tuple("0xnew"))

    expect(h.implementation).toHaveBeenCalledWith({}, "0xnew-factory", "0xnew")
    expect(fee).toEqual({
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      fpcFundingCut: (5n * 10n ** 16n).toString(),
      arrivalFee: (35n * 10n ** 16n).toString(),
    })
    expect(
      migrationAmounts({ amount: "85", rawAmount: (85n * E18).toString(), ...fee })?.netDisplay,
    ).toBe("84.5")
  })

  it("prices nothing while a fee is missing", () => {
    expect(migrationAmounts({ amount: "85", relayerTip: "1", fpcFundingCut: "1" })).toBeUndefined()
  })
})
