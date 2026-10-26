/**
 * Priority gate between user-initiated transactions and background proving (the SIPA pool
 * refill, a deposit address's broadcast, an upgrade's automatic step). Local proving is hard
 * single-flight — a second `sendTx` while one proves throws `LocalProvingInFlight` — and the PXE job
 * queue is FIFO with no priority, so a background proof in the wrong place makes a user's tx FAIL,
 * not just run slow. Mid-proof abort is not possible in the browser (the abort signal is only read
 * at phase boundaries, and bb.js has no cancellation API), so priority means three things:
 * background proofs run one at a time, none starts while a user flow is active, and a user flow
 * waits out a background proof already past the point of no return instead of colliding with it.
 *
 * Correctness leans on JS single-threading: `runUserFlow` raises the flag synchronously before
 * its first await, and a background proof starts in the same synchronous block that checks
 * `userFlowActive()` — no interleaving can slip between the two.
 */
import { useSyncExternalStore } from "react"
import { createExternalState } from "../lib/externalState"

const userFlows = createExternalState(0)
/** The background proof that started last. */
let backgroundProve: Promise<unknown> = Promise.resolve()
/** Settles once every background proof reserved so far has ended; unset while none is. */
let reserved: Promise<void> | undefined
const reservationsEnded = new Set<() => void>()

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
 * Reserve the prover for a background proof. With none reserved and no user flow running it starts
 * now; otherwise once every one reserved before it has ended and no user flow runs. User flows
 * raised after it starts wait it out. The failure still belongs to the caller — a failed background
 * proof must never fail a user flow. Never call it from inside a reserved proof or a user flow: it
 * would wait on itself.
 */
export function trackBackgroundProve<T>(start: () => Promise<T>): Promise<T> {
  const begin = () => {
    const started = start()
    backgroundProve = started.catch(() => {})
    return started
  }
  const run =
    !reserved && !userFlowActive()
      ? begin()
      : (reserved ?? Promise.resolve()).then(async () => {
          while (userFlowActive()) await userFlowsIdle()
          return begin()
        })
  const tail: Promise<void> = run.then(
    () => release(tail),
    () => release(tail),
  )
  reserved = tail
  return run
}

function release(tail: Promise<void>): void {
  if (reserved !== tail) return
  reserved = undefined
  for (const listener of [...reservationsEnded]) listener()
}

/**
 * True while a background proof is reserved. A caller that must not wait its turn, because the
 * user's flow may wait on it, defers instead.
 */
export function backgroundProveReserved(): boolean {
  return !!reserved
}

/** Calls `listener` each time the last reserved background proof ends. */
export function onBackgroundProvesEnded(listener: () => void): () => void {
  reservationsEnded.add(listener)
  return () => reservationsEnded.delete(listener)
}

/** Calls `listener` each time the last user flow ends: background work held behind it may start. */
export function onUserFlowsIdle(listener: () => void): () => void {
  return userFlows.subscribe(() => {
    if (!userFlowActive()) listener()
  })
}

function userFlowsIdle(): Promise<void> {
  return new Promise((resolve) => {
    const off = onUserFlowsIdle(() => {
      off()
      resolve()
    })
  })
}
