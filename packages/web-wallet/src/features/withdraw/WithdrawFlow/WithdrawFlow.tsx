import { Fragment, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { ReactNode } from "react"
import { formatUnits, getAddress, isAddress } from "viem"
import type { Address } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { bestEffort } from "@obsidion/core/errors"
import {
  ACROSS_INPUT_DECIMALS,
  NO_SERVICE,
  UNREAD,
  serviceStatus,
  useEnsAddress,
  useLookup,
  useStore,
} from "@obsidion/front-core"
import {
  Card,
  GradientText,
  Icon,
  NumberedStepRow,
  PrimaryGradientButton,
  RowChevron,
  Spinner,
} from "@obsidion/web-ds"
import walletIcon from "../../../assets/deposit/wallet-line.svg"
import { fireEvent } from "../../../lib/analytics"
import { fmt, fmtNodes } from "../../../lib/fmt"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { useSession } from "../../../session/session"
import { l1Links } from "../../../ui/detailRows"
import { useOpened, useScreenFlow } from "../../../ui/useScreenFlow"
import type { WithdrawStart } from "./withdrawStart"
import { Blockie, L1AddressText } from "../../../ui/L1AddressText"
import { FlowCard, FlowHead } from "../../../ui/flow/FlowCard/FlowCard"
import flowStyles from "../../../ui/flow/flow.module.css"
import { NetworkCoinPicker } from "../../../ui/flow/NetworkCoinPicker/NetworkCoinPicker"
import type { Coin, PickerNetwork } from "../../../ui/flow/NetworkCoinPicker/NetworkCoinPicker"
import { settleStep, useFlowSteps } from "../../../ui/flow/useFlowSteps"
import {
  amountError,
  floorAtomic,
  floorTo,
  shortL1Addr,
  tokenAmount,
  usdFigure,
} from "../../../ui/format"
import { coinFigure, displayDecimals } from "../../../ui/coinDecimals"
import { LocalPasskeyHint } from "../../../ui/LocalPasskeyHint"
import { ChainIcon } from "../../../ui/ChainIcon/ChainIcon"
import {
  RING_TOKEN_SIZE,
  RingStage,
  ringStageSheet,
  type RingPhase,
  type RingStageBlock,
} from "../../../ui/flow/RingStage/RingStage"
import daiIcon from "../../../assets/deposit/dai.svg"
import { ModalSteps } from "../../../ui/Modal"
import { Hops, MoveReview } from "../../../ui/MoveReview/MoveReview"
import { useProvingOutcome } from "../../../ui/hooks"
import { DepositFact } from "../../../ui/screens/DepositFact"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { Warning } from "../../../ui/Warning"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import { useL1Wallet } from "../../../session/useL1Wallet"
import type { SavedL1Wallet } from "../../../session/savedL1Wallets"
import { ChangeWalletPicker } from "../../deposit/ChangeWalletPicker/ChangeWalletPicker"
import walletCopy from "../../deposit/ChangeWalletPicker/ChangeWalletPicker.copy"
import sendCopy from "../../deposit/sendFromWallet.copy"
import { WalletPill } from "../../../ui/flow/WalletPill/WalletPill"
import { AmountStep } from "../../../ui/flow/AmountStep/AmountStep"
import amountCopy from "../../../ui/flow/AmountStep/AmountStep.copy"
import loopRightIcon from "../../../assets/deposit/loop-right-line.svg"
import { LimitNotice, usdFigureGrouped } from "../../limits/publicLimit"
import { useBusyLabel, useUserFlowActive } from "../../operations/operations"
import { OperationHandOff } from "../../operations/OperationHandOff"
import type { OperationHandOffHandle } from "../../operations/OperationHandOff"
import { useTxAmountCap } from "../../token/useTxAmountCap"
import { bridgeAsk, GAS_CHIPS, selectWithdrawQuote, withdrawAsks } from "../withdrawQuoteView"
import type { WithdrawContext, WithdrawStep } from "../withdrawQuoteView"
import { bridgeOutDecimals } from "../bridgeOutQuote"
import type { BridgeOutChain } from "../bridgeOutQuote"
import { useAddressFacts, verdictFromFacts } from "../addressFacts"
import {
  ETHERFI_CONTACT_NAME,
  ETHERFI_RECEIVE_ASSETS,
  etherfiRoutes,
  ETHERFI_SHARE_ADDRESS_URL,
  useSavedEtherfiAddress,
} from "../etherfi"
import etherfiCopy from "../etherfi.copy"
import { isEtherfiCash, useEtherfiAddressVerdict } from "../etherfiCheck"
import type { EtherfiAddressVerdict } from "../etherfiCheck"
import { networkHasSwapStack, useFreshAddressAvailable } from "../freshAddressAvailability"
import { PrivacyRingIcon } from "../PrivacyBadge/PrivacyBadge"
import privacyCopy from "../PrivacyBadge/PrivacyBadge.copy"
import type { PrivacyRing } from "../privacyRing"
import { FASTER_BLOCKED_COPY, type SpeedChoice, type SpeedOutcome } from "../speedChoice"
import { useFasterWithdrawal } from "../useFasterWithdrawal"
import { useWithdrawals } from "../useWithdrawals"
import { ratePrivacy } from "../useWalletPrivacy"
import { etaLabel } from "../WithdrawalSpeedPicker"
import { isEtherfiContact, useSavedL1Wallets } from "../../../session/savedL1Wallets"
import type { WithdrawFlowEntry } from "../../../session/routeStates"
import { FEE_UNAVAILABLE_COPY, useSwapSimulation } from "../withdrawQuote"
import { tokenName } from "../../token/tokenName"
import { WITHDRAWAL_RECEIVE_ASSETS, withdrawalReceiveAsset } from "../withdrawAssets"
import type { WithdrawalReceiveAsset } from "../withdrawAssets"
import { breakdown, FeeInfoButton } from "../../../ui/FeeBreakdown/FeeBreakdown"
import type { FeeRow } from "../../../ui/FeeBreakdown/FeeBreakdown"
import { addressName, asksName, connectedRecipient, walletPillName } from "./walletRecipient"
import { openWithdrawFlow, withdrawFlowDeps, withdrawInitial } from "./withdrawFlow"
import type { WithdrawInputs } from "./withdrawFlow"
import { RecipientCoinBalance } from "../RecipientCoinBalance/RecipientCoinBalance"
import { SpeedCards } from "./SpeedCards/SpeedCards"
import copy from "./WithdrawFlow.copy"
import brandCopy from "../../../ui/brand/brand.copy"
import chainsCopy from "../../../ui/chains.copy"
import balanceCopy from "../../../ui/balance.copy"
import styles from "./WithdrawFlow.module.css"

/** A token amount floored to its coin's display decimals, grouped. */
const shownAmount = (atomic: bigint, decimals: number, symbol: string) => {
  const places = displayDecimals(symbol)
  return tokenAmount(floorTo(atomic, decimals, places), places)
}

/** How long the address reads and the screening may run before they count as unanswered. */
const READ_WAIT_MS = 5_000

const dollars = (atomic?: bigint) =>
  atomic === undefined ? copy.unpriced : usdFigure(formatUnits(atomic, DEFAULT_DECIMALS))

const SEGMENTS = ["activity", "linked", "identity"] as const

/** One phrase per segment that answered, as a sentence. */
function privacySummary(ring: PrivacyRing): string | undefined {
  const [first, second, third] = SEGMENTS.filter((s) => ring[s] !== "unknown").map((s, i) => {
    const pair = i === 0 ? copy.privacy.lead[s] : copy.privacy[s]
    return ring[s] === "clear" ? pair.clear : pair.weak
  })
  const { summary } = copy.privacy
  if (third !== undefined) return fmt(summary.three, { first: first!, second: second!, third })
  if (second !== undefined) return fmt(summary.two, { first: first!, second })
  return first !== undefined ? fmt(summary.one, { first }) : undefined
}

const ETHERFI_TONE: Record<
  Exclude<EtherfiAddressVerdict["kind"], "idle" | "checking">,
  "success" | "warning" | "error"
> = { confirmed: "success", account: "warning", rejected: "error", unknown: "warning" }

const UNRATED: PrivacyRing = { linked: "unknown", activity: "unknown", identity: "unknown" }

/** An address with its first and last four hex characters picked out. */
function AddressParts({ address }: { address: Address }) {
  return (
    <span className={styles.address}>
      <b>{address.slice(0, 6)}</b>
      {address.slice(6, -4)}
      <b>{address.slice(-4)}</b>
    </span>
  )
}

/** The status step's phases: the burn (passkey, then proof), the release, then the outcome. */
type WithdrawView = "burning" | "releasing" | "done" | "failed"

const RING_PHASE: Record<WithdrawView, RingPhase> = {
  burning: "bridging",
  releasing: "arriving",
  done: "arrived",
  failed: "failed",
}

const same = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * One modal for every withdrawal: the address, or the ether.fi Cash address when `entry.start`
 * asks for it, the amount with its network and coin, gas for an Ethereum address that needs it,
 * the review, then the withdrawal's status until it lands. An ether.fi Cash address takes only what
 * Cash credits.
 */
export function WithdrawFlow({
  entry,
  routes,
  l1ChainId,
  onClose,
  start,
}: {
  entry: WithdrawFlowEntry
  /** The bridge chains, in profile order. */
  routes: BridgeOutChain[]
  l1ChainId: number
  onClose: () => void
  /** Where it opens, in place of its first step. */
  start?: WithdrawStart
}) {
  const session = useSession()
  const { page } = session
  const { config } = page
  const { l1AddressUrl } = l1Links(config)
  const statuses = [
    useStore(session.wallet, serviceStatus),
    useStore(session.account ?? NO_SERVICE, serviceStatus),
    useStore(session.token ?? NO_SERVICE, serviceStatus),
    useStore(session.contractService, serviceStatus),
  ]
  const wallet = useStore(session.balances.view)
  const txAmountCap = useTxAmountCap()
  const saved = useSavedL1Wallets(Infinity)
  const swapReady = useFreshAddressAvailable() === true
  const identity = useStore(session.identity).value
  const handle = identity?.handle
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const { records } = useWithdrawals()
  const outcome = useProvingOutcome("withdraw")
  const handOff = useRef<OperationHandOffHandle>(null)

  // Filled in below, once this render has read its quotes.
  let inputs: WithdrawInputs | undefined
  const flow = useScreenFlow(
    () => inputs!,
    (latest) => {
      const initial = withdrawInitial(entry, l1ChainId, start)
      const deps = withdrawFlowDeps(session, initial, start?.signing)
      return openWithdrawFlow(deps, () => latest()())
    },
  )
  const s = useStore(flow.state)

  const opensAtAmount = !!entry.atAmount && !!entry.recipient
  const [picking, setPicking] = useState(!!start?.picker || (opensAtAmount && !!entry.pick))
  const [walletPicking, setWalletPicking] = useState(false)
  // The overlay last opened, still shown while it slides out.
  const [overlay, setOverlay] = useState<"network" | "wallet">("network")
  // Each opening remounts the picker, which starts it again from the current pick.
  const [opened, setOpened] = useState(0)
  const [query, setQuery] = useState<string>(start?.query ?? entry.recipient ?? "")
  const [typedName, setTypedName] = useState(start?.name ?? entry.name ?? "")
  // The address an ether.fi verdict named the empty field for; a cleared field stays cleared.
  const [namedFor, setNamedFor] = useState<Address | null>(null)

  const first: WithdrawStep = entry.start ?? "address"
  const step = s.history.at(-1) ?? first
  const onEtherfi = step === "etherfi"
  const choosingAddress = step === "address" || onEtherfi

  const savedEtherfi = useSavedEtherfiAddress()
  // Typing a new ether.fi address over the saved one.
  const [replacing, setReplacing] = useState(false)
  const [keep, setKeep] = useState(true)
  const usingSaved = onEtherfi && !!savedEtherfi && !replacing
  useOpened(() => onEtherfi && fireEvent("withdraw_opened", { method: "etherfi" }))

  // The address and ether.fi steps read the field; later steps read the chosen address.
  const search = query.trim()
  const ens = useEnsAddress(search, page.ensAddress)
  const raw = usingSaved ? savedEtherfi : onEtherfi ? search : ens.name ? ens.address ?? "" : search
  const target = raw && isAddress(raw) ? getAddress(raw) : null
  const { chosen } = s
  const recipient = choosingAddress ? target : chosen?.recipient ?? null
  const match = saved.find((w) => same(w.address, recipient))
  const etherfiContact =
    (!!entry.etherfi && same(entry.recipient, recipient)) ||
    (!!chosen?.etherfi && same(chosen.recipient, recipient)) ||
    (!!match && isEtherfiContact(match.entry))
  const typed = asksName(search, target, !!match)
  const fieldName = addressName(typed, typedName, match?.name, ens.name)

  // A bridge-out's recipient is screened on the chain it lands on.
  const screened = useScreenedAddress(recipient, "withdraw", {
    chainId: s.route.chainId === l1ChainId ? undefined : s.route.chainId,
    debounceMs: 300,
    waitMs: READ_WAIT_MS,
  })
  const factsRead = useAddressFacts(recipient, READ_WAIT_MS)
  const read = factsRead
  const facts = read.kind === "read" ? read.facts : undefined
  const freshRead =
    read.kind === "read"
      ? verdictFromFacts(read.facts)
      : read.kind === "timeout"
      ? "unknown"
      : read.kind
  // The ether.fi step asks ether.fi even about a saved Cash address.
  const etherfiCheck = useEtherfiAddressVerdict(
    etherfiContact && !onEtherfi ? null : recipient,
    READ_WAIT_MS,
  )
  const etherfiRead = etherfiCheck.kind
  const privacy = facts && ratePrivacy(facts, etherfiContact)
  const etherfiCash = etherfiContact || isEtherfiCash(etherfiRead)
  if (
    step === "address" &&
    etherfiCash &&
    recipient &&
    typedName === "" &&
    namedFor !== recipient
  ) {
    setNamedFor(recipient)
    setTypedName(ETHERFI_CONTACT_NAME)
  }
  const contract = freshRead === "contract"
  const screenAnswer = screened.verdict?.status ?? "screening"
  const screenStatus = screenAnswer === "screening" && screened.late ? "timeout" : screenAnswer
  // A timed-out read stops counting as in flight.
  const reading =
    read.kind === "checking" || etherfiRead === "checking" || screenStatus === "screening"
  const screenFailed = screenStatus === "error" || screenStatus === "timeout"
  // An unanswered read leaves the rating unknown; only screening blocks Continue. ether.fi
  // unanswered reads as not ether.fi and says nothing.
  const readFailed =
    read.kind === "timeout" ||
    (!!facts &&
      (facts.code === undefined || facts.nonce === undefined || facts.balance === undefined))
  const retryReads = () => {
    if (readFailed) factsRead.retry()
    if (etherfiRead === "unknown") etherfiCheck.retry()
    if (screenFailed) screened.rescreen()
  }

  const connected = l1.account
  const faster = useFasterWithdrawal({ active: !choosingAddress })

  // Cash credits only its own assets, from its top-up chains.
  const ethCoins: readonly WithdrawalReceiveAsset[] = etherfiCash
    ? ETHERFI_RECEIVE_ASSETS
    : swapReady
    ? WITHDRAWAL_RECEIVE_ASSETS.map((a) => a.id)
    : ["DAI"]
  const ctx: WithdrawContext = {
    l1ChainId,
    l1Name: chainsCopy.ethereum,
    routes: etherfiCash ? etherfiRoutes(routes) : routes,
    ethCoins,
    // Gas lands as a plain ETH transfer, on Ethereum, through the swap stack.
    gasOffered: swapReady && !etherfiCash && !contract,
    contract,
    hasEth: (privacy?.balance ?? 0n) > 0n,
    fresh: freshRead === "fresh",
    cleared: screened.cleared,
    offer: faster.offer,
    eta: faster.eta,
    speedLoading: faster.loading,
  }
  const balance = { wallet, txAmountCap }
  const asks = withdrawAsks(s, ctx, balance)
  const quoteArgs = { recipient: recipient ?? undefined, network: config.network }
  const quote = useSwapSimulation({ ...asks.swapAsk, ...quoteArgs, quotes: flow.swapQuote })
  const gaslessSimulated = useSwapSimulation({ ...asks.gaslessAsk, ...quoteArgs })
  const gaslessQuote = asks.gaslessLive ? gaslessSimulated : quote
  const ask = bridgeAsk(asks, asks.onL1 ? undefined : quote.fee?.floorAtomic, wallet)
  const { provider, l2Token, chainId: askChain, token: askToken } = ask ?? {}
  const { amount: askAmount, proverTip: askTip } = ask ?? {}
  const heldAsk = useMemo(
    () =>
      provider && l2Token && askChain !== undefined && askToken && askAmount !== undefined
        ? askTip === undefined
          ? undefined
          : {
              provider,
              l2Token,
              chainId: askChain,
              token: askToken,
              amount: askAmount,
              proverTip: askTip,
            }
        : undefined,
    [provider, l2Token, askChain, askToken, askAmount, askTip],
  )
  const bridgeLookup = useLookup(heldAsk, flow.bridgeQuote, { delayMs: 400 })
  // The review keeps its bridge quote current.
  useStore(step === "review" && heldAsk ? flow.bridgeReview(heldAsk) : UNREAD)
  const quotes = { ...ctx, swap: quote, gasless: gaslessSimulated, bridge: bridgeLookup }
  const v = selectWithdrawQuote(s, quotes, balance)
  const { onL1, coin, asset, fundsAtomic, receivedAtomic, toDecimals } = v

  const networks: PickerNetwork[] = [
    { chainId: l1ChainId, name: chainsCopy.ethereum },
    ...ctx.routes.map(({ chain }) => ({ chainId: chain.chainId, name: chain.name })),
  ]
  const coinsOn = (id: number): Coin[] =>
    v.offered(id).map((symbol) => ({
      symbol,
      name: tokenName(symbol),
      icon: <CoinIcon token={withdrawalReceiveAsset(symbol)} size={32} />,
      // Only the connected wallet's balances: a typed or saved address is not read.
      trailing: recipient && same(recipient, connected) && (
        <RecipientCoinBalance
          recipient={recipient}
          chainId={id}
          symbol={symbol}
          l1ChainId={l1ChainId}
          routes={ctx.routes}
        />
      ),
    }))
  const network = networks.find((n) => n.chainId === v.chainId) ?? networks[0]!
  const coinBadge = { id: network.chainId, name: network.name }

  inputs = {
    view: v,
    quotes,
    balance,
    screener: screened.screener,
    network: network.name,
    etherfiCash,
    saved,
    outcome,
    handOff,
    openPicker: l1.openPicker,
    pickerShown: l1.pickerShown,
    onClose,
  }

  const speedChoice: SpeedChoice = {
    offer: faster.offer,
    eta: faster.eta,
    loading: faster.loading,
    // A blocked Faster falls back to Standard.
    speed: v.blocked ? "standard" : v.speed,
    setSpeed: flow.speed,
    settled: v.settled,
    held: false,
    pricedTip: v.pricedTip,
  }
  const speedOutcome: SpeedOutcome = {
    blocked: v.blocked ? FASTER_BLOCKED_COPY : undefined,
    proverTip: v.proverTip,
  }
  const ready = statuses.every((status) => status === "ready")
  const typedText = s.amount.maxed ? "" : s.amount.text
  const typedError = amountError(typedText, v.typedDecimals)
  const hasAmount = s.amount.maxed ? v.canMax : !!v.typedAtomic
  const feeFigure = v.feeAtomic !== undefined ? dollars(v.feeAtomic) : undefined
  const wholeFigure = v.wholeAtomic !== undefined ? dollars(v.wholeAtomic) : undefined
  const receivedShown =
    receivedAtomic !== undefined ? shownAmount(receivedAtomic, toDecimals, coin) : undefined
  const maxAmount = v.canMax ? formatUnits(v.maxAtomic!, DEFAULT_DECIMALS) : undefined

  const name = chosen?.name
  const short4 = recipient ? shortL1Addr(recipient) : ""
  const who = name ? fmt(copy.amount.who, { name, address: short4 }) : short4
  // A saved wallet or the connected one: its pill names it and Change wallet can replace it.
  const pillName = walletPillName(recipient, {
    saved: !!match,
    savedName: fieldName,
    connected,
    walletName: l1.walletName,
    etherfi: etherfiContact,
    fallback: walletCopy.pillFallback,
  })
  const walletId =
    pillName !== undefined && recipient
      ? { name: pillName, address: shortL1Addr(recipient) }
      : undefined
  const walletPill = walletId && <WalletPill wallet={walletId.name} address={walletId.address} />

  const { showPicker, key, dir } = useFlowSteps({
    key: step,
    depth: s.history.length,
    picking: picking || walletPicking,
  })
  const back = () => {
    if (showPicker) {
      setPicking(false)
      return setWalletPicking(false)
    }
    flow.back()
  }
  const openPicker = () => {
    setOpened((n) => n + 1)
    setOverlay("network")
    setPicking(true)
  }
  const openWalletPicker = () => {
    setOpened((n) => n + 1)
    setOverlay("wallet")
    setWalletPicking(true)
  }
  /** A saved wallet is only an address to pay: it becomes the recipient at once, as on the landing. */
  const pickSaved = (picked: SavedL1Wallet) => {
    flow.pickSaved(picked, isEtherfiContact(picked.entry))
    setWalletPicking(false)
  }
  const choose = (nextChain: number, nextSymbol: string) => {
    setPicking(false)
    flow.route(nextChain, nextSymbol as WithdrawalReceiveAsset)
  }
  const card = (label: string, children: ReactNode, backable = true, className?: string) => (
    <FlowCard
      label={label}
      onBack={backable ? back : undefined}
      onClose={flow.close}
      className={className}
    >
      {children}
    </FlowCard>
  )
  const type = (value: string) => {
    setQuery(value)
    setTypedName("")
  }
  const paste = () =>
    void bestEffort(
      "unknown",
      navigator.clipboard.readText().then((text) => type(text.trim())),
    )
  const connectWallet = () =>
    void flow.connectWallet().then((connectedWallet) => {
      if (!connectedWallet) return
      type(connectedWallet.account)
      setTypedName(connectedWallet.walletName ?? "")
    })

  const blockers = (
    <>
      {v.problem && !v.overspent ? (
        <LimitNotice
          operation="withdrawal"
          problem={v.problem}
          maximum={
            maxAmount && v.max?.status === "available" && v.max.bound !== "protocol-ceiling"
              ? usdFigureGrouped(maxAmount)
              : undefined
          }
          onUseMaximum={maxAmount ? flow.max : undefined}
        />
      ) : (
        v.overspent && <span className="ww-pay__error">{copy.amount.overspent}</span>
      )}
      {typedError && <span className="ww-pay__error">{typedError}</span>}
      {onL1 && quote.status === "unavailable" && (
        <Warning
          title={
            v.direct || networkHasSwapStack(config.network)
              ? FEE_UNAVAILABLE_COPY
              : copy.amount.noSwapStack
          }
        />
      )}
      {/* A saved contract is one the user already knows: its card opens on tap. */}
      {v.ethOnContract && (
        <Warning title={copy.amount.contract.title} expanded={!match}>
          {copy.amount.contract.body}
        </Warning>
      )}
      {/* ether.fi Cash takes funds at its address on its top-up chains; ETH's own card explains. */}
      {v.onContract && !v.ethOnContract && !etherfiCash && (
        <Warning title={copy.amount.contractRisk.title} expanded={!match}>
          {fmt(copy.amount.contractRisk.body, { token: coin, network: network.name })}
        </Warning>
      )}
      {/* Past the amount step a typed From cannot move; a typed To re-solves From instead. */}
      {v.belowFee && s.amount.side === "from" && step !== "amount" && (
        <Warning title={copy.amount.feeMoved} />
      )}
      {screened.verdict &&
        (screened.verdict.status === "blocked" || screened.verdict.status === "error") && (
          <ScreeningNotice
            verdict={screened.verdict}
            checkingCopy={copy.address.screening.checking}
            blockedFallback={copy.address.screening.blocked}
            errorCopy={copy.address.screening.unreachable}
            onRetry={screened.rescreen}
          />
        )}
    </>
  )

  const addressStep = () => {
    const explorer = target ? l1AddressUrl(target) : undefined
    const summary = privacy && privacySummary(privacy.ring)
    const blocked = screenStatus === "blocked"
    const failed = screenFailed || readFailed
    // Only a high rating tints the field.
    const high = !!target && !reading && !blocked && !failed && privacy?.level === "High"
    const result = !reading && !blocked && !failed && privacy
    return card(
      copy.title,
      <>
        <FlowHead title={copy.title} />
        <div className="ww-fund__fields">
          <div className="ww-withdraw__field">
            <span>{copy.address.label}</span>
            <span className={`ww-withdraw__box ${high ? styles.resolved : ""}`}>
              {target && !ens.name ? (
                <AddressParts address={target} />
              ) : (
                <input
                  data-autofocus
                  aria-label={copy.address.field}
                  placeholder={copy.address.placeholder}
                  spellCheck={false}
                  data-testid="withdraw-address"
                  value={query}
                  onChange={(e) => type(e.target.value)}
                />
              )}
              {query ? (
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__clear"
                  aria-label={copy.address.clear}
                  onClick={() => type("")}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : (
                <button type="button" className="zkm-btn-reset ww-withdraw__paste" onClick={paste}>
                  <Icon name="copy" size={12} />
                  {copy.address.paste}
                </button>
              )}
            </span>
            {ens.name && ens.state === "found" && target && <AddressParts address={target} />}
            {ens.name && ens.state !== "found" && (
              <span className="ww-fund__label">
                {ens.state === "resolving"
                  ? copy.address.ens.resolving
                  : ens.state === "missing"
                  ? copy.address.ens.missing
                  : ens.state === "invalid"
                  ? copy.address.ens.invalid
                  : copy.address.ens.error}
              </span>
            )}
          </div>
          {target && (
            <div
              className={styles.privacy}
              data-level={
                reading ? undefined : blocked ? "blocked" : failed ? "error" : privacy?.level
              }
            >
              <span className={styles.privacyHead}>
                <span className={styles.privacyIcon}>
                  {reading || (!blocked && !failed && !privacy) ? (
                    <Spinner size={16} />
                  ) : blocked || failed ? (
                    <Icon name="alert-triangle" size={18} color="currentColor" />
                  ) : (
                    <PrivacyRingIcon ring={privacy?.ring ?? UNRATED} />
                  )}
                </span>
                {reading
                  ? copy.address.historyChecking
                  : blocked
                  ? screened.verdict?.reason?.message ?? copy.address.screening.blocked
                  : failed
                  ? copy.address.screening.unreachable
                  : privacy
                  ? privacyCopy.level[privacy.level]
                  : copy.address.historyChecking}
              </span>
              {failed && !blocked && !reading && (
                <p className={styles.privacyRetry}>
                  <button
                    type="button"
                    className="zkm-btn-reset ww-deposit-sheet__check"
                    onClick={retryReads}
                  >
                    {copy.address.screening.retry}
                    <img src={loopRightIcon} alt="" width={11} height={11} />
                  </button>
                </p>
              )}
              {result && summary && <p>{summary}</p>}
              {result && explorer && (
                <p>
                  {copy.address.etherscan}{" "}
                  <a href={explorer} target="_blank" rel="noreferrer">
                    {copy.address.openEtherscan} <Icon name="share-box" size={12} />
                  </a>
                </p>
              )}
            </div>
          )}
          {typed && (
            <label className="ww-withdraw__field">
              <span>{copy.address.name}</span>
              <span className="ww-withdraw__box">
                <input
                  placeholder={copy.address.namePlaceholder}
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                />
              </span>
            </label>
          )}
        </div>
        <PrimaryGradientButton
          title={copy.continue}
          testId="withdraw-address-continue"
          isDisabled={!target || reading || !screened.cleared}
          onClick={() => target && flow.choose({ recipient: target, name: fieldName }, "amount")}
          className="ww-deposit-sheet__cta"
        />
        {!isDesktopL1SubmitActive() && (
          <>
            <div className={`ww-deposit__or ${styles.or}`}>
              <hr className="ww-divider" />
              <span>{copy.address.or}</span>
              <hr className="ww-divider" />
            </div>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__connect"
              onClick={() => {
                if (!connected) return connectWallet()
                type(connected)
                setTypedName(l1.walletName ?? "")
              }}
            >
              <span className="ww-deposit__connect-icon">
                <img src={walletIcon} alt="" width={19} height={17} />
              </span>
              <span className="ww-deposit__connect-text">
                <b>{connected ? copy.address.connected : copy.address.connect}</b>
                <span>
                  {connected
                    ? fmt(copy.address.connectedDetail, {
                        wallet: l1.walletName ?? copy.address.walletFallback,
                        address: shortL1Addr(connected),
                      })
                    : copy.address.connectDetail}
                </span>
              </span>
              <RowChevron />
            </button>
          </>
        )}
      </>,
      false,
    )
  }

  const etherfiStep = () => {
    const ec = copy.etherfi
    const notice =
      etherfiRead === "idle" || etherfiRead === "checking"
        ? undefined
        : { ...ec.verdict[etherfiRead], tone: ETHERFI_TONE[etherfiRead] }
    return card(
      ec.title,
      <>
        <FlowHead title={ec.title} subtitle={fmt(ec.subtitle, { assets: etherfiCopy.assets })} />
        <div className="ww-fund__fields">
          {savedEtherfi === undefined ? null : usingSaved ? (
            <Card>
              <div className="ww-withdraw__saved">
                <div className="ww-deposit__actions" style={{ borderRadius: 8 }}>
                  <span
                    className="zkm-btn-reset ww-deposit__connect ww-paymethod"
                    style={{ flex: 1, paddingBlock: 12, background: "none" }}
                  >
                    <Blockie address={savedEtherfi} size={44} />
                    <span className="ww-deposit__connect-text">
                      <b>{ETHERFI_CONTACT_NAME}</b>
                      <L1AddressText address={savedEtherfi} cut />
                    </span>
                  </span>
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    style={{ paddingRight: 12 }}
                    onClick={() => setReplacing(true)}
                  >
                    {ec.change}
                  </button>
                </div>
              </div>
            </Card>
          ) : (
            <>
              <div className="ww-deposit__fields">
                {ec.steps.map((line, i) => (
                  <NumberedStepRow key={line} index={i + 1}>
                    {line}
                  </NumberedStepRow>
                ))}
              </div>
              <a
                className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-withdraw__howto"
                href={ETHERFI_SHARE_ADDRESS_URL}
                target="_blank"
                rel="noreferrer"
              >
                <span className="ww-deposit__connect-icon">
                  <Icon name="bank" size={22} color="#fff" />
                </span>
                <span className="ww-deposit__connect-text">
                  <b>{ec.getAddress}</b>
                  <span>{ec.getAddressHint}</span>
                </span>
                <Icon name="share-box" size={16} color="var(--text-secondary)" />
              </a>
              <div className="ww-withdraw__field">
                <span>{ec.field}</span>
                <span className={`ww-withdraw__box ${target ? styles.resolved : ""}`}>
                  {target ? (
                    <AddressParts address={target} />
                  ) : (
                    <input
                      data-autofocus
                      aria-label={ec.field}
                      placeholder={ec.placeholder}
                      spellCheck={false}
                      data-testid="withdraw-etherfi-address"
                      value={query}
                      onChange={(e) => type(e.target.value)}
                    />
                  )}
                  {query ? (
                    <button
                      type="button"
                      className="zkm-btn-reset ww-withdraw__clear"
                      aria-label={copy.address.clear}
                      onClick={() => type("")}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="zkm-btn-reset ww-withdraw__paste"
                      onClick={paste}
                    >
                      <Icon name="copy" size={12} />
                      {copy.address.paste}
                    </button>
                  )}
                </span>
              </div>
              {search && !target && <span className="ww-pay__error">{ec.notAnAddress}</span>}
              <label className="ww-sheet__fact" style={{ cursor: "pointer" }}>
                <span>{ec.save}</span>
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              </label>
            </>
          )}
          {target && !screened.cleared ? (
            <ScreeningNotice
              verdict={screened.verdict}
              checkingCopy={copy.address.screening.checking}
              blockedFallback={copy.address.screening.blocked}
              errorCopy={copy.address.screening.unreachable}
              onRetry={screened.rescreen}
            />
          ) : (
            target &&
            etherfiRead === "checking" && <span className="ww-fund__label">{ec.checking}</span>
          )}
          {notice && (
            <Warning
              title={notice.title}
              tone={notice.tone}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              <p>{notice.body}</p>
            </Warning>
          )}
        </div>
        <PrimaryGradientButton
          title={copy.continue}
          testId="withdraw-etherfi-continue"
          isDisabled={
            !target || !screened.cleared || etherfiRead === "checking" || etherfiRead === "rejected"
          }
          onClick={() =>
            target &&
            flow.chooseEtherfi(target, {
              save: !usingSaved && keep,
              unsaved: !usingSaved && !keep,
              previous: savedEtherfi ?? undefined,
            })
          }
          className="ww-deposit-sheet__cta"
        />
      </>,
      false,
    )
  }

  const amountStep = () =>
    card(
      copy.title,
      <AmountStep
        title={copy.title}
        pill={walletId}
        subtitle={fmt(copy.amount.subtitle, { name: who })}
        send={{
          who: handle ? fmt(copy.amount.handle, { handle }) : copy.amount.balanceLabel,
          testId: "withdraw-from",
          inputTestId: "withdraw-amount",
          ariaLabel: copy.amount.amount,
          value:
            s.amount.side === "from"
              ? s.amount.maxed && v.maxAtomic !== undefined
                ? floorTo(v.maxAtomic, DEFAULT_DECIMALS, displayDecimals("DAI"))
                : s.amount.text
              : fundsAtomic !== undefined
              ? floorTo(fundsAtomic, DEFAULT_DECIMALS, displayDecimals("DAI"))
              : "",
          onChange: (next) => flow.typed(next, "from"),
          balance: {
            figure: coinFigure(
              floorAtomic(v.balanceAtomic, DEFAULT_DECIMALS, displayDecimals("DAI")),
              DEFAULT_DECIMALS,
              "DAI",
            ),
            loading: !wallet.readThisSession,
          },
          max: { disabled: !v.canMax, onClick: flow.max },
          asset: {
            icon: <CoinIcon token={withdrawalReceiveAsset("DAI")} size={32} badge="brand" />,
            symbol: "DAI",
            chain: brandCopy.name,
          },
        }}
        receive={{
          who,
          onPickWho: walletId ? openWalletPicker : undefined,
          whoTestId: walletId ? "withdraw-change-wallet" : undefined,
          testId: "withdraw-to",
          inputTestId: "withdraw-receive",
          approx: s.amount.side === "from" && !v.direct,
          value:
            s.amount.side === "to"
              ? s.amount.text
              : receivedAtomic !== undefined
              ? floorTo(receivedAtomic, toDecimals, displayDecimals(coin))
              : "",
          onChange: (next) => flow.typed(next, "to"),
          // Below a bridge's floor the floor is the fee; a quote that failed says so; a re-price
          // shows the last fee faded, never an endless shimmer.
          fee: !hasAmount
            ? "none"
            : !onL1 && v.bridgeBelow && v.bridgeFloorAtomic !== undefined
            ? { figure: dollars(v.bridgeFloorAtomic) }
            : v.pricing && (v.feeAtomic ?? v.staleFeeAtomic) !== undefined
            ? { figure: dollars(v.feeAtomic ?? v.staleFeeAtomic), stale: true }
            : feeFigure !== undefined
            ? { figure: feeFigure }
            : v.bridgeFailed || (onL1 && gaslessQuote.status === "unavailable")
            ? { error: copy.amount.quoteFailed }
            : "unknown",
          asset: {
            icon: <CoinIcon token={asset} size={32} badge={coinBadge} />,
            symbol: coin,
            chain: network.name,
            onPick: openPicker,
          },
        }}
        disabledHint={
          v.belowFee && v.floorFeeAtomic !== undefined
            ? fmt(amountCopy.belowFee, { fee: dollars(v.floorFeeAtomic) })
            : undefined
        }
        notices={
          <>
            <SpeedCards choice={speedChoice} outcome={speedOutcome} />
            {blockers}
          </>
        }
        button={{
          title: wallet.readThisSession ? copy.continue : balanceCopy.checking,
          testId: "withdraw-amount-continue",
          disabled: !v.valid,
          onClick: () => (v.gasStep ? flow.go("gas") : flow.enterReview()),
        }}
      />,
      true,
      styles.amountStep,
    )

  const gasStepView = () => {
    const label = name ?? short4
    const noEth = privacy?.balance === 0n
    const { hasEth } = ctx
    const body = hasEth ? copy.gas.hasEthBody : noEth ? copy.gas.noEthBody : copy.gas.other
    const extraFee =
      v.gasTopUp === undefined ? (
        copy.gas.quoting
      ) : v.topUpPending ? (
        <span className={styles.stale}>{fmt(copy.gas.extraFee, { fee: dollars(v.gasTopUp) })}</span>
      ) : (
        fmt(copy.gas.extraFee, { fee: dollars(v.gasTopUp) })
      )
    const chip = v.chipAtomic
    const gasFigure = usdFigure(formatUnits(chip, DEFAULT_DECIMALS))
    const lands = { received: receivedShown ?? copy.pending, coin }
    return card(
      copy.gas.title,
      <>
        <FlowHead title={copy.gas.title} subtitle={fmt(copy.gas.subtitle, { name: label })} />
        <div className={styles.gasCard}>
          <div className={styles.gasHead}>
            <b>{copy.gas.label}</b>
            {noEth && (
              <span className="ww-withdraw__tag ww-withdraw__tag--private">{copy.gas.noEth}</span>
            )}
            {hasEth && (
              <span className="ww-withdraw__tag ww-withdraw__tag--private">{copy.gas.hasEth}</span>
            )}
          </div>
          <p>{fmt(body, { name: label })}</p>
          <div
            className={`zkm-amount-chips ${styles.chips}`}
            role="group"
            aria-label={copy.gas.label}
          >
            {GAS_CHIPS.map((value) => {
              const off = value > 0n && !v.chipFits(value)
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={value === chip}
                  disabled={off}
                  aria-disabled={off || undefined}
                  className={
                    "zkm-btn-reset zkm-amount-chip zkm-amount-chip--flat" +
                    (off ? " zkm-amount-chip--disabled" : " zkm-pressable") +
                    (value === chip ? " zkm-amount-chip--selected" : "")
                  }
                  onClick={() => flow.gas(value)}
                >
                  {value === 0n
                    ? copy.gas.none
                    : fmt(copy.gas.chip, { amount: formatUnits(value, DEFAULT_DECIMALS) })}
                </button>
              )
            })}
          </div>
          <small className={styles.gasNote}>
            {chip === 0n
              ? fmt(copy.gas.noShare, lands)
              : fmt(copy.gas.share, {
                  gas: gasFigure,
                  ...lands,
                })}
          </small>
          <small className={styles.gasNote}>{extraFee}</small>
        </div>
        {blockers}
        <PrimaryGradientButton
          title={chip > 0n ? fmt(copy.gas.with, { gas: gasFigure }) : copy.gas.without}
          testId="withdraw-gas-continue"
          isDisabled={!v.valid}
          onClick={flow.enterReview}
          className="ww-deposit-sheet__cta"
        />
      </>,
    )
  }

  const reviewStep = () => {
    const amountFigure = shownAmount(fundsAtomic ?? 0n, DEFAULT_DECIMALS, "DAI")
    const fb = copy.review.feeBreakdown
    const whole = v.wholeAtomic
    let feeRows: FeeRow[] | undefined
    if (onL1 && whole !== undefined && (v.gasAtomic === 0n || v.gasTopUp !== undefined)) {
      feeRows = breakdown(
        fb.withdrawal,
        whole,
        [
          [fb.fast, v.tipInFee],
          [fb.gas, v.topUp],
        ],
        DEFAULT_DECIMALS,
      )
    } else if (!onL1 && v.bridgeQuote && whole !== undefined) {
      const acrossFee =
        v.bridgeQuote.acrossFee * 10n ** BigInt(DEFAULT_DECIMALS - ACROSS_INPUT_DECIMALS)
      // Only Across's cut is the bridge's own; the escrow tip and swap floor stay in the rest.
      feeRows = breakdown(
        fb.withdrawal,
        whole,
        [
          [fb.bridge, acrossFee],
          [fb.fast, v.bridgeQuote.proverTip],
        ],
        DEFAULT_DECIMALS,
      )
    }
    const speedName = v.fast ? copy.review.fast : copy.review.standard
    const eta = v.etaMinutes
    return card(
      copy.title,
      <>
        <div className="ww-deposit-sheet__head ww-deposit-sheet__head--tight">
          <CoinIcon token={asset} badge={coinBadge} />
          <GradientText size={24} weight={700}>
            {copy.title}
          </GradientText>
        </div>
        <MoveReview
          to={name ?? short4}
          toDetail={recipient ?? undefined}
          token={
            <Hops
              hops={[
                {
                  label: "DAI",
                  icon: (
                    <img src={withdrawalReceiveAsset("DAI").icon} alt="" width={16} height={16} />
                  ),
                },
                ...(coin === "DAI"
                  ? []
                  : [
                      { label: coin, icon: <img src={asset.icon} alt="" width={16} height={16} /> },
                    ]),
              ]}
            />
          }
          send={fmt(copy.review.send, { amount: amountFigure })}
          receive={fmt(copy.review.receive, { received: receivedShown ?? copy.pending, coin })}
          gas={
            v.gasAtomic > 0n
              ? fmt(copy.review.gas, { gas: usdFigure(formatUnits(v.gasAtomic, DEFAULT_DECIMALS)) })
              : undefined
          }
          speed={
            <DepositFact label={copy.review.speedLabel}>
              <b>
                {eta === undefined
                  ? speedName
                  : fmt(copy.review.speed, { speed: speedName, eta: etaLabel(eta * 60) })}
              </b>
            </DepositFact>
          }
          feeLabel={onL1 ? copy.review.fee : copy.review.bridgeFee}
          fee={wholeFigure ?? copy.unpriced}
          feeInfo={
            // One row would only repeat the fee line.
            feeRows &&
            feeRows.length > 1 &&
            wholeFigure !== undefined && (
              <FeeInfoButton rows={feeRows} total={wholeFigure} testId="withdraw-fee-info" />
            )
          }
          total={dollars(v.burnAtomic)}
          network={{
            hops: [brandCopy.name, network.name],
            arrivesInMinutes: v.arrivesIn,
          }}
        />
        {blockers}
        {s.review.changed && (
          <Warning title={copy.review.feeChanged} testId="withdraw-fee-changed" />
        )}
        <LocalPasskeyHint />
        <PrimaryGradientButton
          title={busy ? busyLabel : ready ? copy.review.confirm : copy.review.connecting}
          testId="withdraw-confirm"
          isDisabled={!ready || !v.valid || busy}
          onClick={() => void flow.submit()}
          className="ww-deposit-sheet__cta"
        />
      </>,
    )
  }

  const walletPicker = () => (
    <FlowCard label={walletCopy.title} onBack={back} onClose={flow.close}>
      <FlowHead title={walletCopy.title} />
      <ChangeWalletPicker
        key={opened}
        l1={l1}
        saved={saved}
        onSaved={pickSaved}
        switchable={!!connected && same(recipient, connected)}
        onPicked={(changed) => {
          if (changed) flow.walletPicked()
          // The connected wallet's own row: it becomes the recipient.
          else if (connected && !same(connected, recipient))
            flow.choose(connectedRecipient(connected, saved, l1.walletName))
          setWalletPicking(false)
        }}
      />
    </FlowCard>
  )
  const picker = () => (
    <NetworkCoinPicker
      titleAside={walletPill}
      key={opened}
      title={copy.picker.title}
      networks={networks}
      coinsOn={coinsOn}
      current={{ chainId: network.chainId }}
      onPick={choose}
      onBack={back}
      onClose={flow.close}
      testIdPrefix="withdraw"
    />
  )

  const statusStep = () => {
    const { sent, stage } = s
    if (!sent) return card(copy.status.label, null, false)
    const { plan: p, chain } = sent
    const bridge = p.route.kind === "bridge"
    const to = p.name ?? shortL1Addr(p.recipient)
    const record = sent.localId ? records.find((r) => r.localId === sent.localId) : undefined
    const phase = record?.phase
    // From the burn's start until the prompt is answered: the build is brief and the prompt follows.
    const prompted = (stage === "building" || stage === "proving") && s.signing
    const view: WithdrawView =
      phase === "done"
        ? "done"
        : phase === "failed" || phase === "recoverable"
        ? "failed"
        : prompted || !record?.l2TxHash || phase === "submitting"
        ? "burning"
        : "releasing"
    const failed = phase === "failed"
    // Released, a bridge-out's leg is what is left; its pill counts that leg alone.
    const bridging = phase === "bridging"
    const legMinutes =
      p.route.kind === "bridge" && bridging ? p.route.choice.chain.etaMinutes : p.etaMinutes
    const legChip = bridging ? copy.status.bridgeChip : copy.status.chip
    const sentDai = fmt(copy.review.send, {
      amount: shownAmount(p.amountAtomic, DEFAULT_DECIMALS, "DAI"),
    })
    const line = fmt(copy.status.line, { amount: sentDai, name: to })
    const landed = (atomic: bigint, decimals: number) =>
      fmt(copy.done.coin, { received: shownAmount(atomic, decimals, p.coin), coin: p.coin })
    // Exact on a plain withdrawal or a filled bridge; else the quote's estimate.
    const filled = record?.bridgeOut?.filledAmount
    const quoted = landed(p.receivedAtomic, p.receivedDecimals)
    const exact =
      p.route.kind === "direct"
        ? quoted
        : filled !== undefined && p.route.kind === "bridge"
        ? landed(
            BigInt(filled),
            bridgeOutDecimals(p.route.choice.token, p.route.choice.chain.chainId),
          )
        : undefined
    const estimate =
      p.route.kind === "direct" ? quoted : fmt(sendCopy.arrived.approx, { amount: quoted })
    const gasFigure =
      p.gasAtomic > 0n ? usdFigure(formatUnits(p.gasAtomic, DEFAULT_DECIMALS)) : undefined
    const blocks: RingStageBlock[] = [
      {
        // The passkey's note turns to the keep-open banner in place.
        key: "burning",
        title: fmt(copy.status.title, { chain }),
        line,
        note: prompted ? copy.status.passkey : copy.status.keepOpen,
        noteTone: prompted ? "wait" : "warning",
      },
      {
        key: "releasing",
        chip: {
          text:
            legMinutes === undefined
              ? legChip
              : fmt(copy.status.chipAbout, { chip: legChip, minutes: legMinutes }),
          tone: "live",
        },
        title: fmt(bridging ? copy.status.bridging : copy.status.releasing, { chain }),
        line: gasFigure
          ? fmt(copy.status.onItsWayGas, { amount: estimate, name: to, gas: gasFigure })
          : fmt(copy.status.onItsWay, { amount: estimate, name: to }),
        note: copy.status.note,
        button: { label: sendCopy.arrived.close, onClick: flow.close },
      },
      {
        key: "done",
        title: fmt(sendCopy.arrived.sentTitle, { amount: sentDai }),
        line: gasFigure
          ? fmt(copy.done.bodyGas, { amount: exact ?? estimate, name: to, chain, gas: gasFigure })
          : fmt(copy.done.body, { amount: exact ?? estimate, name: to, chain }),
        // Linked only while shown; a hidden block only reserves space.
        note: fmtNodes(copy.done.note, {
          activity:
            view === "done" ? (
              <Link to="/activity" onClick={onClose}>
                {copy.done.activity}
              </Link>
            ) : (
              copy.done.activity
            ),
        }),
        button: { label: copy.done.done, onClick: onClose },
      },
      {
        key: "failed",
        title: failed
          ? copy.failed.withdrawTitle
          : bridge
          ? sendCopy.failed.title
          : copy.failed.swapTitle,
        line: failed
          ? copy.failed.failed
          : bridge
          ? fmt(copy.failed.bridge, { chain })
          : copy.failed.swap,
        note: failed
          ? copy.failed.failedLine
          : bridge
          ? copy.failed.bridgeLine
          : copy.failed.swapLine,
        button: { label: sendCopy.failed.retry, onClick: flow.retry },
      },
    ]
    return card(
      copy.status.label,
      <>
        {stage && s.live && (
          // Stays on the status view through the proof; the bell takes over only on close.
          <OperationHandOff
            ref={handOff}
            onLeave={() => {}}
            until="prepared"
            // The flow draws the status itself.
            renderWorking={() => null}
            onBeat={flow.beat}
          />
        )}
        <RingStage
          active={view}
          ring={RING_PHASE[view]}
          // The flip lands on the network, the landing icon.
          front={<ChainIcon chainId={p.chainId} name={chain} size={RING_TOKEN_SIZE} />}
          back={<img src={daiIcon} alt="" width={RING_TOKEN_SIZE} height={RING_TOKEN_SIZE} />}
          landing={<ChainIcon chainId={p.chainId} name={chain} size={RING_TOKEN_SIZE} />}
          blocks={blocks}
        />
        {prompted && <LocalPasskeyHint />}
      </>,
      false,
      ringStageSheet,
    )
  }

  const own = () => {
    if (step === "status") return statusStep()
    if (step === "review") return reviewStep()
    if (step === "gas") return gasStepView()
    if (step === "amount") return amountStep()
    if (step === "etherfi") return etherfiStep()
    return addressStep()
  }

  return (
    <ModalSteps
      label={copy.label}
      animateHeight
      className={flowStyles.card}
      dir={dir}
      onAnimationEnd={settleStep}
    >
      <Fragment key={key}>
        {showPicker ? (overlay === "wallet" ? walletPicker() : picker()) : own()}
      </Fragment>
    </ModalSteps>
  )
}
