/**
 * The wait on a connected wallet's signing prompt. The request cannot be withdrawn once sent, so a
 * stalled sheet offers a way back to its form while the wallet keeps the request open, and refuses
 * a second request until the wallet answers the first. The page holds the one request: a sheet that
 * closes and reopens while the wallet still holds it sees the same request.
 */
import { useEffect, useState } from "react"
import { memoryStore, useStore, type ReadonlyStore } from "@obsidion/front-core"
import { useSession } from "./session"

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
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (!waiting) {
      setStalled(false)
      return
    }
    // eslint-disable-next-line local/timer-in-view -- ZKM-1806
    const timer = setTimeout(() => setStalled(true), ms)
    return () => clearTimeout(timer)
  }, [waiting, ms])
  return waiting && stalled
}

export type WalletPromptToken = number

type OpenRequest = { token: WalletPromptToken; abandoned: boolean }

/** The page's one wallet request. */
export interface WalletPrompt {
  /** The request begun and not yet answered. */
  readonly request: ReadonlyStore<OpenRequest | undefined>
  /** Opens the sheet's one request; throws `WalletPromptOpenError` while another is open. */
  begin(): WalletPromptToken
  /** The wallet answered. A token `begin` never issued is ignored. */
  settle(token?: WalletPromptToken): void
  /** The sheet stops waiting; the request stays open in the wallet until it answers. */
  cancel(): void
  /** Whether the sheet left before this request's outcome arrived. */
  cancelled(token?: WalletPromptToken): boolean
  /** The refusal for a new request while the wallet holds one the sheet stopped waiting on. */
  openElsewhere(): string | undefined
}

export function createWalletPrompt(): WalletPrompt {
  const request = memoryStore<OpenRequest | undefined>(undefined)
  let issued = 0
  return {
    request: request.readonly,
    begin() {
      if (request.get()) throw new WalletPromptOpenError()
      const token = ++issued
      request.set({ token, abandoned: false })
      return token
    },
    settle(token) {
      if (token !== undefined && request.get()?.token === token) request.set(undefined)
    },
    cancel() {
      const open = request.get()
      if (open) request.set({ ...open, abandoned: true })
    },
    cancelled(token) {
      const open = request.get()
      return token !== undefined && open?.token === token && open.abandoned
    },
    openElsewhere: () => (request.get()?.abandoned ? OPEN_MESSAGE : undefined),
  }
}

/** The page's wallet request as a sheet sees it. */
export function useWalletPrompt() {
  const prompt = useSession().page.walletPrompt
  const open = useStore(prompt.request)
  return {
    ...prompt,
    /** A request is begun and not yet answered. */
    open: open !== undefined,
    openElsewhere: open?.abandoned ? OPEN_MESSAGE : undefined,
  }
}
