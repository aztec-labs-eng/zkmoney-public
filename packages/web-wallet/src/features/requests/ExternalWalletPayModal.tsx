/**
 * The external-wallet leg of an accountless request payment, in the deposit flow: the network and
 * coin, then the payee's address or a connected wallet, on Ethereum or bridged in from another chain. The payer never touches a zk.money account, so this leg is public on
 * Ethereum and the chain is the only feedback channel.
 *
 * The address and its EIP-681 URI arrive pre-resolved from the landing. Only the manifest token is
 * offered: the quoted fee and the URI's amount are both in its units, so any other token would need
 * its own fee read and URI.
 */
import { useState, type ReactNode } from "react"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { formatUnits, type Address } from "viem"
import {
  addressShareDecision,
  bestEffort,
  depositTokenValuation,
  fixedAmountLimits,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
  useStore,
  type AddressRoute,
  type RequestInlinePacket,
  type RequiredCredit,
  valueOf,
} from "@obsidion/front-core"
import { Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { Modal } from "../../ui/Modal"
import { usdBalance, shortL1Addr, tokenFigure } from "../../ui/format"
import { useCopy } from "../../ui/hooks"
import { useScreenFlow } from "../../ui/useScreenFlow"
import { DepositFromWalletModal } from "../deposit/DepositFromWalletModal/DepositFromWalletModal"
import { ChangeWalletPicker } from "../deposit/ChangeWalletPicker/ChangeWalletPicker"
import { DepositQrSheet } from "../deposit/DepositQrSheet"
import { useL1Wallet } from "../../session/useL1Wallet"
import { useSession } from "../../session/session"
import { BridgeInModal } from "../deposit/BridgeInModal/BridgeInModal"
import { bridgeRoutes } from "../deposit/bridgeChains"
import { profileBridge } from "../../session/walletChains"
import {
  DepositFlow,
  type DepositFlowNav,
  type DepositFlowSheet,
  type DepositOrigin,
} from "../deposit/DepositFlow/DepositFlow"
import {
  settlementToken,
  useDepositTokens,
  type DepositTokenOption,
} from "../sipa/loadDepositFacts"
import testIcon from "../../assets/deposit/ethereum.webp"
import {
  OneTimeAddressPoints,
  oneTimeAddressPoints,
  OneTimeAddressWarning,
} from "../deposit/OneTimeAddressWarning"
import { AddressLimits, AddressLimitsDetail, tokenAmountLabel } from "../deposit/AddressLimits"
import { AddressCapacityPanel, capacityShareWarning } from "../deposit/AddressCapacity"
import { ADDRESS_RECHECK_NOTE } from "../limits/limitsCopy"
import { WalletAboutLimitsSheet } from "../limits/AboutLimitsSheet"
import { sourceFromTarget } from "../limits/capacitySources"
import type { LimitsTopic } from "../limits/aboutLimitsView"
import {
  capacityHold,
  targetEligibility,
  useTargetCapacity,
  type CapacityTarget,
} from "../deposit/targetCapacity"
import { fundingCapacityView } from "../deposit/fundingCapacity"
import { formatPublicLimit } from "../limits/publicLimit"
import type { AccountlessResolveResult } from "./accountlessRequest"
import { requestAmountDisplay } from "./requestLink"
import { clearPayment, holdPayment, paymentHeld } from "./unresolvedPayment"
import { bridgePaymentHold } from "./bridgePaymentHold"
import { useRowTxAmountCap } from "../token/useTxAmountCap"
import type { PayStart } from "./payStart"
import { openPayFlow } from "./payFlow"
import { payFixedAmounts } from "./payTransition"
import payCopy from "./ExternalWalletPayModal.copy"
import chainsCopy from "../../ui/chains.copy"
import { fmt } from "../../lib/fmt"

/** Why a fixed request cannot be paid. It never suggests more transfers to the same address. */
const OVER_LIMIT_COPY = {
  public: `Over the ${formatPublicLimit()} limit. Ask the requester for a new request with a smaller amount.`,
  protocol:
    "Over the network's maximum per deposit. Ask the requester for a new request with a smaller amount.",
  // The capacity line says why; this says what it holds.
  capacity: "Copy and scan are paused until this payment fits current capacity.",
  ceiling: "Ask the requester for a new request with a smaller amount.",
}

export function ExternalWalletPayModal({
  packet,
  result,
  onClose,
  onFeeChanged,
  onPaid,
  start,
}: {
  packet: RequestInlinePacket
  result: AccountlessResolveResult
  onClose: () => void
  /** The deposit fee moved under a send; the caller quotes again. */
  onFeeChanged: () => void
  /** The payment confirmed on Ethereum. */
  onPaid?: () => void
  /** Where the sheets open on their first showing. */
  start?: PayStart
}) {
  const depositTokens = useDepositTokens()
  // The request names the token it is paid in: the cap and bucket of the row that token settles on apply.
  const rowToken = settlementToken(depositTokens, result.token) ?? result.token
  const txAmountCap = useRowTxAmountCap(rowToken)
  const { page } = useSession()
  const { config } = page
  const { copied, copy } = useCopy()
  const [qr, setQr] = useState(false)
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  // Copy or Show QR waiting on the capacity warning.
  const [warning, setWarning] = useState<"copy" | "qr">()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  // Desktop launcher: no wallet extension, the transfer is approved in the default browser.
  const bridgeMode = isDesktopL1SubmitActive()
  const canFund = bridgeMode || !!l1.account
  // The typed amount, kept while the wallet picker covers the sheet.
  const payee = result.sipaAddress as Address
  const bridge = profileBridge(config)
  const bridgeIn = valueOf(page.bridgeInProvider) ?? undefined
  // A payment from this browser that nothing here can show settled: paying again could pay twice.
  const { database, device, bridgeIns } = useSession()
  const deviceHeld = useStore(device, (state) => paymentHeld(state, config.network, payee))
  // A bridge payment holds from its saved record: the tab may close before its hash comes back.
  const bridgeHeld = useStore(bridgeIns.list, ({ records }) => bridgePaymentHold(records, payee))
  // The bridge payment the payer chose to pay again over.
  const [payingAgain, setPayingAgain] = useState<string>()
  const held = deviceHeld || (bridgeHeld !== undefined && bridgeHeld !== payingAgain)
  const [infoOpen, setInfoOpen] = useState(false)

  const listed = depositTokens?.offered.find(
    (t) => !t.swapped && t.address.toLowerCase() === result.token.toLowerCase(),
  )
  const token: DepositTokenOption = listed ?? {
    address: result.token,
    symbol: packet.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
    decimals: result.decimals,
    icon: testIcon,
    settlesIn: result.token,
    swapped: false,
  }
  // The token's own decimals; the resolve refuses a link that declares others.
  const decimals = result.decimals
  const amountDisplay = requestAmountDisplay(packet)
  const fee = formatUnits(result.feeAtomic, decimals)
  // A fixed-amount request is paid gross, and the sheet shows that total as the amount.
  const total = packet.amountAtomic > 0n ? formatUnits(result.grossAtomic, decimals) : undefined
  // The link pins the payee's address, so the "changes every time" point is a deposit-screen fact.
  const points = oneTimeAddressPoints(token.symbol).filter((p) => p.id !== "rotates")
  const route: AddressRoute =
    packet.amountAtomic > 0n
      ? {
          kind: "fixed-request",
          decimals,
          requestedAtomic: packet.amountAtomic,
          feeAtomic: result.feeAtomic,
          txAmountCap,
        }
      : { kind: "open-request", decimals, feeAtomic: result.feeAtomic, txAmountCap }
  const valuation = depositTokenValuation({
    accepted: depositTokens?.offered.map((t) => t.address) ?? [],
    token: result.token,
  })
  const fixed = packet.amountAtomic > 0n
  const payTitle = fixed
    ? fmt(payCopy.payFixed, {
        amount: tokenFigure(amountDisplay, token.symbol),
        tag: packet.requesterTag,
      })
    : fmt(payCopy.payOpen, { tag: packet.requesterTag })
  const maxSend = maximumSendAtomic(route, valuation)
  const expired = result.deployment === "expired"
  const target: CapacityTarget =
    result.deployment === "active" ? { kind: "active", token: rowToken } : { kind: "unproven" }
  const capacity = useTargetCapacity(target)
  const required: RequiredCredit =
    fixed && capacity.store
      ? {
          status: "known",
          atomic: packet.amountAtomic,
          token: capacity.store.key.token,
          decimals,
        }
      : { status: "unknown" }
  const eligibility = targetEligibility(capacity, required)
  const capacityView = fundingCapacityView({
    eligibility,
    mode: fixed ? "fixed" : "address",
    symbol: token.symbol,
    sentSymbol: token.symbol,
    exactCredit: true,
  })
  const share = addressShareDecision(eligibility, fixed)
  const capacityWarning = capacityShareWarning(share)
  const fitsNow =
    !fixed && eligibility.kind === "amount-unknown" && !eligibility.zero
      ? maximumSendForCapacity(route, eligibility.snapshot.availableAtomic, valuation)
      : undefined
  const fitsLabel =
    fitsNow !== undefined && maxSend !== undefined && fitsNow < maxSend
      ? tokenAmountLabel(fitsNow, decimals, token.symbol)
      : undefined
  const capacityDetail = fitsLabel && `To fit current capacity, send at most ${fitsLabel}.`
  // The address stays on screen, but nothing offers to pay an amount the limits or known capacity
  // refuse. The amount is never changed to fit.
  const over = fixedAmountLimits(route, valuation)?.over ?? capacityHold(eligibility)
  const flow = useScreenFlow(
    {
      over: !!over,
      canFund,
      connected: !!l1.account,
      openPicker: l1.openPicker,
      pickerShown: l1.pickerShown,
    },
    (latest) => openPayFlow({ l1Wallet: page.l1Wallet, start }, latest),
  )
  const pay = useStore(flow.state)
  const { opening, sent } = pay
  const unresolved = held || pay.unresolved
  const close = () => {
    flow.dispatch({ type: "ended" })
    onClose()
  }
  const limits = (
    <>
      <AddressLimits onInfo={() => setAboutLimits("limit")} />
      <AddressCapacityPanel
        view={capacityView}
        onRetry={capacity.retry}
        detail={capacityDetail}
        onAboutLimits={() => setAboutLimits("capacity")}
      />
    </>
  )
  const limitsDetails = {
    limit: (
      <AddressLimitsDetail
        symbol={token.symbol}
        decimals={decimals}
        maxSendAtomic={maxSend}
        maxCreditAtomic={maximumCreditAtomic(route, valuation)}
      />
    ),
    capacity: <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p>,
  }
  // Every share is checked when it happens: a reading can change while a sheet or warning is open.
  const copyAddress = () => {
    if (over) return
    if (capacityWarning) setWarning("copy")
    else void copy(result.sipaAddress)
  }
  const showQr = () => {
    if (over) return
    if (capacityWarning) setWarning("qr")
    else setQr(true)
  }
  // A payment that becomes known not to fit is no longer offered: its QR and warning close.
  if (over && (qr || warning !== undefined)) {
    setQr(false)
    setWarning(undefined)
  }

  const l1ChainId = config.l1ChainId
  const onL1 = (next: DepositOrigin) => next.chainId === l1ChainId
  // Another chain bridges in what lands as the request's token; a fixed amount is paid on the L1.
  const routes = bridge && bridgeIn && !bridgeMode && !fixed ? bridgeRoutes(bridge, [token]) : []

  const summary = (
    <div className="ww-paylink-summary">
      <span className="ww-paylink-summary__label">Pay @{packet.requesterTag}</span>
      <span
        className={`ww-paylink-summary__amount${
          amountDisplay ? "" : " ww-paylink-summary__amount--open"
        }`}
      >
        {total ? usdBalance(total) : amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
      </span>
      {total && (
        <span className="ww-paylink-summary__note" data-testid="request-fee">
          Includes a {tokenFigure(fee, token.symbol)} deposit fee
        </span>
      )}
      {packet.note && <span className="ww-paylink-summary__note">{packet.note}</span>}
    </div>
  )

  // Why nothing more can be paid here; it replaces the first step's fields.
  const status: ReactNode = expired ? (
    <p className="ww-limit-reason" role="alert" data-testid="request-expired">
      This link has expired. Ask @{packet.requesterTag} for a new one.
    </p>
  ) : sent ? (
    <p className="ww-deposit__note" role="status" data-testid="request-sent">
      Payment sent. @{packet.requesterTag} receives it once Ethereum confirms it.
    </p>
  ) : unresolved ? (
    <div className="ww-deposit__stealth" data-testid="request-unresolved">
      <p className="ww-limit-reason" role="status">
        A payment to this address may already be on its way. Check your wallet&apos;s activity
        before you pay again.
      </p>
      <PrimaryGradientButton
        title={payCopy.payAgain}
        buttonStyle="dark"
        onClick={() => {
          void bestEffort("unknown", clearPayment(database, config.network, payee))
          setPayingAgain(bridgeHeld)
          flow.dispatch({ type: "again" })
        }}
      />
    </div>
  ) : undefined

  const addressSheet = (nav: DepositFlowNav) => (
    <Modal
      variant="bare"
      label={payCopy.payWithWallet}
      className="ww-deposit-warning ww-deposit-sheet ww-reqpay"
      onClose={close}
    >
      <div className="ww-deposit-warning__back">
        <TopNavIconButton
          icon="chevron-left"
          ariaLabel="Back"
          onClick={() => flow.dispatch({ type: "closed" })}
        />
      </div>
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
      </div>
      {nav.crumb(false)}
      {summary}
      <div className="ww-deposit__stealth">
        <div className="ww-deposit__fields">
          {!total && (
            <div className="ww-deposit__facts">
              <div className="ww-deposit__fact">
                <span>{payCopy.fee}</span>
                <b>{tokenFigure(fee, token.symbol)}</b>
              </div>
            </div>
          )}
          <div className="ww-deposit__input">
            <span>{payCopy.payTo}</span>
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__addr"
              disabled={!!over}
              onClick={copyAddress}
              title={result.sipaAddress}
            >
              {shortL1Addr(result.sipaAddress)}
              <Icon name={copied ? "check" : "copy"} size={16} />
            </button>
          </div>
          {limits}
        </div>

        <div className="ww-deposit__actions">
          <button
            type="button"
            className={`zkm-btn-reset ww-deposit__btn${over ? "" : " zkm-pressable"}`}
            disabled={!!over}
            onClick={showQr}
          >
            Show <Icon name="qr-code" size={24} />
          </button>
          <button
            type="button"
            className={`zkm-btn-reset ww-deposit__btn${over ? "" : " zkm-pressable"}`}
            disabled={!!over}
            onClick={copyAddress}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        {over ? (
          <p className="ww-limit-reason" role="alert" data-testid="request-over-limit">
            {OVER_LIMIT_COPY[over]}
          </p>
        ) : !total ? (
          <p className="ww-deposit__note">
            Send more than {tokenFigure(fee, token.symbol)}. That much is kept as the deposit fee.
            Anything at or below it is lost.
          </p>
        ) : (
          result.feeAtomic >= packet.amountAtomic && (
            <p className="ww-deposit__note">{payCopy.feeExceeds}</p>
          )
        )}
      </div>

      <section className="ww-deposit__info">
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__info-head"
          aria-expanded={infoOpen}
          onClick={() => setInfoOpen((o) => !o)}
        >
          Important information
          <Icon name={infoOpen ? "chevron-up" : "chevron-down"} size={16} />
        </button>
        {infoOpen && <OneTimeAddressPoints points={points} />}
      </section>
    </Modal>
  )

  /** The sheet the flow shows over its own steps. A sheet left for another network closes, and the
   *  flow opens that network's wallet. */
  const paySheet = (nav: DepositFlowNav): DepositFlowSheet | undefined => {
    const fixedAmounts = payFixedAmounts(packet, result)
    const onOrigin = (next: DepositOrigin) => flow.origin(onL1(next))
    if (pay.sheet === "fund")
      return {
        key: "fund",
        node: (
          <DepositFromWalletModal
            l1={l1}
            deposit={{ address: payee, name: packet.requesterTag }}
            token={token}
            fee={fee}
            valuation={valuation}
            payee={packet.requesterTag}
            fixedAmount={fixedAmounts && formatUnits(fixedAmounts.send, decimals)}
            onChangeOrigin={fixed ? undefined : nav.change}
            onChangeWallet={nav.changeWallet}
            onBack={() => flow.dispatch({ type: "closed" })}
            onClose={close}
            // The hold saved before the send stays until the payer chooses to pay again.
            onSent={() => flow.dispatch({ type: "sent" })}
            onSendFailed={() => flow.dispatch({ type: "sendFailed" })}
            onSendUnresolved={() => flow.dispatch({ type: "sendUnresolved" })}
            onApproving={(submission) => holdPayment(database, config.network, payee, submission)}
            onNotApproved={(submission) =>
              void bestEffort("unknown", clearPayment(database, config.network, payee, submission))
            }
            onFeeChanged={onFeeChanged}
            onConfirmed={onPaid}
          />
        ),
        onOrigin,
      }
    if (pay.sheet === "bridge" && bridge && bridgeIn)
      return {
        key: "bridge",
        node: (
          <BridgeInModal
            bridge={bridge}
            account={l1.account}
            l1={l1}
            walletName={l1.walletName ?? payCopy.wallet}
            toLabel={packet.requesterTag}
            requestId={packet.requestId}
            title={payTitle}
            fixedAmount={fixedAmounts && formatUnits(fixedAmounts.bridge, decimals)}
            l1ChainId={l1ChainId}
            l1ChainName={chainsCopy.ethereum}
            coins={[token]}
            recipient={async () => payee}
            start={opening?.bridge}
            onSent={(originTxHash) => {
              // Kept until the payer chooses to pay again: the bridge may still be filling.
              void bestEffort("unknown", holdPayment(database, config.network, payee, originTxHash))
              flow.dispatch({ type: "sent" })
            }}
            origin={nav.origin}
            onEthereum={() => {
              flow.dispatch({ type: "closed", ended: true })
              nav.restart()
            }}
            onRetry={() => {
              // A bridge that ended short leaves the payment held: the payer chooses to pay again.
              flow.dispatch({ type: "retry" })
              nav.restart()
            }}
            onChangeOrigin={nav.change}
            onChangeWallet={nav.changeWallet}
            onBack={() => flow.dispatch({ type: "closed", ended: true })}
            onClose={close}
          />
        ),
        onOrigin,
      }
    if (pay.sheet === "address" && !status)
      return { key: "address", node: addressSheet(nav), onOrigin }
    return undefined
  }

  return (
    <>
      <DepositFlow
        l1ChainId={l1ChainId}
        chainName={chainsCopy.ethereum}
        // The quoted fee and the URI's amount are in the request's token: Ethereum offers only it.
        coins={[token]}
        token={token}
        onPickToken={() => {}}
        routes={routes}
        startChainId={opening?.origin?.chainId}
        startSymbol={opening?.origin?.symbol}
        originLocked={fixed}
        intro={{
          heading: summary,
          l1Note: fmt(payCopy.l1Note, { symbol: token.symbol, tag: packet.requesterTag }),
        }}
        labels={{
          from: payCopy.payFrom,
          address: payCopy.paymentAddress,
          walletBlocked: over ? OVER_LIMIT_COPY[over] : undefined,
        }}
        fundReady={!over}
        bridgeReady={!over}
        addressReady
        status={status}
        onAddress={() => flow.dispatch({ type: "open", sheet: "address" })}
        onWallet={(kind) => void flow.pay(kind === "fund" ? "fund" : "bridge")}
        sheet={paySheet}
        walletPicker={(done) => <ChangeWalletPicker l1={l1} onPicked={done} />}
        onClose={close}
      />

      {qr && !expired && (
        <DepositQrSheet
          title="Payment address"
          address={result.sipaAddress}
          paymentUri={result.paymentUri}
          copied={copied}
          limits={limits}
          onCopy={copyAddress}
          onClose={() => setQr(false)}
        />
      )}

      {warning && (
        <OneTimeAddressWarning
          capacityWarning={capacityWarning}
          onClose={() => setWarning(undefined)}
          onGotIt={() => {
            setWarning(undefined)
            if (over) return
            if (warning === "qr") setQr(true)
            else void copy(result.sipaAddress)
          }}
        />
      )}
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={limitsDetails}
          capacity={sourceFromTarget(capacity)}
          settlementSymbol={token.symbol}
          // The request page sits outside the account context; a visitor may have no account.
          account={false}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </>
  )
}
