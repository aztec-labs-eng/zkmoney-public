/**
 * Whether this version's network has proven a checkpoint. Until it has, the upgrade and the zk.money
 * withdrawal wait ("Waiting for network"); the own-wallet route does not. Final once seen.
 */
import { memoryStore, serviceStatus, useStore, type QueryState } from "@obsidion/front-core"
import { useSession } from "../../session/session"

const UNREAD = memoryStore<QueryState<boolean>>({ status: "pending" }).readonly

/** True once the network has proven a checkpoint. */
export function useNetworkReady(): boolean {
  const { wallet, page } = useSession()
  const built = useStore(wallet, serviceStatus) === "ready"
  return useStore(built ? page.networkReady : UNREAD, (s) => s.status === "ready" && s.value)
}
