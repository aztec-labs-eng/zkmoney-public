import { useState } from "react"
import { Modal } from "../../ui/Modal"

const HIDE_KEY = "webwallet.hide-deposit-privacy-disclaimer"

export function isDepositPrivacyDisclaimerHidden(): boolean {
  return localStorage.getItem(HIDE_KEY) === "true"
}

/** Explains the fresh-address-per-deposit model on arrival at the deposit screen. */
export function DepositPrivacyDisclaimer({
  handle,
  onClose,
}: {
  handle?: string
  onClose: () => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(true)

  return (
    <Modal
      variant="create"
      className="ww-deposit-disclaimer"
      label="Deposits are private by default"
      onClose={onClose}
    >
      <div className="ww-create-modal__body">
        <div className="ww-invite-modal-head">
          <span className="ww-invite-modal-badge">?</span>
          <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
            Deposits
            <br />
            private by default
          </h2>
          <p className="ww-deposit-disclaimer__body">
            You get a <b>fresh address</b> each deposit. Nothing links it to{" "}
            {handle ? `@${handle}.zk.money` : "your @tag"}, or to your other deposits.
          </p>
        </div>
        <label className="ww-deposit-warning__again">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-deposit__btn"
          onClick={() => {
            if (dontShowAgain) localStorage.setItem(HIDE_KEY, "true")
            onClose()
          }}
        >
          Got it!
        </button>
      </div>
    </Modal>
  )
}
