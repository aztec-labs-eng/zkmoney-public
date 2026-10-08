import type { ClaimFpcAllowance } from "@obsidion/sdk"
import { deriveAllowanceState, type SponsoredAllowanceState } from "./allowanceState"
import type { AllowanceUsage } from "./allowanceUsage"

/** One allowance read: the ClaimFPC instance and rail the account's batches use, and what it holds. */
export interface AllowanceRead {
  fpcAddress: string
  railId: number
  allowance: ClaimFpcAllowance
  /** Absent when the split could not be read; the count still stands. */
  usage?: AllowanceUsage
}

/**
 * The account and deployment an allowance belongs to. `key` must change with either, so a read for
 * one never shows under the other; `read` is bound to that account and deployment.
 */
export interface AllowanceScope {
  key: string
  read: () => Promise<AllowanceRead>
  /** What spent the allowance. Runs after the count is shown, so a slow split never holds it. */
  readUsage?: (read: AllowanceRead) => Promise<AllowanceUsage | undefined>
}

export type AllowanceSnapshot =
  | { status: "signed-out" }
  | { status: "loading"; scope: string }
  | {
      status: "ready"
      scope: string
      read: AllowanceRead
      state: SponsoredAllowanceState
      refreshing: boolean
    }
  | { status: "unavailable"; scope: string; error: unknown }

/**
 * The signed-in account's sponsored-transaction allowance. A scope change clears the previous
 * account's or deployment's read before anything renders. Each scope change starts a new
 * activation, and a response from an earlier activation is dropped, even when the key has come
 * back (A → B → A). When the last subscriber leaves, the store forgets the scope and its read.
 */
export class SponsoredAllowanceStore {
  private snapshot: AllowanceSnapshot = { status: "signed-out" }
  private scope: AllowanceScope | undefined
  private inFlight: Promise<void> | undefined
  private activation = 0
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): AllowanceSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.setScope(undefined)
    }
  }

  setScope(scope: AllowanceScope | undefined): void {
    if (!scope && !this.scope) return
    if (scope && scope.key === this.scope?.key) {
      this.scope = scope
      return
    }
    this.scope = scope
    this.activation++
    this.inFlight = undefined
    this.publish(scope ? { status: "loading", scope: scope.key } : { status: "signed-out" })
    if (scope) void this.refresh()
  }

  /** Read the current scope again; concurrent calls share one read. */
  refresh(): Promise<void> {
    const scope = this.scope
    if (!scope) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const activation = this.activation
    if (this.snapshot.status === "ready") this.publish({ ...this.snapshot, refreshing: true })
    const run = scope
      .read()
      .then(
        (fresh) => {
          if (activation !== this.activation) return
          // The last split stands until this read's own lands, so a refresh does not blink it.
          const previous = this.snapshot.status === "ready" ? this.snapshot.read.usage : undefined
          const read = { ...fresh, usage: fresh.usage ?? previous }
          this.publish({
            status: "ready",
            scope: scope.key,
            read,
            state: deriveAllowanceState(read.allowance),
            refreshing: false,
          })
          if (scope.readUsage) void this.attachUsage(scope.readUsage, read)
        },
        (error: unknown) => {
          if (activation !== this.activation) return
          this.publish({ status: "unavailable", scope: scope.key, error })
        },
      )
      .finally(() => {
        if (this.inFlight === run) this.inFlight = undefined
      })
    this.inFlight = run
    return run
  }

  private async attachUsage(
    readUsage: NonNullable<AllowanceScope["readUsage"]>,
    read: AllowanceRead,
  ): Promise<void> {
    const usage = await readUsage(read).catch(() => undefined)
    const current = this.snapshot
    if (current.status !== "ready" || current.read !== read) return
    this.publish({ ...current, read: { ...read, usage } })
  }

  private publish(snapshot: AllowanceSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
