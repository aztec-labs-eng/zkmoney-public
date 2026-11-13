import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  SkyEscrowAbi,
  SkyEscrowFactoryAbi,
  SkyRoute,
  encodeSkyEscrowDeploy,
  predictSkyEscrowAddressLocally,
} from "@oxide/experiments/sky/sky_savings.js"
import { PlainWithdrawalSubsidyAbi } from "@oxide/l1-contracts"
import { L1_OPERATION_BROADCAST_TIERS } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { decodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { L1_OPERATION_TIP_MARGIN_BPS } from "@obsidion/core/constants"
import {
  ETH_USD_FEED_DECIMALS,
  ETH_USD_MAX_PRICE_AGE_SECONDS,
  weiToUSD,
} from "@oxide/oxide-client/eth_usd_price_feed.js"
import {
  UINT256_EXTRA_CALLDATA_GAS,
  WEI_PER_ETH,
  estimateL1OperationFeeValues,
  gasCostAtQuotePrice,
} from "@oxide/oxide-client/l1_operation_quote.js"
import {
  SKY_RELEASE_GAS,
  SkyTipExceedsFundingError,
  buildSkyEscrowMove,
  encodeSkyEscrowDeployOnly,
  quoteSkyEscrowTip,
  quoteSkyReleaseTip,
  readSkyEscrowOutcome,
} from "../../../src/oxide/escrow/skySavings.js"
import { mappingSlot } from "../../../src/oxide/escrow/swapOnWithdrawSimulator.js"
import { memoryLogsClient, type HeldLog } from "../../utils/memoryLogs.js"

const FACTORY = "0x00000000000000000000000000000000000fac70" as Address
const EXECUTOR = "0x0000000000000000000000000000000000e0e0e0" as Address
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const SUBSIDY = "0x0000000000000000000000000000000000005b51" as Address
const FEED = "0x000000000000000000000000000000000000feed" as Address
const SENDER = "0x0000000000000000000000000000000000000b0b" as Address
const DAI_BALANCE_SLOT = 2n
const NOW = 1_800_000_000n
const BASE_FEE = parseGwei("10")
const PRIORITY_FEE = parseGwei("1")
const FEES = await estimateL1OperationFeeValues({
  getBlock: async () => ({ baseFeePerGas: BASE_FEE }),
  estimateMaxPriorityFeePerGas: async () => PRIORITY_FEE,
} as unknown as PublicClient)
const GAS_USED = 300_000n
const ETH_USD = 3000n * 10n ** ETH_USD_FEED_DECIMALS
const deployment = {
  skyEscrowFactory: FACTORY,
  operationExecutor: EXECUTOR,
  dai: DAI,
  withdrawalSubsidy: SUBSIDY,
}

/** The relayer's floor for `gas` at the fakes' fees, with the wallet's margin. */
const floorFor = (gas: bigint) => {
  const minPayout = gasCostAtQuotePrice(
    gas + 2n * UINT256_EXTRA_CALLDATA_GAS,
    { number: 7n, baseFeePerGas: BASE_FEE },
    FEES,
    weiToUSD(WEI_PER_ETH, ETH_USD),
  )
  return { minPayout, tip: (minPayout * L1_OPERATION_TIP_MARGIN_BPS + 9_999n) / 10_000n }
}

function fakeClient({ feedUpdatedAt = NOW } = {}) {
  return {
    readContract: vi.fn(
      async ({
        functionName,
        args,
        stateOverride,
      }: {
        functionName: string
        args?: readonly unknown[]
        stateOverride?: StateOverride
      }) => {
        switch (functionName) {
          case "PRICE_FEED":
            return FEED
          case "latestRoundData":
            return [0n, ETH_USD, 0n, feedUpdatedAt, 0n]
          case "balanceOf": {
            const wanted = mappingSlot(args![0] as Address, DAI_BALANCE_SLOT)
            const hit = stateOverride?.[0]?.stateDiff?.find((entry) => entry.slot === wanted)
            return hit ? BigInt(hit.value) : 0n
          }
          default:
            throw new Error(`unexpected read ${functionName}`)
        }
      },
    ),
    getBlock: vi.fn(async () => ({ number: 7n, baseFeePerGas: BASE_FEE, timestamp: NOW })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => PRIORITY_FEE),
    // The executor takes the six-argument `execute` only.
    simulateBlocks: vi.fn(async ({ blocks }: { blocks: { calls: { args: unknown[] }[] }[] }) => [
      {
        calls: [
          blocks[0]!.calls[0]!.args.length === 6
            ? { status: "success", result: 0n, gasUsed: GAS_USED, data: "0x", logs: [] }
            : { status: "failure", error: new Error("no data"), gasUsed: 0n },
        ],
      },
    ]),
  }
}

const quote = (client: ReturnType<typeof fakeClient>, escrowFunding: bigint) =>
  quoteSkyEscrowTip(client as unknown as PublicClient, deployment, {
    route: SkyRoute.Stake,
    escrowFunding,
    sender: SENDER,
  })

describe("quoteSkyEscrowTip", () => {
  it("prices the relayer's run of an escrow funded with what the release leaves it", async () => {
    const client = fakeClient()
    const funding = 50n * 10n ** 18n

    const tip = await quote(client, funding)

    const { minPayout, tip: relayerTip } = floorFor(GAS_USED)
    expect(tip).toEqual({
      relayerTip,
      minPayout,
      gasUsed: GAS_USED,
      maxFeePerGas: FEES.maxFeePerGas,
      usdPerEth: ETH_USD,
      baseFee: BASE_FEE,
      priorityFee: FEES.maxPriorityFeePerGas,
    })
    const { blocks } = client.simulateBlocks.mock.calls
      .map(([request]) => request)
      .find((request) => request.blocks[0]!.calls[0]!.args.length === 6) as unknown as {
      blocks: {
        stateOverrides: StateOverride
        calls: { to: Address; functionName: string; args: readonly unknown[] }[]
      }[]
    }
    const call = blocks[0]!.calls[0]!
    expect([call.to, call.functionName]).toEqual([EXECUTOR, "execute"])
    const [target, runCalldata, payoutToken, simulatedPayout] = call.args as [
      Address,
      Hex,
      Address,
      bigint,
    ]
    expect([target.toLowerCase(), payoutToken.toLowerCase()]).toEqual([FACTORY, DAI])
    const run = decodeFunctionData({ abi: SkyEscrowFactoryAbi, data: runCalldata })
    expect(run.functionName).toBe("deployAndExecute")
    const args = run.args[0] as Parameters<typeof predictSkyEscrowAddressLocally>[1]
    expect(args.route).toBe(SkyRoute.Stake)
    // Like the relayer's run, the simulation demands the committed tip as its payout.
    expect(simulatedPayout).toBe(args.relayerTip)
    const daiOverride = blocks[0]!.stateOverrides.find(
      (entry) => entry.address.toLowerCase() === DAI,
    )
    expect(daiOverride?.stateDiff).toEqual([
      {
        slot: mappingSlot(predictSkyEscrowAddressLocally(FACTORY, args), DAI_BALANCE_SLOT),
        value: `0x${funding.toString(16).padStart(64, "0")}`,
      },
    ])
  })

  it("refuses a move whose escrow could not pay the tip", async () => {
    await expect(quote(fakeClient(), 1n)).rejects.toBeInstanceOf(SkyTipExceedsFundingError)
  })

  it("refuses a stale ETH/USD answer", async () => {
    const client = fakeClient({ feedUpdatedAt: NOW - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n })
    await expect(quote(client, 50n * 10n ** 18n)).rejects.toThrow(/stale/)
  })
})

describe("quoteSkyReleaseTip", () => {
  const subsidized = (subsidy: bigint, feedUpdatedAt = NOW) => ({
    ...fakeClient({ feedUpdatedAt }),
    call: vi.fn<(request: unknown) => Promise<{ data: Hex }>>(async () => ({
      data: encodeFunctionResult({
        abi: PlainWithdrawalSubsidyAbi,
        functionName: "quoteSubsidy",
        result: subsidy,
      }),
    })),
  })
  const floor = (route: SkyRoute) => floorFor(SKY_RELEASE_GAS[route]).tip
  const releaseTip = (client: ReturnType<typeof subsidized>, route: SkyRoute) =>
    quoteSkyReleaseTip(client as unknown as PublicClient, SUBSIDY, route)

  it("offers what the relayer's floor asks beyond the subsidy, priced at the release's gas price", async () => {
    const client = subsidized(10n ** 15n)

    const tip = await releaseTip(client, SkyRoute.Unstake)

    expect(tip.relayerTip).toBe(floor(SkyRoute.Unstake) - 10n ** 15n)
    expect(tip.gasUsed).toBe(SKY_RELEASE_GAS[SkyRoute.Unstake])
    expect(client.call).toHaveBeenCalledWith({
      to: SUBSIDY,
      data: encodeFunctionData({
        abi: PlainWithdrawalSubsidyAbi,
        functionName: "quoteSubsidy",
        args: [0],
      }),
      gasPrice: BASE_FEE + FEES.maxPriorityFeePerGas,
    })
  })

  it("prices the Sky executor's release above a plain one", async () => {
    const [stake, unstake] = await Promise.all([
      releaseTip(subsidized(0n), SkyRoute.Stake),
      releaseTip(subsidized(0n), SkyRoute.Unstake),
    ])
    expect(unstake.relayerTip).toBeGreaterThan(stake.relayerTip)
  })

  it("offers nothing once the subsidy covers the release", async () => {
    const tip = await releaseTip(subsidized(floor(SkyRoute.Stake)), SkyRoute.Stake)
    expect(tip.relayerTip).toBe(0n)
  })

  it("refuses a stale ETH/USD answer", async () => {
    const stale = subsidized(0n, NOW - ETH_USD_MAX_PRICE_AGE_SECONDS - 1n)
    await expect(releaseTip(stale, SkyRoute.Unstake)).rejects.toThrow(/stale/)
  })
})

describe("Sky escrow exits", () => {
  const args = {
    route: SkyRoute.Unstake,
    recipientCommitment: `0x${"ab".repeat(32)}` as Hex,
    recoveryCommitment: `0x00${"cd".repeat(31)}` as Hex,
    relayerTip: 7n,
    nonce: `0x${"ef".repeat(32)}` as Hex,
  }

  it("deploys the clone without its run", () => {
    const deploy = decodeFunctionData({
      abi: SkyEscrowFactoryAbi,
      data: encodeSkyEscrowDeployOnly(args),
    })
    expect([deploy.functionName, deploy.args[0]]).toEqual(["deploy", args])
  })
})

describe("buildSkyEscrowMove", () => {
  const ONE = 10n ** 18n
  const PORTAL = "0x000000000000000000000000000000000000da10" as Address
  const BROADCASTER = AztecAddress.fromBigIntUnsafe(0xb0n)
  // The run's broadcast interaction is built from the binding and left to the burn to rebuild.
  const broadcaster = {
    address: BROADCASTER,
    methods: Object.fromEntries(
      L1_OPERATION_BROADCAST_TIERS.map(({ method }) => [method, () => ({})]),
    ),
  } as never
  const salt = new Fr(42n)
  // The route only passes through to oxide; front-core's build test runs both.
  const route = SkyRoute.Unstake
  const move = () =>
    buildSkyEscrowMove({
      broadcaster,
      factory: FACTORY,
      dai: DAI,
      from: AztecAddress.fromBigIntUnsafe(9n),
      portal: PORTAL,
      executor: { address: EXECUTOR, fee: ONE / 10n },
      amount: 100n * ONE,
      route,
      recipientCommitment: `0x${"ab".repeat(32)}`,
      recovery: { salt, account: SENDER },
      nonce: `0x${"ef".repeat(32)}`,
      escrowTip: ONE / 2n,
      releaseTip: ONE,
    })

  it("burns into the escrow its args derive, and runs it once the release pays it DAI", () => {
    const { escrow, args, options } = move()
    expect(args).toEqual({
      route,
      recipientCommitment: `0x${"ab".repeat(32)}`,
      recoveryCommitment: deriveRecoveryCommitment(salt, EthAddress.fromString(SENDER)).toString(),
      relayerTip: ONE / 2n,
      nonce: `0x${"ef".repeat(32)}`,
    })
    expect(getAddress(escrow)).toBe(predictSkyEscrowAddressLocally(FACTORY, args))
    expect(options.escrow.equals(EthAddress.fromString(escrow))).toBe(true)
    const payload = decodePlainWithdrawalPayload(options.userPayload)
    expect([payload.recipient.toString(), payload.relayerTip]).toEqual([escrow, ONE])
    const run = options.l1Operation
    expect(run.target.equals(EthAddress.fromString(FACTORY))).toBe(true)
    expect(`0x${run.calldata.toString("hex")}`).toBe(encodeSkyEscrowDeploy(args))
    expect(run.condition.token.equals(EthAddress.fromString(DAI))).toBe(true)
    expect(run.condition.recipient.equals(EthAddress.fromString(escrow))).toBe(true)
    expect(options).toMatchObject({
      broadcaster: BROADCASTER.toString(),
      memo: { sky: { ...args, factory: FACTORY } },
      executor: EXECUTOR,
      withdrawalFee: ONE / 10n,
    })
  })
})

describe("readSkyEscrowOutcome", () => {
  const ESCROW = getAddress(`0x${"ec".repeat(20)}`)
  const OTHER_ESCROW = getAddress(`0x${"ed".repeat(20)}`)
  const SUSDS = getAddress(`0x${"5d".repeat(20)}`)
  const TO = getAddress(`0x${"7a".repeat(20)}`)
  const TX = `0x${"ce".repeat(32)}` as Hex

  const DAI_AMOUNT = 95n
  const ran = (escrow: Address, blockNumber: bigint): HeldLog => ({
    address: escrow,
    topics: encodeEventTopics({
      abi: SkyEscrowAbi,
      eventName: "SkyEscrowExecuted",
      args: { route: SkyRoute.Stake, tipRecipient: SENDER },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [DAI_AMOUNT, 90n]),
    blockNumber,
    transactionHash: TX,
  })
  const recovered = (
    blockNumber: bigint,
    token: Address = DAI,
    at = ESCROW,
    amount = 5n,
  ): HeldLog => ({
    address: at,
    topics: encodeEventTopics({
      abi: SkyEscrowAbi,
      eventName: "EscrowRecovered",
      args: { token, target: TO },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber,
    transactionHash: TX,
  })
  const read = (logs: HeldLog[]) =>
    readSkyEscrowOutcome(memoryLogsClient(logs), {
      escrow: ESCROW,
      fromBlock: 5n,
      toBlock: 9n,
    })

  it.each([
    { name: "another escrow's run", logs: [ran(OTHER_ESCROW, 6n)] },
    { name: "another escrow's recovery", logs: [recovered(6n, DAI, OTHER_ESCROW)] },
    { name: "a run and a recovery before the range", logs: [ran(ESCROW, 4n), recovered(4n)] },
    { name: "a run and a recovery past the range", logs: [ran(ESCROW, 10n), recovered(10n)] },
  ])("reads nothing while the escrow waits, over $name", async ({ logs }) => {
    expect(await read(logs)).toBeUndefined()
  })

  it("reads the run and its DAI at either end of the range", async () => {
    expect(await read([ran(ESCROW, 5n)])).toEqual({ kind: "ran", assets: DAI_AMOUNT })
    expect(await read([ran(ESCROW, 9n)])).toEqual({ kind: "ran", assets: DAI_AMOUNT })
  })

  it("reads every recovery in the range, in log order: what each took back, whom it paid and when", async () => {
    expect(await read([recovered(7n, SUSDS, ESCROW, 3n), recovered(8n)])).toEqual({
      kind: "recovered",
      recoveries: [
        { txHash: TX, token: SUSDS, amount: 3n, to: TO, blockNumber: 7n },
        { txHash: TX, token: getAddress(DAI), amount: 5n, to: TO, blockNumber: 8n },
      ],
    })
  })

  it("reads a run over a later recovery", async () => {
    expect(await read([ran(ESCROW, 6n), recovered(8n)])).toEqual({
      kind: "ran",
      assets: DAI_AMOUNT,
    })
  })
})
