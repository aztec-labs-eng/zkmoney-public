import { liveStore } from "./liveStore"
import type { ReadonlyStore } from "./store"

/**
 * Wall time in ms, floored to `periodMs` and ticking only while something reads it, so selectors
 * take `now` as an input instead of running timers of their own. A reading lags by at most one
 * period. Given `visible`, it also stops while the page is hidden and ticks at once on its return.
 */
export function createClock(
  periodMs: number,
  now: () => number,
  visible?: ReadonlyStore<boolean>,
): ReadonlyStore<number> {
  const at = () => Math.floor(now() / periodMs) * periodMs
  let ticking = false
  const ticks = liveStore(at(), {
    whileSubscribed(set) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const tick = () => {
        clearTimeout(timer)
        set(at())
        if (visible && !visible.get()) return
        timer = setTimeout(tick, periodMs - (now() % periodMs))
      }
      ticking = true
      tick()
      const offVisible = visible?.subscribe(tick)
      return () => {
        ticking = false
        clearTimeout(timer)
        offVisible?.()
      }
    },
  })
  return { get: () => (ticking ? ticks.get() : at()), subscribe: ticks.subscribe }
}
