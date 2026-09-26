/**
 * Prices a swap-on-withdraw the way oxide's relayer prices it, by simulating the exact L1 transaction the
 * relayer will send — `OperationExecutor.execute(factory, deployAndExecute(args), DAI, minPayout)` — against
 * current L1 state, with the counterfactual escrow funded by a state override. The relayer executes only
 * when the escrow's tip covers its own break-even (gas limit x max fee, converted through the Chainlink
 * ETH/USD feed), so the tip offered is that break-even plus a margin. An operation whose tip is short is
 * re-quoted every relayer poll: a low tip delays the swap, it never fails it.
 *
 * The same simulation runs the swap, so the payout estimate is the executed route (3pool for the stables,
 * 3pool + Universal Router for ETH) on the live pools, exact to the wei at simulation time.
 */
import { defaultL1TxUtilsConfig } from "@aztec/ethereum/l1-tx-utils/config"
import {
  OperationExecutorAbi,
  SwapEscrowAbi,
  SwapEscrowFactoryAbi,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddressLocally,
  type SwapEscrowArgs,
} from "@oxide/l1-contracts"
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  multicall3Abi,
  numberToHex,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem"
import { SWAP_ON_WITHDRAW_TIP_MARGIN_BPS } from "@obsidion/core/constants"
import type { SwapOnWithdrawOutput } from "@obsidion/core/types"
import { MULTICALL3_ADDRESS } from "../services/sipaClaim.js"
import { swapRouteForOutput, type SwapDeductions } from "./swapOnWithdraw.js"

/**
 * Gas the relayer adds on top of its buffered estimate: it estimates with `minPayout = 0` and sends with the
 * real break-even, whose non-zero calldata bytes cost this much more. Mirrors oxide-relayer's
 * `EXECUTOR_MIN_PAYOUT_CALLDATA_GAS` (pinned by `swapOnWithdrawSimulator.test.ts`).
 */
export const EXECUTOR_MIN_PAYOUT_CALLDATA_GAS = 384n

/** Every Chainlink ETH/USD feed the relayer prices with answers in 8 decimals; it never reads the scale. */
export const ETH_USD_FEED_DECIMALS = 8n

/** Oldest feed answer the relayer prices with. Older, and it refuses to quote, so no tip would move it. */
export const MAX_ETH_USD_AGE_SECONDS = 60n * 60n

const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const

const MULTICALL3_ETH_BALANCE_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const

type Multicall3Call = { target: Address; allowFailure: boolean; callData: Hex }

/** Storage slots probed for the token's `balanceOf` mapping. DAI keeps it at 2, OpenZeppelin's ERC20 at 0. */
const BALANCE_SLOT_CANDIDATES = 32
const BALANCE_SLOT_MARKER = 1n << 128n
const BALANCE_PROBE_HOLDER = "0x1111111111111111111111111111111111111111" as Address

/**
 * The simulated escrow's nonce. Only the tip has to match the real escrow; its address does not, and the
 * real nonce is drawn by the gateway when the withdrawal is built.
 */
const SIMULATION_NONCE = keccak256(new TextEncoder().encode("obsidion.swap-on-withdraw.simulation"))
/** The execution path never reads the recovery commitment; it only has to be nonzero. */
const SIMULATION_RECOVERY_COMMITMENT = keccak256(
  new TextEncoder().encode("obsidion.swap-on-withdraw.simulation-recovery"),
)

export interface RelayerTipInputs {
  /** Raw `eth_estimateGas` of the relayer's `OperationExecutor.execute`. */
  gasEstimate: bigint
  /** Base fee of the latest block, wei. */
  baseFee: bigint
  /** `eth_maxPriorityFeePerGas`, wei. */
  priorityFee: bigint
  /** The ETH/USD feed's latest round: the answer in `ETH_USD_FEED_DECIMALS` and when it was updated. */
  ethUsd: { answer: bigint; updatedAt: bigint }
  /** Timestamp of the latest block, the clock the feed's age is measured on. */
  blockTimestamp: bigint
}

/** The relayer's own quote for the transaction, and the tip that clears it. All DAI figures are 18-dec. */
export interface RelayerTipEstimate {
  /** DAI the escrow will commit to paying whoever runs the swap. */
  relayerTip: bigint
  /** DAI the relayer's `minPayout` will demand for this exact transaction. */
  breakEven: bigint
  /** The gas limit the relayer will send with. */
  gasLimit: bigint
  /** The max fee per gas the relayer will send with, wei. */
  maxFeePerGas: bigint
  /** The ETH/USD answer the break-even was converted at, in `ETH_USD_FEED_DECIMALS`. */
  ethUsd: bigint
}

export interface SwapSimulation extends RelayerTipEstimate {
  /** What the recipient receives, in the output asset's smallest unit. */
  amountOut: bigint
  /** Decimal exponent of `amountOut`. Read off the output token; ETH is 18. */
  decimals: number
}

/** The tip is known but the amount leaves the escrow nothing to swap after paying it. */
export class SwapTipExceedsInputError extends RangeError {
  constructor(readonly tip: RelayerTipEstimate, readonly escrowFunding: bigint) {
    super(
      `swap-on-withdraw: the relayer tip ${tip.relayerTip} leaves nothing of the ${escrowFunding} the escrow ` +
        "would receive",
    )
  }
}

const requireDefault = (value: number | undefined, key: string): number => {
  if (value === undefined) throw new Error(`@aztec/ethereum defaultL1TxUtilsConfig lacks ${key}`)
  return value
}

/** `value` raised by `percentage`, floored the way `L1TxUtils` does it. */
const bumped = (value: bigint, percentage: number): bigint =>
  value + (value * BigInt(Math.round(percentage * 100))) / 100_00n

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator

/** The relayer's gas limit for a raw estimate: `L1TxUtils`' buffer, then the `minPayout` calldata gas. */
export function relayerGasLimit(gasEstimate: bigint): bigint {
  const buffer = requireDefault(
    defaultL1TxUtilsConfig.gasLimitBufferPercentage,
    "gasLimitBufferPercentage",
  )
  return bumped(gasEstimate, buffer) + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS
}

/**
 * The max fee per gas the relayer's first send carries: the base fee bumped 12.5% per block it tolerates
 * stalling for, plus the priority fee bumped by `L1TxUtils`' percentage, capped at its max gwei.
 */
export function relayerMaxFeePerGas(baseFee: bigint, priorityFee: bigint): bigint {
  const config = defaultL1TxUtilsConfig
  const stallTimeMs = requireDefault(config.stallTimeMs, "stallTimeMs")
  const slotMs = requireDefault(config.ethereumSlotDuration, "ethereumSlotDuration") * 1000
  const priorityBump = requireDefault(config.priorityFeeBumpPercentage, "priorityFeeBumpPercentage")
  const maxGwei = requireDefault(config.maxGwei, "maxGwei")

  let maxFee = baseFee
  for (let block = 0; block < Math.ceil(stallTimeMs / slotMs); block++) {
    maxFee = ceilDiv(maxFee * 1_125n, 1_000n)
  }
  maxFee += bumped(priorityFee, priorityBump)
  const cap = BigInt(Math.trunc(maxGwei * 1e9))
  return cap > 0n && maxFee > cap ? cap : maxFee
}

/** The feed answer the relayer would price with, or a throw where it would refuse to. */
export function requireFreshEthUsd(
  ethUsd: RelayerTipInputs["ethUsd"],
  blockTimestamp: bigint,
): bigint {
  if (ethUsd.answer <= 0n) {
    throw new Error(`ETH/USD feed answered ${ethUsd.answer}; the relayer refuses to price with it`)
  }
  const age = blockTimestamp - ethUsd.updatedAt
  if (age > MAX_ETH_USD_AGE_SECONDS) {
    throw new Error(
      `ETH/USD feed is stale: answer is ${age}s old, the relayer prices with at most ${MAX_ETH_USD_AGE_SECONDS}s`,
    )
  }
  return ethUsd.answer
}

/** The relayer's break-even for a simulated `execute`, and the tip that clears it by the margin. */
export function relayerTipFromGas(inputs: RelayerTipInputs): RelayerTipEstimate {
  const ethUsd = requireFreshEthUsd(inputs.ethUsd, inputs.blockTimestamp)
  const gasLimit = relayerGasLimit(inputs.gasEstimate)
  const maxFeePerGas = relayerMaxFeePerGas(inputs.baseFee, inputs.priorityFee)
  // wei x (USD per ETH in feed decimals) / feed scale = 18-dec USD, which is DAI at par.
  const breakEven = ceilDiv(gasLimit * maxFeePerGas * ethUsd, 10n ** ETH_USD_FEED_DECIMALS)
  const relayerTip = ceilDiv(breakEven * SWAP_ON_WITHDRAW_TIP_MARGIN_BPS, 10_000n)
  return { relayerTip, breakEven, gasLimit, maxFeePerGas, ethUsd }
}

/** `keccak256(abi.encode(key, slot))`: where a Solidity `mapping(address => uint256)` at `slot` keeps `key`. */
export function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]))
}

/**
 * The storage slot of `token`'s `balanceOf` mapping, found by overriding every candidate slot with a
 * distinct marker in one `eth_call` and reading which one `balanceOf` returns.
 */
export async function findBalanceOfSlot(
  client: Pick<PublicClient, "readContract">,
  token: Address,
): Promise<bigint> {
  const stateDiff = Array.from({ length: BALANCE_SLOT_CANDIDATES }, (_, slot) => ({
    slot: mappingSlot(BALANCE_PROBE_HOLDER, BigInt(slot)),
    value: numberToHex(BALANCE_SLOT_MARKER + BigInt(slot), { size: 32 }),
  }))
  const read = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BALANCE_PROBE_HOLDER],
    stateOverride: [{ address: token, stateDiff }],
  })
  const slot = read - BALANCE_SLOT_MARKER
  if (slot < 0n || slot >= BigInt(BALANCE_SLOT_CANDIDATES)) {
    throw new Error(
      `${token}: balanceOf does not read a Solidity mapping in storage slots 0-${
        BALANCE_SLOT_CANDIDATES - 1
      }, ` + "so an escrow cannot be funded by state override",
    )
  }
  return slot
}

export interface SwapSimulationArgs {
  output: SwapOnWithdrawOutput
  /** The gross burn amount, raw token units. */
  amount: bigint
  /** What the portal takes out of the burn before the escrow sees it. */
  deductions: Omit<SwapDeductions, "relayerTip">
  /** Final L1 recipient of the swap output. Also the simulated sender, so the payout is measured on it. */
  recipient: Address
  /** The last simulated tip. Gas is estimated with it committed, so the estimate converges on the real send. */
  previousTip?: bigint
}

export class SwapOnWithdrawSimulator {
  private deployment?: Promise<{
    implementation: Address
    ethUsdFeed: Address
    outputToken: Record<
      Exclude<SwapOnWithdrawOutput, "ETH">,
      { address: Address; decimals: number }
    >
  }>
  private balanceOfSlot?: Promise<bigint>

  constructor(
    private readonly client: PublicClient,
    private readonly tuple: {
      swapEscrowFactory: Address
      operationExecutor: Address
      token: Address
    },
  ) {}

  async simulate(args: SwapSimulationArgs): Promise<SwapSimulation> {
    const { withdrawalRelayerTip, proverTip, fpcFundingCut } = args.deductions
    const escrowFunding = args.amount - withdrawalRelayerTip - proverTip - fpcFundingCut
    if (escrowFunding <= 0n) {
      throw new RangeError("swap-on-withdraw: the amount does not cover the withdrawal fees")
    }

    const [deployment, balanceOfSlot, block, priorityFee] = await Promise.all([
      this.readDeployment(),
      this.readBalanceOfSlot(),
      this.client.getBlock({ blockTag: "latest" }),
      this.client.estimateMaxPriorityFeePerGas(),
    ])
    const [, answer, , updatedAt] = await this.client.readContract({
      address: deployment.ethUsdFeed,
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    })

    // The factory only executes an escrow funded above its tip, so a carried-over tip the amount cannot
    // cover would estimate the no-op instead of the swap.
    const seedTip =
      args.previousTip !== undefined && args.previousTip < escrowFunding ? args.previousTip : 0n
    const seedArgs = this.escrowArgs(args, seedTip)
    const gasEstimate = await this.client.estimateGas({
      account: args.recipient,
      to: this.tuple.operationExecutor,
      data: this.executeCalldata(seedArgs),
      stateOverride: this.fundingOverride(seedArgs, escrowFunding, balanceOfSlot),
    })
    const tip = relayerTipFromGas({
      gasEstimate,
      baseFee: block.baseFeePerGas ?? 0n,
      priorityFee,
      ethUsd: { answer, updatedAt },
      blockTimestamp: block.timestamp,
    })
    if (escrowFunding <= tip.relayerTip) throw new SwapTipExceedsInputError(tip, escrowFunding)

    const finalArgs = this.escrowArgs(args, tip.relayerTip)
    const amountOut = await this.payout(
      args,
      finalArgs,
      this.fundingOverride(finalArgs, escrowFunding, balanceOfSlot),
      deployment.outputToken,
    )
    const decimals = args.output === "ETH" ? 18 : deployment.outputToken[args.output].decimals
    return { ...tip, amountOut, decimals }
  }

  private escrowArgs(args: SwapSimulationArgs, relayerTip: bigint): SwapEscrowArgs {
    return {
      route: swapRouteForOutput(args.output),
      recipient: args.recipient,
      recoveryCommitment: SIMULATION_RECOVERY_COMMITMENT,
      relayerTip,
      nonce: SIMULATION_NONCE,
    }
  }

  private executeCalldata(escrowArgs: SwapEscrowArgs): Hex {
    return encodeFunctionData({
      abi: OperationExecutorAbi,
      functionName: "execute",
      args: [
        this.tuple.swapEscrowFactory,
        encodeSwapEscrowDeploy(escrowArgs),
        this.tuple.token,
        0n,
      ],
    })
  }

  /** The escrow holding what the portal will release to it, before anything is deployed. */
  private fundingOverride(
    escrowArgs: SwapEscrowArgs,
    escrowFunding: bigint,
    balanceOfSlot: bigint,
  ): StateOverride {
    const escrow = predictSwapEscrowAddressLocally(this.tuple.swapEscrowFactory, escrowArgs)
    return [
      {
        address: this.tuple.token,
        stateDiff: [
          {
            slot: mappingSlot(escrow, balanceOfSlot),
            value: numberToHex(escrowFunding, { size: 32 }),
          },
        ],
      },
    ]
  }

  /**
   * What the executed swap pays the recipient: their balance read before and after `deployAndExecute` in one
   * Multicall3 `aggregate3`, all under the funding override.
   */
  private async payout(
    args: SwapSimulationArgs,
    escrowArgs: SwapEscrowArgs,
    stateOverride: StateOverride,
    outputToken: Awaited<NonNullable<SwapOnWithdrawSimulator["deployment"]>>["outputToken"],
  ): Promise<bigint> {
    const balanceCall: Multicall3Call =
      args.output === "ETH"
        ? {
            target: MULTICALL3_ADDRESS,
            allowFailure: false,
            callData: encodeFunctionData({
              abi: MULTICALL3_ETH_BALANCE_ABI,
              functionName: "getEthBalance",
              args: [args.recipient],
            }),
          }
        : {
            target: outputToken[args.output].address,
            allowFailure: false,
            callData: encodeFunctionData({
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [args.recipient],
            }),
          }
    const calls: Multicall3Call[] = [
      balanceCall,
      {
        target: this.tuple.swapEscrowFactory,
        allowFailure: false,
        callData: encodeSwapEscrowDeploy(escrowArgs),
      },
      balanceCall,
    ]
    const { data } = await this.client.call({
      to: MULTICALL3_ADDRESS,
      data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
      account: args.recipient,
      stateOverride,
    })
    if (!data) throw new Error("swap-on-withdraw: Multicall3 aggregate3 returned no data")
    const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data })
    const balance = (index: number): bigint =>
      decodeAbiParameters([{ type: "uint256" }], results[index]!.returnData)[0]
    return balance(2) - balance(0)
  }

  private readDeployment() {
    this.deployment ??= (async () => {
      const implementation = await this.client.readContract({
        address: this.tuple.swapEscrowFactory,
        abi: SwapEscrowFactoryAbi,
        functionName: "IMPLEMENTATION",
      })
      const readImplementation = (functionName: "ETH_USD_FEED" | "USDC" | "USDT") =>
        this.client.readContract({ address: implementation, abi: SwapEscrowAbi, functionName })
      const [ethUsdFeed, usdc, usdt] = await Promise.all([
        readImplementation("ETH_USD_FEED"),
        readImplementation("USDC"),
        readImplementation("USDT"),
      ])
      const readDecimals = (address: Address) =>
        this.client.readContract({ address, abi: erc20Abi, functionName: "decimals" })
      const [usdcDecimals, usdtDecimals] = await Promise.all([
        readDecimals(usdc),
        readDecimals(usdt),
      ])
      return {
        implementation,
        ethUsdFeed,
        outputToken: {
          USDC: { address: usdc, decimals: usdcDecimals },
          USDT: { address: usdt, decimals: usdtDecimals },
        },
      }
    })()
    this.deployment.catch(() => {
      this.deployment = undefined
    })
    return this.deployment
  }

  private readBalanceOfSlot(): Promise<bigint> {
    this.balanceOfSlot ??= findBalanceOfSlot(this.client, this.tuple.token)
    this.balanceOfSlot.catch(() => {
      this.balanceOfSlot = undefined
    })
    return this.balanceOfSlot
  }
}
