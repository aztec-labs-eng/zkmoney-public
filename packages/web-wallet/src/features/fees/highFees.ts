import { Network } from "@obsidion/core/constants"
import {
  memoryStore,
  type QueryFactory,
  type QueryState,
  type ReadonlyStore,
  type Service,
} from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

const POLL_MS = 60_000
/** A read the notice never makes, or has not made yet. */
export const UNREAD: ReadonlyStore<QueryState<never>> = memoryStore({
  status: "pending",
} as const).readonly

export type HighFees = ReturnType<typeof highFees>

/** The fee reads Home warns on, each read every minute while a notice subscribes. */
export function highFees(
  query: QueryFactory,
  config: WebWalletConfig,
  wallet: Pick<Service<Pick<ObsidionWallet, "sponsoredFeesAboveCap">>, "ready">,
) {
  let client: ReturnType<typeof l1PublicClient> | undefined
  return {
    /** L1 gas price in wei; never read on the sandbox, whose price says nothing about real fees. */
    gasPrice:
      config.network === Network.SANDBOX
        ? UNREAD
        : query("l1GasPrice", {
            load: () => (client ??= l1PublicClient(config)).getGasPrice(),
            poll: POLL_MS,
          })(),
    /** Whether Aztec fees are above what the ClaimFPC sponsors; read once the wallet is built. */
    aboveCap: query<[], boolean>("sponsoredFeeCap", {
      load: async (signal) => (await wallet.ready(signal)).sponsoredFeesAboveCap(),
      poll: POLL_MS,
    })(),
  }
}
