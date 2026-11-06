import { useEffect, useRef, useState } from "react"

/** A screen's commands and state, built per mount. `start` runs once the screen shows. */
export interface ScreenFlow {
  start(signal: AbortSignal): void
}

/**
 * Builds the screen's flow once per mount, starts it, and aborts it when the screen goes. A
 * StrictMode replay aborts the first start and starts it again. The flow reads `inputs` through
 * `live`, which answers with the latest render's.
 */
export function useScreenFlow<I, F extends ScreenFlow>(inputs: I, open: (live: () => I) => F): F {
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
