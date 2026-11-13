/**
 * Prices a move: the one relayer tip its release pays, in the withdrawn token, and the `minOut` its
 * terms step is proved with. A release cannot be simulated before its proof lands, so the tip
 * prices a plain release's measured gas plus the route, simulated as the portal calls the executor.
 */
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { WalletError } from "@obsidion/core/errors"
import { MultiStepExecutorAbi } from "@oxide/l1-contracts/artifacts.js"
import { encodeMultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import type { CompiledRoute, MultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import { checkedMultiStepRemainder } from "@oxide/oxide-client/executors/multi_step_withdrawal.js"
import {
  UINT256_EXTRA_CALLDATA_GAS,
  estimateL1OperationFeeValues,
} from "@oxide/oxide-client/l1_operation_quote.js"
import { encodeExecutorRelayerPayload } from "@oxide/oxide-lib/executor.js"
import {
  BaseError,
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  numberToHex,
  slice,
  zeroAddress,
} from "viem"
import type { Address, PublicClient } from "viem"
import { findBalanceOfSlot, mappingSlot } from "../escrow/swapOnWithdrawSimulator.js"
import type { RelayerTipEstimate } from "../tip/l1OperationQuote.js"
import { PAR_TIP_TOKEN, readTipPrices, tipQuote, withTipMargin } from "../tip/tipQuote.js"
import type { EthUsdSource, TipTokenPrice } from "../tip/tipQuote.js"
import type { ConversionQuote, MoveDirection } from "./conversion.js"
import type { HoldingDeployment, HoldingRoute } from "./holdingDeployment.js"
import { MOVE_FEE_POOL_CUT, assertMoveFits, compileMove, moveEnds } from "./moveRoute.js"

const BPS = 10_000n

/**
 * The default `minOut` buffer. Moving in, a vault's shares per asset fall as the share price rises
 * while the proof waits; 0.1% covers a week of yield at 5% a year, not a jump in the price. Moving
 * out, assets per share do not fall, so the current rate holds.
 */
export const MOVE_BUFFER_BPS: Record<MoveDirection, bigint> = { in: 10n, out: 0n }

/**
 * A move's release outside its simulated route: the most measured on a mainnet fork, 141,359 gas
 * for a `Psm` move in, plus 10%, rounded up to the thousand.
 */
export const RELEASE_GAS_WITHOUT_ROUTE = 156_000n

/** The simulated `execute` pays it once more than the release does. */
const TX_INTRINSIC_GAS = 21_000n

/** `IExecutor.Flow.Withdrawal`. */
const WITHDRAWAL_FLOW = 0

/** Gas depends on whether the tip transfer writes a nonzero balance, not on the amount. */
const SIMULATION_TIP = 1n
/** The simulation opens neither commitment; both only need to be nonzero and field-sized. */
const SIMULATION_COMMITMENT = `0x00${keccak256(
  new TextEncoder().encode("obsidion.vault-move.simulation"),
).slice(4)}` as const
/** A fresh account, so the tip transfer is priced as a cold, zero-to-nonzero write. */
const SIMULATION_TIP_RECIPIENT = slice(
  keccak256(new TextEncoder().encode("obsidion.vault-move.simulation-tip-recipient")),
  12,
)

export interface MoveQuote extends RelayerTipEstimate {
  direction: MoveDirection
  /** The burn, in the withdrawn token: the base's moving in, the vault's shares moving out. */
  amount: bigint
  proverTip: bigint
  /** What the route keeps: the amount less both tips. */
  routed: bigint
  /** What the conversion takes, in the token it converts. */
  conversionFee: bigint
  /** What the conversion returns: the vault's asset moving in, the base's token moving out. */
  conversionOut: bigint
  conversionMinOut: bigint
  /** What the terms step returns at the current rate: shares moving in, the asset moving out. */
  expectedOut: bigint
  minOut: bigint
  /** Gas the simulated route used, within `gasUsed`. */
  routeGas: bigint
}

/** `move.tipsExceedAmount`; its `data.tips` is the tips, in the withdrawn token's base units. */
export function tipsExceedAmount(amount: bigint, tips: bigint): WalletError {
  return new WalletError(
    "move.tipsExceedAmount",
    `the tips ${tips} leave nothing of the ${amount} withdrawn`,
    { data: { tips: tips.toString() } },
  )
}

type QuoteClient = Pick<
  PublicClient,
  "getBlock" | "estimateMaxPriorityFeePerGas" | "simulateBlocks" | "readContract"
>

/**
 * Quotes a move of `amount`. Throws `move.tipsExceedAmount` when the tips leave nothing,
 * `move.routeTooLong` when the route cannot fit `recoveryMemo`, and `move.routeUnread` when a read
 * fails or the simulated route reverts.
 */
export async function quoteMove(
  client: QuoteClient,
  route: HoldingRoute,
  args: {
    direction: MoveDirection
    amount: bigint
    proverTip?: bigint
    /** Below the current rate, in basis points. Defaults by direction. */
    bufferBps?: bigint
    eth: EthUsdSource
    /** The memo the burn will carry, which sizes its recovery data. */
    recoveryMemo: Buffer
    /**
     * `amount` is what the route gets, and the quote's `amount` adds the tips to it. One read of
     * gas prices prices both, so the route gets `amount` exactly.
     */
    tipsOnTop?: boolean
  },
): Promise<MoveQuote> {
  const { direction, proverTip = 0n, tipsOnTop = false } = args
  const bufferBps = args.bufferBps ?? MOVE_BUFFER_BPS[direction]
  const executed = tipsOnTop ? args.amount : args.amount - proverTip
  if (executed <= 0n) throw tipsExceedAmount(args.amount, proverTip)
  assertMoveFits(route, direction, args.recoveryMemo)
  try {
    const token = direction === "in" ? PAR_TIP_TOKEN : await vaultShareTipPrice(client, route)
    // The route's gas does not depend on its amount, so it is measured before the tip is priced, on
    // an amount the route gets at least: the whole of it with the tips on top, else half.
    const probe = tipsOnTop ? executed : executed / 2n
    const [block, feeValues, prices, routeGas] = await Promise.all([
      client.getBlock({ blockTag: "latest" }),
      estimateL1OperationFeeValues(client),
      readTipPrices(client, { eth: args.eth, token }),
      simulateMove(client, route, direction, {
        executed: probe + SIMULATION_TIP,
        relayerTip: SIMULATION_TIP,
      }),
    ])
    const gasUsed = RELEASE_GAS_WITHOUT_ROUTE + routeGas
    // The relayer covers the two gas-cost words of the executor call, as oxide's quote does.
    const minPayout = tipQuote(prices, {
      gasToCover: gasUsed + 2n * UINT256_EXTRA_CALLDATA_GAS,
      block,
      feeValues,
    })
    const relayerTip = withTipMargin(minPayout)
    const feePoolCut = MOVE_FEE_POOL_CUT.amount
    const amount = tipsOnTop ? args.amount + proverTip + relayerTip + feePoolCut : args.amount
    if (amount - proverTip <= relayerTip + feePoolCut) {
      throw tipsExceedAmount(amount, proverTip + relayerTip + feePoolCut)
    }
    const routed = checkedMultiStepRemainder({
      amount,
      proverTip,
      relayerTip,
      feePoolCut,
      fixed: [],
    })
    const terms = await readMoveTerms(route, direction, routed, bufferBps)
    if (!tipsOnTop) {
      // The route as the release runs it: what it gets once the tip is paid, held to its floors.
      await simulateMove(client, route, direction, {
        executed: amount - proverTip,
        relayerTip,
        minOut: terms.minOut,
        conversionMinOut: terms.conversion.minOut,
      })
    }
    return {
      direction,
      amount,
      proverTip,
      routed,
      conversionFee: terms.conversion.fee,
      conversionOut: terms.conversion.out,
      conversionMinOut: terms.conversion.minOut,
      expectedOut: terms.expectedOut,
      minOut: terms.minOut,
      routeGas,
      relayerTip,
      minPayout,
      gasUsed,
      maxFeePerGas: feeValues.maxFeePerGas,
      usdPerEth: prices.usdPerEth,
      baseFee: block.baseFeePerGas ?? 0n,
      priorityFee: feeValues.maxPriorityFeePerGas,
    }
  } catch (error) {
    if (error instanceof WalletError) throw error
    throw new WalletError("move.routeUnread", String(error), { cause: error })
  }
}

/**
 * A vault share as the relayer values it: the assets one whole share converts to now, each whole
 * asset at one USD.
 */
export async function vaultShareTipPrice(
  client: Pick<PublicClient, "readContract">,
  { deployment, terms }: Pick<HoldingRoute, "deployment" | "terms">,
): Promise<TipTokenPrice> {
  const decimals = (token: Address) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
  const [shareDecimals, assetDecimals] = await Promise.all([
    decimals(deployment.held.token),
    decimals(deployment.held.asset),
  ])
  const assets = await terms.reader.convertToAssets(10n ** BigInt(shareDecimals))
  return {
    kind: "fixed",
    price: { usdPerToken: assets * 10n ** BigInt(18 - assetDecimals), decimals: shareDecimals },
  }
}

/** `expectedOut` less `bufferBps`, rounded down. */
export function bufferedMinOut(expectedOut: bigint, bufferBps: bigint): bigint {
  if (bufferBps < 0n || bufferBps >= BPS) throw new RangeError(`buffer ${bufferBps} bps`)
  return (expectedOut * (BPS - bufferBps)) / BPS
}

/** What a vault takes and gives back now: a deposit in its asset, a redeem in its shares. */
export interface TermsLimits {
  /** For a deposit by the portal-deposit adapter's route, in the asset. */
  maxDeposit: bigint
  /** For a redeem of the vault portal's shares, in shares. */
  maxRedeem: bigint
}

/** The vault's limits for a move's terms step. */
export async function readTermsLimits({
  deployment,
  terms,
}: Pick<HoldingRoute, "deployment" | "terms">): Promise<TermsLimits> {
  const [maxDeposit, maxRedeem] = await Promise.all([
    terms.reader.maxDeposit(deployment.portalDepositAdapter),
    terms.reader.maxRedeem(deployment.held.portal),
  ])
  return { maxDeposit, maxRedeem }
}

interface MoveTerms {
  /** What the terms step returns for the routed amount at the current rate. */
  expectedOut: bigint
  minOut: bigint
  conversion: ConversionQuote
}

/**
 * The terms step's terms for `routed`. The conversion runs before the terms step moving in, after
 * it moving out, and the step after it is floored on its `minOut`.
 */
async function readMoveTerms(
  { conversion, terms }: HoldingRoute,
  direction: MoveDirection,
  routed: bigint,
  bufferBps: bigint,
): Promise<MoveTerms> {
  const { reader } = terms
  if (direction === "in") {
    const converted = await conversion.quote("in", routed)
    const [expectedOut, floor] = await Promise.all([
      reader.previewDeposit(converted.out),
      reader.previewDeposit(converted.minOut),
    ])
    return { expectedOut, minOut: bufferedMinOut(floor, bufferBps), conversion: converted }
  }
  const expectedOut = await reader.previewRedeem(routed)
  const minOut = bufferedMinOut(expectedOut, bufferBps)
  return { expectedOut, minOut, conversion: await conversion.quote("out", minOut) }
}

/** The gas of the move's route alone, as the source portal calls the executor. */
function simulateMove(
  client: Pick<PublicClient, "simulateBlocks" | "readContract">,
  holding: HoldingRoute,
  direction: MoveDirection,
  run: { executed: bigint; relayerTip: bigint; minOut?: bigint; conversionMinOut?: bigint },
): Promise<bigint> {
  const { deployment } = holding
  const { route } = compileMove(holding, {
    direction,
    minOut: run.minOut ?? 1n,
    conversionMinOut: run.conversionMinOut ?? 1n,
    recipientCommitment: SIMULATION_COMMITMENT,
  })
  const { source } = moveEnds(deployment, direction)
  return simulateExecutorRoute(client, deployment, source, route, run)
}

/**
 * The gas `route` takes on the executor, called by `source.portal` with `executed` of its token,
 * which a state override gives the executor; the route gets what `relayerTip` leaves. Throws
 * `move.routeUnread` when the route reverts.
 */
export async function simulateExecutorRoute(
  client: Pick<PublicClient, "simulateBlocks" | "readContract">,
  deployment: Pick<HoldingDeployment, "executor">,
  source: { portal: Address; token: Address },
  route: CompiledRoute,
  { executed, relayerTip }: { executed: bigint; relayerTip: bigint },
): Promise<bigint> {
  const payload: MultiStepPayload = {
    relayerTip,
    recoveryCommitment: SIMULATION_COMMITMENT,
    ...route,
    remainderRecipient: route.remainderRecipient ?? zeroAddress,
  }
  const relayerPayload = encodeExecutorRelayerPayload({
    tipRecipient: EthAddress.fromString(SIMULATION_TIP_RECIPIENT),
  })
  const balanceOfSlot = await findBalanceOfSlot(client, source.token)
  const [block] = await client.simulateBlocks({
    blocks: [
      {
        stateOverrides: [
          {
            address: source.token,
            stateDiff: [
              {
                slot: mappingSlot(deployment.executor, balanceOfSlot),
                value: numberToHex(executed, { size: 32 }),
              },
            ],
          },
        ],
        calls: [
          {
            account: source.portal,
            to: deployment.executor,
            data: encodeFunctionData({
              abi: MultiStepExecutorAbi,
              functionName: "execute",
              args: [
                WITHDRAWAL_FLOW,
                executed,
                bytesToHex(encodeMultiStepPayload(payload)),
                bytesToHex(relayerPayload),
              ],
            }),
          },
        ],
      },
    ],
  })
  const call = block?.calls[0]
  if (!call) throw new WalletError("move.routeUnread", "the simulation returned no call")
  if (call.status === "failure") {
    const { error } = call
    const reason = error instanceof BaseError ? error.shortMessage : error.message
    throw new WalletError("move.routeUnread", `the route reverts: ${reason}`, { cause: error })
  }
  return call.gasUsed - TX_INTRINSIC_GAS
}
