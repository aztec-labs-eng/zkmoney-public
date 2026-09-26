import { useState } from "react"
import { Modal } from "../../ui/Modal"

const HIDE_KEY = "webwallet.hide-withdraw-privacy-disclaimer"

export function isWithdrawPrivacyDisclaimerHidden(): boolean {
  return localStorage.getItem(HIDE_KEY) === "true"
}

/**
 * The deposit side hands out a fresh address and says so; a withdrawal address is the user's own
 * choice, so this is the one place they are told reuse is what links their withdrawals.
 */
export function WithdrawPrivacyDisclaimer({ onClose }: { onClose: () => void }) {
  const [dontShowAgain, setDontShowAgain] = useState(true)

  return (
    <Modal
      variant="create"
      className="ww-deposit-disclaimer"
      label="Withdraw to a fresh address"
      onClose={onClose}
    >
      <div className="ww-create-modal__body">
        <div className="ww-invite-modal-head">
          <span className="ww-invite-modal-badge">?</span>
          <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">
            Withdraw to a
            <br />
            fresh address
          </h2>
          <p className="ww-deposit-disclaimer__body">
            Use a <b>fresh withdrawal address</b> each time. Withdrawing to the same Ethereum
            address repeatedly will link your withdrawals together.
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
