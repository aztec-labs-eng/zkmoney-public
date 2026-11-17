import { useRef, type ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { usePickerDismiss } from "../usePickerDismiss"
import copy from "./TransferWidget.copy"
import styles from "./TransferWidget.module.css"

/** The token on one side, under it its chain or a vault's rate. Pressable where it can change. */
export interface TransferAsset {
  icon: ReactNode
  symbol: string
  detail: string
  onPick?: () => void
  /** The choices, under the chip while they are open. */
  menu?: ReactNode
  /** Closes `menu` from a press outside the chip, or Escape. */
  onDismiss?: () => void
  /** Replaces the chip's `transfer-asset` test id. */
  testId?: string
}

export interface TransferSide {
  /** "From" or "To", then who: a wallet and its address, or a zk.money name. */
  label: string
  who: string
  /** Beside `who`: a way to change it. */
  action?: ReactNode
  /** Makes `who` a button that changes it, in place of `action`. */
  onPickWho?: () => void
  whoTestId?: string
  /** The figure, or the field that sets it. */
  amount: ReactNode
  /** The figure follows from the other side: marked "≈", outside any field's value. */
  approx?: boolean
  /** Under the figure: a balance with MAX, or the fee. */
  note?: ReactNode
  asset: TransferAsset
  testId?: string
}

function AssetChip({ asset }: { asset: TransferAsset }) {
  const slot = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const dismiss = useRef(asset.onDismiss)
  dismiss.current = asset.onDismiss
  const close = useRef((next: boolean) => {
    if (!next) dismiss.current?.()
  })
  const open = asset.menu != null
  usePickerDismiss(open, close.current, slot, trigger)
  const body = (
    <>
      {asset.icon}
      <span className={styles.chipText}>
        <b>{asset.symbol}</b>
        <small>{asset.detail}</small>
      </span>
    </>
  )
  return (
    <div className={styles.slot} ref={slot}>
      {asset.onPick ? (
        <button
          ref={trigger}
          type="button"
          className={`zkm-btn-reset zkm-pressable ${styles.chip}`}
          data-testid={asset.testId ?? "transfer-asset"}
          aria-haspopup={asset.onDismiss ? "listbox" : undefined}
          aria-expanded={asset.onDismiss ? open : undefined}
          onClick={asset.onPick}
        >
          {body}
          <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
        </button>
      ) : (
        <span className={styles.chip} data-testid={asset.testId ?? "transfer-asset"}>
          {body}
        </span>
      )}
      {open && <div className={styles.menu}>{asset.menu}</div>}
    </div>
  )
}

/**
 * One From/To amount widget for every move across an address or chain. Bridging in, the picker sits
 * on the From side; moving out, From is the private balance and the picker sits on the To side.
 */
export function TransferWidget({ from, to }: { from: TransferSide; to: TransferSide }) {
  return (
    <div className={styles.transfer}>
      {[from, to].map((side) => (
        <div
          key={side.label}
          className={side.asset.menu != null ? `${styles.side} ${styles.open}` : styles.side}
          data-testid={side.testId}
        >
          {side === to && (
            <span className={styles.arrow} aria-hidden>
              <Icon name="arrow-down" size={16} />
            </span>
          )}
          <span className={styles.who}>
            <b>{side.label}</b>
            {side.onPickWho ? (
              <button
                type="button"
                className={`zkm-btn-reset zkm-pressable ${styles.whoBtn}`}
                data-testid={side.whoTestId}
                onClick={side.onPickWho}
              >
                {side.who}
                <Icon name="chevron-down" size={12} color="var(--text-secondary)" />
              </button>
            ) : (
              <>
                {side.who}
                {side.action}
              </>
            )}
          </span>
          <div className={styles.row}>
            <span className={styles.amount}>
              {side.approx ? (
                <span className={styles.approx}>
                  <span aria-hidden>{copy.approx}</span>
                  {side.amount}
                </span>
              ) : (
                side.amount
              )}
              {/* An empty note keeps its line, so a note arriving does not move the card. */}
              <small>{side.note || "\u00a0"}</small>
            </span>
            <AssetChip asset={side.asset} />
          </div>
        </div>
      ))}
    </div>
  )
}
