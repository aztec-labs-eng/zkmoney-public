import coins from "../assets/phone/deposit-coins.webp"
import deposit from "../assets/phone/deposit-token.svg"

/** Decorative illustration from web Home node 10881:33995. */
export function DepositArt() {
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
          <strong>Deposit</strong>
          <span>
            Ethereum <small>ERC20</small>
          </span>
        </span>
      </div>
    </div>
  )
}
