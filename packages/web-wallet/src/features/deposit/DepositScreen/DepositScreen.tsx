import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { formatUnits, type Address } from "viem"
import {
  bestEffort,
  depositsOffered,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
  selectSipaDeposit,
  sipaSweepsReceived,
  unresolvedSendState,
  useStore,
  type AddressRoute,
  type SIPADepositPhase,
  type SipaDeposit,
  serviceStatus,
} from "@obsidion/front-core"
import type { SipaIntentName } from "@obsidion/core/oxide"
import {
  ContactRow,
  GradientText,
  Icon,
  RowChevron,
  PrimaryGradientButton,
  Spinner,
} from "@obsidion/web-ds"
import paylinkCoins from "../../../assets/home/paylink-coins.webp"
import { useUserFlowActive } from "../../operations/operations"
import { errorCopy, errorMessage } from "../../../errors/catalog"
import { amountBucket, failureCode, fireEvent, fireOnboardingEvent } from "../../../lib/analytics"
import { useCopy } from "../../../ui/hooks"
import { shortL1Addr, tokenFigure, usdFigure } from "../../../ui/format"
import {
  useRegistrationEscalated,
  useTagPresentationPending,
} from "../../registration/webRegistration"
import { useOwedRegistration } from "../../registration/owedRegistration"
import type { ChosenNameClaim } from "../../registration/chooseOwnName"
import { useRegistrationDepositTarget } from "../../registration/registrationDepositTarget"
import {
  RegistrationAskLine,
  useRegistrationAsk,
} from "../../registration/RegistrationAskLine/RegistrationAskLine"
import { formatDepositDue } from "../../registration/depositAmounts"
import { ChooseNameSheet } from "../ChooseNameSheet/ChooseNameSheet"
import {
  useOpenRegistration,
  useRegistrationTagConfirmed,
} from "../../registration/openRegistration"
import { buildErc20TransferUriWithoutAmount } from "../../requests/eip681"
import { DepositFromWalletModal } from "../DepositFromWalletModal/DepositFromWalletModal"
import {
  DepositSentStatus,
  depositArrivedFigure,
  depositSentStatusSheet,
} from "../DepositSentStatus/DepositSentStatus"
import sentStatusCopy from "../DepositSentStatus/DepositSentStatus.copy"
import { Modal } from "../../../ui/Modal"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { DepositCoinModal, DepositTokensStatus } from "../DepositCoinModal/DepositCoinModal"
import { isDemoMode } from "../../../dev/demoFlag"
import { DepositDetailModal } from "../../../ui/screens/DepositDetailModal/DepositDetailModal"
import {
  depositCreditNote,
  loadDepositDisplayFacts,
  settlementOf,
  useDepositTokensRead,
  type DepositDisplayFacts,
  type DepositTokenOption,
  type DepositTokens,
} from "../../sipa/loadDepositFacts"
import { sentDepositRecord } from "../sentDepositRecord"
import { AddressLimitsDetail } from "../AddressLimits"
import { ADDRESS_RECHECK_NOTE, swapCapacityNote } from "../../limits/limitsCopy"
import { WalletAboutLimitsSheet } from "../../limits/AboutLimitsSheet"
import { InfoButton } from "../../../ui/InfoButton/InfoButton"
import { formatPublicLimit, usdFigureGrouped } from "../../limits/publicLimit"
import { sourceFromTarget } from "../../limits/capacitySources"
import { targetEligibility, useTargetCapacity } from "../targetCapacity"
import { fundingCapacityView } from "../fundingCapacity"
import { permittedAccount, pickAccount, savedInWallet } from "../../../session/l1Wallet"
import { useL1Wallet } from "../../../session/useL1Wallet"
import { ChangeWalletPicker, ConnectedTrailing } from "../ChangeWalletPicker/ChangeWalletPicker"
import { useDepositWatch } from "../../sipa/useDepositWatch"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { OneTimeAddressPoints, type OneTimeAddressPoint } from "../OneTimeAddressWarning"
import { DepositPrivacyDisclaimer } from "../DepositPrivacyDisclaimer/DepositPrivacyDisclaimer"
import { MethodOption } from "../../../ui/MethodOption/MethodOption"
import { ChainIcon } from "../../../ui/ChainIcon/ChainIcon"
import { IconStack } from "../../../ui/IconStack/IconStack"
import { ChainStack } from "../../../ui/flow/ChainStack/ChainStack"
import { BridgeInModal } from "../BridgeInModal/BridgeInModal"
import { SwitchAccountModal } from "../SwitchAccountModal/SwitchAccountModal"
import { bridgeRoutes } from "../bridgeChains"
import { profileBridge } from "../../../session/walletChains"
import {
  DepositFlow,
  type DepositFlowNav,
  type DepositOrigin,
  type DepositFlowSheet,
  type WalletKind,
} from "../DepositFlow/DepositFlow"
import { useSavedL1WalletList } from "../../../session/savedL1Wallets"
import type { SavedL1Wallet } from "../../../session/savedL1Wallets"
import { tokenName } from "../../token/tokenName"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import {
  DepositAddressSheet,
  LimitsRow,
  type DepositSheetPhase,
  type DepositSpottedProblem,
} from "../DepositAddressSheet/DepositAddressSheet"
import { CheckAgainPill } from "../../../ui/CheckAgainPill/CheckAgainPill"
import { AddressesPublishingError } from "../addressesPublishing"
import { openDepositHandOutFlow } from "../depositHandOutFlow"
import { openDepositScreenFlow, type DepositScreenInputs } from "./depositScreenFlow"
import { depositScreenStart } from "./depositScreenTransition"
import {
  selectDepositHold,
  selectEntry,
  selectEntrySheet,
  selectSwitch,
} from "../depositScreenView"
import { useOpened, useScreenFlow } from "../../../ui/useScreenFlow"
import { depositValuation } from "../depositValuation"
import { useDepositArrivalMinutes } from "../depositArrival"
import { useSession } from "../../../session/session"
import { reloadPage } from "../../../platform/storage/walletStorage"
import { fmt, fmtNodes } from "../../../lib/fmt"
import depositCopy from "./DepositScreen.copy"
import sendCopy from "../sendFromWallet.copy"
import styles from "./DepositScreen.module.css"
import type { DepositStart } from "../depositStart"

/** A sent deposit in these phases shows its detail and its Recover action, not its status. */
const SENT_ENDED: SIPADepositPhase[] = ["recoverable", "recovered"]

/** The smallest deposit the relayer sweeps, as the limits drawer states it. */
const MINIMUM_DEPOSIT = "$1"

const coinName = (token: DepositTokenOption) => tokenName(token.symbol)

/** "USDC, USDT and DAI". */
const listed = (symbols: string[]) =>
  symbols.length < 2
    ? symbols.join("")
    : fmt(depositCopy.coinList.last, {
        rest: symbols.slice(0, -1).join(depositCopy.coinList.separator),
        last: symbols.at(-1)!,
      })

const DEPOSIT_INFO_POINTS: OneTimeAddressPoint[] = [
  {
    id: "loss",
    icon: "coins",
    title: depositCopy.info.lossTitle,
    body: depositCopy.info.lossBody,
  },
  {
    id: "rotates",
    icon: "shield-check",
    title: depositCopy.info.rotatesTitle,
    body: depositCopy.info.rotatesBody,
  },
]

/** The coin the screen opens on: Main's settlement token when offered. */
const defaultCoin = (tokens: DepositTokens) =>
  tokens.offered.find((t) => t.address === tokens.settlement.address) ?? tokens.offered[0]!

/** Map raw errors to something a user can act on (esp. the stale-identity resolve revert). */
function friendlyError(e: unknown): string {
  const msg = errorMessage(e)
  if (/UserNotFound|User not found/i.test(msg)) {
    return depositCopy.userNotFound
  }
  return errorCopy(e) ?? msg
}

/**
 * Deposit: pick a coin, then a sheet hands out a single-use SIPA address for THIS wallet's
 * `<tag>.<ensDomain>` to copy or scan, or funds it from a connected wallet. Anything sent there is
 * discovered and credited automatically by the SIPA sync loop mounted in WalletGate; the screen
 * watches the address itself so the sheet can say when funds are spotted. With `onClose` it is a
 * modal over Home instead of a page: the coin pick, then the same address sheet. An owed
 * registration's address takes the place of a fresh deposit address.
 */
export function DepositScreen(props: {
  claimName: ChosenNameClaim
  onClose?: () => void
  /** Where the screen and its sheets open on their first showing. */
  start?: DepositStart
}) {
  const owed = useOwedRegistration() !== null
  // Unknown while the withdrawals load: the screen waits rather than offer a plain deposit.
  const open = useOpenRegistration()
  const known = open === null || open.stage !== undefined
  // A registration settles on the fee token's row.
  const intent = owed ? "registration" : "deposit"
  const { tokens, failed, retry } = useDepositTokensRead(intent)
  if (known && tokens?.offered.length)
    return <DepositScreenBody {...props} tokens={tokens} intent={intent} />
  const title = owed ? depositCopy.titleActivate : depositCopy.title
  // A table that offers Main no token has nothing to deposit, as when it cannot be read.
  const status = (
    <DepositTokensStatus failed={failed || (!!tokens && !tokens.offered.length)} onRetry={retry} />
  )
  if (props.onClose) {
    return <DepositCoinModal title={title} status={status} onClose={props.onClose} />
  }
  return (
    <div className="ww-panel ww-deposit">
      <div className={`ww-deposit__stealth ${styles.top}`}>
        <GradientText size={24} weight={700}>
          {title}
        </GradientText>
        {status}
      </div>
    </div>
  )
}

function DepositScreenBody({
  claimName,
  onClose,
  tokens,
  intent,
  start,
}: {
  claimName: ChosenNameClaim
  onClose?: () => void
  tokens: DepositTokens
  intent: SipaIntentName
  start?: DepositStart
}) {
  const navigate = useNavigate()
  const session = useSession()
  const identity = useStore(session.identity).value
  const handle = identity?.handle
  // The gate is effectful, not cosmetic: while the registration is unconfirmed, deriving and
  // publishing a deposit address for a name that may be lost must not happen at all.
  const claiming = useTagPresentationPending()
  const escalated = useRegistrationEscalated()
  const owedRegistration = useOwedRegistration()
  const owed = owedRegistration !== null
  const registration = owedRegistration?.needsCheck === false ? owedRegistration.record : null
  const [choosingName, setChoosingName] = useState(false)
  const tagConfirmed = useRegistrationTagConfirmed(registration)
  const registrationAsk = useRegistrationAsk()
  // The registration's funds landed: Home carries its progress, so this screen does not turn into
  // a plain deposit (and its privacy disclaimer) under the user.
  const wasOwed = useRef(owed)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (owed) wasOwed.current = true
    else if (wasOwed.current) {
      if (onClose) onClose()
      else navigate("/", { replace: true })
    }
  }, [owed, navigate, onClose])
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const contracts = useStore(session.contractService, serviceStatus) === "ready"
  const { sipaAddresses } = session
  const { config } = session.page
  const { l1Chain, l1ChainId, l1RpcUrl, oxideProfile } = config
  const manifestUrl = oxideProfile.manifestUrl
  const chainName = l1Chain.name
  const l1 = useL1Wallet({ expectedChainId: l1ChainId, rpcUrl: l1RpcUrl })
  // Desktop launcher: no wallet extension, the transfer is approved in the default browser.
  const bridgeMode = isDesktopL1SubmitActive()
  // The default pick, when Main offers it: a pinned product row is never offered.
  const [token, setToken] = useState<DepositTokenOption>(
    () =>
      (start?.origin?.chainId === l1ChainId &&
        tokens.offered.find((c) => c.symbol === start.origin?.symbol)) ||
      defaultCoin(tokens),
  )
  // `startDeposit` in router state opens the deposit flow at its first step.
  const location = useLocation()
  const startDeposit = !!(location.state as { startDeposit?: boolean } | null)?.startDeposit
  const startKey = startDeposit && !onClose ? location.key : undefined
  // Filled below once this render's callbacks exist: the flow reads it when the wallet changes.
  const screenInputs = {} as DepositScreenInputs
  const steps = useScreenFlow(screenInputs, (latest) =>
    openDepositScreenFlow(
      {
        l1Wallet: session.page.l1Wallet,
        // Over Home the flow opens at once; on the page a card opens it. A registration skips the
        // privacy step.
        initial: depositScreenStart(start, {
          picking: !onClose ? "closed" : owed ? "coin" : "privacy",
          symbol: token.symbol,
          now: session.page.now(),
        }),
      },
      latest,
    ),
  )
  const screen = useStore(steps.state)
  // The start holds for the first showing only: closing the flow ends it.
  const opening = screen.start
  const { sheet: openSheetKind, funded, balance, lastReadAt, readError } = screen
  const sheetOpen = openSheetKind?.kind === "address"
  const fundOpen = openSheetKind?.kind === "fund"
  const bridging = openSheetKind?.kind === "bridge"
  const sent = openSheetKind?.kind === "sent" ? openSheetKind.deposit : undefined
  const { carried, holdError } = screen
  const entry = selectEntry(screen, startKey)
  const step = screen.awaiting ? "awaiting" : "address"

  const target = useRegistrationDepositTarget(registration, handle, registrationAsk)
  // Read by callbacks the funding poll holds, so a new ask does not restart the poll.
  const targetRef = useRef(target)
  targetRef.current = target
  const addresses = (walletBuilt && contracts && !claiming && sipaAddresses) || undefined
  const account = identity?.address
  const handOut = useScreenFlow({ handle, account, addresses, sheetOpen }, (latest) =>
    openDepositHandOutFlow(latest, session.sipaDeposits.view, friendlyError),
  )
  const handedOut = useStore(handOut.state)
  const { address: deposit, failed: resolveFailed } = handedOut
  // A start that holds the address back as creating or capped.
  const seededAddress = opening?.address
  const generating =
    !!handedOut.running || seededAddress === "creating" || seededAddress === "capped"
  const capped = handedOut.capped || seededAddress === "capped"
  const shown = target ? target.address : deposit
  const busy = useUserFlowActive()
  const canFund = bridgeMode || !!l1.account
  const [infoOpen, setInfoOpen] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [aboutLimits, setAboutLimits] = useState(start?.aboutLimits)
  const bridge = profileBridge(config)
  const bridgeIn = useStore(session.page.bridgeInProvider, serviceStatus) === "ready"
  const savedWallets = useSavedL1WalletList(Infinity).wallets
  // A desktop send may have been approved without a known hash: that address may still be funded, so
  // new funding waits until funds reach it or the user starts again.
  const holds = session.unresolvedSends
  const saved = unresolvedSendState(useStore(holds.view))
  // After the wallet broadcasts a deposit the detail sheet tracks it: a client-side `funding` view
  // until event discovery creates the store record, then that record as it advances.
  const { records } = useStore(session.sipaDeposits.view)
  // Funds reached the address the unresolved send was going to: its deposit shows, and closing it
  // ends the hold. A close whose clear failed still closes; the saved hold reopens it on the next visit.
  const { hold, unresolved, arrived: arrivedShown } = selectDepositHold(screen, saved, records)
  // Nothing new is offered while the saved holds are still being read.
  const offering = depositsOffered(hold)
  const stored = sent
    ? records.find((r) => r.sipaAddress.toLowerCase() === sent.address.toLowerCase())
    : undefined
  const shownRecord = useStore(session.sipaDeposits.view, (set) =>
    shown ? selectSipaDeposit(set, shown.address) : undefined,
  )
  const addressRecord = shownRecord
  // The spotted deposit is in the private funds once the rail has claimed its sweeps.
  const landed =
    addressRecord && sipaSweepsReceived(addressRecord)
      ? depositArrivedFigure(addressRecord, tokens)
      : undefined
  // The user's explicit choice; the hold stays until the saved marker is really gone.
  const clearHold = useCallback(
    (only?: { address?: string }) =>
      holds.apply({ type: "cleared", only }).then(
        () => {
          steps.holdError(false)
          steps.held(undefined)
        },
        () => steps.holdError(true),
      ),
    [holds, steps],
  )
  const coins = tokens.offered
  const settlement = settlementOf(tokens, token)
  const flow = screen.picking
  const closeFlow = () => (onClose ? onClose() : steps.pick("closed"))
  const [facts, setFacts] = useState<DepositDisplayFacts>()
  const [factsFailed, setFactsFailed] = useState(false)
  const [factsAttempt, setFactsAttempt] = useState(0)
  const fee = facts?.fee
  // A target's sweep takes its own fee, so a deposit sent to it is shown at that fee.
  const sentFacts =
    facts && target?.fee !== undefined ? { ...facts, sweepFeeAtomic: target.fee } : facts
  const sentRecord = sent ? sentDepositRecord(sent, stored, l1ChainId, sentFacts) : undefined
  const { copied, copy } = useCopy()
  // Without the fee nothing may be funded: the wallet path would charge amount + 0 while the sweep
  // still takes the real fee. Copy/Deposit stay disabled until it loads.
  const quoteFailed = fee == null && factsFailed
  const quoteLoading = fee == null && !factsFailed
  const reloadFacts = () => setFactsAttempt((n) => n + 1)

  useOpened(() => fireEvent("deposit_sheet_opened", owed ? { registration: true } : undefined))
  const reportedOwed = useRef(false)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!owed || reportedOwed.current) return
    reportedOwed.current = true
    fireOnboardingEvent("registration_deposit_opened")
  }, [owed])

  // The quote is the picked token's row for the screen's intent, read again on Retry and when the row, the intent or
  // the deployment changes.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    let stale = false
    setFacts(undefined)
    setFactsFailed(false)
    void loadDepositDisplayFacts(session.page, token, intent)
      .then((next) => {
        if (!stale) setFacts(next)
      })
      .catch((e) => {
        if (stale) return
        console.warn("[deposit] fee quote failed:", e)
        fireEvent("action_failed", { action: "deposit:facts", code: failureCode(e) })
        setFactsFailed(true)
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debt the row it settles on keys the quote
  }, [factsAttempt, l1RpcUrl, l1ChainId, manifestUrl, token.settlesIn, intent])

  // A demo page's fixture address stands in for a derived one.
  const { demoDepositAddress } = session
  const heldBack = seededAddress === "creating" || seededAddress === "capped"
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!demoDepositAddress || heldBack || claiming || deposit || !handle) return
    handOut.show(demoDepositAddress(handle))
  }, [demoDepositAddress, heldBack, claiming, deposit, handle, handOut])

  // The address appears on open when the pool holds one nobody was shown; the coin row derives. While
  // a sent deposit's detail is open, the next address waits for the user to come back to the sheet.
  const opens =
    !target && !deposit && !capped && !resolveFailed && !busy && !sent && hold.status === "none"
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (opens) void handOut.handOut(0)
  }, [opens, handle, addresses, handOut])

  /** Open the funding sheet. Funding needs the address the user is shown, so derive one first. */
  const beginFunding = useCallback(() => {
    if (!offering || fee == null || (claiming && !target)) return
    // The sheet moves the wallet's money, so it opens only for an address whose broadcast landed.
    if (shown) return steps.open({ kind: "fund" })
    if (!generating) void handOut.handOut().then((ok) => ok && steps.open({ kind: "fund" }))
  }, [offering, fee, shown, generating, handOut, claiming, target, steps])

  const switching = selectSwitch(screen, l1)
  /** Fund or bridge in from the connected wallet; a saved one must be the account it has selected. */
  const beginWallet = useCallback(
    (kind: WalletKind, saved?: SavedL1Wallet) => {
      if (kind === "fund" && bridgeMode) return beginFunding()
      // The wallet as it is now: a held step carries on before the render that shows it.
      const { account: connected, accounts } = session.page.l1Wallet.view.get()
      if (!connected) {
        steps.awaitConnect({ kind, saved })
        return void l1.connect()
      }
      // The wallet is asked for a saved account it has not granted; this carries on once it does.
      if (saved && !pickAccount({ ...l1, accounts }, saved.address))
        return steps.awaitAccount({ kind, saved })
      if (kind === "fund") beginFunding()
      else steps.open({ kind: "bridge" })
    },
    [l1, bridgeMode, beginFunding, steps, session],
  )
  const beginBridge = useCallback(
    (saved?: SavedL1Wallet) => beginWallet("bridge", saved),
    [beginWallet],
  )
  /** Connects a new wallet, then opens the deposit modal to pick what it sends. */
  const connectThenPick = () => {
    if (bridgeMode) {
      steps.entry({ intent: "wallet" })
      return beginFunding()
    }
    steps.awaitConnect({ kind: "pick" })
    l1.connectAnother()
  }
  // `l1.connect` only opens the wallet picker; the account lands later, so the click that asked to
  // fund would otherwise stop at "Wallet connected" and need a second one. A successful pick cannot
  // close the picker ahead of its account: wagmi stores the connection before RainbowKit reacts.
  const latestScreen: DepositScreenInputs = {
    startKey,
    clearStart: () => navigate(".", { replace: true, state: null }),
    bridgeMode,
    pickerShown: l1.pickerShown,
    resume: (kind, saved) =>
      kind === "pick" ? steps.entry({ intent: "wallet" }) : beginWallet(kind, saved),
  }
  Object.assign(screenInputs, latestScreen)

  // A target's sweep takes its own fee, not the plain deposit fee. Priced in the settlement token,
  // which a stablecoin matches one to one.
  const depositFee = target
    ? target.fee !== undefined
      ? formatUnits(target.fee, settlement.decimals)
      : undefined
    : fee
  const ready = !!shown && !generating && fee != null
  const qrToken = token.address
  // A swapped token is converted into its row's token before the portal credits it.
  const swap = token.swapped
  const route: AddressRoute = {
    kind: "deposit",
    decimals: token.decimals,
    swap,
    feeAtomic: target ? target.fee : facts?.sweepFeeAtomic,
    txAmountCap: facts?.txAmountCap,
  }
  const valuation = depositValuation(token, tokens)
  const maxSend = maximumSendAtomic(route, valuation)
  // The address on this screen is derived from the active deployment, so its bucket is the active one.
  const capacity = useTargetCapacity({ kind: "active", token: token.settlesIn })
  const arrivalMinutes = useDepositArrivalMinutes()
  const capacityEligibility = targetEligibility(capacity, { status: "unknown" })
  const capacityView = fundingCapacityView({
    eligibility: capacityEligibility,
    mode: "address",
    symbol: settlement.symbol,
    sentSymbol: token.symbol,
    exactCredit: !swap,
  })
  const capacityKnown = capacityEligibility.kind === "amount-unknown"
  // No figure fits a swap: the settlement credited is set by the swap.
  const fitsNow =
    !swap && capacityKnown && !capacityEligibility.zero
      ? maximumSendForCapacity(route, capacityEligibility.snapshot.availableAtomic, valuation)
      : undefined
  const limitNow =
    capacityKnown && capacityEligibility.zero
      ? "$0"
      : fitsNow !== undefined && maxSend !== undefined && fitsNow < maxSend
      ? usdFigureGrouped(formatUnits(fitsNow, token.decimals))
      : formatPublicLimit()
  const capacityNote =
    capacityView.tone === "ok" || capacityView.tone === "checking"
      ? undefined
      : [capacityView.statusText, capacityView.detailText].filter(Boolean).join(" ")
  // A swapped coin's credit is set by the swap rate, so no figure is promised for it.
  // The sweep floors each coin on its own, so only what the address holds in the picked coin counts.
  const held = token.symbol === settlement.symbol ? target?.held ?? 0n : 0n
  // The least to send, before the address: a target's ask, less what its address holds.
  const askLeft =
    target?.ask === undefined
      ? undefined
      : held > 0n && held < target.ask
      ? target.ask - held
      : target.ask
  const depositMinimum = !target
    ? MINIMUM_DEPOSIT
    : askLeft === undefined
    ? depositCopy.quotePending
    : formatDepositDue(askLeft, settlement.decimals).replace(/\.00$/, "")
  const minimumRow = (
    <LimitsRow
      label={depositCopy.limits.minimum}
      value={depositMinimum}
      testId="deposit-minimum"
      info={
        <InfoButton
          label={depositCopy.limits.aboutLimit}
          outline
          onClick={() => setAboutLimits("limit")}
        />
      }
    />
  )
  /** The address sheet re-reads the limit in place; the privacy step leaves it to About limits. */
  const limitRow = (checkAgain: boolean) => (
    <LimitsRow
      label={depositCopy.limits.now}
      value={
        capacityKnown
          ? fmt(depositCopy.limits.nowValue, { limit: limitNow })
          : capacityEligibility.kind === "checking"
          ? depositCopy.quotePending
          : depositCopy.limits.unchecked
      }
      testId="deposit-limit-now"
      info={
        <InfoButton
          label={depositCopy.limits.aboutCapacity}
          testId="about-capacity-link"
          outline
          onClick={() => setAboutLimits("capacity")}
        />
      }
      action={
        checkAgain && (
          <CheckAgainPill
            checking={capacityEligibility.kind === "checking"}
            onClick={capacity.retry}
            testId="funding-capacity-retry"
          />
        )
      }
    />
  )
  const feeRow = (
    <LimitsRow
      label={depositCopy.limits.fee}
      value={
        depositFee != null
          ? usdFigure(depositFee)
          : quoteFailed
          ? depositCopy.limits.unavailable
          : depositCopy.quotePending
      }
      testId="deposit-fee"
      info={
        <InfoButton
          label={depositCopy.limits.aboutFee}
          outline
          onClick={() => setAboutLimits("limit")}
        />
      }
      action={
        quoteFailed && (
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            data-testid="deposit-facts-retry"
            onClick={reloadFacts}
          >
            {depositCopy.limits.retry}
          </button>
        )
      }
    />
  )
  const limitsDrawer = (
    <>
      {minimumRow}
      {limitRow(true)}
      {feeRow}
      <LimitsRow
        label={depositCopy.limits.arrival}
        value={
          arrivalMinutes === undefined
            ? depositCopy.limits.arrivalUnknown
            : fmt(depositCopy.limits.arrivalMinutes, { minutes: arrivalMinutes })
        }
      />
      {quoteFailed && (
        <p className="ww-deposit-sheet__fine" data-testid="deposit-fee-unavailable">
          {depositCopy.feeUnavailableNote}
        </p>
      )}
      <p
        className="ww-deposit-sheet__fine"
        data-testid={swap ? "deposit-swap-note" : "deposit-credit-note"}
      >
        {depositCreditNote(token, settlement)}
      </p>
    </>
  )
  const limitsDetails = {
    limit: (
      <AddressLimitsDetail
        symbol={token.symbol}
        decimals={token.decimals}
        checking={quoteLoading}
        maxSendAtomic={maxSend}
        maxCreditAtomic={maximumCreditAtomic(route, valuation)}
        swapInto={swap ? settlement.symbol : undefined}
      />
    ),
    capacity: (
      <>
        {swap && (
          <p className="ww-about-limits__note" data-testid="address-capacity-swap">
            {swapCapacityNote(settlement.symbol, token.symbol)}
          </p>
        )}
        <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p>
      </>
    ),
  }

  const markFunded = useCallback(
    (next: bigint) => {
      if (!steps.funded(next)) return
      const funded = targetRef.current
      fireEvent("deposit_funded", {
        funding: "external",
        amount_bucket: amountBucket(next, token.decimals),
        ...(funded?.kind === "registration" && { registration: true }),
      })
      // The scanner moves the record on; back on its per-tick lane, the row shows within a tick.
      if (funded) funded.onFunded(next, token.decimals)
    },
    [token.decimals, steps],
  )
  // The ask is priced in the settlement token; any stablecoin funds it one to one, in its own units.
  const settledToToken = (settled: bigint) =>
    (settled * 10n ** BigInt(token.decimals)) / 10n ** BigInt(settlement.decimals)
  // A target's address short of its floor is not funded: the sweep refuses it, so it waits. Rounded
  // up, so a coin with fewer decimals still covers all of it.
  const floorRef = useRef<bigint | undefined>(undefined)
  const unit = 10n ** BigInt(settlement.decimals)
  floorRef.current =
    target?.floor === undefined
      ? undefined
      : (target.floor * 10n ** BigInt(token.decimals) + unit - 1n) / unit
  const recordRead = useCallback(
    (next: bigint, at: number) => {
      steps.read(next, at)
      if (next === 0n) return
      const floor = floorRef.current
      if (targetRef.current && (floor === undefined || next < floor)) return
      markFunded(next)
    },
    [markFunded, steps],
  )

  // A third-party send leaves no local trace: the rail's record of the address is what moves the
  // sheet to spotted, and the sweep credits it. The demo's fake L1 reports a balance for every
  // address, which would read as an instant external send; the connected-wallet path is tracked by
  // its own detail sheet.
  const watched = useDepositWatch(
    shown &&
      qrToken &&
      !fundOpen &&
      !sent &&
      funded == null &&
      !(import.meta.env.DEV && isDemoMode())
      ? shown.address
      : null,
  )
  const watchedBalance = settledToToken(watched.balance)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (watched.readAt !== undefined) recordRead(watchedBalance, watched.readAt)
  }, [watched.readAt, watchedBalance, recordRead])

  /** A check, on demand. */
  const refresh = () => {
    if (!shown || !qrToken || refreshing) return
    setRefreshing(true)
    watched
      .read()
      .catch((e) => {
        steps.readFailed()
        console.warn("[deposit] balance read failed:", e)
      })
      .finally(() => setRefreshing(false))
  }

  // Once per address per mount, when the sheet shows it.
  const reportedShown = useRef(new Set<string>())
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!sheetOpen || !shown || reportedShown.current.has(shown.address)) return
    reportedShown.current.add(shown.address)
    if (targetRef.current) targetRef.current.onShown(shown.address)
    else fireEvent("deposit_address_shown", { address_source: shown.source })
  }, [sheetOpen, shown])

  // A sheet with nothing to show and nothing coming closes: the derivation failed or never started.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (sheetOpen && !shown && !generating && !capped) steps.shut("address")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debt runs on sheet or address changes
  }, [sheetOpen, shown, generating])

  // Copying is the hand-off: after the copied feedback the sheet waits for the funds. A refused
  // clipboard copies nothing, so the sheet stays put.
  const copyAddress = () => {
    if (!shown) return
    void copy(shown.address).then((ok) => ok && steps.copied())
  }
  /** A coin row: the sheet for that coin, deriving an address when none is held yet. */
  const openSheet = (next: DepositTokenOption) => {
    if (!offering) return
    // The picker sets the coin before the sheet opens, so `token` cannot tell the last one shown.
    steps.coin(next.symbol)
    if (funded != null) return
    setToken(next)
    if (!shown) void handOut.handOut()
  }
  /** The held address was spent or may be: the next sheet derives a fresh one. */
  const dropAddress = () => {
    handOut.drop()
    steps.dropAddress()
  }
  const phase: DepositSheetPhase =
    funded != null ? "spotted" : !shown ? "creating" : step === "awaiting" ? "waiting" : "ready"
  const paymentUri =
    ready && qrToken
      ? buildErc20TransferUriWithoutAmount({
          token: qrToken,
          chainId: l1ChainId,
          to: shown.address,
        })
      : undefined
  // The sweep cannot credit an amount over the per-transaction limit; over current capacity, or with
  // none, it waits. Unknown capacity promises nothing either way.
  const spottedProblem: DepositSpottedProblem | undefined =
    funded == null
      ? undefined
      : maxSend !== undefined && funded > maxSend
      ? "limit"
      : (capacityKnown && capacityEligibility.zero) || (fitsNow !== undefined && funded > fitsNow)
      ? "capacity"
      : undefined
  // The least the funding sheet may credit, in the picked coin: the floor less what the sweep
  // takes (the sheet adds that fee to what it sends) and less what the address already holds.
  const targetMinimum =
    target?.floor !== undefined && target.fee !== undefined
      ? formatUnits(
          settledToToken(
            target.floor - target.fee - held > 0n ? target.floor - target.fee - held : 0n,
          ),
          token.decimals,
        )
      : undefined
  const arriving =
    !swap && funded != null && depositFee != null
      ? tokenFigure(
          String(Math.max(0, Number(formatUnits(funded, token.decimals)) - Number(depositFee))),
          token.symbol,
        )
      : undefined
  const bridgeRecipient = async () =>
    (shown?.address as Address | undefined) ??
    ((await handOut.handOut()) ? (handOut.state.get().address?.address as Address) : undefined)
  // The desktop launcher signs Ethereum sends only, through its helper page.
  const canBridge = !!bridge && !!bridgeIn && !owed && !bridgeMode
  const bridgeChains = canBridge && bridge ? bridge.chains : []
  const tagLabel = handle ? `@${handle}` : depositCopy.tagFallback
  const walletLabel = l1.account
    ? fmt(depositCopy.fromWallet, {
        wallet: l1.walletName ?? depositCopy.walletFallback,
        address: shortL1Addr(l1.account),
      })
    : bridgeMode
    ? depositCopy.fromBrowser
    : depositCopy.connectWallet
  const connectLink = (
    <p className="ww-deposit__note">
      <button
        type="button"
        className="zkm-btn-reset ww-deposit__link"
        data-testid="deposit-connect-link"
        // An unconfirmed tag has no broadcast queued to sweep what arrives, so nothing may be sent yet.
        disabled={!offering || fee == null || (claiming && !target) || (owed && !tagConfirmed)}
        onClick={() => {
          if (!canFund) {
            steps.awaitConnect({ kind: "fund" })
            return void l1.connect()
          }
          beginFunding()
        }}
      >
        {walletLabel}
      </button>
      {l1.account && (
        <>
          {" "}
          <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={l1.disconnect}>
            {depositCopy.disconnect}
          </button>
        </>
      )}
    </p>
  )

  // Web has no background re-sign; the claim page owns the status check.
  const claimingBlock = claiming && !target && (
    <>
      <button
        type="button"
        className={`zkm-btn-reset ww-banner ww-banner--activate ${styles.claiming}`}
        data-testid="deposit-claiming"
        onClick={() => navigate(handle ? `/claim/${handle}` : "/claim")}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {owed
              ? depositCopy.claiming.checkTitle
              : fmt(depositCopy.claiming.title, { tag: tagLabel })}
          </span>
          <span className="ww-banner__body">
            {owed
              ? fmt(depositCopy.claiming.checkBody, { tag: tagLabel })
              : fmt(depositCopy.claiming.body, {
                  status: escalated ? depositCopy.claiming.slow : depositCopy.claiming.usual,
                })}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          {owed || escalated ? (
            <Icon name="chevron-right" size={12} color="#fff" />
          ) : (
            <Spinner size={12} color="#fff" />
          )}
        </span>
      </button>
      <p className="ww-deposit__note">{fmt(depositCopy.claiming.note, { tag: tagLabel })}</p>
    </>
  )
  const holdBlock = (hold.status === "held" || hold.status === "unreadable") && (
    <div className="ww-deposit__unresolved" role="status" data-testid="deposit-send-unresolved">
      {unresolved ? (
        <>
          <b>{depositCopy.hold.waitingTitle}</b>
          <p>{fmt(depositCopy.hold.waitingBody, { address: shortL1Addr(unresolved.address) })}</p>
        </>
      ) : (
        <>
          <b>{depositCopy.hold.unreadTitle}</b>
          <p>{depositCopy.hold.unreadBody}</p>
        </>
      )}
      <p>{depositCopy.hold.paused}</p>
      {holdError && (
        <p data-testid="deposit-send-unresolved-error">{depositCopy.hold.writeFailed}</p>
      )}
      <div className="ww-deposit__unresolved-actions">
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          onClick={() => (unresolved ? navigate("/activity") : void reloadPage())}
        >
          {unresolved ? depositCopy.hold.viewActivity : depositCopy.hold.checkAgain}
        </button>
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          data-testid="deposit-send-unresolved-restart"
          onClick={() => void clearHold()}
        >
          {depositCopy.hold.restart}
        </button>
      </div>
    </div>
  )
  const shownCoin = (!owed || tagConfirmed) && !claimingBlock && !holdBlock

  /** In the deposit modal the sheet goes back to the step before it and closes the modal. */
  type InFlow = {
    onBack: () => void
    onClose: () => void
  }
  const addressSheet = (flow?: InFlow) => (
    <DepositAddressSheet
      token={token}
      chainId={l1ChainId}
      chainName={chainName}
      phase={phase}
      address={shown?.address}
      paymentUri={paymentUri}
      publishing={!!shown?.publishing}
      // eslint-disable-next-line local/message-in-state -- debt
      creatingNote={capped ? new AddressesPublishingError().message : undefined}
      canCopy={ready}
      copied={copied}
      onCopy={copyAddress}
      balance={balance}
      lastReadAt={lastReadAt}
      checking={refreshing}
      onCheck={refresh}
      funded={funded}
      arriving={arriving}
      swapInto={swap ? settlement : undefined}
      limitNow={limitNow}
      limits={limitsDrawer}
      capacityNote={capacityNote}
      arrivalMinutes={arrivalMinutes}
      onPayWithWallet={
        flow || canBridge
          ? undefined
          : () => {
              steps.shut("address")
              if (!canFund) {
                steps.awaitConnect({ kind: "fund" })
                return void l1.connect()
              }
              beginFunding()
            }
      }
      walletLabel={walletLabel}
      readError={readError}
      problem={spottedProblem}
      limitLabel={formatPublicLimit()}
      arrived={landed}
      onOpenActivity={() => navigate("/activity")}
      ask={owed && <RegistrationAskLine />}
      onBack={flow?.onBack}
      onClose={() => {
        // A copy's pending hand-off is dropped; a sheet already waiting keeps waiting.
        steps.shut("address")
        // Funds spotted: the deposit carries on in Activity, so the screen is done.
        if (phase === "spotted") {
          flow?.onClose()
          return onClose ? onClose() : navigate("/")
        }
        if (flow) flow.onClose()
        else closeFlow()
      }}
    />
  )

  // The saved wallet the modal was opened from names the connected account it is.
  const savedName =
    entry?.saved && entry.saved.address.toLowerCase() === l1.account?.toLowerCase()
      ? entry.saved.name
      : undefined
  const fundSheet = (flow?: InFlow & { onChange?: () => void; onChangeWallet?: () => void }) =>
    fundOpen &&
    shown && (
      <DepositFromWalletModal
        l1={l1}
        walletLabel={savedName}
        deposit={shown}
        token={token}
        fee={depositFee}
        target={target?.kind}
        minimum={targetMinimum}
        valuation={valuation}
        handle={handle}
        minutes={arrivalMinutes}
        carried={carried}
        onCarry={steps.carry}
        start={opening?.fund}
        onChangeOrigin={flow?.onChange}
        onChangeWallet={flow?.onChangeWallet}
        onBack={flow?.onBack}
        onClose={flow?.onClose ?? (() => steps.shut("fund"))}
        onSent={(next) => {
          steps.open({ kind: "sent", deposit: next })
          // The address was spent; the next visit derives a fresh one.
          dropAddress()
          // A known hash replaces the hold; if it cannot be removed, the funded record ends it.
          void bestEffort("unknown", clearHold({ address: next.address }))
        }}
        onSendFailed={() => steps.shut("sent")}
        onFeeChanged={reloadFacts}
        onApproving={(submission) =>
          holds.apply({
            type: "held",
            send: { address: shown.address, at: Date.now(), submission },
          })
        }
        onNotApproved={(submission) =>
          // Its hold can land after the refusal; nothing was sent, so it goes.
          void bestEffort("unknown", holds.apply({ type: "cleared", only: { submission } }))
        }
        onSendUnresolved={() => {
          // The hold was saved before the approval; this page holds even if it is gone now.
          steps.held({ id: "send", address: shown.address, at: Date.now() })
          steps.shut("fund")
          // That address may already hold the transfer; it is never offered again.
          dropAddress()
        }}
      />
    )
  /** A sent deposit's status, or its detail once it needs recovery. */
  const sentSheet = (record: SipaDeposit, onDone: () => void) =>
    SENT_ENDED.includes(record.phase) ? (
      <DepositDetailModal record={record} onClose={onDone} />
    ) : (
      <Modal
        variant="bare"
        label={sentStatusCopy.label}
        className={`ww-deposit-warning ww-deposit-sheet ww-bridge-sheet ${depositSentStatusSheet}`}
        onClose={onDone}
      >
        <div className="ww-deposit-warning__close">
          <CornerButton kind="close" label={sendCopy.arrived.close} onClick={onDone} />
        </div>
        <DepositSentStatus
          record={record}
          tokens={tokens}
          l1ChainId={l1ChainId}
          l1ChainName={chainName}
          minutes={arrivalMinutes}
          onClose={onDone}
        />
      </Modal>
    )
  const otherSheets = (
    <>
      {arrivedShown && (
        <DepositDetailModal
          record={arrivedShown}
          onClose={() => {
            steps.arrivalClosed(arrivedShown.sipaAddress)
            void clearHold({ address: arrivedShown.sipaAddress })
          }}
        />
      )}
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={limitsDetails}
          capacity={sourceFromTarget(capacity)}
          settlementSymbol={settlement.symbol}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </>
  )
  const sheets = (
    <>
      {sheetOpen && addressSheet()}
      {fundSheet()}
      {sentRecord &&
        (target ? (
          <DepositDetailModal
            record={sentRecord}
            onClose={() => {
              steps.shut("sent")
              // A registration's deposit is in flight: asking for it again risks a second payment.
              if (onClose) onClose()
              else navigate("/")
            }}
          />
        ) : (
          sentSheet(sentRecord, () => steps.shut("sent"))
        ))}
      {otherSheets}
    </>
  )

  const symbols = listed(coins.map((coin) => coin.symbol))
  const flowStep = !sheetOpen && !fundOpen && !sentRecord && !arrivedShown ? flow : "closed"
  const bridgeSheet = (flow?: InFlow & { nav: DepositFlowNav }) =>
    bridging &&
    bridge &&
    bridgeIn && (
      <BridgeInModal
        bridge={bridge}
        depositMinutes={arrivalMinutes}
        account={l1.account}
        l1={l1}
        walletName={l1.walletName ?? sendCopy.walletFallback}
        walletLabel={savedName}
        handle={handle}
        l1ChainId={l1ChainId}
        l1ChainName={chainName}
        coins={coins}
        carried={carried}
        onCarry={steps.carry}
        recipient={bridgeRecipient}
        start={opening?.bridge}
        onSent={dropAddress}
        onRetry={() => {
          steps.shut("bridge")
          if (flow) flow.nav.restart()
          else steps.pick("coin")
        }}
        origin={flow?.nav.origin}
        onEthereum={() => {
          steps.shut("bridge")
          if (flow) flow.nav.restart()
          else beginFunding()
        }}
        onChangeOrigin={flow?.nav.change}
        onChangeWallet={flow?.nav.changeWallet}
        onBack={flow?.onBack}
        onClose={flow?.onClose ?? (() => steps.shut("bridge"))}
      />
    )
  const switchSheet = (flow?: InFlow) =>
    switching &&
    l1.account && (
      <SwitchAccountModal
        walletName={l1.walletName ?? switching.saved.name ?? sendCopy.walletFallback}
        saved={switching.saved.address}
        connected={l1.account}
        onUseConnected={() => {
          steps.dropAccount()
          if (switching.kind === "fund") beginFunding()
          else steps.open({ kind: "bridge" })
        }}
        onBack={flow?.onBack}
        onClose={flow?.onClose ?? (() => steps.dropAccount())}
      />
    )
  const flowModals = (
    <>
      {bridgeSheet()}
      {switchSheet()}
      {flowStep === "privacy" && (
        <DepositPrivacyDisclaimer
          rows={
            <>
              {feeRow}
              {minimumRow}
              {limitRow(false)}
            </>
          }
          onContinue={() => steps.pick("coin")}
          onClose={closeFlow}
        />
      )}
      {flowStep === "coin" && (
        <DepositCoinModal
          title={owed ? depositCopy.titleActivate : depositCopy.title}
          subtitle={owed ? undefined : fmt(depositCopy.coinSubtitle, { chain: chainName })}
          coins={coins}
          coinName={coinName}
          token={token}
          onPick={setToken}
          rows={
            owed && (
              <>
                {feeRow}
                {minimumRow}
              </>
            )
          }
          note={
            !owed && (
              <>
                {fmt(depositCopy.coinNote.only, { symbols, chain: chainName })}
                {canBridge && (
                  <>
                    {" "}
                    {fmtNodes(depositCopy.coinNote.otherChain, {
                      link: (
                        <button
                          type="button"
                          className="zkm-btn-reset ww-deposit__link"
                          onClick={() => {
                            steps.pick("closed")
                            beginBridge()
                          }}
                        >
                          {depositCopy.coinNote.bridgeIn}
                        </button>
                      ),
                    })}
                  </>
                )}
              </>
            )
          }
          footer={
            canBridge && (
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__link"
                data-testid="deposit-bridge-link"
                onClick={() => {
                  steps.pick("closed")
                  beginBridge()
                }}
              >
                {depositCopy.coinNote.bridgeInWallet}
              </button>
            )
          }
          status={claimingBlock || holdBlock || undefined}
          canContinue={shownCoin && offering && !(busy && !shown)}
          onContinue={() => openSheet(token)}
          onClose={closeFlow}
        />
      )}
    </>
  )

  if (onClose)
    return (
      <>
        {flowModals}
        {sheets}
      </>
    )

  const closeEntry = steps.close
  const closeSent = () => {
    closeEntry()
    // A registration's deposit is in flight: asking for it again risks a second payment.
    if (target) navigate("/")
  }
  /** The sheet the deposit modal shows over its own steps, latest first. */
  const entrySheet = (nav: DepositFlowNav): DepositFlowSheet | undefined => {
    const inFlow = (onBack: () => void) => ({ onBack, onClose: closeEntry })
    const onL1 = (next: DepositOrigin) => next.chainId === l1ChainId
    const closeAddress = () => steps.shut("address")
    const top = selectEntrySheet(screen, l1)
    switch (top?.kind) {
      case "sent":
        return sentRecord && { key: "sent", node: sentSheet(sentRecord, closeSent) }
      case "switch":
        // Over the fund or bridge sheet it was asked from.
        return { key: "switch", node: switchSheet(inFlow(steps.dropAccount)) }
      case "fund": {
        const node = fundSheet({
          ...inFlow(() => steps.shut("fund")),
          onChange: nav.change,
          onChangeWallet: nav.changeWallet,
        })
        return node
          ? {
              key: "fund",
              node,
              // The flow already picked the L1 coin the sheet sends.
              onOrigin: (next) => {
                if (onL1(next)) return "kept"
                // Another chain bridges in from the same wallet.
                if (!l1.account || !bridge || !bridgeIn) {
                  steps.shut("fund")
                  return "closed"
                }
                steps.open({ kind: "bridge" })
                return "kept"
              },
            }
          : undefined
      }
      case "address":
        return {
          key: "address",
          node: addressSheet(inFlow(closeAddress)),
          onOrigin: (next) => {
            const coin = onL1(next) && coins.find((c) => c.symbol === next.symbol)
            if (coin) {
              openSheet(coin)
              return "kept"
            }
            closeAddress()
            return "closed"
          },
        }
      case "bridge": {
        const node = bridgeSheet({ ...inFlow(() => steps.shut("bridge")), nav })
        return node
          ? {
              key: "bridge",
              node,
              // The sheet follows a bridged origin itself.
              onOrigin: (next) => {
                if (!onL1(next)) return "kept"
                // Ethereum sends from the same wallet to the address already made for it.
                if (!offering || !shown || fee == null || (claiming && !target)) {
                  steps.shut("bridge")
                  return "closed"
                }
                steps.open({ kind: "fund" })
                return "kept"
              },
            }
          : undefined
      }
    }
    return undefined
  }

  const isConnected = (address: string) => address.toLowerCase() === l1.account?.toLowerCase()

  if (!owed)
    return (
      <div className="ww-move-landing">
        <h1>{depositCopy.landing.title}</h1>
        {claimingBlock || holdBlock || (
          <section className="ww-move-landing__wallets">
            <div className="ww-move-landing__intro">
              <div className="ww-method-banners">
                {bridgeChains.length > 0 && (
                  <MethodOption
                    glow="blue"
                    title={depositCopy.landing.bridgeTitle}
                    body={depositCopy.landing.bridgeBody}
                    testId="deposit-bridge-in"
                    onOpen={() => steps.entry({ intent: "bridge" })}
                  >
                    <span className="ww-deposit-banner__icons">
                      <ChainStack
                        chains={[{ chainId: l1ChainId, name: chainName }, ...bridgeChains]}
                        size={26}
                        label={fmt(depositCopy.landing.networks, {
                          count: bridgeChains.length + 1,
                        })}
                      />
                    </span>
                  </MethodOption>
                )}
                <MethodOption
                  glow="purple"
                  title={depositCopy.landing.addressTitle}
                  body={fmt(depositCopy.landing.addressBody, { chain: chainName })}
                  testId="deposit-show-address"
                  onOpen={() => steps.entry({ intent: "address" })}
                >
                  <span className="ww-deposit-banner__icons">
                    <IconStack>
                      <ChainIcon chainId={l1ChainId} name={chainName} size={26} />
                    </IconStack>
                    {depositCopy.landing.moreSoon}
                  </span>
                </MethodOption>
              </div>
            </div>
            <span className="ww-move-landing__wallets-head">
              {depositCopy.landing.savedWallets}
            </span>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-move-landing__new ww-move-landing__new--wallet"
              data-testid="deposit-new-address"
              onClick={connectThenPick}
            >
              <span className="ww-move-landing__plus">
                <Icon name="wallet" size={20} color="#fff" />
              </span>
              <span>
                <b>{depositCopy.landing.connect}</b>
                {!bridgeMode && <small>{depositCopy.landing.bridgeFrom}</small>}
              </span>
              <RowChevron />
            </button>
            {!bridgeMode && savedWallets.length > 0 && (
              <div className="ww-move-landing__list">
                {savedWallets.map((wallet) => (
                  <ContactRow
                    key={wallet.address}
                    name={wallet.name}
                    tag={shortL1Addr(wallet.address)}
                    isL1
                    trailing={isConnected(wallet.address) ? <ConnectedTrailing /> : undefined}
                    onClick={() => steps.entry({ intent: "wallet", saved: wallet })}
                  />
                ))}
              </div>
            )}
          </section>
        )}
        {entry && (
          <DepositFlow
            l1ChainId={l1ChainId}
            chainName={chainName}
            coins={coins}
            token={token}
            onPickToken={setToken}
            routes={canBridge && bridge ? bridgeRoutes(bridge, coins) : []}
            steps={opening?.steps}
            startChainId={opening?.origin?.chainId}
            startSymbol={opening?.origin?.symbol}
            saved={entry.saved}
            wallet={
              l1.account
                ? {
                    name: savedName ?? l1.walletName ?? sendCopy.walletFallback,
                    address: shortL1Addr(l1.account),
                  }
                : undefined
            }
            // The wallet's chain, once the account the flow sends from is the connected one.
            walletChainId={
              l1.account &&
              (!entry.saved || entry.saved.address.toLowerCase() === l1.account.toLowerCase())
                ? l1.chainId ?? undefined
                : undefined
            }
            intent={entry.intent}
            fundReady={fee != null && !(claiming && !target)}
            addressReady={!(busy && !shown)}
            status={claimingBlock || holdBlock || undefined}
            privacyRows={
              <>
                {feeRow}
                {minimumRow}
                {limitRow(false)}
              </>
            }
            onAddress={() => openSheet(token)}
            onWallet={beginWallet}
            sheet={entrySheet}
            walletPicker={
              bridgeMode
                ? undefined
                : (done) => (
                    <ChangeWalletPicker
                      l1={l1}
                      saved={savedWallets}
                      onSaved={(saved) => {
                        done()
                        if (permittedAccount(l1.accounts, saved.address))
                          return void pickAccount(l1, saved.address)
                        // An account of another wallet connects that wallet first.
                        const inWallet = !!l1.account && savedInWallet(saved.entry, l1.walletName)
                        if (inWallet) void l1.switchAccount(saved.address)
                        else l1.connectAnother()
                        steps.awaitAccount({ kind: fundOpen ? "fund" : "bridge", saved })
                      }}
                      onPicked={done}
                    />
                  )
            }
            onClose={closeEntry}
          />
        )}
        {otherSheets}
      </div>
    )

  return (
    <div className="ww-panel ww-deposit">
      <div className={`ww-deposit__stealth ${styles.top}`}>
        <GradientText size={24} weight={700}>
          {depositCopy.title}
        </GradientText>

        {claimingBlock || holdBlock || (
          <>
            <div className="ww-deposit__fields">
              {owed && (
                <div className={styles.tag} data-testid="deposit-tag-row">
                  <span>{depositCopy.yourName}</span>
                  <b>@{handle}</b>
                  {tagConfirmed ? (
                    <Icon name="lock" size={14} color="var(--text-secondary)" />
                  ) : (
                    <button
                      type="button"
                      className="zkm-btn-reset ww-deposit__link"
                      onClick={() => setChoosingName(true)}
                    >
                      {depositCopy.chooseOwn}
                    </button>
                  )}
                </div>
              )}
              {owed && !tagConfirmed && registration && (
                <div className={styles.confirm} data-testid="deposit-confirm-tag">
                  <p>{fmt(depositCopy.keepOrChoose, { tag: handle ?? "" })}</p>
                  <PrimaryGradientButton
                    title={fmt(depositCopy.keep, { tag: String(handle) })}
                    onClick={() => session.confirmTag(registration)}
                  />
                </div>
              )}
              {owed && <RegistrationAskLine />}
              {(!owed || tagConfirmed) && (
                <>
                  <p className={styles.label}>{depositCopy.whichToken}</p>
                  <div className={styles.coins}>
                    {coins.map((t) => (
                      <button
                        key={t.symbol}
                        type="button"
                        className="zkm-btn-reset ww-deposit__coin"
                        data-testid={`deposit-coin-${t.symbol}`}
                        disabled={!offering || (busy && !shown)}
                        onClick={() => openSheet(t)}
                      >
                        <CoinIcon token={t} />
                        <span className="ww-deposit__coin-name">
                          {t.symbol}
                          <small>{coinName(t)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className={styles.network}>
                    <span>
                      {depositCopy.network}
                      <Icon name="lock" size={14} />
                    </span>
                    <b>{chainName}</b>
                  </div>
                </>
              )}
            </div>
            <section className="ww-deposit__info">
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__info-head"
                aria-expanded={infoOpen}
                onClick={() => setInfoOpen((o) => !o)}
              >
                {depositCopy.info.head}
                <Icon name={infoOpen ? "chevron-up" : "chevron-down"} size={16} />
              </button>
              {infoOpen && <OneTimeAddressPoints points={DEPOSIT_INFO_POINTS} />}
            </section>
            {connectLink}
          </>
        )}
      </div>

      {sheets}
      {choosingName && handle && (
        <ChooseNameSheet tag={handle} claim={claimName} onClose={() => setChoosingName(false)} />
      )}
    </div>
  )
}
