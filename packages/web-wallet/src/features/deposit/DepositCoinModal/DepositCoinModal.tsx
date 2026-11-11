import { useId, useRef, useState, type ReactNode } from "react"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { Modal } from "../../../ui/Modal"
import { usePickerDismiss } from "../../../ui/usePickerDismiss"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import type { DepositTokenOption } from "../../sipa/loadDepositFacts"
import copy from "./DepositCoinModal.copy"
import styles from "./DepositCoinModal.module.css"

/** The coin the user sends, with what the deposit costs and its least amount, before the address. */
export function DepositCoinModal({
  title,
  subtitle,
  coins = [],
  coinName = (coin) => coin.symbol,
  token,
  onPick = () => {},
  rows,
  note,
  footer,
  status,
  canContinue = false,
  onContinue = () => {},
  onClose,
}: {
  title: string
  subtitle?: string
  coins?: DepositTokenOption[]
  coinName?: (token: DepositTokenOption) => string
  /** Unset until the accepted tokens are read; `status` then says why. */
  token?: DepositTokenOption
  onPick?: (token: DepositTokenOption) => void
  /** The fee and minimum rows, where no step before this one showed them. */
  rows?: ReactNode
  note?: ReactNode
  footer?: ReactNode
  /** Why no coin can be picked yet; replaces the picker. */
  status?: ReactNode
  canContinue?: boolean
  onContinue?: () => void
  onClose: () => void
}) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const labelId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  usePickerDismiss(open, setOpen, anchorRef, triggerRef)

  return (
    <Modal
      variant="bare"
      label={title}
      className="ww-deposit-warning ww-deposit-sheet"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={onClose} />
      </div>
      <div className="ww-deposit-sheet__head">
        <span className={`zkm-on-brand ${styles.icon}`}>
          <Icon name="arrow-down" size={32} color="#fff" />
        </span>
        <GradientText size={24} weight={700}>
          {title}
        </GradientText>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {status ??
        (token && (
          <>
            <div className={styles.fields}>
              <div className={styles.field} ref={anchorRef}>
                <span id={labelId}>{copy.whichCoin}</span>
                <button
                  ref={triggerRef}
                  type="button"
                  className={`zkm-btn-reset ${styles.select}`}
                  data-testid="deposit-coin-select"
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-labelledby={labelId}
                  onClick={() => setOpen((current) => !current)}
                >
                  <CoinIcon token={token} />
                  <span className="ww-deposit__coin-name">
                    {token.symbol}
                    <small>{coinName(token)}</small>
                  </span>
                  <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
                </button>
                {open && (
                  <div
                    id={listboxId}
                    className={`ww-deposit__picker ${styles.list}`}
                    role="listbox"
                    aria-labelledby={labelId}
                  >
                    {coins.map((coin) => (
                      <button
                        key={coin.symbol}
                        type="button"
                        role="option"
                        className="zkm-btn-reset ww-deposit__picker-row"
                        data-testid={`deposit-coin-${coin.symbol}`}
                        aria-selected={coin.symbol === token.symbol}
                        onClick={() => {
                          onPick(coin)
                          setOpen(false)
                          triggerRef.current?.focus()
                        }}
                      >
                        <CoinIcon token={coin} size={30} />
                        <span>
                          <b>{coin.symbol}</b>
                          <small>{coinName(coin)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {note && <p className={styles.note}>{note}</p>}
              {rows && <div className={styles.rows}>{rows}</div>}
            </div>
            <PrimaryGradientButton
              title={copy.continue}
              testId="deposit-coin-continue"
              isDisabled={!canContinue}
              onClick={onContinue}
              className="ww-deposit-sheet__cta"
            />
            {footer}
          </>
        ))}
    </Modal>
  )
}

/**
 * Stands in for the coin picker while the accepted tokens are read, or once a read failed: the screen names no
 * token, fee or limit before the table says what it accepts.
 */
export function DepositTokensStatus({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return failed ? (
    <div className="ww-deposit__unresolved" role="alert" data-testid="deposit-tokens-failed">
      <b>{copy.tokensFailed}</b>
      <p>{copy.tokensFailedBody}</p>
      <div className="ww-deposit__unresolved-actions">
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__link"
          data-testid="deposit-tokens-retry"
          onClick={onRetry}
        >
          {copy.retry}
        </button>
      </div>
    </div>
  ) : (
    <p className="ww-deposit__note" role="status" data-testid="deposit-tokens-loading">
      <Spinner size={12} /> {copy.tokensLoading}
    </p>
  )
}
