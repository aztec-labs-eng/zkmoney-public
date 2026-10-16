import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"

const sdk = vi.hoisted(() => ({
  quoteSkyReleaseTip: vi.fn(),
  quoteSkyEscrowTip: vi.fn(),
  readFpcFundingCut: vi.fn(),
}))
vi.mock("@obsidion/sdk", () => ({
  ...sdk,
  SkyTipExceedsFundingError: class SkyTipExceedsFundingError extends RangeError {
    constructor(readonly tip: { relayerTip: bigint }, readonly escrowFunding: bigint) {
      super("tip exceeds funding")
    }
  },
}))

import { SkyTipExceedsFundingError } from "@obsidion/sdk"
import {
  SavingsFeeError,
  expectedSavingsNet,
  quoteSavingsMove,
  resolveSkyFactory,
} from "../../../src/core/services/savings/savingsMoveQuote"

const DAI = "0x00000000000000000000000000000000000000d1" as Address
const SUSDS = "0x00000000000000000000000000000000000000d2" as Address
const MAIN_PORTAL = "0x00000000000000000000000000000000000000aa" as Address
const SKY_PORTAL = "0x00000000000000000000000000000000000000bb" as Address
const FACTORY = "0x00000000000000000000000000000000000000ff" as Address
const ONE = 10n ** 18n

const tuple = (portal: Address, extra: Partial<OxideEnvTuple> = {}): OxideEnvTuple =>
  ({
    portal,
    withdrawalSubsidy: `0x${"1".repeat(40)}`,
    operationExecutor: `0x${"2".repeat(40)}`,
    l2Broadcaster: `0x${"3".repeat(64)}`,
    plainWithdrawalExecutor: `0x${"4".repeat(40)}`,
    ...extra,
  } as OxideEnvTuple)

const deployments = {
  main: tuple(MAIN_PORTAL, { skyEscrowFactory: FACTORY }),
  savings: tuple(SKY_PORTAL),
}

/** The factory's constants and a vault where one share redeems for 1.05 DAI. */
const client = {
  readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: bigint[] }) => {
    switch (functionName) {
      case "DAI":
        return DAI
      case "DAI_PORTAL":
        return MAIN_PORTAL
      case "SUSDS":
        return SUSDS
      case "SUSDS_PORTAL":
        return SKY_PORTAL
      case "convertToAssets":
        return (args![0] * 105n) / 100n
    }
    throw new Error(functionName)
  }),
} as never

const factory = { address: FACTORY, dai: DAI, sUsds: SUSDS }
const cuts: Record<string, bigint> = { [MAIN_PORTAL]: ONE / 10n, [SKY_PORTAL]: 0n }
const cutOf = async (portal: Address) => cuts[portal]

beforeEach(() => {
  sdk.quoteSkyReleaseTip.mockResolvedValue({ relayerTip: ONE, subsidy: 0n })
  sdk.quoteSkyEscrowTip.mockResolvedValue({ relayerTip: ONE / 2n })
})

describe("resolveSkyFactory", () => {
  it("takes the manifest's factory when it moves between this wallet's portals", async () => {
    await expect(resolveSkyFactory(client, deployments)).resolves.toEqual(factory)
  })

  it("refuses a factory wired to other portals", async () => {
    const other = { ...deployments, savings: tuple(`0x${"9".repeat(40)}` as Address) }
    await expect(resolveSkyFactory(client, other)).rejects.toThrow(/not this wallet's deployments/)
  })

  it("needs a factory on one of the two entries", async () => {
    const none = { main: tuple(MAIN_PORTAL), savings: tuple(SKY_PORTAL) }
    await expect(resolveSkyFactory(client, none)).rejects.toThrow(/no Sky escrow factory/)
  })
})

describe("quoteSavingsMove", () => {
  it("prices a move in: Main's cut and the release tip off the burn, the escrow tip off the run", async () => {
    const quote = await quoteSavingsMove({ client, deployments, factory, cutOf }, "in", 100n * ONE)
    expect(quote.value).toBe(100n * ONE)
    expect(quote.sourceCut).toBe(ONE / 10n)
    expect(quote.arrivalCut).toBe(0n)
    expect(quote.escrowFunding).toBe(100n * ONE - ONE / 10n - ONE)
    expect(quote.net).toBe(quote.escrowFunding - ONE / 2n)
    expect(quote.fee).toBe(quote.value - quote.net)
    expect(sdk.quoteSkyReleaseTip).toHaveBeenCalledWith(
      client,
      deployments.main.withdrawalSubsidy,
      0,
    )
    expect(sdk.quoteSkyEscrowTip.mock.calls[0][1]).toEqual({
      skyEscrowFactory: FACTORY,
      operationExecutor: deployments.main.operationExecutor,
      dai: DAI,
      withdrawalSubsidy: deployments.main.withdrawalSubsidy,
    })
  })

  it("prices a move out in DAI: the shares' value, then Main's deposit cut on arrival", async () => {
    const quote = await quoteSavingsMove({ client, deployments, factory, cutOf }, "out", 100n * ONE)
    expect(quote.value).toBe(105n * ONE)
    expect(quote.escrowFunding).toBe(105n * ONE - ONE)
    expect(quote.arrivalCut).toBe(ONE / 10n)
    expect(quote.net).toBe(105n * ONE - ONE - ONE / 2n - ONE / 10n)
    expect(sdk.quoteSkyReleaseTip).toHaveBeenCalledWith(
      client,
      deployments.savings.withdrawalSubsidy,
      1,
    )
  })

  it("names the fee an amount cannot pay", async () => {
    await expect(
      quoteSavingsMove({ client, deployments, factory, cutOf }, "in", ONE),
    ).rejects.toBeInstanceOf(SavingsFeeError)
    sdk.quoteSkyEscrowTip.mockRejectedValueOnce(
      new SkyTipExceedsFundingError({ relayerTip: 3n * ONE } as never, 2n * ONE),
    )
    const err = await quoteSavingsMove(
      { client, deployments, factory, cutOf },
      "in",
      3n * ONE,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SavingsFeeError)
    expect((err as SavingsFeeError).fee).toBe(ONE / 10n + ONE + 3n * ONE)
  })
})

describe("expectedSavingsNet", () => {
  const deps = { client, deployments, factory, cutOf }

  it.each(["in", "out"] as const)(
    "prices a move %s without a quote to what its quote would say lands",
    async (direction) => {
      const quote = await quoteSavingsMove(deps, direction, 100n * ONE)
      const escrowTip = quote.escrowTip
      expect(await expectedSavingsNet(deps, direction, 100n * ONE, { escrowTip })).toBe(quote.net)
    },
  )

  it("takes the cut and the release tip its burn kept, and the escrow tip it paid", async () => {
    sdk.quoteSkyReleaseTip.mockClear()
    const net = await expectedSavingsNet(deps, "out", 100n * ONE, {
      escrowTip: ONE / 4n,
      sourceCut: 10n * ONE,
      releaseTip: 2n * ONE,
    })
    // 90 shares at 1.05 less the 2 release tip, the 0.25 escrow tip and Main's 0.1 cut.
    expect(net).toBe((945n * ONE) / 10n - 2n * ONE - ONE / 4n - ONE / 10n)
    expect(sdk.quoteSkyReleaseTip).not.toHaveBeenCalled()
  })
})
