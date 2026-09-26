import { useCallback, useRef, useState } from "react"
import type { AddressScreener, ScreeningReason } from "../core"

export type AddressScreeningStatus = "screening" | "compliant" | "blocked" | "error"

export interface AddressScreeningResult {
  /** Lowercased, so callers compare against `input.toLowerCase()`. */
  address: string
  status: AddressScreeningStatus
  /** Set only when `status === "blocked"` and the policy attached one. */
  reason?: ScreeningReason
}

/**
 * Screen an L1 address as the user settles on it. The caller debounces and only calls `screen`
 * with a well-formed address (an empty string resets). Stale responses are ignored — only the
 * most recent `screen` call can win. `error` means the verdict is UNKNOWN: gate flows on
 * `status === "compliant"`, never on "not blocked".
 */
export function useAddressScreening(screener: AddressScreener) {
  const [lastScreened, setLastScreened] = useState<AddressScreeningResult | null>(null)

  // Address of the most-recent `screen` call, for discarding stale responses.
  const currentAddressRef = useRef<string | null>(null)

  const screen = useCallback(
    async (rawAddress: string) => {
      const address = rawAddress.trim().toLowerCase()
      if (!address) {
        currentAddressRef.current = null
        setLastScreened(null)
        return
      }

      currentAddressRef.current = address
      setLastScreened({ address, status: "screening" })

      try {
        const verdict = await screener.screen(rawAddress.trim())
        if (currentAddressRef.current !== address) return // stale
        setLastScreened(
          verdict.compliant
            ? { address, status: "compliant" }
            : { address, status: "blocked", reason: verdict.reason },
        )
      } catch {
        if (currentAddressRef.current !== address) return
        setLastScreened({ address, status: "error" })
      }
    },
    [screener],
  )

  return { lastScreened, screen }
}
