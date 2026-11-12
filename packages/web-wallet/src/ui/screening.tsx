import { useCallback, useEffect } from "react"
import { useLookup, useScreener, useScreenings, type ScreeningReason } from "@obsidion/front-core"
import { fireEvent } from "../lib/analytics"

/** `error` means the verdict is unknown: gate flows on "compliant", never on "not blocked". */
export type ScreeningVerdict = {
  /** Lowercased, so callers compare against `input.toLowerCase()`. */
  address: string
  status: "screening" | "compliant" | "blocked" | "error"
  /** Set only when blocked and the policy attached one. */
  reason?: ScreeningReason
} | null

/**
 * Screen one address (the current field or account value) on the chain it sends from, the L1 when
 * `chainId` is unset, and hold the verdict only while it still matches — a stale verdict must never
 * clear a new address. A blocked verdict reports the flow to analytics (never the address). `late`
 * once `waitMs` passes with no verdict.
 */
export function useScreenedAddress(
  address: string | null,
  flow: "deposit" | "withdraw" | "deposit-exit",
  opts: { debounceMs?: number; waitMs?: number; chainId?: number } = {},
) {
  const screener = useScreener()
  const screenings = useScreenings()
  const { chainId } = opts
  const onChain = useCallback((a: string) => screenings(a, chainId), [screenings, chainId])
  const asked = address?.trim().toLowerCase() || undefined
  const lookup = useLookup(asked, onChain, {
    delayMs: opts.debounceMs ?? 0,
    lateMs: opts.waitMs,
  })
  const verdict: ScreeningVerdict = !asked
    ? null
    : lookup.status === "answered"
    ? lookup.value.compliant
      ? { address: asked, status: "compliant" }
      : { address: asked, status: "blocked", reason: lookup.value.reason }
    : { address: asked, status: lookup.status === "failed" ? "error" : "screening" }
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (verdict?.status === "blocked") fireEvent("screening_blocked", { flow })
  }, [verdict?.status, verdict?.address, flow])

  return {
    screener,
    verdict,
    cleared: verdict?.status === "compliant",
    late: lookup.status === "waiting" && lookup.late,
    rescreen: lookup.retry,
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
