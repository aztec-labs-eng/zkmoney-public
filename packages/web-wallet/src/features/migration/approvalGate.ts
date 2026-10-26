/**
 * Each passkey prompt of an upgrade opens from the user's tap on "Use passkey" (Figma 2b and 3c).
 * A tap grants one prompt. A prompt with no grant asks for the next one and waits.
 */
import { useSyncExternalStore } from "react"
import { createExternalState } from "../../lib/externalState"

export interface ApprovalAsk {
  /** The approval asked for, counted from 1. */
  number: number
  total: number
}

let grants = 0
let waiter: { resolve: () => void; reject: (error: Error) => void } | undefined
const asked = createExternalState<ApprovalAsk | null>(null)

/** A tap on "Use passkey": the next prompt may open. */
export function grantApproval(): void {
  if (!waiter) {
    grants++
    return
  }
  const { resolve } = waiter
  waiter = undefined
  asked.set(null)
  resolve()
}

/** Cancel the asked approval and drop unused grants. A waiting prompt rejects as cancelled. */
export function resetApprovals(): void {
  grants = 0
  const pending = waiter
  waiter = undefined
  asked.set(null)
  pending?.reject(new Error("Cancelled"))
}

/** The run's `beforeApproval`. An abort of `signal` rejects the wait. */
export function beforeApproval(approved: number, total: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (grants > 0) {
    grants--
    return Promise.resolve()
  }
  waiter?.reject(new Error("Cancelled"))
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject }
    waiter = entry
    asked.set({ number: approved + 1, total })
    signal?.addEventListener(
      "abort",
      () => {
        if (waiter !== entry) return
        waiter = undefined
        asked.set(null)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export function useApprovalAsk(): ApprovalAsk | null {
  return useSyncExternalStore(asked.subscribe, asked.get)
}
