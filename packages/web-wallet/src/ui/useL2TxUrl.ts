import { l2ExplorerTxEffectsBase, UNREAD, useStore } from "@obsidion/front-core"
import { useSession } from "../session/session"

/**
 * The L2 explorer link for each hash of a row made on rollup `networkId`: a retired generation's row
 * links to that generation's explorer. Null while the rollup resolves, so no link opens on the
 * wrong explorer.
 */
export function useL2TxUrl(networkId: string | undefined): ((txHash: string) => string) | null {
  const session = useSession()
  const { config, chain } = session.page
  const active = useStore(session.page.networkId)
  const retired = !!networkId && networkId.toLowerCase() !== active?.toLowerCase()
  const major = useStore(retired ? chain.retiredRollupMajor(networkId) : UNREAD)
  if (retired && major.status !== "ready") return null
  const retiredMajor = major.status === "ready" ? major.value ?? undefined : undefined
  const base = l2ExplorerTxEffectsBase(config.network, config.nodeUrl, retiredMajor)
  return (txHash) => `${base}${txHash}`
}
