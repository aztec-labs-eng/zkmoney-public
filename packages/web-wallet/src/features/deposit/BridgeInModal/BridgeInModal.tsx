import { useMemo, useState } from "react"
import { formatUnits, parseUnits, type Address, type Hex } from "viem"
import {
  admitDeposit,
  depositTokenValuation,
  useLookup,
  useStore,
  type BridgeInQuote,
  type BridgeInQuoteRequest,
} from "@obsidion/front-core"
import type { ConfigBridge } from "@obsidion/config-client"
import { GradientText } from "@obsidion/web-ds"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { Modal } from "../../../ui/Modal"
import { PickerList } from "../../../ui/PickerList/PickerList"
import { ChainIcon } from "../../../ui/ChainIcon/ChainIcon"
import { fixedCents, floorAtomic, floorTo, shortL1Addr, usdFigure } from "../../../ui/format"
import { coinFigure, displayDecimals } from "../../../ui/coinDecimals"
import { groupedCents } from "../../../ui/groupedCents"
import { useSession } from "../../../session/session"
import { CoinIcon, OriginTokenIcon } from "../../../ui/CoinIcon/CoinIcon"
import { AmountStep } from "../../../ui/flow/AmountStep/AmountStep"
import amountCopy from "../../../ui/flow/AmountStep/AmountStep.copy"
import { DepositReview } from "../DepositReview/DepositReview"
import { breakdown, FeeInfoButton } from "../../../ui/FeeBreakdown/FeeBreakdown"
import { BridgeInStatus, bridgeInStatusSheet } from "../BridgeInStatus/BridgeInStatus"
import { bridgeChainFor } from "../../../session/walletChains"
import {
  bridgeCharged,
  bridgeCredit,
  bridgeDepositFee,
  bridgeInputFor,
  bridgeReceived,
  bridgeLanding,
  bridgeRefusedFee,
  bridgeSize,
  bridgeUsdValue,
  bridgeRoutes,
  bridgeValuation,
  isNativeToken,
  tokenAddress,
} from "../bridgeChains"
import type { useL1Wallet } from "../../../session/useL1Wallet"
import type { DepositTokenOption } from "../../sipa/loadDepositFacts"
import type { CarriedAmount } from "../DepositScreen/depositScreenTransition"
import { tokenName } from "../../token/tokenName"
import { fmt } from "../../../lib/fmt"
import copy from "../sendFromWallet.copy"
import { UNREAD } from "../../fees/highFees"
import bridgeCopy from "./BridgeInModal.copy"
import type { BridgeInStart } from "../depositStart"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { openBridgeInFlow } from "./bridgeInFlow"
import { bridgeInStart, bridgeQuoteKey, type BridgeInStep } from "./bridgeInTransition"
import { bridgeInFees, selectQuote } from "../bridgeInQuoteView"
import { useRowTxAmountCap } from "../../token/useTxAmountCap"
import { useFundingCapacity } from "../useFundingCapacity"
import { FundingCapacityPanel } from "../FundingCapacityPanel"
import { UNKNOWN_CAPACITY } from "../fundingPreflight"
import { LimitNotice, usdFigureGrouped, type LimitProblem } from "../../limits/publicLimit"
import { WalletAboutLimitsSheet } from "../../limits/AboutLimitsSheet"

/** How deep each step sits, for the direction it swaps in from. */
const STEP_DEPTH: Record<BridgeInStep, number> = {
  amount: 0,
  chain: 1,
  token: 2,
  progress: 1,
  status: 3,
}

/**
 * Bridge in from a wallet on another chain: the bridge pays a fresh deposit address on L1 the
 * landing coin, the fee on top, and the deposit carries on from there. Picking Ethereum hands back
 * to the direct deposit.
 */
export function BridgeInModal({
  bridge,
  account: connected,
  l1,
  walletName,
  walletLabel,
  handle,
  toLabel,
  requestId,
  title = copy.bridgeTitle,
  fixedAmount,
  l1ChainId,
  l1ChainName,
  coins,
  origin: picked,
  carried,
  onCarry,
  recipient,
  onSent,
  onRetry,
  onEthereum,
  onChangeOrigin,
  depositMinutes,
  onBack,
  onChangeWallet,
  onClose,
  start,
}: {
  bridge: ConfigBridge
  /** The connected account; none once the wallet left, until one connects again. */
  account: Address | null
  /** The connected wallet: set, the From row connects one when none is. */
  l1?: ReturnType<typeof useL1Wallet>
  walletName: string
  /** Names the connected account in place of `walletName`, such as a saved wallet's. */
  walletLabel?: string
  handle?: string
  /** Who the bridge pays, where it is not this wallet: a request's payee tag. */
  toLabel?: string
  /** The request a payment pays. */
  requestId?: string
  /** The sheet's title on every step; a payment names whom it pays. */
  title?: string
  /** What must land, where the amount is not the payer's to choose: a fixed request's gross. */
  fixedAmount?: string
  l1ChainId: number
  l1ChainName: string
  /** The L1 deposit tokens: a bridge-in lands as the one {@link bridgeLanding} picks. */
  coins: DepositTokenOption[]
  /** The chain and token to start from, where they were picked before this sheet. */
  origin?: { chainId: number; symbol: string }
  /** The amount typed on another sheet, which this one starts from. */
  carried?: CarriedAmount
  /** Keeps what is typed here for the next sheet. */
  onCarry?: (amount: CarriedAmount) => void
  /** A fresh deposit address for this bridge-in. */
  recipient: () => Promise<Address | undefined>
  /** The address was paid by the bridge call in `originTxHash`. */
  onSent: (originTxHash: Hex) => void
  /** A bridge that came back: start the deposit over from its first step. */
  onRetry: () => void
  onEthereum: () => void
  /** Where the chain and token were picked before this sheet: changing them goes back there. */
  onChangeOrigin?: () => void
  /** Minutes the Ethereum deposit takes after the fill; unknown, the bridge leg shows alone. */
  depositMinutes?: number
  /** Leaves the amount step for the step before this sheet. */
  onBack?: () => void
  /** Opens the flow's wallet picker from the From row. */
  onChangeWallet?: () => void
  onClose: () => void
  /** Where it opens, in place of the amount. */
  start?: BridgeInStart
}) {
  // A request's exact amount lands only from its own token.
  const fixed = fixedAmount !== undefined
  const routes = useMemo(
    () => bridgeRoutes(bridge, coins, { sameToken: fixed }),
    [bridge, coins, fixed],
  )
  const session = useSession()
  const { page } = session
  const flow = useScreenFlow({ onSent }, (latest) =>
    openBridgeInFlow(
      {
        l1Wallet: page.l1Wallet,
        quote: page.bridgeInQuote,
        reader: page.chain.bridgeChainClient,
        depositFee: (token) => page.rowDepositFee(token as Address).read(),
        bridgeIns: session.bridgeIns,
        contacts: session.contacts,
        track: () => void session.wake(session.tasks.bridgeInTracker),
        now: page.now,
        initial: bridgeInStart(start, {
          chain: routes[0]?.chain.chainId,
          token: routes[0]?.tokens.find((t) => !t.comingSoon)?.symbol,
          carried,
          fixed: fixedAmount,
        }),
      },
      latest,
    ),
  )
  const s = useStore(flow.state)
  const { step, sending, sentFrom, repriced, reviewing } = s
  // A flow above the sheet picks the origin; else the sheet's own pickers do.
  const chainId = picked?.chainId ?? s.chain
  const route = routes.find((r) => r.chain.chainId === chainId) ?? routes[0]
  const symbol = picked?.symbol ?? s.token
  const origin = route?.tokens.find((t) => t.symbol === symbol && !t.comingSoon)
  const originCoin = coins.find((c) => c.symbol === symbol)
  const landing = bridgeLanding(coins, origin?.symbol)
  // The sheet names what is credited; quotes, limits and the send stay in the landing coin.
  const credit = bridgeCredit(coins, landing)
  const settlement = credit?.coin
  // The fee the landing row's sweep keeps from what lands, decimal in its coin.
  const feeRead = useStore(landing ? page.rowDepositFee(landing.settlesIn) : UNREAD)
  const depositFee = feeRead.status === "ready" ? feeRead.value : undefined
  const sweepFee =
    landing && depositFee !== undefined ? bridgeDepositFee(landing, depositFee) : undefined
  const { side, maxed } = s.amount
  const account = sentFrom ?? connected
  const paying = toLabel !== undefined
  // The bridge-in sent from this sheet; the session's tracker follows it.
  const record = useStore(session.bridgeIns.list, ({ records }) =>
    records.find((r) => r.id === s.sent),
  )

  const routeChain = route?.chain
  const originChain = useMemo(() => routeChain && bridgeChainFor(routeChain), [routeChain])
  const originAddress = origin && tokenAddress(origin)
  // The origin wallet's balance of the picked token, and its decimals there.
  const native = !!originAddress && isNativeToken(originAddress)
  const balanceRead = useStore(
    routeChain && originAddress && account
      ? page.originBalance(routeChain.chainId, originAddress, account)
      : UNREAD,
  )
  const decimalsRead = useStore(
    routeChain && originAddress && !native
      ? page.originToken(routeChain.chainId, originAddress)
      : UNREAD,
  )
  const balance = balanceRead.status === "ready" ? balanceRead.value : undefined
  const originDecimals =
    !originChain || !originAddress
      ? undefined
      : native
      ? originChain.nativeCurrency.decimals
      : decimalsRead.status === "ready"
      ? decimalsRead.value.decimals
      : undefined

  // The quote's input and fee are in the origin token's units; what lands is in the landing's.
  // Nothing is quoted or sent until the origin chain answers with its decimals.
  const inDecimals = originDecimals
  const outDecimals = landing?.decimals ?? 18
  const fromPlaces = displayDecimals(symbol ?? "")
  // Swapped on the origin chain: quoted from what is sent, To only follows.
  const originSwap = !!origin && !!landing && origin.symbol !== landing.symbol
  const feeOrigin = route && originAddress && `${route.chain.chainId}:${originAddress}`
  // MAX shows the balance to the coin's display decimals and sends all of it.
  const maxText =
    balance !== undefined && inDecimals !== undefined
      ? floorTo(balance, inDecimals, fromPlaces)
      : undefined
  const size = bridgeSize({
    amount: s.amount.text,
    side,
    fixedAmount,
    maxed,
    balance,
    inDecimals,
    outDecimals,
    needed: sweepFee?.needed,
    originSwap,
    rate: s.rate && s.rate.origin === feeOrigin ? s.rate.quote : undefined,
  })
  const {
    toTyped,
    exactOutput,
    sendsAll,
    error: typedError,
    typed: typedAtomic,
    output: outputAtomic,
  } = size
  const amount = sendsAll && maxText !== undefined ? maxText : s.amount.text
  // The most the wallet is charged, which the review shows as From.
  const charged = (q: BridgeInQuote) => bridgeCharged(q, fixedAmount !== undefined)

  // A quote for what was typed, priced to a placeholder recipient until the address is taken.
  const routeId = route?.chain.chainId
  const landingAddress = landing?.address as Address | undefined
  const landingSymbol = landing?.symbol
  const inputAmount = size.request?.inputAmount
  const outputAmount = size.request?.outputAmount
  const quoteRequest = useMemo((): BridgeInQuoteRequest | undefined => {
    if (!routeId || !originAddress || !landingAddress || !landingSymbol || !account)
      return undefined
    const base = {
      originChainId: routeId,
      inputToken: originAddress,
      destinationChainId: l1ChainId,
      outputToken: landingAddress,
      outputSymbol: landingSymbol,
      depositor: account,
      recipient: account,
    }
    if (outputAmount !== undefined) return { ...base, outputAmount }
    if (inputAmount !== undefined) return { ...base, inputAmount }
    return undefined
  }, [
    routeId,
    originAddress,
    landingAddress,
    landingSymbol,
    account,
    l1ChainId,
    inputAmount,
    outputAmount,
  ])
  const quoteKey = quoteRequest && typedAtomic ? bridgeQuoteKey(quoteRequest) : undefined
  const quoteRead = useLookup(quoteKey ? quoteRequest : undefined, flow.quote, { delayMs: 400 })
  const quoting = quoteRead.status === "waiting"
  const answer = selectQuote(s, quoteKey)
  const quote = answer?.answer
  const refusal = answer?.refusal
  const lastQuote = s.held

  const lands = exactOutput ? outputAtomic : quote?.outputAmount
  const landed = sweepFee && lands ? sweepFee.arriving(lands) : undefined
  // The portal's say on the quote: what most lands against the cap and capacity, what is sent
  // against the published limit at the quote's own rate.
  const txAmountCap = useRowTxAmountCap(landing?.settlesIn)
  const minimumAtomic = fixed || !landing ? 0n : parseUnits("1", landing.decimals)
  const landingValuation =
    landing &&
    depositTokenValuation({ accepted: coins.map((c) => c.address), token: landing.address })
  const admit =
    landing && sweepFee && inDecimals !== undefined
      ? (q: BridgeInQuote) =>
          admitDeposit(
            { token: landing, depositFeeAtomic: sweepFee.atomic, txAmountCap, minimumAtomic },
            {
              landedAtomic: q.expectedOutputAmount,
              gross: {
                atomic: bridgeCharged(q, fixed),
                decimals: inDecimals,
                valuation: bridgeValuation(q, landingValuation, inDecimals, outDecimals),
              },
            },
          )
      : undefined
  const admission = quote && admit?.(quote)
  const capacity = useFundingCapacity({
    rowToken: landing?.settlesIn,
    amountAtomic: admission?.creditAtomic,
    decimals: outDecimals,
    exactCredit: !landing?.swapped,
    mode: "editable",
    symbol: settlement?.symbol ?? "",
    sentSymbol: landing?.symbol ?? "",
    minimumAtomic,
    unknownCapacity: UNKNOWN_CAPACITY,
  })
  const [aboutLimits, setAboutLimits] = useState(false)
  // MAX within both limits: the most that may land, back in origin units at the quote's rate.
  const maxLanded = admission?.maxLandedAtomic
  // The limits count the expected landing, so MAX converts through it.
  const maxInput =
    quote && maxLanded !== undefined
      ? bridgeInputFor({ ...quote, outputAmount: quote.expectedOutputAmount }, maxLanded)
      : undefined
  const maxReceive =
    maxLanded !== undefined && sweepFee && maxLanded > sweepFee.atomic
      ? floorTo(maxLanded - sweepFee.atomic, outDecimals, displayDecimals(landing?.symbol ?? ""))
      : undefined
  const landedFigure = (atomic: bigint) => {
    const next = sweepFee?.arriving(atomic)
    return next && credit ? `${next.amount} ${credit.coin.symbol}` : undefined
  }
  const receivedFigure = (q: BridgeInQuote) => {
    const minimum = sweepFee?.arriving(q.outputAmount).atomic
    if (minimum === undefined || !credit) return undefined
    const atomic = bridgeReceived(minimum, toTyped ? typedAtomic : undefined)
    return `${groupedCents(formatUnits(atomic, outDecimals)) ?? "0"} ${credit.coin.symbol}`
  }
  const landedText = (atomic: bigint) => {
    const figure = landedFigure(atomic)
    return figure && credit?.approx ? fmt(copy.arrived.approx, { amount: figure }) : figure
  }

  const review = () => {
    if (!quoteRequest) return
    void flow.review({
      request: quoteRequest,
      fresh: toTyped,
      balance,
      fixed: fixedAmount !== undefined,
    })
  }
  const send = () => {
    if (!quote || !quoteRequest || !quoteKey || !origin || !landing || !admit) return
    if (depositFee === undefined || inDecimals === undefined) return
    void flow.send({
      key: quoteKey,
      reviewed: quote,
      request: quoteRequest,
      fixed: fixedAmount !== undefined,
      balance,
      recipient,
      units: {
        symbol: origin.symbol,
        inputDecimals: inDecimals,
        outputSymbol: landing.symbol,
        outputDecimals: outDecimals,
      },
      feeUsd: feeDollars,
      ...(paying && {
        pays: { payee: toLabel, ...(requestId !== undefined && { requestId }) },
      }),
      walletName: l1?.walletName ?? undefined,
      admit,
      capacity: capacity.store,
      depositFee: { shown: depositFee, row: landing.settlesIn },
    })
  }

  const inFigure = (atomic: bigint) =>
    inDecimals === undefined ? undefined : coinFigure(atomic, inDecimals, symbol ?? "")
  // A dollar coin reads in dollars; ETH or BTC reads in its own units.
  const dollars = coins.some((c) => c.symbol === symbol)
  /** The bridge's fee in dollars, decimal: a dollar coin's loss to what lands, else its price. */
  const fees = (q: BridgeInQuote) =>
    inDecimals === undefined
      ? {}
      : bridgeInFees(q, {
          fixed: fixedAmount !== undefined,
          dollars,
          inDecimals,
          outDecimals,
          depositFee,
        })
  const feeDollars = (q: BridgeInQuote) => fees(q).bridge
  /** The whole fee in dollars, decimal: the bridge's plus the deposit fee, a dollar coin's. */
  const wholeDollars = (q: BridgeInQuote) => fees(q).whole
  const totalValue = (q: BridgeInQuote) => {
    const usd = !dollars
      ? bridgeUsdValue(q, charged(q), outDecimals)
      : inDecimals !== undefined
      ? formatUnits(charged(q), inDecimals)
      : undefined
    return usd !== undefined ? usdFigure(usd) : inFigure(charged(q))
  }
  /** The whole fee; unpriced, nothing lands and the bridge's fee alone shows, in the origin coin. */
  const feeValue = (q: BridgeInQuote) => {
    if (depositFee === undefined) return undefined
    const usd = wholeDollars(q)
    return usd !== undefined ? usdFigure(usd) : inFigure(q.fee)
  }
  const feeInfo = (q: BridgeInQuote) => {
    const usd = feeDollars(q)
    if (usd === undefined || depositFee === undefined) return undefined
    const kept = parseUnits(depositFee, 18)
    const whole = parseUnits(usd, 18) + kept
    const rows = breakdown(copy.fees.bridging, whole, [[copy.fees.deposit, kept]], 18)
    // One row would only repeat the fee line.
    return (
      rows.length > 1 && (
        <FeeInfoButton
          rows={rows}
          total={usdFigure(formatUnits(whole, 18))}
          testId="bridge-in-fee-info"
        />
      )
    )
  }
  const chainName = route?.chain.name ?? ""
  const from = account
    ? fmt(copy.from, { wallet: walletName, address: shortL1Addr(account) })
    : copy.noWallet
  const changeable = !sending && !sentFrom && step !== "status"
  const fromPick = account
    ? changeable && onChangeWallet && { testId: "bridge-in-change-wallet", onPick: onChangeWallet }
    : l1 && { testId: "bridge-in-connect-wallet", onPick: () => void l1.connect() }
  const back =
    step === "chain" || step === "token" || (step === "progress" && !sending)
      ? () => flow.go("amount")
      : step === "amount"
      ? onBack
      : undefined
  const typed = (nextSide: "from" | "to", next: string, max?: boolean) => {
    flow.type(nextSide, next, max)
    if (fixedAmount === undefined) onCarry?.({ amount: next, side: nextSide })
  }
  const typeFrom = (next: string) => typed("from", next)
  const typeTo = (next: string) => typed("to", next)
  const fromShown = toTyped
    ? quote && inDecimals !== undefined
      ? floorTo(charged(quote), inDecimals, fromPlaces)
      : ""
    : amount
  // What lands is a dollar coin: cents, as the fee rounds them.
  const toShown = toTyped
    ? amount
    : landed
    ? fixedCents({ atomic: landed.atomic, decimals: outDecimals })
    : ""
  const short = balance !== undefined && !!quote && charged(quote) > balance
  const feeQuote =
    quote ?? (quoting && lastQuote && lastQuote.origin === feeOrigin ? lastQuote.quote : undefined)
  const feeShown = feeQuote && feeValue(feeQuote)

  const refusedFee =
    inDecimals === undefined
      ? undefined
      : bridgeRefusedFee({
          refused: refusal?.below,
          typed: exactOutput ? typedAtomic : inputAmount,
          output: outputAtomic,
          exactOutput,
          dollars,
          inDecimals,
          outDecimals,
          rate: lastQuote?.quote,
          symbol: symbol ?? "",
          depositFee: depositFee ?? "0",
        })
  // The amount cannot cover the whole fee: nothing reaches the private funds, or Across says so.
  const belowFee =
    (!!quote && quote.outputAmount <= (sweepFee?.atomic ?? 0n)) || refusedFee !== undefined
  const belowFeeFigure = refusedFee ?? (quote && feeValue(quote))
  // A quote that cannot cover its fee says so on its own.
  const problem: LimitProblem | undefined =
    belowFee || admission?.problem === "minimum" ? undefined : admission?.problem
  const belowMinimum = !belowFee && admission?.problem === "minimum"
  const admitted = !!admission && !admission.problem && capacity.view.canFund
  const limitNotice = (onUseMaximum?: () => void) =>
    problem && (
      <LimitNotice
        operation="deposit"
        problem={problem}
        maximum={problem === "public" && maxReceive ? usdFigureGrouped(maxReceive) : undefined}
        onUseMaximum={onUseMaximum}
        onAboutLimits={() => setAboutLimits(true)}
      />
    )
  const amountStep = route && origin && (
    <AmountStep
      title={title}
      pill={
        account ? { name: walletLabel ?? walletName, address: shortL1Addr(account) } : undefined
      }
      subtitle={from}
      send={{
        who: !account && l1 ? copy.connect : from,
        onPickWho: fromPick ? fromPick.onPick : undefined,
        whoTestId: fromPick ? fromPick.testId : undefined,
        testId: "bridge-in-from",
        inputTestId: "bridge-in-amount",
        value: fromShown,
        onChange: fixed ? undefined : typeFrom,
        balance: account
          ? {
              figure:
                balance !== undefined && inDecimals !== undefined
                  ? coinFigure(
                      floorAtomic(balance, inDecimals, fromPlaces),
                      inDecimals,
                      symbol ?? "",
                    )
                  : coinFigure(0n, 0, symbol ?? ""),
              loading: balance === undefined || inDecimals === undefined,
            }
          : undefined,
        max:
          account && !fixed
            ? {
                disabled: maxText === undefined,
                onClick: () => {
                  if (maxText === undefined || inDecimals === undefined) return
                  if (balance !== undefined && maxInput !== undefined && maxInput < balance)
                    return typed("from", floorTo(maxInput, inDecimals, fromPlaces))
                  typed("from", maxText, true)
                },
              }
            : undefined,
        asset: {
          icon: (
            <OriginTokenIcon
              symbol={origin.symbol}
              coins={coins}
              chain={{ chainId: route.chain.chainId, name: chainName }}
            />
          ),
          symbol: origin.symbol,
          chain: chainName,
          onPick: onChangeOrigin ?? (() => flow.go("chain")),
        },
      }}
      receive={{
        who: toLabel ?? (handle ? fmt(copy.to, { handle }) : copy.toFallback),
        testId: "bridge-in-to",
        inputTestId: "bridge-in-receive",
        feeTestId: "bridge-in-fee",
        value: fixed ? landed?.amount ?? "0" : toShown,
        onChange: fixed ? undefined : typeTo,
        // Every bridge is quoted: what lands follows from a typed From, or from a swap.
        approx: (!fixed && (side === "from" || originSwap)) || !!credit?.approx,
        fee: !typedAtomic
          ? "none"
          : refusedFee !== undefined
          ? { figure: refusedFee }
          : feeShown
          ? { figure: feeShown, stale: !quote }
          : refusal
          ? { error: copy.quoteFailed }
          : "unknown",
        asset: {
          icon: <CoinIcon token={settlement ?? coins[0]} size={32} />,
          symbol: settlement?.symbol ?? "",
          chain: l1ChainName,
        },
      }}
      errors={[typedError, short && copy.short].filter((e): e is string => !!e)}
      disabledHint={
        belowFee && belowFeeFigure
          ? fmt(amountCopy.belowFee, { fee: belowFeeFigure })
          : belowMinimum && landing
          ? fmt(copy.belowMinimum, {
              min: usdFigureGrouped(formatUnits(minimumAtomic, landing.decimals)),
            })
          : undefined
      }
      notices={
        <>
          {limitNotice(maxReceive && !fixed ? () => typeTo(maxReceive) : undefined)}
          <FundingCapacityPanel
            view={capacity.view}
            onRetry={capacity.retry}
            onUseAvailable={fixed ? undefined : typeTo}
            onAboutLimits={() => setAboutLimits(true)}
          />
          {s.failure === "capacity" && (
            <p className="ww-capacity__reason" data-testid="funding-action-reason">
              {copy.progress.capacityChanged}
            </p>
          )}
        </>
      }
      button={{
        title: copy.review,
        testId: "bridge-in-review",
        disabled: !quote || short || belowFee || !admitted,
        loading: reviewing,
        onClick: review,
      }}
    />
  )

  const progressStep = quote && landing && origin && (
    <DepositReview
      icon={
        <CoinIcon
          token={originCoin ?? landing}
          chain={route && { chainId: route.chain.chainId, name: chainName }}
        />
      }
      title={title}
      from={from}
      to={toLabel ?? (handle ? fmt(copy.to, { handle }) : copy.toFallback)}
      toDetail={!toLabel && handle ? copy.toFallback : undefined}
      token={[
        {
          label: origin.symbol,
          icon: <OriginTokenIcon symbol={origin.symbol} coins={coins} size={16} />,
        },
        ...(origin.symbol === (settlement ?? landing).symbol
          ? []
          : [
              {
                label: (settlement ?? landing).symbol,
                icon: <CoinIcon token={settlement ?? landing} size={16} badge={false} />,
              },
            ]),
      ]}
      send={inFigure(charged(quote)) ?? bridgeCopy.pending}
      // The review marks Receive as approximate itself.
      receive={receivedFigure(quote) ?? bridgeCopy.pending}
      feeUsd={feeValue(quote) ?? bridgeCopy.pending}
      feeInfo={feeInfo(quote)}
      totalUsd={totalValue(quote) ?? bridgeCopy.pending}
      network={{
        hops: [chainName, l1ChainName],
        arrivesInMinutes: Math.max(1, Math.ceil(quote.fillSeconds / 60) + (depositMinutes ?? 0)),
      }}
      callout={sending ? copy.approve : undefined}
      notices={
        <>
          {limitNotice()}
          {repriced && (
            <p className="ww-deposit-sheet__note" role="status" data-testid="bridge-in-repriced">
              {copy.progress.repriced}
            </p>
          )}
          {s.failure === "fee-changed" && (
            <p className="ww-deposit-sheet__note" role="status" data-testid="funding-action-reason">
              {copy.progress.feeChanged}
            </p>
          )}
          {s.failure === "unreachable" && (
            <p className="ww-deposit-sheet__note" role="status" data-testid="bridge-in-unreachable">
              {fmt(copy.progress.unreachable, { network: chainName })}
            </p>
          )}
        </>
      }
      button={{
        title: toLabel ? copy.payButton : copy.bridgeButton,
        testId: "bridge-in-send",
        loading: sending,
        // Capacity is read again when sent: a refusal goes back to the amount and says why.
        disabled: !admission || !!admission.problem,
        onClick: send,
      }}
    />
  )

  const recordChain = record && routes.find((r) => r.chain.chainId === record.originChainId)?.chain
  const statusStep = record && (
    <BridgeInStatus
      record={record}
      coins={coins}
      chainName={recordChain?.name ?? chainName}
      l1ChainName={l1ChainName}
      arriving={landedText(BigInt(record.outputAmount))}
      payee={toLabel}
      fillMinutes={quote ? Math.max(1, Math.ceil(quote.fillSeconds / 60)) : undefined}
      depositMinutes={depositMinutes}
      onTryAgain={onRetry}
      onClose={onClose}
    />
  )

  return (
    <Modal
      variant="bare"
      label={title}
      className={`ww-deposit-warning ww-deposit-sheet ww-bridge-sheet${
        step === "status" ? ` ${bridgeInStatusSheet}` : ""
      }`}
      step={step}
      stepDepth={STEP_DEPTH[step]}
      onClose={onClose}
    >
      {back && (
        <div className="ww-deposit-warning__back">
          <CornerButton kind="back" onClick={back} />
        </div>
      )}
      <div className="ww-deposit-warning__close">
        <CornerButton kind="close" onClick={onClose} />
      </div>
      {step === "amount" && amountStep}
      {step === "chain" && (
        <>
          <GradientText size={20} weight={700}>
            {bridgeCopy.chain.title}
          </GradientText>
          <PickerList
            searchLabel={bridgeCopy.chain.search}
            section={bridgeCopy.chain.section}
            selected={String(route?.chain.chainId)}
            items={[
              {
                id: String(l1ChainId),
                icon: <ChainIcon chainId={l1ChainId} name={l1ChainName} />,
                title: l1ChainName,
                detail: bridgeCopy.chain.direct,
              },
              ...routes.map(({ chain }) => ({
                id: String(chain.chainId),
                icon: <ChainIcon chainId={chain.chainId} name={chain.name} />,
                title: chain.name,
              })),
            ]}
            onPick={(id) => {
              if (Number(id) === l1ChainId) return onEthereum()
              const next = routes.find((r) => r.chain.chainId === Number(id))
              flow.pickChain(
                Number(id),
                next?.tokens.some((t) => t.symbol === symbol && !t.comingSoon)
                  ? undefined
                  : next?.tokens.find((t) => !t.comingSoon)?.symbol,
              )
            }}
          />
        </>
      )}
      {step === "token" && route && (
        <>
          <GradientText size={20} weight={700}>
            {bridgeCopy.token.title}
          </GradientText>
          <PickerList
            searchLabel={bridgeCopy.token.search}
            section={bridgeCopy.token.section}
            selected={symbol}
            items={route.tokens.map((token) => {
              const address = tokenAddress(token)
              return {
                id: token.symbol,
                icon: <OriginTokenIcon symbol={token.symbol} coins={coins} />,
                title: tokenName(token.symbol),
                tag: token.symbol,
                detail: fmt(bridgeCopy.token.detail, {
                  chain: route.chain.name,
                  token: isNativeToken(address) ? bridgeCopy.token.native : shortL1Addr(address),
                }),
                comingSoon: token.comingSoon,
              }
            })}
            onPick={(next) => {
              flow.pickToken(next)
            }}
          />
        </>
      )}
      {step === "progress" && progressStep}
      {step === "status" && statusStep}
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic="capacity"
          capacity={{ kind: "active", token: landing?.settlesIn }}
          settlementSymbol={settlement?.symbol ?? ""}
          onClose={() => setAboutLimits(false)}
        />
      )}
    </Modal>
  )
}
