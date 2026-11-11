import { l2ExplorerTxEffectsBase } from "@obsidion/front-core"
import type { Network } from "@obsidion/sdk"

/** Public explorers: the L1s and the bridge's origin chains. Local anvil has none. */
const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  10: "https://optimistic.etherscan.io",
  137: "https://polygonscan.com",
  999: "https://hyperevmscan.io",
  59144: "https://lineascan.build",
  130: "https://uniscan.xyz",
  57073: "https://explorer.inkonchain.com",
  480: "https://worldchain-mainnet-explorer.alchemy.com",
  324: "https://explorer.zksync.io",
  43114: "https://snowscan.xyz",
  143: "https://monadvision.com",
  9745: "https://plasmascan.to",
  4326: "https://megaeth.blockscout.com",
  56: "https://bscscan.com",
  1868: "https://soneium.blockscout.com",
  4217: "https://explore.mainnet.tempo.xyz",
  4663: "https://robinhoodchain.blockscout.com",
  5042: "https://explorer.arc.io",
}

const explorerOrigin = (chainId: number): string | null => EXPLORERS[chainId] ?? null

/** A tx link, or null on chains with no public explorer (local anvil). */
export function l1TxUrl(chainId: number, txHash: string): string | null {
  const origin = explorerOrigin(chainId)
  return origin ? `${origin}/tx/${txHash}` : null
}

/** An address link, or null on chains with no public explorer. */
export function l1AddressUrl(chainId: number, address: string): string | null {
  const origin = explorerOrigin(chainId)
  return origin ? `${origin}/address/${address}` : null
}

/** A bridge origin chain's tx link; undefined where the chain has no listed explorer. */
export const originTxUrl = (chainId: number, txHash: string) =>
  l1TxUrl(chainId, txHash) ?? undefined

/** A bridge origin chain's address link; undefined where the chain has no listed explorer. */
export const originAddressUrl = (chainId: number, address: string) =>
  l1AddressUrl(chainId, address) ?? undefined

/** L2 explorer tx-effects link over the shared network mapping. */
export function l2TxUrl(network: Network, nodeUrl: string, txHash: string): string {
  return `${l2ExplorerTxEffectsBase(network, nodeUrl)}${txHash}`
}
