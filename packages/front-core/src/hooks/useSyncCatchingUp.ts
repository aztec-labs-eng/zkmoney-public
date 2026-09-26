import { useEffect, useState } from "react"
import { globalEventEmitter } from "../core/services/GlobalEventEmitter"

/** True while a chain scan rebuilds history (fresh device, PXE rebuild, or a cursor far behind head). */
export function useSyncCatchingUp(): boolean {
  const [catchingUp, setCatchingUp] = useState(() => globalEventEmitter.isSyncCatchingUp())
  useEffect(() => {
    setCatchingUp(globalEventEmitter.isSyncCatchingUp())
    globalEventEmitter.onSyncCatchUpChanged(setCatchingUp)
    return () => globalEventEmitter.offSyncCatchUpChanged(setCatchingUp)
  }, [])
  return catchingUp
}
