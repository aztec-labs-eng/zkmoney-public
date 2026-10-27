import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"

const sdk = vi.hoisted(() => ({
  quoteSkyReleaseTip: vi.fn(),
  quoteSkyEscrowTip: vi.fn(),
  readWithdrawalExecutor: vi.fn(),
  readExecutorSubsidy: vi.fn(),
  assertExecutorServesPortal: vi.fn((executor: { portal: string }, portal: string) => {
    if (executor.portal.toLowerCase() !== portal.toLowerCase()) throw new Error("serves portal")
  }),
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
  quoteSavingsMove,
} from "../../../src/core/services/savings/savingsMoveQuote"

const DAI = "0x00000000000000000000000000000000000000d1" as Address
const SUSDS = "0x00000000000000000000000000000000000000d2" as Address
const MAIN_PORTAL = "0x00000000000000000000000000000000000000aa" as Address
const SKY_PORTAL = "0x00000000000000000000000000000000000000bb" as Address
const FACTORY = "0x00000000000000000000000000000000000000ff" as Address
const MAIN_EXECUTOR = "0x00000000000000000000000000000000000000e1" as Address
const SKY_EXECUTOR = "0x00000000000000000000000000000000000000e2" as Address
const BENEFICIARY = "0x00000000000000000000000000000000000000be" as Address
const MAIN_SUBSIDY = "0x00000000000000000000000000000000000000c1" as Address
const SKY_SUBSIDY = "0x00000000000000000000000000000000000000c2" as Address
const ONE = 10n ** 18n
/** Main's plain withdrawal executor fee; the Sky withdrawal executor takes none. */
const FEE = ONE / 10n
const STALE = new Error("price feed 0xfeed is stale: answer is 3601s old, max age is 3600s")

const tuple = (portal: Address, extra: Partial<OxideEnvTuple> = {}): OxideEnvTuple =>
  ({
    portal,
    withdrawalSubsidy: `0x${"1".repeat(40)}`,
    operationExecutor: `0x${"2".repeat(40)}`,
    l2Broadcaster: `0x${"3".repeat(64)}`,
    ...extra,
  } as OxideEnvTuple)

/** The Savings bridge's own executor serves direct withdrawals; a move out pays the Sky executor. */
const deployments = {
  main: tuple(MAIN_PORTAL, { plainWithdrawalExecutor: MAIN_EXECUTOR }),
  savings: tuple(SKY_PORTAL, { plainWithdrawalExecutor: `0x${"9".repeat(40)}` }),
  skyExecutor: SKY_EXECUTOR,
}

const subsidies: Record<string, Address> = {
  [MAIN_EXECUTOR]: MAIN_SUBSIDY,
  [SKY_EXECUTOR]: SKY_SUBSIDY,
}

const executors = {
  [MAIN_EXECUTOR]: {
    address: MAIN_EXECUTOR,
    kind: "plain",
    portal: MAIN_PORTAL,
    fee: FEE,
    beneficiary: BENEFICIARY,
  },
  [SKY_EXECUTOR]: { address: SKY_EXECUTOR, kind: "sky", portal: SKY_PORTAL, fee: 0n },
}

/** A vault where one share redeems for 1.05 DAI. */
const client = {
  readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: bigint[] }) => {
    if (functionName === "convertToAssets") return (args![0] * 105n) / 100n
    throw new Error(functionName)
  }),
} as never

const factory = { address: FACTORY, dai: DAI, sUsds: SUSDS }

beforeEach(() => {
  sdk.assertExecutorServesPortal.mockClear()
  sdk.quoteSkyReleaseTip.mockResolvedValue({ relayerTip: ONE, subsidy: 0n })
  sdk.quoteSkyEscrowTip.mockResolvedValue({ relayerTip: ONE / 2n })
  sdk.readWithdrawalExecutor
    .mockReset()
    .mockImplementation(async (_client, address: Address) => executors[address])
  sdk.readExecutorSubsidy
    .mockReset()
    .mockImplementation(async (_client, address: Address) => subsidies[address])
})

describe("quoteSavingsMove", () => {
  it("prices a move in: main's executor fee and the release tip off the burn, the escrow tip off the run", async () => {
    const quote = await quoteSavingsMove({ client, deployments, factory }, "in", 100n * ONE)
    expect(quote.unit).toBe(DAI)
    expect(quote.value).toBe(100n * ONE)
    expect(quote.withdrawalFee).toBe(FEE)
    expect(quote.feeBeneficiary).toBe(BENEFICIARY)
    expect(sdk.readWithdrawalExecutor).toHaveBeenCalledWith(client, MAIN_EXECUTOR, "plain")
    expect(sdk.assertExecutorServesPortal).toHaveBeenCalledWith(
      executors[MAIN_EXECUTOR],
      MAIN_PORTAL,
    )
    expect(quote.escrowFunding).toBe(100n * ONE - FEE - ONE)
    expect(quote.net).toBe(quote.escrowFunding - ONE / 2n)
    expect(quote.fee).toBe(quote.value - quote.net)
    expect(sdk.quoteSkyReleaseTip).toHaveBeenCalledWith(client, MAIN_SUBSIDY, 0)
    expect(sdk.quoteSkyEscrowTip.mock.calls[0][1]).toEqual({
      skyEscrowFactory: FACTORY,
      operationExecutor: deployments.main.operationExecutor,
      dai: DAI,
      withdrawalSubsidy: MAIN_SUBSIDY,
    })
  })

  it("prices a move out in DAI through the Sky executor and its subsidy; the executor charges no fee", async () => {
    const quote = await quoteSavingsMove({ client, deployments, factory }, "out", 100n * ONE)
    expect(quote.unit).toBe(DAI)
    expect(quote.value).toBe(105n * ONE)
    expect(sdk.readWithdrawalExecutor).toHaveBeenCalledWith(client, SKY_EXECUTOR, "sky")
    expect(sdk.assertExecutorServesPortal).toHaveBeenCalledWith(executors[SKY_EXECUTOR], SKY_PORTAL)
    expect(quote.withdrawalFee).toBe(0n)
    expect(quote).not.toHaveProperty("feeBeneficiary")
    expect(quote.escrowFunding).toBe(105n * ONE - ONE)
    expect(quote.net).toBe(105n * ONE - ONE - ONE / 2n)
    expect(sdk.readExecutorSubsidy).toHaveBeenCalledWith(client, SKY_EXECUTOR)
    expect(sdk.quoteSkyReleaseTip).toHaveBeenCalledWith(client, SKY_SUBSIDY, 1)
  })

  it("reads the executor's terms through the reads a front injects", async () => {
    const executorReads = {
      executor: vi.fn(async (address: Address) => executors[address]),
      subsidy: vi.fn(async (address: Address) => subsidies[address]),
    }
    const quote = await quoteSavingsMove(
      { client, deployments, factory, executorReads },
      "in",
      100n * ONE,
    )
    expect(quote.withdrawalFee).toBe(FEE)
    expect(executorReads.executor).toHaveBeenCalledWith(MAIN_EXECUTOR, "plain")
    expect(executorReads.subsidy).toHaveBeenCalledWith(MAIN_EXECUTOR)
    expect(sdk.readWithdrawalExecutor).not.toHaveBeenCalled()
    expect(sdk.readExecutorSubsidy).not.toHaveBeenCalled()
  })

  it("refuses an executor that serves another portal", async () => {
    sdk.readWithdrawalExecutor.mockResolvedValueOnce({
      ...executors[MAIN_EXECUTOR],
      portal: SKY_PORTAL,
    })
    await expect(
      quoteSavingsMove({ client, deployments, factory }, "in", 100n * ONE),
    ).rejects.toThrow(/serves portal/)
  })

  it("takes the release tip net of its subsidy and nets it no further", async () => {
    sdk.quoteSkyReleaseTip.mockResolvedValueOnce({ relayerTip: ONE, subsidy: ONE / 4n })
    const quote = await quoteSavingsMove({ client, deployments, factory }, "in", 100n * ONE)
    expect(quote.releaseTip).toBe(ONE)
    expect(quote.escrowFunding).toBe(100n * ONE - FEE - ONE)
  })

  it("fails on a stale feed rather than quoting without it", async () => {
    sdk.quoteSkyReleaseTip.mockRejectedValueOnce(STALE)
    await expect(
      quoteSavingsMove({ client, deployments, factory }, "out", 100n * ONE),
    ).rejects.toBe(STALE)
    sdk.quoteSkyEscrowTip.mockRejectedValueOnce(STALE)
    await expect(quoteSavingsMove({ client, deployments, factory }, "in", 100n * ONE)).rejects.toBe(
      STALE,
    )
  })

  it("names the fee an amount cannot pay", async () => {
    const short = await quoteSavingsMove({ client, deployments, factory }, "in", ONE).catch(
      (e: unknown) => e,
    )
    expect(short).toBeInstanceOf(SavingsFeeError)
    expect((short as SavingsFeeError).fee).toBe(FEE + ONE)
    sdk.quoteSkyEscrowTip.mockRejectedValueOnce(
      new SkyTipExceedsFundingError({ relayerTip: 3n * ONE } as never, 2n * ONE),
    )
    const err = await quoteSavingsMove({ client, deployments, factory }, "in", 3n * ONE).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SavingsFeeError)
    expect((err as SavingsFeeError).fee).toBe(FEE + ONE + 3n * ONE)
  })
})
