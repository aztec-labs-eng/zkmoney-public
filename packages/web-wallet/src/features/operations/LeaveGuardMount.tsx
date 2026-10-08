/**
 * The browser's own leave prompt while leaving would lose a transaction. Moving between screens
 * never triggers it: operations outlive the screen that started them. Nor does the reload of a tab
 * another tab took over: taking over already warned that it interrupts this tab's work.
 */
import { useEffect } from "react"
import { fireEvent } from "../../lib/analytics"
import { isActiveTab } from "../../platform/storage/activeTab"
import { getTabBoundOperation, useLeavingLosesTransaction } from "./operations"

export function LeaveGuardMount(): null {
  const guarded = useLeavingLosesTransaction()
  useEffect(() => {
    if (!guarded) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isActiveTab()) return
      event.preventDefault()
      // Browsers that predate `preventDefault` here prompt only on a non-empty returnValue.
      event.returnValue = ""
      fireEvent("proving_leave_prompted", {
        flow: getTabBoundOperation()?.flow,
      })
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [guarded])
  return null
}
