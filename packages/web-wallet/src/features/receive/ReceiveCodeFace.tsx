import {
  ConfirmationSheetDetailRow,
  GradientInitialAvatar,
  Icon,
  PrimaryGradientButton,
  avatarColors,
} from "@obsidion/web-ds"
import coinLogo from "../../assets/receive/coin.webp"
import { requestAmountLabel } from "../../ui/format"
import { StyledQr } from "../../ui/StyledQr"
import type { ReceiveCode } from "./receiveCode"
import type { CodePayment } from "./useReceiveCode"

export const CODE_LOGO = coinLogo

/** The white pay card full screen shows: "Scan to pay", the amount and note, the code and the tag. */
export function ReceiveCodeCard({
  tag,
  code,
  url = code?.url,
  busy = false,
}: {
  tag: string
  code?: ReceiveCode
  /** What the QR encodes, when not the code's own link. */
  url?: string
  /** The code's short link is publishing. */
  busy?: boolean
}) {
  return (
    <div className="ww-receive__card">
      <span className="ww-receive__eyebrow">Scan to pay</span>
      {code && code.amount > 0 && (
        <b className="ww-receive__amount">{requestAmountLabel(code.amount)}</b>
      )}
      {code?.note && <span className="ww-receive__muted">{code.note}</span>}
      <span className="ww-receive__qr">
        {code && url && <StyledQr value={url} icon={CODE_LOGO} busy={busy} label="Your pay code" />}
      </span>
      <b className="ww-receive__tag">@{tag}</b>
    </div>
  )
}

/** Frames 5 and 6: what paid the code, the code it moved to, and the way back to it. */
export function ReceivePaid({
  payment,
  next,
  onShowCode,
}: {
  payment: CodePayment
  next?: ReceiveCode
  onShowCode: () => void
}) {
  const ethereum = payment.via === "ethereum"
  const payer = payment.payer?.replace(/^@/, "")
  return (
    <>
      <div className="ww-receive__paid" data-testid="receive-paid">
        <span className={`ww-receive__check${ethereum ? " ww-receive__check--onchain" : ""}`}>
          <Icon
            name="check"
            size={40}
            color={ethereum ? "#eed04e" : "var(--accent-green)"}
            strokeWidth={2.2}
          />
        </span>
        <b className="ww-receive__big">{requestAmountLabel(payment.amount)}</b>
        {ethereum ? (
          <>
            <span className="ww-receive__sub">On its way from an Ethereum wallet</span>
            <div className="ww-review-card ww-receive__facts">
              <ConfirmationSheetDetailRow
                label="Sent on Ethereum"
                value={<b className="ww-receive__ok">Seen</b>}
              />
              <ConfirmationSheetDetailRow
                label="Arrives in your balance"
                value="In a few minutes"
              />
            </div>
          </>
        ) : (
          <>
            <span className="ww-receive__sub">
              {payment.payer ? `Received from ${payment.payer}` : "Received"}
            </span>
            {payment.added && payer && (
              <span className="ww-receive__chip">
                <GradientInitialAvatar name={payer} colors={avatarColors(payer)} size={28} />
                Added to your contacts
              </span>
            )}
          </>
        )}
      </div>
      <div className="ww-receive__mini">
        {next && <StyledQr value={next.url} size={44} />}
        <span className="ww-send-option__text">
          <span>{next ? "Ready for the next payment" : "Making your next code"}</span>
          {next && payment.hadAddress && <span>Your code now uses a new address.</span>}
        </span>
      </div>
      <PrimaryGradientButton title="Show code" isDisabled={!next} onClick={onShowCode} />
    </>
  )
}
