import { useState } from "react"
import { NumberedStepRow } from "@obsidion/web-ds"
import { Modal } from "../../ui/Modal"
import { deviceStorage } from "../../platform/storage/rollupStorage"
import envelope from "../../assets/paylink/paylink-envelope.webp"

const HIDE_KEY = "webwallet.hide-paylink-info"

const steps = (voucher: boolean) => [
  [
    "Set an amount, share the link",
    "Message, email or QR code. The funds wait in the link, privately.",
  ],
  [
    "They choose how to receive",
    voucher
      ? "Free and instant to zk.money, or to any Ethereum address for a fee."
      : "With a zk.money account, receive free and instantly in zk.money, or to any Ethereum address for a fee.",
  ],
  ["Not claimed? Take it back", "Only you can reclaim the funds while the link is unclaimed."],
]

export function isPaylinkInfoHidden(): boolean {
  return deviceStorage.getItem(HIDE_KEY) === "true"
}

/**
 * Explains paylinks. `offerHide` adds "Don't show this again", saved on "Got it!" only. Without
 * `voucher` (a sponsored cash-out to Ethereum), the claimer needs a zk.money account.
 */
export function PaylinkInfoModal({
  offerHide,
  voucher,
  onClose,
  onGotIt,
}: {
  offerHide: boolean
  voucher: boolean
  onClose: () => void
  onGotIt: () => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(true)

  return (
    <Modal
      variant="create"
      className="ww-paylink-info"
      label="Send funds via paylink"
      onClose={onClose}
    >
      <div className="ww-create-modal__body">
        <div className="ww-paylink-info__intro">
          <div className="ww-invite-modal-head">
            <img src={envelope} alt="" width={120} height={102} />
            <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
              Send funds via paylink
            </h2>
            <p className="ww-paylink-info__lead">
              {voucher
                ? "A private link that carries funds. Share it with anyone, no zk.money account needed."
                : "A private link that carries funds. Share it with anyone. They'll need a zk.money account to claim."}
            </p>
          </div>
          {steps(voucher).map(([title, body], i) => (
            <NumberedStepRow key={title} index={i + 1}>
              <b>{title}</b>
              {body}
            </NumberedStepRow>
          ))}
        </div>
        {offerHide && (
          <label className="ww-deposit-warning__again">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            Don't show this again
          </label>
        )}
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-deposit__btn"
          onClick={() => {
            try {
              if (offerHide && dontShowAgain) deviceStorage.setItem(HIDE_KEY, "true")
            } catch {
              // Full or blocked storage: the modal shows again next time.
            }
            onGotIt()
          }}
        >
          Got it!
        </button>
      </div>
    </Modal>
  )
}
