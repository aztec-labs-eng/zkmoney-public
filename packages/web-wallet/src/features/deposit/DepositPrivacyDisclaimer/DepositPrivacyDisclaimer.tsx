import type { ReactNode } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { Modal } from "../../../ui/Modal"
import depositCopy from "../DepositScreen/DepositScreen.copy"
import copy from "./DepositPrivacyDisclaimer.copy"
import styles from "./DepositPrivacyDisclaimer.module.css"

/** The one rule of a private deposit, shown before an address is handed out. */
export function DepositPrivacyDisclaimer({
  rows,
  onContinue,
  onBack,
  onClose,
}: {
  /** The fee, minimum and limit rows. */
  rows: ReactNode
  onContinue: () => void
  onBack?: () => void
  onClose: () => void
}) {
  return (
    <Modal
      variant="bare"
      className="ww-deposit-warning ww-deposit-sheet ww-deposit-disclaimer"
      label={copy.title}
      onClose={onClose}
    >
      {onBack && (
        <div className="ww-deposit-warning__back">
          <CornerButton kind="back" onClick={onBack} />
        </div>
      )}
      <div className="ww-deposit-warning__close">
        <CornerButton kind="close" onClick={onClose} />
      </div>
      <div className="ww-deposit-sheet__head">
        <span className={`ww-deposit-coin__icon ${styles.icon}`} aria-hidden>
          {copy.glyph}
        </span>
        <div className={styles.text}>
          <h2>{copy.title}</h2>
          <p className={styles.body}>{copy.body}</p>
        </div>
      </div>
      <div className={styles.facts}>
        <div className="ww-deposit-coin__rows">{rows}</div>
        <div className={styles.note} role="note">
          <Icon name="alert-triangle" size={16} color="#fdfdfd" />
          <span>
            <b>{depositCopy.info.lossTitle}</b>
            <span>{depositCopy.info.lossBody}</span>
          </span>
        </div>
      </div>
      <PrimaryGradientButton
        title={copy.continue}
        testId="deposit-privacy-continue"
        onClick={onContinue}
        className="ww-deposit-sheet__cta"
      />
    </Modal>
  )
}
