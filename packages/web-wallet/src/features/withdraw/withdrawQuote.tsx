import { useEffect, useState } from "react"
import { DEFAULT_DECIMALS, Network, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  SwapOnWithdrawSimulator,
  SwapTipExceedsInputError,
  type RelayerTipEstimate,
  type SwapOnWithdrawOutput,
} from "@obsidion/sdk"
import { formatUnits, type Address, type PublicClient } from "viem"
import { Warning } from "../../ui/Warning"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { currentFpcFundingCut, fpcFundingCut } from "../fees/fpcFundingCut"
import { tokenAmount, usdFigure } from "../../ui/format"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "./withdrawAssets"

/** The market fee a swap's relayer tip was priced at. */
export type SwapGas = Pick<RelayerTipEstimate, "baseFee" | "priorityFee">

/** The DAI a route takes off the burn, priced live. */
export interface WithdrawalFee {
  /** What the plain withdrawal executor pays whoever finalizes the release on L1. */
  withdrawalRelayerTip: bigint
  /** DAI the escrow commits to paying whoever runs the swap: 1.1x the relayer's simulated floor.
   *  Zero on the direct route, which runs no swap. */
  swapRelayerTip: bigint
  /** The fee `swapRelayerTip` was priced at. Absent on the direct route. */
  swapGas?: SwapGas
  /** `OxidePortal.FPC_FUNDING_CUT`. */
  fpcFundingCut: bigint
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
}

/**
 * `status` tracks the estimate; the fee is priced on its own. The direct route answers its estimate
 * outright, so it is "ready" before the portal's cut is read and `fee` is undefined until then. Every
 * figure and gate reads `fee` for that reason, never `status` alone.
 */
export interface WithdrawalQuoteState {
  status: "idle" | "loading" | "ready" | "unavailable"
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

export type SimulateSwap = (args: {
  output: SwapOnWithdrawOutput
  /** Absent prices the route alone, on a reference amount. */
  amountAtomic?: bigint
  /** Absent prices against a placeholder recipient. */
  recipient?: Address
  proverTip?: bigint
}) => Promise<SwapQuote>

/** How often a priced route is re-simulated: the relayer's own re-quote cadence. */
export const SWAP_QUOTE_REFRESH_MS = 30_000

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

// Caches the deployment reads (escrow implementation, feed, balance slot) across simulations.
let simulatorCache: { key: string; simulator: SwapOnWithdrawSimulator } | undefined

function swapSimulator(client: PublicClient, tuple: OxideEnvTuple): SwapOnWithdrawSimulator {
  const addresses = {
    swapEscrowFactory: requireTupleField(tuple, "swapEscrowFactory") as Address,
    operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
    token: requireTupleField(tuple, "token") as Address,
  }
  const key = Object.values(addresses).join("|")
  if (simulatorCache?.key !== key) {
    simulatorCache = { key, simulator: new SwapOnWithdrawSimulator(client, addresses) }
  }
  return simulatorCache.simulator
}

function routeFee(cut: bigint, proverTip: bigint, tip?: RelayerTipEstimate): WithdrawalFee {
  const swapRelayerTip = tip?.relayerTip ?? 0n
  return {
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    swapRelayerTip,
    ...(tip ? { swapGas: { baseFee: tip.baseFee, priorityFee: tip.priorityFee } } : {}),
    fpcFundingCut: cut,
    proverTip,
    floorAtomic: WITHDRAW_RELAYER_TIP + cut + proverTip + swapRelayerTip,
  }
}

/**
 * Simulate the swap oxide's relayer will run for this withdrawal and price its tip off that. The fee
 * is always answered: an amount the fee leaves nothing of gets its floor back without an estimate, and
 * no amount at all prices the route on a reference amount.
 */
const simulateSwap: SimulateSwap = async (args) =>
  simulateSwapForTuple(args, await getOxideTuple(getConfig()))

export async function simulateSwapForTuple(
  args: Parameters<SimulateSwap>[0],
  tuple: OxideEnvTuple,
): Promise<SwapQuote> {
  const config = getConfig()
  const client = l1PublicClient(config)
  const cut = await fpcFundingCut(client, requireTupleField(tuple, "portal") as Address)
  const simulator = swapSimulator(client, tuple)
  const proverTip = args.proverTip ?? 0n
  const fee = (tip: RelayerTipEstimate): WithdrawalFee => routeFee(cut, proverTip, tip)
  // An amount the portal's own deductions consume cannot be simulated; price the route instead.
  const exact =
    args.amountAtomic !== undefined && args.amountAtomic > WITHDRAW_RELAYER_TIP + cut + proverTip
      ? args.amountAtomic
      : undefined
  try {
    const simulation = await simulator.simulate({
      output: args.output,
      amount: exact ?? REFERENCE_AMOUNT,
      deductions: { withdrawalRelayerTip: WITHDRAW_RELAYER_TIP, proverTip, fpcFundingCut: cut },
      recipient: args.recipient ?? REFERENCE_RECIPIENT,
    })
    return {
      fee: fee(simulation),
      estimate:
        exact === undefined
          ? undefined
          : { amountOut: simulation.amountOut, decimals: simulation.decimals },
    }
  } catch (err) {
    if (err instanceof SwapTipExceedsInputError) return { fee: fee(err.tip) }
    throw err
  }
}

/**
 * Live pricing for one receive asset: the route's fee and, for an amount, its output estimate. The
 * direct route needs only the portal's cut, so it is priced off that one read. A swap route runs the
 * simulator on the debounced amount and re-runs it every {@link SWAP_QUOTE_REFRESH_MS} while it stays
 * selected. A simulation that fails leaves the route unavailable — there is no fallback tip to offer
 * the relayer.
 */
export function useSwapSimulation({
  receiveAsset,
  amountAtomic,
  recipient,
  network,
  sourceKey = "active",
  simulate = simulateSwap,
  readCut = currentFpcFundingCut,
  proverTip = 0n,
  debounceMs = 300,
  refreshMs = SWAP_QUOTE_REFRESH_MS,
}: {
  receiveAsset: WithdrawalReceiveAsset
  /** The burn amount. Absent (or non-positive) prices the route alone. */
  amountAtomic?: bigint
  recipient?: Address
  network: Network
  sourceKey?: string
  simulate?: SimulateSwap
  /** The direct route's one live pricing input. */
  readCut?: () => Promise<bigint>
  /** Offered on the burn; every route's fee includes it. */
  proverTip?: bigint
  debounceMs?: number
  refreshMs?: number
}): WithdrawalQuoteState {
  const scope = JSON.stringify([network, sourceKey])
  const requestKey = JSON.stringify([
    receiveAsset,
    amountAtomic?.toString(),
    recipient,
    proverTip.toString(),
    scope,
  ])
  // A fee and a tip belong to the asset that priced them: another asset's route never inherits
  // them, so a swap's relayer tip cannot be charged on the direct route while its cut is read.
  const [snapshot, setSnapshot] = useState<{
    key: string
    scope: string
    asset: WithdrawalReceiveAsset
    state: WithdrawalQuoteState
  }>({ key: requestKey, scope, asset: receiveAsset, state: { status: "idle" } })

  useEffect(() => {
    const setState = (state: WithdrawalQuoteState) =>
      setSnapshot({ key: requestKey, scope, asset: receiveAsset, state })
    const carriedFee = (current: {
      scope: string
      asset: WithdrawalReceiveAsset
      state: WithdrawalQuoteState
    }) =>
      current.scope === scope && current.asset === receiveAsset ? current.state.fee : undefined
    const amount = amountAtomic !== undefined && amountAtomic > 0n ? amountAtomic : undefined
    if (receiveAsset === "DAI") {
      let live = true
      const estimate = echoEstimate(amount)
      // The typed amount is what lands, so the estimate is answered outright and only the fee waits
      // on the portal's cut.
      setSnapshot((current) => ({
        key: requestKey,
        scope,
        asset: receiveAsset,
        state: { status: "ready", fee: carriedFee(current), estimate },
      }))
      void readCut().then(
        (cut) => {
          if (!live) return
          setState({ status: "ready", fee: routeFee(cut, proverTip), estimate })
        },
        () => {
          if (live) setState({ status: "unavailable", estimate })
        },
      )
      return () => {
        live = false
      }
    }
    // Testnet has no swap stack; sandbox and mainnet both deploy one.
    if (network !== Network.MAINNET && network !== Network.SANDBOX) {
      setState({ status: "unavailable" })
      return
    }

    let active = true
    let inFlight = false
    setSnapshot((current) => ({
      key: requestKey,
      scope,
      asset: receiveAsset,
      state: { status: "loading", fee: carriedFee(current) },
    }))
    const run = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const quote = await simulate({
          output: receiveAsset,
          amountAtomic: amount,
          recipient,
          proverTip,
        })
        if (!active) return
        setState({ status: "ready", ...quote })
      } catch {
        if (active) setState({ status: "unavailable" })
      } finally {
        inFlight = false
      }
    }
    const timer = window.setTimeout(() => void run(), debounceMs)
    const interval = window.setInterval(() => void run(), refreshMs)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [
    amountAtomic,
    debounceMs,
    network,
    proverTip,
    readCut,
    receiveAsset,
    recipient,
    refreshMs,
    simulate,
    requestKey,
    scope,
  ])

  // Effects in consumers run before this hook's state reset is rendered. Never expose a ready
  // quote from the previous inputs during that render, even if its simulation already finished.
  // The direct route's estimate is the new amount itself, so it answers without waiting.
  if (snapshot.key === requestKey) return snapshot.state
  const fee =
    snapshot.scope === scope && snapshot.asset === receiveAsset ? snapshot.state.fee : undefined
  return receiveAsset === "DAI"
    ? { status: "ready", fee, estimate: echoEstimate(amountAtomic) }
    : { status: "loading", fee }
}

/**
 * The atomic floor an amount has to clear to leave anything behind: the withdrawal relayer tip, the
 * prover tip and the portal's cut on any route, plus the relayer tip a swap commits to, so `planSwapOnWithdraw`
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

export const SWAP_UNAVAILABLE_COPY = "Swap fee unavailable. Withdraw DAI instead."

/** " at 3.4 gwei": the market fee the tip was priced at, base plus priority. */
function swapGasDetail(gas: SwapGas | undefined): string {
  if (!gas) return ""
  return ` at ${tokenAmount(formatUnits(gas.baseFee + gas.priorityFee, 9), 1)} gwei`
}

/** What a swap route adds to the fee, and why it closes when it cannot be priced. */
export function SwapFeeNote({ state }: { state: WithdrawalQuoteState }) {
  if (state.status === "unavailable") {
    return <Warning title={SWAP_UNAVAILABLE_COPY} />
  }
  if (!state.fee) return null
  const tip = usdFigure(formatUnits(state.fee.swapRelayerTip, DEFAULT_DECIMALS))
  return (
    <small className="ww-withdraw__fee-note">
      Includes {tip} for L1 gas{swapGasDetail(state.fee.swapGas)}.
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
      case "idle":
        return "—"
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
