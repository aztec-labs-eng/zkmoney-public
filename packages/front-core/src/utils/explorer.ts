import { Network } from "@obsidion/core/constants"

/**
 * L2 (Aztec) explorer tx-effects base URL; sandbox routes at the given local node. The plain hosts
 * show the current Aztec major version. `retiredMajor` picks a retired one's explorer, which
 * aztecscan serves at `v<major>.`.
 */
export function l2ExplorerTxEffectsBase(
  network: Network | string,
  nodeUrl: string,
  retiredMajor?: string,
): string {
  const prefix = retiredMajor && /^\d+$/.test(retiredMajor) ? `v${retiredMajor}.` : ""
  switch (network) {
    case Network.MAINNET:
      return `https://${prefix}aztecscan.xyz/tx-effects/`
    case Network.SANDBOX:
      return `${nodeUrl}/tx-effects/`
    case Network.TESTNET:
    default:
      return `https://${prefix}testnet.aztecscan.xyz/tx-effects/`
  }
}
