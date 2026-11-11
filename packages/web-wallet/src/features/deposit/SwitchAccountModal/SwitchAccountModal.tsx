import type { Address } from "viem"
import { GradientText, Icon, Spinner } from "@obsidion/web-ds"
import { CornerButton } from "../../../ui/flow/CornerButton/CornerButton"
import { Modal } from "../../../ui/Modal"
import { shortL1Addr } from "../../../ui/format"
import { fmt } from "../../../lib/fmt"
import copy from "./SwitchAccountModal.copy"
import styles from "./SwitchAccountModal.module.css"

/** A saved wallet's account is not the one connected: switch in the wallet, or bridge from the connected one. */
export function SwitchAccountModal({
  walletName,
  saved,
  connected,
  onUseConnected,
  onBack,
  onClose,
}: {
  walletName: string
  saved: Address
  connected: Address
  onUseConnected: () => void
  onBack?: () => void
  onClose: () => void
}) {
  return (
    <Modal
      variant="bare"
      label={fmt(copy.title, { wallet: walletName })}
      className="ww-deposit-warning ww-deposit-sheet"
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
      <div className={`ww-deposit-sheet__head ${styles.head}`}>
        <Icon name="refresh" size={44} color="var(--accent-gold)" />
        <div className={styles.text}>
          <GradientText size={24} weight={700}>
            {fmt(copy.title, { wallet: walletName })}
          </GradientText>
          <p className="ww-deposit-sheet__sub--sm">{fmt(copy.body, { wallet: walletName })}</p>
        </div>
      </div>
      <div className="ww-deposit-sheet__status ww-deposit-sheet__status--pending">
        <Spinner size={14} color="var(--accent-gold)" />
        <span className="ww-deposit-sheet__status-text">
          <b>{copy.accounts}</b>
          <span>
            {fmt(copy.pair, {
              saved: shortL1Addr(saved),
              connected: shortL1Addr(connected),
            })}
          </span>
        </span>
      </div>
      <div className={styles.foot}>
        <p className="ww-deposit-sheet__note">{fmt(copy.note, { wallet: walletName })}</p>
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-deposit__btn ww-deposit-sheet__ghost"
          data-testid="bridge-in-use-connected"
          onClick={onUseConnected}
        >
          {copy.useConnected}
        </button>
      </div>
    </Modal>
  )
}
