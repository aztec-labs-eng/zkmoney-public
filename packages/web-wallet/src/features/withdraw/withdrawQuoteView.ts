/**
 * What a withdrawal pays, lands and confirms, from its state and the quotes the view reads: the
 * fee, what arrives, the limit and balance checks, the speed's tip and the plan it submits.
 */
import type { Address } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  NOMINAL_USD_VALUATION,
  exceedsBalance,
  withdrawalMaxNet,
  type BalanceView,
} from "@obsidion/front-core"
import type { BridgeOutToken } from "@obsidion/sdk"
import { parseUnits } from "viem"
import { amountError, chargedAmount } from "../../ui/format"
import { withdrawalLimitProblem } from "../limits/withdrawalLimit"
import type { LimitProblem } from "../limits/publicLimit"
import type { BridgeOutChoice } from "./bridgeOut"
import {
  bridgeOutDecimals,
  type BridgeOutAnswer,
  type BridgeOutAsk,
  type BridgeOutChain,
  type BridgeOutPriced,
} from "./bridgeOutQuote"
import { freshDaiForGas, type FreshQuote } from "./freshAddressGateway"
import { fasterIsWorthIt, type FasterWithdrawal, type WithdrawalEta } from "./useFasterWithdrawal"
import type { WithdrawalSpeed } from "./WithdrawalSpeedPicker"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "./withdrawAssets"
import type { WithdrawalQuoteState } from "./withdrawQuote"

/** How the burn leaves: straight to the recipient, through a swap escrow, or across a bridge. */
export type WithdrawRoute =
  | { kind: "direct"; quote: FreshQuote }
  | { kind: "swap"; quote: FreshQuote }
  | { kind: "bridge"; choice: BridgeOutChoice }

/**
 * Everything a withdrawal needs to submit. `fresh` sends it through the fresh-address gateway
 * (funds, gas, `route.quote`); otherwise an Ethereum route goes through the sponsored one and a
 * bridge through `submitBridgeOut`. Amounts are DAI base units, `receivedAtomic` the coin's.
 */
export interface WithdrawPlan {
  recipient: Address
  name?: string
  chainId: number
  coin: WithdrawalReceiveAsset
  /** From: what leaves the wallet before any gas share, every fee inside it. */
  amountAtomic: bigint
  /** DAI that lands as ETH for gas. */
  gasAtomic: bigint
  /** The whole burn: From, the gas share and what the gas adds to the fee. */
  burnAtomic: bigint
  /** To, in `receivedDecimals`. */
  receivedAtomic: bigint
  receivedDecimals: number
  speed: WithdrawalSpeed
  proverTip: bigint
  route: WithdrawRoute
  fresh: boolean
  /** Minutes until it lands, as the review estimated: the release, plus the bridge's on a bridge-out. */
  etaMinutes?: number
}

export type WithdrawStep = "etherfi" | "address" | "amount" | "gas" | "review" | "status"

/** The recipient the address or ether.fi step picked. */
export interface Chosen {
  recipient: Address
  name?: string
  /** Picked on the ether.fi step. */
  etherfi?: boolean
  /** Picked on the ether.fi step with saving turned off. */
  unsaved?: boolean
}

/** A typed To: the From being priced, how often it was re-priced, and the fee it was priced at. */
export interface WithdrawSolve {
  from: bigint
  tries: number
  fee?: bigint
}

/** The part of a withdrawal's state its quote reads. */
export interface WithdrawQuoteState {
  history: readonly WithdrawStep[]
  chosen?: Chosen
  route: { chainId: number; coin: WithdrawalReceiveAsset }
  /** The amount field's text, the field it was typed in, and whether MAX holds it. */
  amount: { text: string; side: "from" | "to"; maxed: boolean }
  /** The gas chip picked on the gas step. */
  gasAtomic: bigint
  /** The speed the user picked; Faster whenever an offer stands, else Standard. */
  speed?: WithdrawalSpeed
  solve?: WithdrawSolve
  /** The last bridge answer, for the ask `key` names. */
  bridge?: { key: string; answer: BridgeOutAnswer }
  /** The least burn the last bridge answer named, for the route and tip `route` names. */
  floor?: { route: string; floor: bigint }
  /** The last fee a route priced, shown faded while a new amount is priced. */
  lastFee?: { route: string; fee: bigint }
}

/** What the view knows besides the quotes. */
export interface WithdrawContext {
  l1ChainId: number
  l1Name: string
  /** The bridge chains the recipient can take: none for an ether.fi Cash address. */
  routes: readonly BridgeOutChain[]
  /** The coins Ethereum lands. */
  ethCoins: readonly WithdrawalReceiveAsset[]
  /** A gas share can land: the swap stack runs, and the recipient is neither Cash nor a contract. */
  gasOffered: boolean
  /** The recipient's L1 reads: a contract, holds ETH, never used. */
  contract: boolean
  hasEth: boolean
  fresh: boolean
  /** The screening cleared the recipient. */
  cleared: boolean
  offer?: FasterWithdrawal
  eta?: WithdrawalEta
  /** The first speed quote is out. */
  speedLoading: boolean
}

/** The live quotes for the current asks. */
export interface WithdrawQuotes extends WithdrawContext {
  /** The burn on Ethereum, gas share included. */
  swap: WithdrawalQuoteState
  /** The same burn without the gas share; `swap` itself off the gas and review steps. */
  gasless: WithdrawalQuoteState
  /** The bridge read of the current ask. */
  bridge: { status: "idle" | "waiting" | "answered" | "failed" }
}

export interface WithdrawBalance {
  wallet: BalanceView
  txAmountCap?: bigint
}

/** Dollars of DAI that land as ETH, on top of the funds. At most `MAX_DAI_FOR_GAS`. */
export const GAS_CHIPS: readonly bigint[] = [0n, 1n, 5n, 10n, 15n].map(
  (d) => d * 10n ** BigInt(DEFAULT_DECIMALS),
)
/** Where an address without ETH starts, when the balance covers it; then $1, then None. */
const DEFAULT_GAS = [GAS_CHIPS[2]!, GAS_CHIPS[1]!]

/** USDC and USDT on Ethereum. */
const STABLE_DECIMALS = 6
export const CENT = 10n ** BigInt(DEFAULT_DECIMALS - 2)
/** Over a bridge's fixed fees, DAI enough for a quote that prices its escrow tip and Across fee. */
const FLOOR_PROBE = 100n * 10n ** BigInt(DEFAULT_DECIMALS)

/** The key a bridge answer is kept under: its chain, token and amount, whatever the tip. */
export const bridgeKey = (ask: Pick<BridgeOutAsk, "chainId" | "token" | "amount">) =>
  `${ask.chainId}:${ask.token}:${ask.amount}`
/** The key a bridge floor is kept under: its chain, token and tip. */
export const floorRoute = (chainId: number, token: string, proverTip: bigint) =>
  `${chainId}:${token}:${proverTip}`
/** The key a route's last fee is kept under. */
export const feeRoute = (chainId: number, coin: string) => `${chainId}:${coin}`

/** What lands, in DAI units. */
export const bridgeLanded = (quote: Pick<BridgeOutPriced, "minReceived">, decimals: number) =>
  quote.minReceived * 10n ** BigInt(DEFAULT_DECIMALS - decimals)

/** The bridge-out's whole fee: the amount less what lands. */
export const bridgeFee = (amount: bigint, quote: BridgeOutPriced, decimals: number) => {
  const landed = bridgeLanded(quote, decimals)
  return amount > landed ? amount - landed : 0n
}

/** The units To is typed and quoted in: off Ethereum, the token Across lands there. */
function decimalsOf(onL1: boolean, coin: WithdrawalReceiveAsset, chainId: number): number {
  if (!onL1) return bridgeOutDecimals(coin as BridgeOutToken, chainId)
  return coin === "USDC" || coin === "USDT" ? STABLE_DECIMALS : DEFAULT_DECIMALS
}

const parsed = (text: string, decimals: number): bigint | undefined => {
  const charged = chargedAmount(text, "0", decimals)
  return charged !== undefined && !amountError(text, decimals)
    ? parseUnits(charged, decimals)
    : undefined
}

/** What the burn asks of the quotes: the route, its units, From and the gas share. */
export function withdrawAsks(
  state: WithdrawQuoteState,
  ctx: WithdrawContext,
  balance: WithdrawBalance,
) {
  const { wallet, txAmountCap } = balance
  const bridgeRoutes = ctx.routes
  const offered = (id: number): readonly WithdrawalReceiveAsset[] =>
    id === ctx.l1ChainId
      ? ctx.ethCoins
      : bridgeRoutes.find((r) => r.chain.chainId === id)?.tokens.map((t) => t.symbol) ?? []
  const route = bridgeRoutes.find((r) => r.chain.chainId === state.route.chainId)
  const chainId = route ? route.chain.chainId : ctx.l1ChainId
  const onL1 = chainId === ctx.l1ChainId
  const coins = offered(chainId)
  const coin = coins.includes(state.route.coin) ? state.route.coin : coins[0] ?? "DAI"
  const step = state.history.at(-1)
  // ETH lands as gas itself, so it never adds a share.
  const gasStep = onL1 && ctx.gasOffered && coin !== "ETH"
  const gasApplied = gasStep && state.history.includes("gas")
  const balanceAtomic = wallet.main?.atomic ?? 0n
  const toDecimals = decimalsOf(onL1, coin, chainId)
  const typedDecimals = state.amount.side === "to" ? toDecimals : DEFAULT_DECIMALS
  const typedAtomic = parsed(state.amount.text, typedDecimals)
  // MAX is the balance: every fee comes out of it.
  const max = wallet.main
    ? withdrawalMaxNet({
        spendableAtomic: balanceAtomic,
        feeAtomic: 0n,
        decimals: DEFAULT_DECIMALS,
        valuation: NOMINAL_USD_VALUATION,
        txAmountCap,
      })
    : undefined
  // The exact balance, dust included; a limit below it is the limit.
  const maxAtomic =
    max?.status === "available" ? (max.bound === "balance" ? balanceAtomic : max.atomic) : undefined
  // MAX waits for this session's balance read: a cached figure can be high.
  const canMax = wallet.readThisSession && maxAtomic !== undefined && maxAtomic > 0n
  // From: the burn before any gas. Typed in To, it is the guess the solve has reached.
  const fundsAtomic =
    state.amount.side === "to"
      ? typedAtomic
        ? state.solve?.from
        : undefined
      : state.amount.maxed && canMax
      ? maxAtomic
      : typedAtomic || undefined
  const fits = (gas: bigint) => (fundsAtomic ?? 0n) + gas <= balanceAtomic
  const defaultGasAtomic = ctx.hasEth ? 0n : DEFAULT_GAS.find(fits) ?? 0n
  // A chip that no longer fits falls back to the default.
  const chipAtomic =
    step === "gas" && state.gasAtomic > 0n && !fits(state.gasAtomic)
      ? defaultGasAtomic
      : state.gasAtomic
  const gasAtomic = gasApplied ? chipAtomic : 0n
  const daiForGas = onL1 ? freshDaiForGas(coin, gasAtomic) : 0n
  // Speed: Faster whenever an offer stands, unless picked otherwise.
  const { offer } = ctx
  const speed = state.speed ?? (offer ? "faster" : "standard")
  const settled = !!offer && !fasterIsWorthIt(offer)
  const pricedTip = speed === "faster" && offer && !settled ? offer.proverTip : 0n
  const gaslessLive = onL1 && gasAtomic > 0n && (step === "gas" || step === "review")
  return {
    bridgeRoutes,
    offered,
    route,
    chainId,
    onL1,
    coin,
    step,
    gasStep,
    gasApplied,
    balanceAtomic,
    toDecimals,
    typedDecimals,
    typedAtomic,
    max,
    maxAtomic,
    canMax,
    fundsAtomic,
    fits,
    defaultGasAtomic,
    chipAtomic,
    gasAtomic,
    daiForGas,
    speed,
    settled,
    pricedTip,
    /** The burn's quote on Ethereum: From and the gas share. A bridge chain reads only the executor. */
    swapAsk: {
      receiveAsset: onL1 ? coin : ("DAI" as const),
      amountAtomic: onL1 && fundsAtomic !== undefined ? fundsAtomic + gasAtomic : undefined,
      proverTip: pricedTip,
      daiForGas,
    },
    /** The same burn without the gas share, live on the gas and review steps; else direct DAI. */
    gaslessAsk: {
      receiveAsset: gaslessLive ? coin : ("DAI" as const),
      amountAtomic: gaslessLive ? fundsAtomic : undefined,
      proverTip: pricedTip,
      daiForGas: 0n,
    },
    gaslessLive,
  }
}

export type WithdrawAsks = ReturnType<typeof withdrawAsks>

/**
 * The bridge ask for From; under the bridge's fixed fees (the main quote's floor) no amount can
 * bridge, so a probe above them prices the escrow tip instead.
 */
export function bridgeAsk(
  asks: WithdrawAsks,
  fixedFee: bigint | undefined,
  wallet: BalanceView,
): (BridgeOutAsk & { probe: boolean }) | undefined {
  const { onL1, route, fundsAtomic, coin, pricedTip } = asks
  if (onL1 || !route || !fundsAtomic) return undefined
  const probe = fixedFee !== undefined && fundsAtomic <= fixedFee
  const amount = probe ? fixedFee + FLOOR_PROBE : fundsAtomic
  if (!probe && exceedsBalance(wallet, amount)) return undefined
  return {
    provider: route.provider,
    l2Token: route.l2Token,
    chainId: route.chain.chainId,
    token: coin as BridgeOutToken,
    amount,
    proverTip: pricedTip,
    probe,
  }
}

/** A withdrawal's figures and checks, from its state and the live quotes. */
export function selectWithdrawQuote(
  state: WithdrawQuoteState,
  quotes: WithdrawQuotes,
  balance: WithdrawBalance,
) {
  const asks = withdrawAsks(state, quotes, balance)
  const { wallet, txAmountCap } = balance
  const { onL1, route, coin, fundsAtomic, gasAtomic, toDecimals, pricedTip, settled } = asks
  const { offer } = quotes
  const quote = quotes.swap
  const gaslessQuote = asks.gaslessLive ? quotes.gasless : quote
  const asset = withdrawalReceiveAsset(coin)
  const direct = onL1 && asset.direct && asks.daiForGas === 0n

  // What the gas share adds to the fee; undefined until both quotes answer.
  const gasTopUp =
    quote.fee && gaslessQuote.fee
      ? quote.fee.floorAtomic > gaslessQuote.fee.floorAtomic
        ? quote.fee.floorAtomic - gaslessQuote.fee.floorAtomic
        : 0n
      : undefined
  const topUp = gasAtomic > 0n ? gasTopUp ?? 0n : 0n
  // A refresh carries the fee it last priced; a new chip waits for its own.
  const topUpPending =
    gasAtomic > 0n &&
    (gasTopUp === undefined || quote.status !== "ready" || gaslessQuote.status !== "ready")
  // What leaves the wallet: From, and on Ethereum the gas share and what the gas adds to the fee.
  const burnAtomic =
    fundsAtomic === undefined ? undefined : onL1 ? fundsAtomic + gasAtomic + topUp : fundsAtomic
  // Off Ethereum the main quote is direct DAI: its floor is the executor fee, the relayer tip and
  // the speed tip, all of which a bridge takes out of the amount before its own fees.
  const fixedBridgeFee = onL1 ? undefined : quote.fee?.floorAtomic
  const ask = bridgeAsk(asks, fixedBridgeFee, wallet)
  const underFixed = !!ask?.probe
  const key = ask && bridgeKey(ask)
  const tipRoute = floorRoute(asks.chainId, coin, pricedTip)
  // A new tip re-prices the same bridge, so its last quote stays up meanwhile. A probe's quote
  // only names the floor.
  const bridgeAnswer = key && state.bridge?.key === key ? state.bridge.answer : undefined
  const bridgeFailed = !!key && quotes.bridge.status === "failed"
  const bridgeQuote = underFixed || bridgeFailed ? undefined : bridgeAnswer?.quote
  const bridgeBelow = underFixed || (!bridgeFailed && !!bridgeAnswer?.below)
  const bridgeFloorAtomic = state.floor?.route === tipRoute ? state.floor.floor : undefined
  const bridgeQuoting =
    !!key &&
    !bridgeFailed &&
    !bridgeAnswer?.below &&
    (underFixed ? !bridgeAnswer : !bridgeQuote || bridgeQuote.proverTip !== pricedTip)

  // The whole fee the amount step quotes, which comes out of From on every route.
  const feeAtomic = onL1
    ? gaslessQuote.fee?.floorAtomic
    : fundsAtomic !== undefined && bridgeQuote
    ? bridgeFee(fundsAtomic, bridgeQuote, toDecimals)
    : undefined
  const routeKey = feeRoute(asks.chainId, coin)
  // A new amount or tip is being priced on this route.
  const pricing = onL1
    ? quote.status === "loading" || gaslessQuote.status === "loading"
    : bridgeQuoting
  const staleFeeAtomic =
    pricing && feeAtomic === undefined && state.lastFee?.route === routeKey
      ? state.lastFee.fee
      : undefined
  // From at or below the fee: nothing reaches the recipient.
  const belowFee =
    fundsAtomic !== undefined &&
    (onL1 ? feeAtomic !== undefined && fundsAtomic <= feeAtomic : underFixed || bridgeBelow)
  // The fee the floor message names: on a bridge, the floor its last quote or refusal named.
  const floorFeeAtomic = onL1 ? feeAtomic : bridgeFloorAtomic
  // The review's whole fee: the amount step's, and on Ethereum what the gas adds.
  const wholeAtomic = feeAtomic === undefined ? undefined : feeAtomic + (onL1 ? topUp : 0n)
  // The fee a moved quote is checked against on the review: the burn's own quote's on Ethereum.
  const reviewFeeAtomic = onL1 ? quote.fee?.floorAtomic : feeAtomic
  // To, in the coin's units: DAI is From less the fee exactly; a swap's is the no-gas quote's
  // output, since the main quote's lands the gas share too.
  const receivedAtomic = belowFee
    ? 0n
    : onL1
    ? coin === "DAI"
      ? fundsAtomic !== undefined && feeAtomic !== undefined
        ? fundsAtomic - feeAtomic
        : undefined
      : gaslessQuote.status === "ready"
      ? gaslessQuote.estimate?.amountOut
      : undefined
    : bridgeQuote?.minReceived
  // The burn's quote, landing what the review shows: the burn adds the gas share and its fee on top
  // of the quoted From, so the main quote's own output falls short of it by that fee.
  const committed: FreshQuote | undefined =
    onL1 && quote.status === "ready" && quote.fee && quote.estimate && receivedAtomic !== undefined
      ? {
          ...quote.estimate,
          amountOut: receivedAtomic,
          relayerTip: quote.fee.swapRelayerTip,
          floorAtomic: quote.fee.floorAtomic,
          proverTip: quote.fee.proverTip,
        }
      : undefined

  /** The From a typed To starts at: its value in DAI plus the fee last quoted. */
  const guessFrom = (toAtomic: bigint): bigint => {
    const fee = feeAtomic ?? fixedBridgeFee ?? 0n
    if (coin !== "ETH") return toAtomic * 10n ** BigInt(DEFAULT_DECIMALS - toDecimals) + fee
    // With no rate yet, the balance prices one and the solve scales from there.
    if (!receivedAtomic || fundsAtomic === undefined || feeAtomic === undefined)
      return asks.balanceAtomic > 0n ? asks.balanceAtomic : 1000n * 10n ** BigInt(DEFAULT_DECIMALS)
    return (toAtomic * (fundsAtomic - feeAtomic)) / receivedAtomic + fee
  }

  // A floor not yet priced counts nothing, so only a known excess shows.
  const problem: LimitProblem | undefined =
    burnAtomic !== undefined ? withdrawalLimitProblem(burnAtomic, txAmountCap) : undefined
  // Only a known shortfall blocks: a balance still loading reads 0.
  const overspent = exceedsBalance(wallet, burnAtomic)
  const tipInFee = onL1 ? quote.fee?.proverTip ?? 0n : 0n
  /** A gas chip fits when From, its gas and what the gas adds to the fee fit in the balance. */
  const chipFits = (gas: bigint) => (fundsAtomic ?? 0n) + gas + topUp <= asks.balanceAtomic

  // The tip is inside the fee, so Ethereum never refuses Fast; a bridge needs it under the amount.
  const covers =
    !onL1 && offer && fundsAtomic !== undefined && bridgeQuote
      ? fundsAtomic > bridgeQuote.withdrawalFee + WITHDRAW_RELAYER_TIP + offer.proverTip
      : undefined
  // A blocked Faster falls back to Standard.
  const blocked = !!offer && !settled && covers === false
  const proverTip = asks.speed === "faster" && offer && !settled && !blocked ? offer.proverTip : 0n
  const fast = proverTip > 0n || settled
  const etaSeconds = offer
    ? fast
      ? offer.tippedEtaSeconds
      : offer.standardEtaSeconds
    : quotes.eta?.standardSeconds
  const etaMinutes =
    etaSeconds === undefined
      ? undefined
      : Math.max(1, Math.round(etaSeconds / 60)) + (onL1 ? 0 : route?.chain.etaMinutes ?? 0)
  const arrivesIn = onL1 ? etaMinutes : undefined

  // The fee on screen was priced with the tip the burn will carry.
  const priced = onL1
    ? committed !== undefined &&
      quote.fee?.proverTip === proverTip &&
      (gasAtomic === 0n || gasTopUp !== undefined)
    : !!bridgeQuote && !bridgeQuoting && bridgeQuote.proverTip === proverTip
  const ethOnContract = quotes.contract && coin === "ETH"
  // A contract may not take the token, or exist on a bridge chain: the user is warned, not stopped.
  const onContract = quotes.contract
  // Every check trusts only this session's balance read.
  const valid =
    wallet.readThisSession &&
    fundsAtomic !== undefined &&
    fundsAtomic > 0n &&
    !belowFee &&
    receivedAtomic !== undefined &&
    priced &&
    !quotes.speedLoading &&
    !problem &&
    !overspent &&
    !ethOnContract &&
    quotes.cleared

  const bridgeChoice =
    !onL1 && route && bridgeQuote && bridgeQuote.proverTip === proverTip
      ? { chain: route.chain, token: coin as BridgeOutToken, quote: bridgeQuote, proverTip }
      : undefined

  const plan = (): WithdrawPlan | undefined => {
    const { chosen } = state
    if (!chosen || fundsAtomic === undefined || burnAtomic === undefined) return undefined
    if (receivedAtomic === undefined) return undefined
    const base = {
      recipient: chosen.recipient,
      name: chosen.name,
      chainId: asks.chainId,
      coin,
      amountAtomic: fundsAtomic,
      gasAtomic,
      burnAtomic,
      receivedAtomic,
      receivedDecimals: toDecimals,
      speed: fast ? ("faster" as const) : ("standard" as const),
      proverTip,
      etaMinutes,
    }
    if (onL1 && committed)
      return {
        ...base,
        route: { kind: direct ? "direct" : "swap", quote: committed },
        fresh: gasAtomic > 0n || quotes.fresh,
      }
    if (bridgeChoice)
      return {
        ...base,
        route: {
          kind: "bridge",
          choice: {
            chain: bridgeChoice.chain,
            token: bridgeChoice.token,
            quote: bridgeChoice.quote,
          },
        },
        fresh: false,
      }
    return undefined
  }

  return {
    ...asks,
    asset,
    direct,
    gasTopUp,
    topUp,
    topUpPending,
    burnAtomic,
    committed,
    fixedBridgeFee,
    bridgeAsk: ask,
    bridgeQuote,
    bridgeBelow,
    bridgeFailed,
    bridgeFloorAtomic,
    feeAtomic,
    pricing,
    staleFeeAtomic,
    belowFee,
    floorFeeAtomic,
    wholeAtomic,
    reviewFeeAtomic,
    receivedAtomic,
    guessFrom,
    problem,
    overspent,
    tipInFee,
    chipFits,
    covers,
    blocked,
    proverTip,
    fast,
    etaSeconds,
    etaMinutes,
    arrivesIn,
    priced,
    ethOnContract,
    onContract,
    valid,
    bridgeChoice,
    plan,
  }
}

export type WithdrawQuoteView = ReturnType<typeof selectWithdrawQuote>
