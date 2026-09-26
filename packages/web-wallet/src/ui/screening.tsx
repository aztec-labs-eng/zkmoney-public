import { useEffect } from "react"
import { useAddressScreening, useScreener } from "@obsidion/front-core"
import { fireEvent } from "../lib/analytics"

export type ScreeningVerdict = ReturnType<typeof useAddressScreening>["lastScreened"]

/**
 * Screen one L1 address (the current field or account value) and hold the verdict only while it
 * still matches — a stale verdict must never clear a new address. A blocked verdict reports the
 * flow to analytics (never the address).
 */
export function useScreenedAddress(
  address: string | null,
  flow: "deposit" | "withdraw" | "deposit-exit",
  opts: { debounceMs?: number } = {},
) {
  const screener = useScreener()
  const { lastScreened, screen } = useAddressScreening(screener)
  const debounceMs = opts.debounceMs ?? 0
  useEffect(() => {
    if (!address) {
      void screen("")
      return
    }
    const timer = setTimeout(() => void screen(address), debounceMs)
    return () => clearTimeout(timer)
  }, [address, debounceMs, screen])

  const verdict =
    address && lastScreened?.address === address.toLowerCase() ? lastScreened : null
  useEffect(() => {
    if (verdict?.status === "blocked") fireEvent("screening_blocked", { flow })
  }, [verdict?.status, verdict?.address, flow])

  return {
    screener,
    verdict,
    cleared: verdict?.status === "compliant",
    rescreen: () => {
      if (address) void screen(address)
    },
  }
}

/** The three-branch screening caption (checking / blocked / verify-failed with Retry). */
export function ScreeningNotice({
  verdict,
  checkingCopy,
  blockedFallback,
  errorCopy,
  onRetry,
  style,
}: {
  verdict: ScreeningVerdict | null
  checkingCopy: string
  blockedFallback: string
  errorCopy: string
  onRetry: () => void
  style?: React.CSSProperties
}) {
  return (
    <div style={{ fontSize: 13, ...style }}>
      {(!verdict || verdict.status === "screening") && (
        <span style={{ color: "var(--text-secondary)" }}>{checkingCopy}</span>
      )}
      {verdict?.status === "blocked" && (
        <span style={{ color: "var(--accent-red, #e66)" }}>
          {verdict.reason?.message ?? blockedFallback}
        </span>
      )}
      {verdict?.status === "error" && (
        <span style={{ color: "var(--text-secondary)" }}>
          {errorCopy}{" "}
          <span
            role="button"
            onClick={onRetry}
            style={{ color: "var(--accent-green, #6c9)", cursor: "pointer" }}
          >
            Retry
          </span>
        </span>
      )}
    </div>
  )
}
