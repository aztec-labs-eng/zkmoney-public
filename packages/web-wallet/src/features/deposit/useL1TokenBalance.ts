import { memoryStore, useStore, type QueryState, type ReadonlyStore } from "@obsidion/front-core"
import type { Address } from "viem"
import { useSession } from "../../session/session"
import type { L1TokenBalance } from "./l1DepositTokenBalance"

export type { L1TokenBalance }

/** No wallet connected: nothing to read. */
const UNREAD: ReadonlyStore<QueryState<never>> = memoryStore({
  status: "pending",
} as const).readonly

const answer = (s: QueryState<L1TokenBalance>) => (s.status === "ready" ? s.value : undefined)

/**
 * The connected wallet's L1 balance of `token` (default: the manifest token), from the page's
 * query. The receive form uses it as the amount ceiling.
 */
export function useL1TokenBalance(opts: {
  account: Address | null
  token?: Address
}): L1TokenBalance | undefined {
  const { account, token } = opts
  const { page } = useSession()
  return useStore(account ? page.l1Balance(account, token) : UNREAD, answer)
}
