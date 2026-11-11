import type { CSSProperties } from "react"
import { ChainIcon } from "../ChainIcon/ChainIcon"
import { ICONS } from "./coinIcons"
import type { DepositTokenOption } from "../../features/sipa/loadDepositFacts"
import ethLogo from "../../assets/deposit/eth.svg"
import wethLogo from "../../assets/deposit/weth.svg"
import wbtcLogo from "../../assets/deposit/wbtc.svg"
import ethBadge from "../../assets/deposit/eth-fill.svg"
import styles from "./CoinIcon.module.css"

/** The coin with its Ethereum badge, on the coin rows and the sheet header. */
export function CoinIcon({
  token,
  size = 44,
  badge = true,
  chain,
}: {
  token: Pick<DepositTokenOption, "icon">
  size?: number
  badge?: boolean
  /** Another chain's logo in place of the Ethereum badge. */
  chain?: { chainId: number; name: string }
}) {
  return (
    <span
      className={badge ? `${styles.coin} ww-badged` : styles.coin}
      style={{ "width": size, "height": size, "--coin-size": `${size}px` } as CSSProperties}
    >
      <img src={token.icon} alt="" width={size} height={size} />
      {badge &&
        (chain ? (
          <span className={`${styles.coinBadge} ${styles.coinBadgeChain}`}>
            <ChainIcon chainId={chain.chainId} name={chain.name} size={16} />
          </span>
        ) : (
          <span className={styles.coinBadge}>
            <img src={ethBadge} alt="" width={10} height={10} />
          </span>
        ))}
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
  chain?: { chainId: number; name: string }
}) {
  const coin = coins.find((c) => c.symbol === symbol)
  if (coin) return <CoinIcon token={coin} size={size} badge={!!chain} chain={chain} />
  const logo = ORIGIN_LOGOS[symbol]
  return logo ? (
    <CoinIcon token={{ icon: logo }} size={size} badge={!!chain} chain={chain} />
  ) : (
    <ChainIcon chainId={0} name={symbol} size={size} />
  )
}
