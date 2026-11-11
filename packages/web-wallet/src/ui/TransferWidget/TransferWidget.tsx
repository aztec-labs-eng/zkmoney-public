import type { ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import copy from "./TransferWidget.copy"
import styles from "./TransferWidget.module.css"

/** The token and chain on one side; pressable where that side can change. */
export interface TransferAsset {
  icon: ReactNode
  symbol: string
  chain: string
  onPick?: () => void
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
  const body = (
    <>
      {asset.icon}
      <span className={styles.chipText}>
        <b>{asset.symbol}</b>
        <small>{asset.chain}</small>
      </span>
    </>
  )
  return asset.onPick ? (
    <button
      type="button"
      className={`zkm-btn-reset zkm-pressable ${styles.chip}`}
      data-testid="transfer-asset"
      onClick={asset.onPick}
    >
      {body}
      <Icon name="chevron-down" size={16} />
    </button>
  ) : (
    <span className={styles.chip}>{body}</span>
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
        <div key={side.label} className={styles.side} data-testid={side.testId}>
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
