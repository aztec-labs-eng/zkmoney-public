/** Predicate's attestation `chain` name per EVM chain id, for the chains it screens on. */
export const PREDICATE_CHAINS: Readonly<Record<number, string>> = {
  1: "ethereum",
  11155111: "sepolia",
  8453: "base",
  84532: "base-sepolia",
  42161: "arbitrum",
  999: "hyperliquid",
  43114: "avalanche",
  56: "bsc",
  5000: "mantle",
  480: "worldchain",
  9745: "plasma",
  4326: "megaeth",
  143: "monad-mainnet",
}
