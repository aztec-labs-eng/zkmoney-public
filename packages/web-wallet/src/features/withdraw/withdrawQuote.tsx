import { useMemo } from "react"
import {
  UNREAD,
  useDebouncedKey,
  useStore,
  type QueryState,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { DEFAULT_DECIMALS, Network, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  SwapTipExceedsInputError,
  type RelayerTipEstimate,
  type SwapEscrowOutput,
  type WithdrawalExecutor,
} from "@obsidion/sdk"
import { formatUnits, type Address } from "viem"
import { Warning } from "../../ui/Warning"
import type { PageFacts } from "../../session/pageChain"
import { useSession } from "../../session/session"
import { shortL1Addr, tokenAmount, usdFigure } from "../../ui/format"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "./withdrawAssets"
import { withdrawalExecutor } from "./withdrawalFee"
import {
  ACTIVE_SOURCE,
  SWAP_QUOTE_REFRESH_MS,
  feeOf,
  priced,
  sameRoute,
  shownQuote,
  swapsTo,
  type RouteKey,
  type SwapKey,
} from "./swapQuotes"

/** The DAI a route takes off the burn, priced live. */
export interface WithdrawalFee {
  /** What the plain withdrawal executor keeps from the burn. */
  withdrawalFee: bigint
  /** Who the executor pays `withdrawalFee` to. Absent when it names nobody. */
  feeBeneficiary?: Address
  /** What the plain withdrawal executor pays whoever finalizes the release on L1. */
  withdrawalRelayerTip: bigint
  /** DAI the escrow commits to paying whoever runs the swap: 1.1x the relayer's simulated floor.
   *  Zero on the direct route, which runs no swap. */
  swapRelayerTip: bigint
  /** What the portal pays the first prover of the burn's checkpoint. */
  proverTip: bigint
  /** Every component summed: the whole fee, and the atomic floor an amount has to clear. */
  floorAtomic: bigint
}

export interface SwapEstimate {
  /** Exact output in the selected asset's smallest unit. */
  amountOut: bigint
  /** Decimal exponent for formatting `amountOut`. */
  decimals: number
  /** ETH the escrow's gas swap pays, wei. Absent without one. */
  gasOut?: bigint
}

/**
 * `status` tracks the estimate; the fee is priced on its own. The direct route answers both outright.
 * A swap route's `fee` is undefined until its first simulation, so every figure and gate reads `fee`,
 * never `status` alone.
 */
export interface WithdrawalQuoteState {
  status: "loading" | "ready" | "unavailable"
  /** The route's fee. Kept while the same route reloads, so the floor never flickers away. */
  fee?: WithdrawalFee
  /** The output for the exact amount. Absent while only the fee is priced, and for an amount below the floor. */
  estimate?: SwapEstimate
}

/** One simulation's answer: the fee always, the output only for a real amount above the floor. */
export interface SwapQuote {
  fee: WithdrawalFee
  estimate?: SwapEstimate
}

export type SwapArgs = {
  output: SwapEscrowOutput
  /** Absent prices the route alone, on a reference amount. */
  amountAtomic?: bigint
  /** Absent prices against a placeholder recipient. */
  recipient?: Address
  proverTip?: bigint
  /** DAI the escrow swaps to ETH for the recipient before its route. */
  daiForGas?: bigint
}
/** A new input holds this long first, so typing simulates only the amount it settles on. */
export const SWAP_DEBOUNCE_MS = 300

/** A floor that moves by less than this between quotes is kept: one cent of the wallet asset. */
export const FLOOR_SETTLE_ATOMIC = 10n ** 16n

/**
 * The floor a burn carries once a route has priced it. The burn is the typed amount plus the floor,
 * and the floor comes from pricing that very burn, so each quote could re-key the next; a swap tip
 * that jitters by atomic units (the simulator feeds the last tip into its gas estimate) would then
 * never settle. A move under {@link FLOOR_SETTLE_ATOMIC} keeps the floor the burn already carries;
 * an unpriced route keeps it too, so an unavailable state can settle instead of restarting the read.
 */
export function settledFloor(previous: bigint, learned: bigint | undefined): bigint {
  if (learned === undefined || previous === 0n) return learned ?? previous
  const delta = learned > previous ? learned - previous : previous - learned
  return delta < FLOOR_SETTLE_ATOMIC ? previous : learned
}

/** Priced when there is no amount yet. Gas does not depend on the swap size, so any fillable amount serves. */
const REFERENCE_AMOUNT = 1_000n * 10n ** 18n
/** Priced when there is no recipient yet: an address that accepts ETH and holds no code. */
const REFERENCE_RECIPIENT = "0x000000000000000000000000000000000000dEaD" as Address

/** The direct route's output: the burn amount itself, so it needs no simulation to answer. */
const echoEstimate = (amountAtomic?: bigint): SwapEstimate | undefined =>
  amountAtomic !== undefined && amountAtomic > 0n
    ? { amountOut: amountAtomic, decimals: DEFAULT_DECIMALS }
    : undefined

/** The executor terms a quote prices: its fee, and who receives it. */
export type ExecutorTerms = Pick<WithdrawalExecutor, "fee" | "beneficiary">

function routeFee(
  proverTip: bigint,
  { fee: withdrawalFee, beneficiary }: ExecutorTerms,
  tip?: RelayerTipEstimate,
): WithdrawalFee {
  const swapRelayerTip = tip?.relayerTip ?? 0n
  return {
    withdrawalFee,
    ...(beneficiary ? { feeBeneficiary: beneficiary } : {}),
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    swapRelayerTip,
    proverTip,
    floorAtomic: withdrawalFee + WITHDRAW_RELAYER_TIP + proverTip + swapRelayerTip,
  }
}

/**
 * Simulate the swap oxide's relayer will run for this withdrawal on `tuple`'s deployment and price
 * its tip off that. The fee is always answered: an amount the fee leaves nothing of gets its floor
 * back without an estimate, and no amount at all prices the route on a reference amount.
 */
export async function simulateSwapForTuple(
  args: SwapArgs,
  tuple: OxideEnvTuple,
  page: PageFacts,
): Promise<SwapQuote> {
  const simulator = await page.chain.swapSimulator(tuple).ready()
  const proverTip = args.proverTip ?? 0n
  const daiForGas = args.daiForGas ?? 0n
  const executor = await withdrawalExecutor(page.chain, tuple)
  const withdrawalFee = executor.fee
  const fee = (tip: RelayerTipEstimate): WithdrawalFee => routeFee(proverTip, executor, tip)
  // An amount the withdrawal's fee, its tips and the gas swap consume cannot be simulated; price
  // the route instead.
  const exact =
    args.amountAtomic !== undefined &&
    args.amountAtomic > withdrawalFee + WITHDRAW_RELAYER_TIP + proverTip + daiForGas
      ? args.amountAtomic
      : undefined
  try {
    const simulation = await simulator.simulate({
      output: args.output,
      amount: exact ?? REFERENCE_AMOUNT,
      deductions: { withdrawalFee, withdrawalRelayerTip: WITHDRAW_RELAYER_TIP, proverTip },
      recipient: args.recipient ?? REFERENCE_RECIPIENT,
      daiForGas,
    })
    return {
      fee: fee(simulation),
      estimate:
        exact === undefined
          ? undefined
          : {
              amountOut: simulation.amountOut,
              decimals: simulation.decimals,
              ...(daiForGas > 0n ? { gasOut: simulation.gasOut } : {}),
            },
    }
  } catch (err) {
    if (err instanceof SwapTipExceedsInputError) return { fee: fee(err.tip) }
    throw err
  }
}

/**
 * The direct route: the typed amount lands, and the fee is the executor's fee plus the fixed tips.
 * Unavailable without an executor or once its read failed.
 */
export function directQuote(
  executor: QueryState<ExecutorTerms> | null,
  proverTip: bigint,
  amountAtomic: bigint | undefined,
): WithdrawalQuoteState {
  if (!executor || executor.status === "failed") return { status: "unavailable" }
  if (executor.status === "pending") return { status: "loading" }
  return {
    status: "ready",
    fee: routeFee(proverTip, executor.value),
    estimate: echoEstimate(amountAtomic),
  }
}

/**
 * Live pricing for one receive asset: the route's fee and, for an amount, its output estimate. The
 * direct route's fee is the executor's fee and the fixed tips, so it reads only the executor's fee.
 * A swap route, and DAI with a gas swap, reads the page's simulation of the inputs the user has held
 * for {@link SWAP_DEBOUNCE_MS}, re-run every {@link SWAP_QUOTE_REFRESH_MS} while shown.
 */
export function useSwapSimulation({
  receiveAsset,
  amountAtomic,
  recipient,
  network,
  sourceKey = ACTIVE_SOURCE,
  executor,
  proverTip = 0n,
  daiForGas = 0n,
  quotes,
}: {
  receiveAsset: WithdrawalReceiveAsset
  /** The burn amount. Absent (or non-positive) prices the route alone. */
  amountAtomic?: bigint
  recipient?: Address
  network: Network
  /** The deployment a swap prices on, null while it is unread: a fee never carries to another. */
  sourceKey?: string | null
  /** The source executor's fee and beneficiary: the active one's when absent, none when null. */
  executor?: ReadonlyStore<QueryState<ExecutorTerms>> | null
  /** Offered on the burn; every route's fee includes it. */
  proverTip?: bigint
  /** DAI the escrow swaps to ETH for the recipient; the route then always rides an escrow. */
  daiForGas?: bigint
  /** Where a swap key's quote is read: the page's when absent. */
  quotes?: (key: SwapKey) => ReadonlyStore<QueryState<SwapQuote>>
}): WithdrawalQuoteState {
  const { page } = useSession()
  const feeRead = useStore(executor === undefined ? page.activeExecutorTerms : executor ?? UNREAD)
  const amount = amountAtomic !== undefined && amountAtomic > 0n ? amountAtomic : undefined
  const typed = useMemo(
    (): RouteKey => ({
      source: sourceKey,
      output: receiveAsset,
      amountAtomic: amount,
      recipient,
      proverTip,
      daiForGas,
    }),
    [sourceKey, receiveAsset, amount, recipient, proverTip, daiForGas],
  )
  const { key, before } = useDebouncedKey(typed, SWAP_DEBOUNCE_MS)
  // Testnet has no swap stack; sandbox and mainnet both deploy one.
  const swappable = network === Network.MAINNET || network === Network.SANDBOX
  const quoted = (k: RouteKey | undefined) =>
    swappable && k && priced(k) && swapsTo(k) ? (quotes ?? page.swapQuote)(k) : UNREAD
  const read = useStore(quoted(key))
  // The key held before carries its fee, read only until the held key has one of its own.
  const carry = before && sameRoute(before, typed) && !feeOf(read) ? before : undefined
  const earlier = useStore(quoted(carry))

  if (!swapsTo(typed)) return directQuote(executor === null ? null : feeRead, proverTip, amount)
  if (!swappable || !priced(typed)) return { status: "unavailable" }
  return shownQuote(typed, { key, state: read }, carry && { key: carry, state: earlier })
}

/**
 * The atomic floor an amount has to clear to leave anything behind: the executor's fee, the withdrawal
 * relayer tip and the prover tip on any route, plus the relayer tip a swap commits to, so `planSwapOnWithdraw`
 * has something left to swap. Zero until the route is priced — the form then only applies its own
 * minimum, and a too-small swap would still be caught at plan time.
 */
export function swapFloorAtomic(state: WithdrawalQuoteState): bigint {
  return state.fee?.floorAtomic ?? 0n
}

/**
 * The all-in fee for a route, as a decimal display string in the burned asset: everything the
 * recipient does not receive. Undefined while the route is unpriced, which is not a figure to
 * round down to one component of it.
 */
export function withdrawalFeeDisplay(state: WithdrawalQuoteState): string | undefined {
  return state.fee ? formatUnits(state.fee.floorAtomic, DEFAULT_DECIMALS) : undefined
}

/** True when the relayer tip would eat more than a fifth of the amount. */
export function swapTipIsHigh(state: WithdrawalQuoteState, amountAtomic?: bigint): boolean {
  return (
    state.fee !== undefined &&
    amountAtomic !== undefined &&
    amountAtomic > 0n &&
    state.fee.swapRelayerTip * 5n > amountAtomic
  )
}

/** Shown wherever a route's fee cannot be read, so no screen prices a withdrawal it cannot quote. */
export const FEE_UNAVAILABLE_COPY =
  "The fee can't be read right now. Check your connection and try again."

/** The executor's protocol fee inside a quoted fee, and who receives it; nothing when it takes none. */
export function ProtocolFeeNote({ fee, beneficiary }: { fee?: bigint; beneficiary?: Address }) {
  if (!fee) return null
  return (
    <small className="ww-withdraw__fee-note">
      Includes a {usdFigure(formatUnits(fee, DEFAULT_DECIMALS))} protocol fee
      {beneficiary && (
        <>
          {" "}
          paid to <span title={beneficiary}>{shortL1Addr(beneficiary)}</span>
        </>
      )}
      .
    </small>
  )
}

export function SwapGasWarning({
  state,
  amountAtomic,
}: {
  state: WithdrawalQuoteState
  amountAtomic?: bigint
}) {
  if (!swapTipIsHigh(state, amountAtomic)) return null
  return (
    <Warning title="L1 gas is over 20% of this amount">
      It costs the same whatever you withdraw, so a larger amount loses less of it. Withdrawing DAI
      costs less.
    </Warning>
  )
}

export function WithdrawalEstimate({
  receiveAsset,
  state,
}: {
  receiveAsset: WithdrawalReceiveAsset
  state: WithdrawalQuoteState
}) {
  const option = withdrawalReceiveAsset(receiveAsset)
  const value = (() => {
    switch (state.status) {
      case "loading":
        return "Loading…"
      case "unavailable":
        return "Estimate unavailable"
      case "ready":
        return state.estimate
          ? `${tokenAmount(formatUnits(state.estimate.amountOut, state.estimate.decimals))} ${
              option.symbol
            }`
          : "—"
    }
  })()

  return (
    <div
      className="ww-withdraw__estimate"
      data-quote-state={state.status}
      aria-live="polite"
      aria-busy={state.status === "loading"}
    >
      <div>
        <span>Estimated received:</span>
        <b>{value}</b>
      </div>
      {!option.direct && (
        <small>
          Already net of withdrawal and swap fees. Estimate uses current pool state; the final
          amount can change before L1 execution.
        </small>
      )}
    </div>
  )
}
