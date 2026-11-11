import { useEffect, useState } from "react"

/** Past this, a run's page says it is taking longer than expected (Figma 423:2188, 424:2798). */
export const SLOW_AFTER_MS = 10 * 60_000

/** How long `active` has held; undefined before it first holds. */
export function useElapsed(active: boolean): number | undefined {
  const [since, setSince] = useState<number>()
  const [now, setNow] = useState(Date.now)
  // eslint-disable-next-line local/effect-hook -- ZKM-1625
  useEffect(() => {
    if (!active) return
    setSince((at) => at ?? Date.now())
    // eslint-disable-next-line local/timer-in-view -- ZKM-1625
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [active])
  return since === undefined ? undefined : Math.max(0, now - since)
}
