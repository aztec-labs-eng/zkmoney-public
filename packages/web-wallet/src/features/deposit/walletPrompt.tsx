/**
 * The wait on a connected wallet's signing prompt. The request cannot be withdrawn once sent, so a
 * stalled sheet offers a way back to its form while the wallet keeps the request open, and refuses
 * a second request until the wallet answers the first.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

export const WALLET_PROMPT_STALL_MS = 30_000

const OPEN_MESSAGE =
  "Your wallet still has the previous request open. Approve or reject it there first."

/** A new request was asked for while the wallet still holds the previous one. */
export class WalletPromptOpenError extends Error {
  constructor() {
    super(OPEN_MESSAGE)
    this.name = "WalletPromptOpenError"
  }
}

/** True once `waiting` has held for `ms` without a break. */
export function useWalletPromptStall(waiting: boolean, ms = WALLET_PROMPT_STALL_MS): boolean {
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setStalled(false)
      return
    }
    const timer = setTimeout(() => setStalled(true), ms)
    return () => clearTimeout(timer)
  }, [waiting, ms])
  return waiting && stalled
}

export type WalletPromptToken = number

export interface WalletPrompt {
  /** Opens the sheet's one request; throws `WalletPromptOpenError` while the previous one is open. */
  begin: () => WalletPromptToken
  /** The wallet answered. A token `begin` never issued is ignored. */
  settle: (token?: WalletPromptToken) => void
  /** The sheet stops waiting; the request stays open in the wallet until it answers. */
  cancel: () => void
  /** Whether the sheet left before this request's outcome arrived. */
  cancelled: (token?: WalletPromptToken) => boolean
  /** A request is begun and not yet answered. */
  open: boolean
  /** The refusal for a new request while the wallet holds one the sheet stopped waiting on. */
  openElsewhere: string | undefined
}

type OpenRequest = { token: WalletPromptToken; abandoned: boolean }

// The one request a connected wallet holds for this page, shared by every sheet: a sheet that closes
// and reopens while the wallet still holds it sees the same request.
let current: OpenRequest | undefined
let issued = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const set = (next: OpenRequest | undefined) => {
  current = next
  listeners.forEach((listener) => listener())
}

/** Forgets the open request. Tests use it between cases; in the app only the wallet's answer settles one. */
export function clearWalletPrompt(): void {
  set(undefined)
}

/** The page's one in-flight wallet request, as a sheet sees it. */
export function useWalletPrompt(): WalletPrompt {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => undefined,
  )
  const begin = useCallback(() => {
    if (current) throw new WalletPromptOpenError()
    const token = ++issued
    set({ token, abandoned: false })
    return token
  }, [])
  const settle = useCallback((token?: WalletPromptToken) => {
    if (token === undefined || current?.token !== token) return
    set(undefined)
  }, [])
  const cancel = useCallback(() => {
    if (current) set({ ...current, abandoned: true })
  }, [])
  const cancelled = useCallback(
    (token?: WalletPromptToken) =>
      token !== undefined && current?.token === token && current.abandoned,
    [],
  )
  return {
    begin,
    settle,
    cancel,
    cancelled,
    open: request !== undefined,
    openElsewhere: request?.abandoned ? OPEN_MESSAGE : undefined,
  }
}

/** The stall note under a sheet's wallet stage, with the way back to its form. */
export function WalletPromptNote({
  walletName,
  onCancel,
}: {
  walletName?: string | null
  onCancel?: () => void
}) {
  return (
    <p className="ww-sheet__note" role="status" data-testid="wallet-prompt-stall">
      Still waiting for {walletName ?? "your wallet"}. Open it to approve the request, or cancel and
      try again.
      {onCancel && (
        <>
          {" "}
          <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </p>
  )
}
