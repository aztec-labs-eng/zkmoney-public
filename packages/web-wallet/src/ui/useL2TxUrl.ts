import { getActiveNetworkId, l2ExplorerTxEffectsBase } from "@obsidion/front-core"
import { useEffect, useState } from "react"
import { getConfig } from "../config/env"
import { retiredRollupMajor } from "../platform/sourceGeneration"

/**
 * The L2 explorer link for each hash of a row made on rollup `networkId`: a retired generation's row
 * links to that generation's explorer. Null while the rollup resolves, so no link opens on the
 * wrong explorer.
 */
export function useL2TxUrl(networkId: string | undefined): ((txHash: string) => string) | null {
  const { network, nodeUrl } = getConfig()
  const current = !networkId || networkId.toLowerCase() === getActiveNetworkId()?.toLowerCase()
  const [resolved, setResolved] = useState<{ networkId: string; major?: string }>()
  useEffect(() => {
    if (current) return
    let cancelled = false
    void retiredRollupMajor(networkId).then(
      (major) => !cancelled && setResolved({ networkId, major }),
    )
    return () => {
      cancelled = true
    }
  }, [current, networkId])
  if (!current && resolved?.networkId !== networkId) return null
  const base = l2ExplorerTxEffectsBase(network, nodeUrl, current ? undefined : resolved?.major)
  return (txHash) => `${base}${txHash}`
}
