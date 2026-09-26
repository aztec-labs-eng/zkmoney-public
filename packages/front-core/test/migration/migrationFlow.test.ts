import { describe, expect, it } from "vitest"
import {
  advanceMigration,
  MAX_DEPOSIT_ATTEMPTS,
  MigrationStepError,
  newMigrationRecord,
  retryMigrationRecord,
  type ExitOperationEntry,
  type MigrationRecord,
  type MigrationSteps,
} from "../../src/index.js"

// Deterministic clock (advanceMigration takes an injected clock).
let t = 1000
const clock = () => (t += 1)

const entryFor = (unitKey: string): ExitOperationEntry => ({
  operationId: `0xop:${unitKey}`,
  broadcastAtL2Block: 99,
  nullifiers: [`0xn:${unitKey}`],
  state: "broadcast" as const,
})

/** Recording fake steps; each returns landed=false unless overridden. */
function fakeSteps(over: Partial<MigrationSteps> = {}) {
  const calls: string[] = []
  // Flip to model the relayer executing; until then published operations stay `broadcast`.
  const executor = { ran: false }
  const steps: MigrationSteps = {
    async buildExit() {
      calls.push("buildExit")
      return { amount: "800000", freezeBlock: 42 }
    },
    async withdrawalLanded(record) {
      calls.push("withdrawalLanded")
      // Landed once every published operation executed — the shape the chain reconciler reads.
      const entries = Object.values(record.operations ?? {}).flatMap((b) => Object.values(b))
      return entries.length > 0 && entries.every((e) => e.state === "executed")
    },
    async submitWithdrawal(record) {
      calls.push("submitWithdrawal")
      // A batch per invocation; broadcast units are gated out of the next selection, so the
      // second call reports exhaustion and the machine moves on.
      if (record.operations?.account?.[0]) return { kind: "none-remaining" as const }
      return {
        kind: "broadcast-many" as const,
        entries: [{ unitKey: "account", batch: 0, entry: entryFor("account") }],
      }
    },
    async reconcileOperations(record) {
      calls.push("reconcileOperations")
      // Stands in for the executor: everything published reads executed on the next look.
      const next: typeof record.operations = {}
      for (const [unitKey, batches] of Object.entries(record.operations ?? {})) {
        next[unitKey] = {}
        for (const [batch, entry] of Object.entries(batches)) {
          next[unitKey][Number(batch)] = executor.ran ? { ...entry, state: "executed" } : entry
        }
      }
      return next
    },
    async canonicalAccount() {
      return "0xaccount"
    },
    async reclaimed() {
      calls.push("reclaimed")
      return false
    },
    async reclaim() {
      calls.push("reclaim")
    },
    ...over,
  }
  return { steps, calls, executor }
}

const persistTo =
  (sink: MigrationRecord[]): ((r: MigrationRecord) => Promise<void>) =>
  async (r) => {
    sink.push(structuredClone(r))
  }

describe("advanceMigration", () => {
  it("rests at awaitingExecution, then reaches done once the operation executes", async () => {
    const { steps, calls, executor } = fakeSteps()
    const saved: MigrationRecord[] = []
    // Pass 1: everything publishable is published, and the machine yields — completion is a
    // relayer's transaction, so a driver that looped would burn battery waiting on it.
    const resting = await advanceMigration(
      newMigrationRecord("m1", 4, clock()),
      steps,
      persistTo(saved),
      clock,
    )
    expect(resting.phase).toBe("awaitingExecution")
    expect(resting.amount).toBe("800000")
    expect(resting.freezeBlock).toBe(42)
    expect(resting.operations?.account?.[0]).toMatchObject({
      operationId: "0xop:account",
      state: "broadcast",
    })
    expect(resting.endTime).toBeUndefined()

    // Pass 2: the re-drive the provider schedules, after a relayer executed the operation.
    executor.ran = true
    const out = await advanceMigration(resting, steps, persistTo(saved), clock)
    expect(out.phase).toBe("done")
    expect(out.operations?.account?.[0]?.state).toBe("executed")
    expect(out.endTime).toBeGreaterThan(0)
    expect(calls).toEqual([
      "buildExit",
      "submitWithdrawal",
      "withdrawalLanded",
      "submitWithdrawal",
      "withdrawalLanded",
      // Pass 1 ends here: reconciled, still unexecuted, so it rests.
      "reconcileOperations",
      "withdrawalLanded",
      // Pass 2.
      "reconcileOperations",
      "withdrawalLanded",
      "reclaimed",
      "reclaim",
    ])
    // Each transition persisted, plus one in-place save per batch: its entries must be durable
    // before anything else can throw, or the retry would rebroadcast live operations.
    expect(saved.map((r) => r.phase)).toEqual([
      "exiting",
      "withdrawing",
      "withdrawing",
      "awaitingExecution",
      "awaitingExecution",
      "awaitingExecution",
      "reclaiming",
      "done",
    ])
  })

  it("resume after a kill at reclaiming: does NOT re-exit or re-withdraw", async () => {
    // Persisted state as if the app died after the withdrawal landed.
    const resumed: MigrationRecord = {
      localId: "m2",
      rollupVersion: 4,
      phase: "reclaiming",
      amount: "800000",
      freezeBlock: 42,
      startTime: 1,
      phaseEnteredAt: 2,
    }
    const { steps, calls } = fakeSteps()
    const out = await advanceMigration(resumed, steps, persistTo([]), clock)
    expect(out.phase).toBe("done")
    expect(calls).not.toContain("buildExit")
    expect(calls).not.toContain("submitWithdrawal")
    expect(calls).toEqual(["reclaimed", "reclaim"])
  })

  it("a landed withdrawal produces no new operation before the aggregate reconcile", async () => {
    const atWithdraw: MigrationRecord = {
      localId: "m3",
      rollupVersion: 4,
      phase: "withdrawing",
      amount: "800000",
      freezeBlock: 42,
      startTime: 1,
      phaseEnteredAt: 2,
    }
    const { steps, calls } = fakeSteps({
      async submitWithdrawal() {
        calls.push("submitWithdrawal")
        return { kind: "none-remaining" }
      },
      async withdrawalLanded() {
        return true // already on chain
      },
    })
    const out = await advanceMigration(atWithdraw, steps, persistTo([]), clock)
    expect(out.phase).toBe("done")
    expect(calls).toContain("submitWithdrawal")
    expect(out.operations).toBeUndefined()
  })

  it("reclaim already done on chain is not re-run", async () => {
    const { steps, calls, executor } = fakeSteps({ async reclaimed() {
      return true
    } })
    const resting = await advanceMigration(
      newMigrationRecord("m4", 4, clock()),
      steps,
      persistTo([]),
      clock,
    )
    executor.ran = true
    const out = await advanceMigration(resting, steps, persistTo([]), clock)
    expect(out.phase).toBe("done")
    expect(calls).not.toContain("reclaim")
  })

  it("a throwing step terminalizes to failed with the message; no later steps run", async () => {
    const { steps, calls } = fakeSteps({ async submitWithdrawal(): Promise<never> {
      throw new Error("L1 revert")
    } })
    const saved: MigrationRecord[] = []
    const out = await advanceMigration(
      newMigrationRecord("m5", 4, clock()),
      steps,
      persistTo(saved),
      clock,
    )
    expect(out.phase).toBe("failed")
    expect(out.error).toBe("L1 revert")
    expect(calls).not.toContain("reclaim")
    // failed is persisted with an endTime stamp
    expect(saved.at(-1)?.phase).toBe("failed")
    expect(saved.at(-1)?.endTime).toBeGreaterThan(0)
  })

  it("buildExit residuals + depositAttempts merge onto the record and survive to done", async () => {
    const residuals = [{ sipaAddress: "0xsipa1", reason: "missing-message-secret" }]
    const depositAttempts = { "0xsipa2:7": MAX_DEPOSIT_ATTEMPTS }
    const { steps, executor } = fakeSteps({
      async buildExit() {
        return { amount: "100", freezeBlock: 42, residuals, depositAttempts }
      },
    })
    const saved: MigrationRecord[] = []
    // Pass 1 publishes and rests — completion waits on a relayer, so `done` is never one pass away.
    const resting = await advanceMigration(
      newMigrationRecord("m7", 4, clock()),
      steps,
      persistTo(saved),
      clock,
    )
    expect(resting.phase).toBe("awaitingExecution")
    expect(resting.residuals).toEqual(residuals)

    executor.ran = true
    const out = await advanceMigration(resting, steps, persistTo(saved), clock)
    expect(out.phase).toBe("done")
    expect(out.residuals).toEqual(residuals)
    expect(out.depositAttempts).toEqual(depositAttempts)
    // done-with-residual: the terminal persisted record names the residual, never log-only.
    expect(saved.at(-1)?.residuals).toEqual(residuals)
  })

  it("a MigrationStepError recordPatch lands on the failed record; retry preserves it", async () => {
    const { steps } = fakeSteps({
      async buildExit(): Promise<{ amount: string; freezeBlock: number }> {
        throw new MigrationStepError("deposit 0xsipa:3 transient", {
          depositAttempts: { "0xsipa:3": 1 },
        })
      },
    })
    const out = await advanceMigration(
      newMigrationRecord("m8", 4, clock()),
      steps,
      persistTo([]),
      clock,
    )
    expect(out.phase).toBe("failed")
    expect(out.error).toBe("deposit 0xsipa:3 transient")
    expect(out.depositAttempts).toEqual({ "0xsipa:3": 1 })
    // Rewind for retry keeps the attempt count — the bound accumulates across runs.
    const retried = retryMigrationRecord(out)
    expect(retried.phase).toBe("exiting")
    expect(retried.depositAttempts).toEqual({ "0xsipa:3": 1 })
  })

  // A residual can be discovered after the record left `exiting` (a deposit that exhausts its
  // attempts at `withdrawing`), so the landed reconcile carries record state, not just a verdict.
  it("withdrawalLanded may hand back residual state, which is merged and persisted", async () => {
    const residuals = [{ sipaAddress: "0xlate", reason: "max-attempts" as const }]
    const { steps } = fakeSteps({
      async withdrawalLanded(record) {
        const entries = Object.values(record.operations ?? {}).flatMap((b) => Object.values(b))
        return { landed: entries.length > 0 && entries.every((e) => e.state === "executed"), residuals }
      },
    })
    const saved: MigrationRecord[] = []
    const out = await advanceMigration(
      newMigrationRecord("m12", 4, clock()),
      steps,
      persistTo(saved),
      clock,
    )
    expect(out.residuals).toEqual(residuals)
    // Persisted at the resting phase too — a record that never advances must still name it.
    expect(saved.at(-1)?.residuals).toEqual(residuals)
  })

  it("a plain (non-step) error terminalizes without touching attempt state", async () => {
    const { steps } = fakeSteps({
      async buildExit(): Promise<{ amount: string; freezeBlock: number }> {
        throw new Error("rpc down")
      },
    })
    const start = { ...newMigrationRecord("m9", 4, clock()), depositAttempts: { "0xsipa:3": 2 } }
    const out = await advanceMigration(start, steps, persistTo([]), clock)
    expect(out.phase).toBe("failed")
    expect(out.depositAttempts).toEqual({ "0xsipa:3": 2 })
  })

  it("the persisted record never carries portal / recipient / L1 asset", async () => {
    const { steps } = fakeSteps()
    const saved: MigrationRecord[] = []
    await advanceMigration(newMigrationRecord("m6", 4, clock()), steps, persistTo(saved), clock)
    for (const r of saved) {
      const keys = Object.keys(r)
      expect(keys).not.toContain("portalAddress")
      expect(keys).not.toContain("recipient")
      expect(keys).not.toContain("l1Recipient")
      expect(keys).not.toContain("erc20Address")
    }
  })
})

describe("batched broadcast results", () => {
  it("persists every entry of a batch in one pass, before the reconcile", async () => {
    const { steps } = fakeSteps({
      async submitWithdrawal(record) {
        if (record.operations?.account?.[0]) return { kind: "none-remaining" as const }
        return {
          kind: "broadcast-many" as const,
          entries: ["account", "0xa", "0xb"].map((u) => ({
            unitKey: u,
            batch: 0,
            entry: entryFor(u),
          })),
        }
      },
    })
    const saved: MigrationRecord[] = []
    const out = await advanceMigration(newMigrationRecord("b1", 4, clock()), steps, persistTo(saved), clock)
    expect(out.phase).toBe("awaitingExecution")
    expect(Object.keys(out.operations ?? {})).toEqual(["account", "0xa", "0xb"])
    // The batch is one atomic transaction: all three entries land in a single in-place save.
    const firstWithOps = saved.find((r) => r.operations)
    expect(Object.keys(firstWithOps?.operations ?? {})).toEqual(["account", "0xa", "0xb"])
  })

  it("persists batch entries BEFORE surfacing a partial-batch failure, with any record patch", async () => {
    const { steps } = fakeSteps({
      async submitWithdrawal() {
        return {
          kind: "broadcast-many" as const,
          entries: [
            { unitKey: "account", batch: 0, entry: entryFor("account") },
            { unitKey: "0xa", batch: 0, entry: entryFor("0xa") },
          ],
          failure: {
            error: new MigrationStepError("deposit 0xsipa:9 transient", {
              depositAttempts: { "0xsipa:9": 1 },
            }),
          },
        }
      },
    })
    const saved: MigrationRecord[] = []
    const out = await advanceMigration(newMigrationRecord("b2", 4, clock()), steps, persistTo(saved), clock)
    expect(out.phase).toBe("failed")
    expect(out.error).toBe("deposit 0xsipa:9 transient")
    expect(out.depositAttempts).toEqual({ "0xsipa:9": 1 })
    // The live operations survived the failure — a retry must not rebroadcast them.
    expect(out.operations?.account?.[0]?.state).toBe("broadcast")
    expect(out.operations?.["0xa"]?.[0]?.state).toBe("broadcast")
    // And they were durable before the failed transition was written.
    const firstWithOps = saved.find((r) => r.operations)
    expect(firstWithOps?.phase).toBe("withdrawing")
    expect(Object.keys(firstWithOps?.operations ?? {})).toEqual(["account", "0xa"])
  })

  it("a zero-entry result with a failure terminalizes without recording operations", async () => {
    const { steps } = fakeSteps({
      async submitWithdrawal() {
        return {
          kind: "broadcast-many" as const,
          entries: [],
          failure: { error: new Error("first proof failed") },
        }
      },
    })
    const out = await advanceMigration(newMigrationRecord("b3", 4, clock()), steps, persistTo([]), clock)
    expect(out.phase).toBe("failed")
    expect(out.error).toBe("first proof failed")
    expect(out.operations).toBeUndefined()
  })

  it("a duplicate slice within one pass trips the re-offer guard", async () => {
    const { steps } = fakeSteps({
      async submitWithdrawal() {
        return {
          kind: "broadcast-many" as const,
          entries: [
            { unitKey: "account", batch: 0, entry: entryFor("account") },
            { unitKey: "account", batch: 0, entry: entryFor("account") },
          ],
        }
      },
    })
    const out = await advanceMigration(newMigrationRecord("b4", 4, clock()), steps, persistTo([]), clock)
    expect(out.phase).toBe("failed")
    expect(out.error).toMatch(/re-offered account#0/)
  })
})

describe("awaitingExecution", () => {
  it("enters only once every payload is broadcast, not after the first batch", async () => {
    // Three units over a 2-slot budget: the record must keep publishing rather than parking on
    // the first batch.
    const published: string[][] = []
    const { steps } = fakeSteps({
      async submitWithdrawal(record) {
        const done = new Set(Object.keys(record.operations ?? {}))
        const next = ["account", "0xa", "0xb"].filter((u) => !done.has(u)).slice(0, 2)
        if (next.length === 0) return { kind: "none-remaining" as const }
        published.push(next)
        return {
          kind: "broadcast-many" as const,
          entries: next.map((u) => ({ unitKey: u, batch: 0, entry: entryFor(u) })),
        }
      },
    })
    const saved: MigrationRecord[] = []
    const out = await advanceMigration(newMigrationRecord("m7", 4, clock()), steps, persistTo(saved), clock)

    expect(published).toEqual([["account", "0xa"], ["0xb"]])
    expect(out.phase).toBe("awaitingExecution")
    // All operations are live; parking after the first batch would strand the third.
    expect(Object.keys(out.operations ?? {})).toEqual(["account", "0xa", "0xb"])
    // The FIRST time it rests, every operation is already live — never a partial set.
    const firstRest = saved.find((r) => r.phase === "awaitingExecution")
    expect(Object.keys(firstRest?.operations ?? {})).toEqual(["account", "0xa", "0xb"])
  })

  it("re-enters withdrawing when an operation goes stale, and rebroadcasts it", async () => {
    let reconciles = 0
    const { steps } = fakeSteps({
      async reconcileOperations(record) {
        reconciles++
        const next: typeof record.operations = {}
        for (const [unitKey, batches] of Object.entries(record.operations ?? {})) {
          next[unitKey] = {}
          for (const [batch, entry] of Object.entries(batches)) {
            // Reconcile 1 lands in the publishing pass and is ignored by design. Reconcile 2 is
            // the first that can take effect: the broadcast finalized unexecuted, so no new
            // relayer can find it. The rebuild then executes.
            next[unitKey][Number(batch)] =
              reconciles <= 2 ? { ...entry, state: "stale" } : { ...entry, state: "executed" }
          }
        }
        return next
      },
    })
    const saved: MigrationRecord[] = []
    // Pass 1 publishes and rests. The freshly-broadcast entry is deliberately NOT judged here —
    // a relayer has had no chance to act on it yet.
    const resting = await advanceMigration(
      newMigrationRecord("m8", 4, clock()),
      steps,
      persistTo(saved),
      clock,
    )
    expect(resting.operations?.account?.[0]?.state).toBe("broadcast")

    // Pass 2 finds it stale — the node no longer serves the payload — so the machine goes BACK
    // to withdrawing and rebuilds rather than waiting forever on something undiscoverable.
    const out = await advanceMigration(resting, steps, persistTo(saved), clock)
    const phases = saved.map((r) => r.phase)
    expect(phases.lastIndexOf("withdrawing")).toBeGreaterThan(phases.indexOf("awaitingExecution"))
    expect(reconciles).toBeGreaterThan(1)
    expect(out.phase).toBe("done")
  })

  it("stops when the active account no longer matches the pinned one", async () => {
    const { steps } = fakeSteps({ async canonicalAccount() {
      return "0xdifferent"
    } })
    const pinned: MigrationRecord = {
      ...newMigrationRecord("m9", 4, clock()),
      phase: "awaitingExecution",
      canonicalAccount: "0xaccount",
    }
    const out = await advanceMigration(pinned, steps, persistTo([]), clock)
    // Rebuilding for another account would pay an address this run's discovery never searches.
    expect(out.phase).toBe("failed")
    expect(out.error).toMatch(/0xaccount/)
  })

  it("pins the canonical account on the first pass", async () => {
    const { steps } = fakeSteps()
    const out = await advanceMigration(newMigrationRecord("m10", 4, clock()), steps, persistTo([]), clock)
    expect(out.canonicalAccount).toBe("0xaccount")
  })
})

describe("fresh broadcasts are not judged in the same pass", () => {
  it("does not mark any operation of a fresh batch stale in the pass that published it", async () => {
    // A reconciler that calls everything stale — the shape a fast chain produces when the
    // broadcast's own block already reads finalized.
    const { steps } = fakeSteps({
      async submitWithdrawal(record) {
        if (record.operations?.account?.[0]) return { kind: "none-remaining" as const }
        return {
          kind: "broadcast-many" as const,
          entries: [
            { unitKey: "account", batch: 0, entry: entryFor("account") },
            { unitKey: "0xa", batch: 0, entry: entryFor("0xa") },
          ],
        }
      },
      async reconcileOperations(record) {
        const next: typeof record.operations = {}
        for (const [unitKey, batches] of Object.entries(record.operations ?? {})) {
          next[unitKey] = {}
          for (const [batch, entry] of Object.entries(batches)) {
            next[unitKey][Number(batch)] = { ...entry, state: "stale" }
          }
        }
        return next
      },
    })
    const out = await advanceMigration(
      newMigrationRecord("m11", 4, clock()),
      steps,
      persistTo([]),
      clock,
    )
    // Rebroadcasting here would put a second operation on the wire for slices that are still
    // perfectly live, and the re-offer guard would then fail the record.
    expect(out.phase).toBe("awaitingExecution")
    expect(out.operations?.account?.[0]?.state).toBe("broadcast")
    expect(out.operations?.["0xa"]?.[0]?.state).toBe("broadcast")
    expect(out.error).toBeUndefined()
  })
})
