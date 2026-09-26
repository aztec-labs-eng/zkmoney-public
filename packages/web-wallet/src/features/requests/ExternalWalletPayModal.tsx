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
import { useState } from "react"
import { formatUnits } from "viem"
import type { RequestInlinePacket } from "@obsidion/front-core"
import { GradientText, Icon, TopNavIconButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { shortAddr, usdBalance, usdFigure } from "../../ui/format"
import { useCopy } from "../../ui/hooks"
import { DepositQrSheet } from "../deposit/DepositQrSheet"
import { depositTokensFor } from "../deposit/loadDepositFacts"
import { OneTimeAddressPoints, oneTimeAddressPoints } from "../deposit/OneTimeAddressWarning"
import type { AccountlessResolveResult } from "./accountlessRequest"
import { requestAmountDisplay } from "./requestLink"
import ethIcon from "../../assets/deposit/ethereum.webp"

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

  const token = depositTokensFor(config.network)[0]
  const decimals = packet.tokenDecimals ?? 6
  const amountDisplay = requestAmountDisplay(packet)
  const fee = formatUnits(result.feeAtomic, decimals)
  // Fixed-amount requests are paid gross: what the requester asked for plus the deposit fee.
  const total = packet.amountAtomic > 0n ? formatUnits(result.grossAtomic, decimals) : undefined
  // The link pins the payee's address, so the "changes every time" point is a deposit-screen fact.
  const points = oneTimeAddressPoints(token.symbol).filter((p) => p.id !== "rotates")

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
                onClick={() => void copy(result.sipaAddress)}
                title={result.sipaAddress}
              >
                {shortAddr(result.sipaAddress)}
                <Icon name={copied ? "check" : "copy"} size={16} />
              </button>
            </div>
          </div>

          <div className="ww-deposit__actions">
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__btn"
              onClick={() => setQr(true)}
            >
              Show <Icon name="qr-code" size={24} />
            </button>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__btn"
              onClick={() => void copy(result.sipaAddress)}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <p className="ww-deposit__note">
            {total ? (
              <>
                Send {usdFigure(total)} — the requested amount plus the deposit fee.
                {result.feeAtomic >= packet.amountAtomic && " The fee exceeds what was requested."}
              </>
            ) : (
              `Send more than ${usdFigure(
                fee,
              )} — that much is kept as the deposit fee, and anything at or below it is lost.`
            )}
          </p>
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
          onCopy={() => void copy(result.sipaAddress)}
          onClose={() => setQr(false)}
        />
      )}
    </>
  )
}
