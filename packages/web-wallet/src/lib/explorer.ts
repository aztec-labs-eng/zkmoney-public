import { l2ExplorerTxEffectsBase } from "@obsidion/front-core"
import type { Network } from "@obsidion/sdk"

/** Etherscan origin for a public L1. Local anvil has no explorer. */
function l1EtherscanOrigin(chainId: number): string | null {
  if (chainId === 1) return "https://etherscan.io"
  if (chainId === 11155111) return "https://sepolia.etherscan.io"
  return null
}

/** L1 Etherscan tx link, or null on chains with no public explorer (local anvil). */
export function l1TxUrl(chainId: number, txHash: string): string | null {
  const origin = l1EtherscanOrigin(chainId)
  return origin ? `${origin}/tx/${txHash}` : null
}

/** L1 Etherscan address link, or null on chains with no public explorer. */
export function l1AddressUrl(chainId: number, address: string): string | null {
  const origin = l1EtherscanOrigin(chainId)
  return origin ? `${origin}/address/${address}` : null
}

/** L2 explorer tx-effects link over the shared network mapping. */
export function l2TxUrl(network: Network, nodeUrl: string, txHash: string): string {
  return `${l2ExplorerTxEffectsBase(network, nodeUrl)}${txHash}`
}
