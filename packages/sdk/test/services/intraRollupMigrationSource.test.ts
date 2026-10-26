import { describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { IntraRollupMigrationDeps } from "../../src/services/IntraRollupMigrationService.js"
import type { WithdrawalOptions } from "../../src/services/plainWithdrawal.js"

const readSipaPortalTerms = vi.hoisted(() =>
  vi.fn(async (_client: unknown, _route: { token: string }) => ({
    portal: `0x${"44".repeat(20)}`,
    token: `0x${"11".repeat(20)}`,
    depositFee: 1n,
    txAmountCap: 10n ** 24n,
  })),
)
vi.mock("../../src/oxide/sipaPortalTerms.js", () => ({ readSipaPortalTerms }))

import { IntraRollupMigrationService } from "../../src/services/IntraRollupMigrationService.js"
import { planPayout } from "../../src/services/plainWithdrawal.js"

const oldToken = AztecAddress.fromBigIntUnsafe(10n)
const source = {
  portal: `0x${"33".repeat(20)}`,
  token: `0x${"11".repeat(20)}`,
  l2Token: oldToken.toString(),
  plainWithdrawalExecutor: `0x${"66".repeat(20)}`,
  l2Broadcaster: AztecAddress.fromBigIntUnsafe(13n).toString(),
}
const live = {
  ...source,
  portal: `0x${"44".repeat(20)}`,
  l2Token: AztecAddress.fromBigIntUnsafe(11n).toString(),
  plainWithdrawalExecutor: `0x${"77".repeat(20)}`,
  l2Broadcaster: AztecAddress.fromBigIntUnsafe(14n).toString(),
}
const recipient = EthAddress.fromString(`0x${"55".repeat(20)}`)

describe("migration withdrawal source", () => {
  it.each([false, true])(
    "keeps the historic deployment through the burn setup (sponsored=%s)",
    async (sponsored) => {
      // The planner passes its deployment checks and reaches the source's broadcaster.
      const accepted = new Error("withdrawal source accepted")
      const getArtifactForInstance = vi.fn(async (_address: AztecAddress) => {
        throw accepted
      })
      const contractService = {
        getOxideClient: () => ({ initialize: async () => {}, getCurrentTuple: () => live }),
        getArtifactForInstance,
      }
      const exit = vi.fn(async (options: { withdrawal: WithdrawalOptions }) =>
        planPayout(
          {} as never,
          contractService as never,
          oldToken,
          { from: oldToken, recipient, amount: 20n },
          options.withdrawal,
        ),
      )
      const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "ROLLUP_VERSION" ? 5n : functionName === "FEE" ? 0n : false,
      )
      const broadcastSipa = vi.fn(async () => {})
      // The node reports a different rollup version than the destination tuple carries.
      const getNodeInfo = vi.fn(async () => ({ rollupVersion: 1 }))
      const resolveAddress = vi.fn(async () => ({
        sipaAddress: recipient.toString(),
        sipaArgs: {},
        resolution: { nonce: 0, messageSecret: Fr.ONE },
      }))
      const deps = {
        node: {
          getNodeInfo,
          getBlock: async () => ({ header: { globalVariables: { timestamp: 86400n } } }),
        },
        fromTokenService: {
          tokenAddress: oldToken,
          exitToL1Private: (
            _recipient: unknown,
            _amount: unknown,
            options: Parameters<typeof exit>[0],
          ) => exit(options),
          exitToL1PrivateSponsored: (
            _recipient: unknown,
            _amount: unknown,
            _sponsor: unknown,
            options: Parameters<typeof exit>[0],
          ) => exit(options),
        },
        from: source,
        to: {
          portal: live.portal,
          sipaFactory: recipient.toString(),
          forwardingTable: `0x${"88".repeat(20)}`,
          rollupVersion: "5",
        },
        selfResolver: { resolveAddress },
        publicClient: { readContract },
      } as unknown as IntraRollupMigrationDeps
      const migration = new IntraRollupMigrationService(deps)
      await expect(
        migration.migrate({
          account: { getAddress: () => AztecAddress.fromBigIntUnsafe(12n) } as never,
          amount: 20n,
          nonceForDay: () => 0,
          broadcastSipa,
          resolveSpendMetadata: vi.fn(),
          ...(sponsored ? { sponsor: async () => ({} as never) } : {}),
        }),
      ).rejects.toBe(accepted)
      expect(broadcastSipa).toHaveBeenCalledOnce()
      // The SIPA is keyed by the destination tuple's rollup version; the node's is never read.
      expect(resolveAddress).toHaveBeenCalledWith(expect.objectContaining({ rollupVersion: 5n }))
      expect(getNodeInfo).not.toHaveBeenCalled()
      expect(exit).toHaveBeenCalledOnce()
      const { withdrawal } = exit.mock.calls[0]![0]
      expect(withdrawal.tuple).toBe(source)
      // The destination portal confirms the version and the source's executor answers its fee; the
      // source portal is not read.
      expect(readContract.mock.calls.map(([call]) => (call as any).address)).toEqual([
        live.portal,
        source.plainWithdrawalExecutor,
      ])
      // The destination row is read for the source bridge's own asset.
      expect(readSipaPortalTerms.mock.calls[0]![1].token).toBe(source.token)
      expect(getArtifactForInstance.mock.calls[0]![0]).toEqual(
        AztecAddress.fromStringUnsafe(source.l2Broadcaster),
      )
    },
  )

  it("refuses before any broadcast or burn when the manifest's version is not the portal's", async () => {
    const readContract = vi.fn(async () => 6n)
    const broadcastSipa = vi.fn(async () => {})
    const exit = vi.fn()
    const deps = {
      node: { getBlock: async () => ({ header: { globalVariables: { timestamp: 86400n } } }) },
      fromTokenService: { tokenAddress: oldToken, exitToL1Private: exit },
      from: source,
      to: {
        portal: live.portal,
        sipaFactory: recipient.toString(),
        forwardingTable: `0x${"88".repeat(20)}`,
        rollupVersion: "5",
      },
      selfResolver: { resolveAddress: vi.fn() },
      publicClient: { readContract },
    } as unknown as IntraRollupMigrationDeps
    await expect(
      new IntraRollupMigrationService(deps).migrate({
        account: { getAddress: () => AztecAddress.fromBigIntUnsafe(12n) } as never,
        amount: 20n,
        nonceForDay: () => 0,
        broadcastSipa,
        resolveSpendMetadata: vi.fn(),
      }),
    ).rejects.toThrow(/manifest says rollupVersion 5.*says 6/)
    expect(broadcastSipa).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})
