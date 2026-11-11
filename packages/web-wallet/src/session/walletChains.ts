/**
 * The chains a connected L1 wallet may sign on: the active L1, then the profile bridge's chains.
 */
import { defineChain, http, type Chain } from "viem"
import type { ConfigBridge, ConfigBridgeChain } from "@obsidion/config-client"
import { l1ChainFor, type WebWalletConfig } from "../config/env"

/** Chains whose gas token is not ETH; a wallet adding the chain is told its native currency. */
const NATIVE: Record<number, { name: string; symbol: string }> = {
  137: { name: "POL", symbol: "POL" },
  80002: { name: "POL", symbol: "POL" },
  999: { name: "HYPE", symbol: "HYPE" },
  998: { name: "HYPE", symbol: "HYPE" },
  43114: { name: "Avalanche", symbol: "AVAX" },
  43113: { name: "Avalanche", symbol: "AVAX" },
  143: { name: "Monad", symbol: "MON" },
  10143: { name: "Monad", symbol: "MON" },
  9745: { name: "Plasma", symbol: "XPL" },
  9746: { name: "Plasma", symbol: "XPL" },
  56: { name: "BNB", symbol: "BNB" },
  97: { name: "BNB", symbol: "BNB" },
  // Fees in stablecoins: Tempo has no native token, ARC's is USDC.
  4217: { name: "USD", symbol: "USD" },
  5042: { name: "USDC", symbol: "USDC" },
  5042002: { name: "USDC", symbol: "USDC" },
}

export function bridgeChainFor(chain: ConfigBridgeChain): Chain {
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: {
      decimals: 18,
      ...(NATIVE[chain.chainId] ?? { name: "Ether", symbol: "ETH" }),
    },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  })
}

/** The one bridge `config` offers, when this build speaks its provider. */
export function profileBridge(
  config: Pick<WebWalletConfig, "bridge">,
): Extract<ConfigBridge, { provider: "across" }> | undefined {
  const { bridge } = config
  return bridge?.provider === "across" ? bridge : undefined
}

/** Every chain a connected wallet may be asked to sign on: the L1, then the bridge's. */
export function walletChains(config: Pick<WebWalletConfig, "l1ChainId" | "bridge">): {
  chains: [Chain, ...Chain[]]
  transports: Record<number, ReturnType<typeof http>>
} {
  const bridge = (profileBridge(config)?.chains ?? []).map((chain) => ({
    chain: bridgeChainFor(chain),
    rpc: chain.rpcUrl,
  }))
  return {
    chains: [l1ChainFor(config.l1ChainId), ...bridge.map((b) => b.chain)],
    transports: Object.fromEntries(bridge.map((b) => [b.chain.id, http(b.rpc)])),
  }
}

/** `chainId` among the wallet's `chains`, else an L1. */
export function walletChainFor(chainId: number, chains: readonly Chain[]): Chain {
  return chains.find((chain) => chain.id === chainId) ?? l1ChainFor(chainId)
}
