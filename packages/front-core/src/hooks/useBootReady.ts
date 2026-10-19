import { useEffect, useState } from "react"
import { bootPriority, type BootReader } from "../core/services/transactions/bootPriority"

/** Whether `reader` may start, per the boot order in `bootPriority`. */
export function useBootReady(reader: BootReader): boolean {
  const [ready, setReady] = useState(() => bootPriority.isReady(reader))
  useEffect(() => {
    if (ready) return
    let live = true
    void bootPriority.whenReady(reader).then(() => live && setReady(true))
    return () => {
      live = false
    }
  }, [reader, ready])
  return ready
}
