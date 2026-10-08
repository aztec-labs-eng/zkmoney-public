import { Modal } from "../../ui/Modal"
/**
 * The external-wallet leg of an accountless request payment: what to send, where to send it, and
 * the L1 connect entry. The payer never touches a zk.money account, so this leg is public on
 * Ethereum and the chain is the only feedback channel.
 *
 * The address and its EIP-681 URI arrive pre-resolved from the landing. Only the manifest token is
 * offered: the quoted fee and the URI's amount are both in its units, so any other token would need
 * its own fee read and URI.
 */
import { useEffect, useState } from "react"
import { formatUnits } from "viem"
import {
  addressShareDecision,
  depositTokenValuation,
  fixedAmountLimits,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
  type AddressRoute,
  type RequestInlinePacket,
  type RequiredCredit,
} from "@obsidion/front-core"
import { GradientText, Icon, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { shortAddr, usdBalance, usdFigure } from "../../ui/format"
import { useCopy } from "../../ui/hooks"
import { DepositQrSheet } from "../deposit/DepositQrSheet"
import { depositTokensFor } from "../deposit/loadDepositFacts"
import {
  OneTimeAddressPoints,
  oneTimeAddressPoints,
  OneTimeAddressWarning,
} from "../deposit/OneTimeAddressWarning"
import { AddressLimits, AddressLimitsDetail, tokenAmountLabel } from "../deposit/AddressLimits"
import {
  ADDRESS_RECHECK_NOTE,
  AddressCapacityPanel,
  capacityShareWarning,
} from "../deposit/AddressCapacity"
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
import ethIcon from "../../assets/deposit/ethereum.webp"

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
}: {
  packet: RequestInlinePacket
  result: AccountlessResolveResult
  onClose: () => void
}) {
  const config = getConfig()
  const { copied, copy } = useCopy()
  const [qr, setQr] = useState(false)
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  // Copy or Show QR waiting on the capacity warning.
  const [warning, setWarning] = useState<"copy" | "qr">()

  const token = depositTokensFor(config.network)[0]
  // The token's own decimals; the resolve refuses a link that declares others.
  const decimals = result.decimals
  const amountDisplay = requestAmountDisplay(packet)
  const fee = formatUnits(result.feeAtomic, decimals)
  // Fixed-amount requests are paid gross: what the requester asked for plus the deposit fee.
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
        }
      : { kind: "open-request", decimals, feeAtomic: result.feeAtomic }
  const valuation = depositTokenValuation({
    chainId: config.l1ChainId,
    portalToken: result.token,
    token: result.token,
  })
  const fixed = packet.amountAtomic > 0n
  const maxSend = maximumSendAtomic(route, valuation)
  // A link carries the payee's address but nothing that proves its portal, so its capacity is not
  // known. An address resolved from the active deployment just now uses the active bucket.
  const target: CapacityTarget = packet.sipaAddress ? { kind: "unproven" } : { kind: "active" }
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
  useEffect(() => {
    if (!over) return
    setQr(false)
    setWarning(undefined)
  }, [over])

  return (
    <>
      <Modal variant="bare" label="Pay with an Ethereum wallet" className="ww-deposit-warning ww-reqpay" onClose={onClose}>
        <div className="ww-deposit-warning__close">
          <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
        </div>
        <span className="ww-deposit__connect-icon ww-deposit-warning__icon">
          <Icon name="coins" size={32} color="#fff" />
        </span>
        <GradientText size={24} weight={700}>
          Pay with an Ethereum wallet
        </GradientText>

        <div className="ww-paylink-summary">
          <span className="ww-paylink-summary__label">Someone requested</span>
          <span className="ww-paylink-summary__amount">
            {amountDisplay ? usdBalance(amountDisplay) : "Any amount"}
          </span>
          {packet.note && <span className="ww-paylink-summary__note">{packet.note}</span>}
        </div>

        <div className="ww-deposit__stealth">
          <div className="ww-deposit__fields">
            <div className="ww-deposit__facts">
              <div className="ww-deposit__fact">
                <span>Token</span>
                <b>
                  <img src={token.icon} alt="" width={16} height={16} />
                  {token.symbol}
                </b>
              </div>
              <div className="ww-deposit__fact">
                <span>Network</span>
                <b>
                  <img src={ethIcon} alt="" width={16} height={16} />
                  Ethereum (ERC20)
                </b>
              </div>
              <hr className="ww-divider" />
              <div className="ww-deposit__fact">
                <span>Fee</span>
                <b>{usdFigure(fee)}</b>
              </div>
              {total && (
                <div className="ww-deposit__fact">
                  <span>Total to send</span>
                  <b>{usdFigure(total)}</b>
                </div>
              )}
            </div>
            <div className="ww-deposit__input">
              <span>Pay to</span>
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__addr"
                disabled={!!over}
                onClick={copyAddress}
                title={result.sipaAddress}
              >
                {shortAddr(result.sipaAddress)}
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
          ) : (
            <p className="ww-deposit__note">
              {total ? (
                <>
                  Send {usdFigure(total)} — the requested amount plus the deposit fee.
                  {result.feeAtomic >= packet.amountAtomic &&
                    " The fee exceeds what was requested."}
                </>
              ) : (
                `Send more than ${usdFigure(
                  fee,
                )} — that much is kept as the deposit fee, and anything at or below it is lost.`
              )}
            </p>
          )}
        </div>

        {/* No connect-your-wallet card: connecting could not submit the payment (that needs the deposit
            screen's address screening first), so it only promised an action it did not have. The payer
            sends to the address above from any wallet. */}
        <h3 className="ww-reqpay__heading">Additional information</h3>
        <OneTimeAddressPoints points={points} />
      </Modal>

      {qr && (
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
          symbol={token.symbol}
          capacityWarning={capacityWarning}
          privacy={false}
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
          // The request page sits outside the account context; a visitor may have no account.
          account={false}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </>
  )
}
