import { useState } from "react"
import { GradientText, TopNavIconButton } from "@obsidion/web-ds"
import { Modal } from "../../ui/Modal"
import { deviceStorage } from "../../platform/storage/rollupStorage"
import questionMark from "../../assets/deposit/question-mark.svg"

const HIDE_KEY = "webwallet.hide-deposit-privacy-disclaimer"

export function isDepositPrivacyDisclaimerHidden(): boolean {
  return deviceStorage.getItem(HIDE_KEY) === "true"
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
      variant="bare"
      className="ww-deposit-warning ww-deposit-sheet ww-deposit-disclaimer"
      label="How do private deposits work?"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <span className="ww-deposit__connect-icon ww-deposit-warning__icon">
        <img src={questionMark} alt="" width={32} height={32} />
      </span>
      <div className="ww-deposit-sheet__head">
        <GradientText size={24} weight={700} style={{ maxWidth: 288 }}>
          How do private deposits work?
        </GradientText>
        <p className="ww-deposit-disclaimer__body">
          You get a <b>fresh address</b> for each deposit. Nothing links it to{" "}
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
        className="zkm-btn-reset zkm-pressable ww-deposit__btn ww-deposit-sheet__ghost"
        onClick={() => {
          if (dontShowAgain) deviceStorage.setItem(HIDE_KEY, "true")
          onClose()
        }}
      >
        Got it!
      </button>
    </Modal>
  )
}
