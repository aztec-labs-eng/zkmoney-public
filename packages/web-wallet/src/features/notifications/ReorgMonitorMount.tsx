/**
 * Runs the reorg monitor while the tab is visible; its outcomes are the bell's reorg notices.
 */

import { useEffect } from "react"
import { createReorgMonitor, useAztecContext } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { useSession } from "../../platform/session"
import { whenVisibilityChanges } from "../../platform/visibilityScheduler"
import { recordReorgOutcome } from "./notifications"

export function ReorgMonitorMount(): null {
  const { obsidionWallet } = useAztecContext()
  const { activity, notifications } = useSession()

  useEffect(() => {
    if (!obsidionWallet) return
    const monitor = createReorgMonitor({
      wallet: obsidionWallet,
      storage: webStorage,
      activity,
      onOutcome: (outcome) => recordReorgOutcome(notifications, outcome),
    })
    // A pass costs a receipt read per watched payment, and nothing reads the result until the tab
    // is looked at again; returning to it runs a side-effect pass before the loop resumes.
    const unwatch = whenVisibilityChanges({
      onShow: () => {
        monitor.start()
        monitor.requestPass({ sideEffects: true })
      },
      onHide: () => monitor.stop(),
    })
    return () => {
      unwatch()
      monitor.stop()
    }
  }, [obsidionWallet, activity, notifications])

  return null
}
