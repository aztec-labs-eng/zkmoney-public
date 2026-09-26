/**
 * Priority gate between user-initiated transactions and background proving (the SIPA pool
 * refill). Local proving is hard single-flight — a second `sendTx` while one proves throws
 * `LocalProvingInFlight` — and the PXE job queue is FIFO with no priority, so a background proof
 * in the wrong place makes a user's tx FAIL, not just run slow. Mid-proof abort is not possible
 * in the browser (the abort signal is only read at phase boundaries, and bb.js has no
 * cancellation API), so priority means two things: background work never starts while a user
 * flow is active, and a user flow waits out a background proof already past the point of no
 * return instead of colliding with it.
 *
 * Correctness leans on JS single-threading: `runUserFlow` raises the flag synchronously before
 * its first await, and a background prover checks `userFlowActive()` in the same synchronous
 * block that calls `trackBackgroundProve` — no interleaving can slip between the two.
 */
import { useSyncExternalStore } from "react"
import { createExternalState } from "../lib/externalState"

const userFlows = createExternalState(0)
let backgroundProve: Promise<void> = Promise.resolve()

/** True while any user-initiated tx flow is running — background provers must not start. */
export function userFlowActive(): boolean {
  return userFlows.get() > 0
}

/** React view of `userFlowActive`: disable tx CTAs while a flow runs instead of letting `sendTx` throw. */
export function useUserFlowActive(): boolean {
  return useSyncExternalStore(userFlows.subscribe, userFlowActive)
}

/** Run a user-initiated tx flow: raise the flag, wait out any in-flight background proof. */
export async function runUserFlow<T>(flow: () => Promise<T>): Promise<T> {
  userFlows.set(userFlows.get() + 1)
  try {
    await backgroundProve
    return await flow()
  } finally {
    userFlows.set(userFlows.get() - 1)
  }
}

/**
 * Register a background proof as it starts so user flows can wait it out. The failure still
 * belongs to the caller — a failed background proof must never fail a user flow.
 */
export function trackBackgroundProve(start: () => Promise<void>): Promise<void> {
  const run = start()
  backgroundProve = run.catch(() => {})
  return run
}
