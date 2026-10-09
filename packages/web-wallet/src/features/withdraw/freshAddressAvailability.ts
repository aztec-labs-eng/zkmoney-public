import { Network } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig } from "../../config/env"
import { useOxideTuple } from "./useOxideTuple"

/** Testnet has no swap stack; sandbox and mainnet both deploy one. */
export const networkHasSwapStack = (network: Network) =>
  network === Network.MAINNET || network === Network.SANDBOX

/**
 * Preview builds set this so the fresh-address screens can be viewed on a network without a swap
 * stack. The sheet's quotes stay unavailable there, so nothing can be confirmed.
 */
const SHOWCASE = import.meta.env.VITE_FRESH_ADDRESS_SHOWCASE === "true"

/** The optional manifest fields a fresh-address quote or burn reads. */
const REQUIRED: readonly (keyof OxideEnvTuple)[] = [
  "swapEscrowFactoryV2",
  "operationExecutor",
  "accountFactory",
  "l2Broadcaster",
  "plainWithdrawalExecutor",
]

/**
 * Whether this deployment can run a fresh-address withdrawal: the gas share rides a swap escrow, so
 * the network must carry a swap stack and the manifest must name every contract the quotes and
 * burns read. `undefined` until the manifest answers; one that cannot be read fails
 * closed.
 */
export function useFreshAddressAvailable(): boolean | undefined {
  const swapStack = networkHasSwapStack(getConfig().network)
  const tuple = useOxideTuple(!SHOWCASE && swapStack)
  if (SHOWCASE) return true
  if (!swapStack) return false
  return tuple === undefined ? undefined : REQUIRED.every((field) => !!tuple?.[field]?.trim())
}
