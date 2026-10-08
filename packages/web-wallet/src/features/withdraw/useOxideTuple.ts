import { useEffect, useState } from "react"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig } from "../../config/env"
import { getOxideTuple } from "../../config/oxideTuple"

/** The manifest tuple: `undefined` while pending or disabled, `null` when it cannot be read. */
export function useOxideTuple(enabled = true): OxideEnvTuple | null | undefined {
  const [tuple, set] = useState<OxideEnvTuple | null>()
  useEffect(() => {
    // Async, so a synchronous throw from the read also lands as `null`.
    if (enabled) void (async () => getOxideTuple(getConfig()))().then(set, () => set(null))
  }, [enabled])
  return tuple
}
