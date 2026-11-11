import { useEffect, useRef, useState } from "react"

/** A screen's commands and state, built per mount. `start` runs once the screen shows. */
export interface ScreenFlow {
  start(signal: AbortSignal): void
}

/**
 * Builds the screen's flow once per mount, starts it, and aborts it when the screen goes. A
 * StrictMode replay aborts the first start and starts it again. The flow reads the latest render's
 * `inputs` through `latest`.
 */
export function useScreenFlow<I, F extends ScreenFlow>(inputs: I, open: (latest: () => I) => F): F {
  const latest = useRef(inputs)
  latest.current = inputs
  const [flow] = useState(() => open(() => latest.current))
  useEffect(() => {
    const ended = new AbortController()
    flow.start(ended.signal)
    return () => ended.abort()
  }, [flow])
  return flow
}

/** A flow whose only work is to report the screen's opening: `fire` runs at its first start. */
export function openedFlow(fire: () => void): ScreenFlow {
  let opened = false
  return {
    start() {
      if (opened) return
      opened = true
      fire()
    },
  }
}

/** Reports the screen's opening once per mount, a StrictMode replay included. */
export function useOpened(fire: () => void): void {
  useScreenFlow(fire, (latest) => openedFlow(() => latest()()))
}
