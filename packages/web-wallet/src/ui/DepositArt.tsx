import type { ReactNode } from "react"
import coins from "../assets/phone/deposit-coins.webp"
import deposit from "../assets/phone/deposit-token.svg"

/** Decorative illustration from web Home node 10881:33995; the chip's words are the caller's. */
export function DepositArt({
  label = "Deposit",
  note = (
    <>
      Ethereum <small>ERC20</small>
    </>
  ),
}: {
  label?: string
  /** The chip's second line; null drops it. */
  note?: ReactNode
}) {
  return (
    <div className="ww-home__deposit-art" aria-hidden>
      <div className="ww-home__deposit-coins">
        <img src={coins} alt="" decoding="async" />
      </div>
      <div className="ww-home__deposit-token">
        <span className="ww-home__deposit-token-icon">
          <img src={deposit} alt="" />
        </span>
        <span className="ww-home__deposit-token-label">
          <strong>{label}</strong>
          {note !== null && <span>{note}</span>}
        </span>
      </div>
    </div>
  )
}
