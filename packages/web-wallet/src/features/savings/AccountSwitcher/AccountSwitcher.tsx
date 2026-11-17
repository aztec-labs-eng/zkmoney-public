import { useRef, useState, type ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import { useDomEffect } from "../../../ui/useDomEffect"
import copy from "./AccountSwitcher.copy"
import styles from "./AccountSwitcher.module.css"

export type SavingsAccount = "main" | "savings"

/** Home's account pill: Main or Savings, with both balances and their total in the menu. */
export function AccountSwitcher({
  selected,
  onSelect,
  mainBalance,
  savingsBalance,
  total,
  apyLabel,
}: {
  selected: SavingsAccount
  onSelect: (account: SavingsAccount) => void
  /** Display figures, hidden or unknown as the caller decides; whole dollars and cents, no ticking digits. */
  mainBalance: string
  savingsBalance: string
  total: string
  apyLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDomEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])
  const pick = (account: SavingsAccount) => {
    onSelect(account)
    setOpen(false)
  }
  const option = (
    account: SavingsAccount,
    avatar: React.ReactNode,
    note: string,
    figure: ReactNode,
  ) => (
    <button
      type="button"
      className="zkm-btn-reset"
      role="option"
      aria-selected={selected === account}
      onClick={() => pick(account)}
    >
      <span className={styles.avatar} aria-hidden>
        {avatar}
      </span>
      <span>
        <b>{copy[account]}</b>
        <small>{note}</small>
      </span>
      <strong>{figure}</strong>
      <span className={styles.check} aria-hidden>
        {selected === account && <Icon name="check" size={14} />}
      </span>
    </button>
  )
  return (
    <div className={styles.switcher} ref={ref}>
      <button
        type="button"
        className={`zkm-btn-reset ${styles.trigger}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={copy.select}
        onClick={() => setOpen(!open)}
      >
        {copy[selected]}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>
      {open && (
        <div className={styles.menu} role="listbox" aria-label={copy.accounts}>
          <small>{copy.accounts}</small>
          {option("main", copy.mainInitial, copy.mainNote, mainBalance)}
          {option(
            "savings",
            <Icon name="earn" size={16} color="#fff" />,
            apyLabel ? fmt(copy.savingsNote, { apy: apyLabel }) : copy.private,
            savingsBalance,
          )}
          <div className={styles.total}>
            <span>{copy.total}</span>
            <b>{total}</b>
          </div>
        </div>
      )}
    </div>
  )
}
