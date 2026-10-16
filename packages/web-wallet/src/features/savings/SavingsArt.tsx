import coin from "../../assets/home/earn-coin.webp"

/** The Savings empty state's picture: one coin in DepositArt's frame. */
export function SavingsArt() {
  return (
    <div className="ww-home__deposit-art" aria-hidden>
      <div className="ww-savings-art__coin">
        <img src={coin} alt="" decoding="async" />
      </div>
    </div>
  )
}
