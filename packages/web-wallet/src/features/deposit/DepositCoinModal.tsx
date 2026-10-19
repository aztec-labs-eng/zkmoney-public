import { useId, useRef, useState, type ReactNode } from "react"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { Modal } from "../../ui/Modal"
import { usePickerDismiss } from "../../ui/usePickerDismiss"
import { CoinIcon } from "./DepositAddressSheet"
import type { DepositTokenOption } from "./loadDepositFacts"

/** The coin the user sends, with what the deposit costs and its least amount, before the address. */
export function DepositCoinModal({
  title,
  coins,
  coinName,
  token,
  onPick,
  rows,
  status,
  canContinue,
  onContinue,
  onClose,
}: {
  title: string
  coins: DepositTokenOption[]
  coinName: (token: DepositTokenOption) => string
  token: DepositTokenOption
  onPick: (token: DepositTokenOption) => void
  /** The fee and minimum rows. */
  rows: ReactNode
  /** Why no coin can be picked yet; replaces the picker. */
  status?: ReactNode
  canContinue: boolean
  onContinue: () => void
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
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-deposit-sheet__head">
        <span className="ww-deposit-coin__icon">
          <Icon name="arrow-down" size={32} color="#fff" />
        </span>
        <GradientText size={24} weight={700}>
          {title}
        </GradientText>
      </div>
      {status ?? (
        <>
          <div className="ww-deposit-coin__fields">
            <div className="ww-deposit-coin__field" ref={anchorRef}>
              <span id={labelId}>Which coin are you sending?</span>
              <button
                ref={triggerRef}
                type="button"
                className="zkm-btn-reset ww-deposit-coin__select"
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
                  className="ww-deposit__picker ww-deposit-coin__list"
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
            <div className="ww-deposit-coin__rows">{rows}</div>
          </div>
          <PrimaryGradientButton
            title="Continue"
            testId="deposit-coin-continue"
            isDisabled={!canContinue}
            onClick={onContinue}
            className="ww-deposit-sheet__cta"
          />
        </>
      )}
    </Modal>
  )
}
