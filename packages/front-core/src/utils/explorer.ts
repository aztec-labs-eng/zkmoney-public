import { Network } from "@obsidion/core/constants"

/** L2 (Aztec) explorer tx-effects base URL; sandbox routes at the given local node. */
export function l2ExplorerTxEffectsBase(network: Network | string, nodeUrl: string): string {
  switch (network) {
    case Network.MAINNET:
      return "https://aztecscan.xyz/tx-effects/"
    case Network.SANDBOX:
      return `${nodeUrl}/tx-effects/`
    case Network.TESTNET:
    default:
      return "https://testnet.aztecscan.xyz/tx-effects/"
  }
}
