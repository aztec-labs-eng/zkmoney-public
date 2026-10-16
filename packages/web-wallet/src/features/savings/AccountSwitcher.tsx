import { useEffect, useRef, useState, type ReactNode } from "react"
import { Icon } from "@obsidion/web-ds"

export type SavingsAccount = "main" | "savings"

const LABEL: Record<SavingsAccount, string> = { main: "Main Account", savings: "Savings" }

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
  useEffect(() => {
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
      <span className="ww-account-switcher__avatar" aria-hidden>
        {avatar}
      </span>
      <span>
        <b>{LABEL[account]}</b>
        <small>{note}</small>
      </span>
      <strong>{figure}</strong>
      <span className="ww-account-switcher__check" aria-hidden>
        {selected === account && <Icon name="check" size={14} />}
      </span>
    </button>
  )
  return (
    <div className="ww-account-switcher" ref={ref}>
      <button
        type="button"
        className="zkm-btn-reset ww-account-switcher__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select account"
        onClick={() => setOpen(!open)}
      >
        {LABEL[selected]}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>
      {open && (
        <div className="ww-account-switcher__menu" role="listbox" aria-label="Accounts">
          <small>Accounts</small>
          {option("main", "M", "Day-to-day · private", mainBalance)}
          {option(
            "savings",
            <Icon name="earn" size={16} color="#fff" />,
            apyLabel ? `${apyLabel} · variable · private` : "Private",
            savingsBalance,
          )}
          <div className="ww-account-switcher__total">
            <span>Total wealth</span>
            <b>{total}</b>
          </div>
        </div>
      )}
    </div>
  )
}
