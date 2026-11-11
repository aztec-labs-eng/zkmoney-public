import ethereum from "../../assets/chains/ethereum.svg"
import base from "../../assets/chains/base.svg"
import arbitrum from "../../assets/chains/arbitrum.svg"
import optimism from "../../assets/chains/optimism.svg"
import polygon from "../../assets/chains/polygon.svg"
import hyperevm from "../../assets/chains/hyperevm.svg"
import linea from "../../assets/chains/linea.svg"
import unichain from "../../assets/chains/unichain.svg"
import ink from "../../assets/chains/ink.svg"
import worldChain from "../../assets/chains/world-chain.svg"
import zksync from "../../assets/chains/zksync.svg"
import avalanche from "../../assets/chains/avalanche.svg"
import monad from "../../assets/chains/monad.svg"
import plasma from "../../assets/chains/plasma.svg"
import megaeth from "../../assets/chains/megaeth.svg"
import bnb from "../../assets/chains/bnb.svg"
import soneium from "../../assets/chains/soneium.svg"
import tempo from "../../assets/chains/tempo.svg"
import robinhood from "../../assets/chains/robinhood.svg"
import arc from "../../assets/chains/arc.svg"
import styles from "./ChainIcon.module.css"

/** Mainnet and testnet ids share a logo; a chain without one shows its initial. */
const CHAIN_LOGOS: Record<number, string> = {
  1: ethereum,
  11155111: ethereum,
  31337: ethereum,
  8453: base,
  84532: base,
  42161: arbitrum,
  421614: arbitrum,
  10: optimism,
  11155420: optimism,
  137: polygon,
  80002: polygon,
  999: hyperevm,
  998: hyperevm,
  59144: linea,
  59141: linea,
  130: unichain,
  1301: unichain,
  57073: ink,
  763373: ink,
  480: worldChain,
  4801: worldChain,
  324: zksync,
  300: zksync,
  43114: avalanche,
  43113: avalanche,
  143: monad,
  10143: monad,
  9745: plasma,
  9746: plasma,
  4326: megaeth,
  6342: megaeth,
  56: bnb,
  97: bnb,
  1868: soneium,
  1946: soneium,
  4217: tempo,
  4663: robinhood,
  5042: arc,
  5042002: arc,
}

export function ChainIcon({
  chainId,
  name,
  size = 32,
}: {
  chainId: number
  name: string
  size?: number
}) {
  const logo = CHAIN_LOGOS[chainId]
  return logo ? (
    <img className={styles.icon} src={logo} alt="" width={size} height={size} />
  ) : (
    <span
      className={`${styles.icon} ${styles.initial}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {name.charAt(0)}
    </span>
  )
}
