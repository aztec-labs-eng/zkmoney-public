/**
 * The browser's own leave prompt while leaving would lose a transaction. Moving between screens
 * never triggers it: operations outlive the screen that started them.
 */
import { useEffect } from "react"
import { fireEvent } from "../../lib/analytics"
import { getTabBoundOperation, useLeavingLosesTransaction } from "./operations"

export function LeaveGuardMount(): null {
  const guarded = useLeavingLosesTransaction()
  useEffect(() => {
    if (!guarded) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
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
