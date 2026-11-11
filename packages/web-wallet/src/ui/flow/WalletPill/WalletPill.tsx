import { Icon } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import copy from "./WalletPill.copy"
import styles from "./WalletPill.module.css"

/** The connected wallet a flow sends from. */
export function WalletPill({
  wallet,
  address,
  className,
}: {
  wallet: string
  /** Shortened. */
  address: string
  className?: string
}) {
  return (
    <span className={[styles.walletPill, className].filter(Boolean).join(" ")}>
      <span>{fmt(copy.label, { wallet, address })}</span>
      <Icon name="link-unlink" size={11} />
    </span>
  )
}
