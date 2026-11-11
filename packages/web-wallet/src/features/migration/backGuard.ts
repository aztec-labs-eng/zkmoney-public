import { useEffect, useRef } from "react"

/** While `active`, the browser's Back calls `onBack` and stays on the page. */
export function useBackGuard(active: boolean, onBack: () => void): void {
  const back = useRef(onBack)
  back.current = onBack
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!active) return
    history.pushState(history.state, "")
    const onPop = () => {
      history.pushState(history.state, "")
      back.current()
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      history.back()
    }
  }, [active])
}
