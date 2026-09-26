import { isDemoMode } from "../../../src/dev/demoFlag"
import { provingProgress } from "@obsidion/proving-progress"
import { runOperation, type OperationFlow } from "../../../src/features/operations/operations"
import { TX_HASH } from "./data"

const STATES = ["success", "post-signing-failure", "retry", "pending", "signing", "signing-failure", "signing-retry", "no-signing", "failure", "loading", "no-voucher", "claimed", "terminal", "warning"] as const
type FixtureState = (typeof STATES)[number]
const KEY = "ui-capture.flow-state"

/** Explicit capture-only control; a normal demo keeps its existing service behavior. */
export function fixtureState(): FixtureState | null {
  if (!isDemoMode()) return null
  const requested = new URLSearchParams(location.search).get("flowFixture")
  if (requested === "off") {
    sessionStorage.removeItem(KEY)
    return null
  }
  const value = requested ?? sessionStorage.getItem(KEY)
  if (value === null) return null
  if (!STATES.includes(value as FixtureState)) throw new Error(`Unknown flow fixture: ${value}`)
  sessionStorage.setItem(KEY, value)
  return value as FixtureState
}

export const pause = (ms = 900) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const attempts = new Map<string, number>()

/** The operation `inOperation` runs; user flows are single-flight, so there is at most one. */
let current: string | undefined
let operationSequence = 0

/**
 * Run a faked flow as its real one runs: inside one operation, so the hand-off, the bell and the
 * panel rows render as in production. `operation` marks it proving and sent along the way.
 */
export function inOperation<T>(
  flow: OperationFlow,
  summary: string,
  run: () => Promise<T>,
  txHashOf?: (result: T) => string | undefined,
): Promise<T> {
  const operationId = `capture-op-${++operationSequence}`
  return runOperation(
    { operationId, flow, summary },
    async () => {
      current = operationId
      try {
        return await run()
      } finally {
        current = undefined
      }
    },
    txHashOf,
  )
}

interface OperationOptions {
  operationId?: string
  /** The hash the flow's record holds once sent. */
  txHash?: string
  /** Persist a prepared result after the cancellation boundary, before any signing event. */
  onPrepared?: () => void | Promise<void>
}

/** A pending fixture deliberately never settles; closing its context releases its timers. */
export async function operation(name: string, onStage?: (stage: "proving" | "submitting") => void, signing = false, options: OperationOptions = {}) {
  const state = fixtureState()
  const attempt = (attempts.get(name) ?? 0) + 1
  attempts.set(name, attempt)
  await pause()
  if (state === "failure" || (state === "retry" && attempt === 1)) {
    throw new Error("The connection was interrupted. Try again.")
  }
  onStage?.("proving")
  await options.onPrepared?.()
  if (signing && state !== "no-signing") {
    provingProgress.emitSigningStart(options.operationId)
    if (state === "signing") await new Promise<void>(() => {})
    await pause(1400)
    const failed = state === "signing-failure" || (state === "signing-retry" && attempt === 1)
    provingProgress.emitSigningEnd(options.operationId, failed)
    if (failed) throw new Error("The signing request was declined. Try again.")
  }
  if (current) provingProgress.emitStageStart("proving", current)
  if (state === "pending") await new Promise<void>(() => {})
  await pause(2400)
  if (state === "post-signing-failure") throw new Error("The transaction could not be submitted. Try again.")
  if (current) provingProgress.emitTxHashSaved(current, options.txHash ?? TX_HASH)
  onStage?.("submitting")
  await pause()
}
