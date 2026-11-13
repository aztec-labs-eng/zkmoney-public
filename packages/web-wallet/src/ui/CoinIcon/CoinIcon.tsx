import type { CSSProperties } from "react"
import { ChainIcon } from "../ChainIcon/ChainIcon"
import { BrandIcon } from "../brand/BrandIcon/BrandIcon"
import { ICONS } from "./coinIcons"
import type { DepositTokenOption } from "../../features/sipa/loadDepositFacts"
import ethLogo from "../../assets/deposit/eth.svg"
import wethLogo from "../../assets/deposit/weth.svg"
import wbtcLogo from "../../assets/deposit/wbtc.svg"
import styles from "./CoinIcon.module.css"

/** Where a coin is held: a chain, as the config names it, or the brand for the private balance. */
export type CoinBadge = { id: number; name: string } | "brand"

/** The coin, with the logo of where it is held as its badge; none without `badge`. */
export function CoinIcon({
  token,
  size = 44,
  badge,
}: {
  token: Pick<DepositTokenOption, "icon">
  size?: number
  badge?: CoinBadge
}) {
  return (
    <span
      className={badge ? `${styles.coin} ww-badged` : styles.coin}
      style={{ "width": size, "height": size, "--coin-size": `${size}px` } as CSSProperties}
    >
      <img src={token.icon} alt="" width={size} height={size} />
      {badge && (
        <span className={styles.coinBadge}>
          {badge === "brand" ? (
            <BrandIcon size={16} />
          ) : (
            <ChainIcon chainId={badge.id} name={badge.name} size={16} />
          )}
        </span>
      )}
    </span>
  )
}

const ORIGIN_LOGOS: Record<string, string> = {
  ...ICONS,
  ETH: ethLogo,
  WETH: wethLogo,
  WBTC: wbtcLogo,
}

/** A bridge-in token's icon: a listed coin's own, else its logo, else its initial; never another coin's. */
export function OriginTokenIcon({
  symbol,
  coins,
  size = 32,
  chain,
}: {
  symbol: string
  coins: readonly DepositTokenOption[]
  size?: number
  /** The chain the token is on, shown as its badge. */
  chain?: { id: number; name: string }
}) {
  const coin = coins.find((c) => c.symbol === symbol)
  if (coin) return <CoinIcon token={coin} size={size} badge={chain} />
  const logo = ORIGIN_LOGOS[symbol]
  return logo ? (
    <CoinIcon token={{ icon: logo }} size={size} badge={chain} />
  ) : (
    <ChainIcon chainId={0} name={symbol} size={size} />
  )
}
