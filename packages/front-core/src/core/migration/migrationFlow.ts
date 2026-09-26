// The resumable migration state machine. A v4→v5 migration spans minutes of L1
// legs across a kill-able app, so the flow is a persisted phase machine that
// survives backgrounding/kill and resumes where it left off — the durable
// pattern is the bridge WithdrawalTrackingService + WithdrawalStorage, which
// production backs with the same RecordStorage kernel (inject `persist` with a
// RecordStorage-backed store; tests inject a fake).
//
// Two safety rules the driver enforces:
//   1. The persisted record NEVER holds portal / recipient / L1 asset. Those are
//      re-derived from chain by the injected steps on every run, so a stale or
//      tampered persisted blob cannot misdirect funds.
//   2. The app never submits an L1 transaction. It publishes an operation and a
//      third party executes it, so the bound on double-execution is the on-chain
//      nullifier guard, not client bookkeeping: two live operations for the same
//      batch can coexist, and the second simply reverts in the executor's own
//      profitability call. The submit seam checks chain spentness before it
//      returns a payload, and the driver reconciles after every submit attempt.
//      Those checks save a fee; they are not what makes the flow safe.

import type { DepositExitResidual } from "../services/deposits/depositExitCandidates"

export type MigrationPhase =
  | "discovering" // detect the frozen balance; nothing submitted yet
  | "exiting" // build the escape-door proof (read-only until submit — safe to re-run)
  | "withdrawing" // build + broadcast this round's operations, one batched tx per invocation
  | "awaitingExecution" // published; a third party executes them on L1 — see below
  | "reclaiming" // deposit the released ERC20 into the canonical portal + claim
  | "done" // terminal — funds live on the canonical generation
  | "failed" // terminal — a step threw; safe to retry from the persisted phase

export const MIGRATION_TERMINAL_PHASES: ReadonlySet<MigrationPhase> = new Set(["done", "failed"])

/** Non-benign deposit failures tolerated per deposit key before it converts to a residual. */
export const MAX_DEPOSIT_ATTEMPTS = 3

/** A deposit that could not be exited, named on the record (done-with-residual, never log-only). */
export interface MigrationResidual {
  sipaAddress: string
  /** Enumeration drops carry their own reason; `max-attempts` is the step layer giving up. */
  reason: DepositExitResidual["reason"] | "max-attempts"
}

/**
 * A step failure that must also patch the persisted record (e.g. incremented deposit
 * attempt counts) — `advanceMigration` merges `recordPatch` into the failed record.
 */
export class MigrationStepError extends Error {
  readonly recordPatch?: Pick<MigrationRecord, "depositAttempts" | "residuals">

  constructor(
    message: string,
    recordPatch?: Pick<MigrationRecord, "depositAttempts" | "residuals">,
  ) {
    super(message)
    this.name = "MigrationStepError"
    this.recordPatch = recordPatch
  }
}

/**
 * `broadcast` — published, awaiting an executor. `executed` — this batch's nullifiers read spent.
 * `stale` — the broadcast transaction finalized with them still unspent, so no NEW executor can
 * discover the payload. `stale` permits a rebuild; it does not assert the original is dead, and
 * repeating `stale → broadcast` is allowed. Capping the repeats would strand a record on the
 * second missed payload, which is the failure the state exists to prevent.
 */
export type ExitOperationState = "broadcast" | "executed" | "stale"

export interface ExitOperationEntry {
  /** Content hash of (target, payoutToken, calldata) — stable across a rebroadcast of the same bytes. */
  operationId: string
  /** L2 block the broadcast landed in; finality is read against this. */
  broadcastAtL2Block: number
  /**
   * This batch's nullifiers. Load-bearing rather than incidental: a unit-level landed check is
   * true only when EVERY candidate is spent, so it cannot tell whether a particular batch landed.
   */
  nullifiers: string[]
  state: ExitOperationState
}

/** Operations by unit key, then by batch index within that unit. */
export type ExitOperations = Record<string, Record<number, ExitOperationEntry>>

/** One broadcast operation's record entry, addressed by its unit and slice batch. */
export interface BroadcastEntryRef {
  unitKey: string
  batch: number
  entry: ExitOperationEntry
}

/**
 * One step invocation's outcome. A batched submit publishes up to the per-tx call budget in ONE
 * v5 transaction, so `entries` are live atomically. `failure` carries a proof-build error the
 * step captured after some payloads were already built and broadcast — the driver persists every
 * entry BEFORE surfacing it, so a retry cannot discard or rebroadcast live operations. Zero
 * entries with a failure means nothing was broadcast (the first proof failed).
 */
export type SubmitWithdrawalResult =
  | { kind: "broadcast-many"; entries: BroadcastEntryRef[]; failure?: { error: unknown } }
  | { kind: "none-remaining" }

/** Record the entry a step just broadcast, leaving the rest of the collection untouched. */
export function withExitOperation(
  record: MigrationRecord,
  unitKey: string,
  batch: number,
  entry: ExitOperationEntry,
): MigrationRecord {
  const operations = { ...(record.operations ?? {}) }
  operations[unitKey] = { ...(operations[unitKey] ?? {}), [batch]: entry }
  return { ...record, operations }
}

/** Units with an operation still awaiting an executor — they yield nothing this pass. */
export function unitsAwaitingExecution(record: MigrationRecord): string[] {
  return Object.entries(record.operations ?? {})
    .filter(([, batches]) => Object.values(batches).some((e) => e.state === "broadcast"))
    .map(([unitKey]) => unitKey)
}

const entriesOf = (record: MigrationRecord): ExitOperationEntry[] =>
  Object.values(record.operations ?? {}).flatMap((batches) => Object.values(batches))

/**
 * Is there anything to publish again? A `stale` entry can be rebuilt, and a unit whose every
 * entry executed may still have later slices to refund. Nothing else — a `broadcast` entry is
 * someone else's turn.
 */
export function hasPublishableWork(record: MigrationRecord): boolean {
  const entries = entriesOf(record)
  if (entries.length === 0) return false
  if (entries.some((e) => e.state === "stale")) return true
  return entries.every((e) => e.state === "executed")
}

/**
 * Carry forward the pre-reconcile entry for any slice published during this pass. A relayer has
 * not had a chance to act on it yet, so the only verdict it could receive is a wrong one.
 */
function keepFresh(
  reconciled: ExitOperations,
  previous: ExitOperations,
  broadcastThisPass: ReadonlySet<string>,
): ExitOperations {
  if (broadcastThisPass.size === 0) return reconciled
  const out: ExitOperations = {}
  for (const [unitKey, batches] of Object.entries(reconciled)) {
    out[unitKey] = {}
    for (const [batch, entry] of Object.entries(batches)) {
      const fresh = broadcastThisPass.has(`${unitKey}#${batch}`)
      out[unitKey][Number(batch)] = fresh ? (previous[unitKey]?.[Number(batch)] ?? entry) : entry
    }
  }
  return out
}

/**
 * Persisted migration progress. Deliberately carries only non-security-critical
 * markers — portal / recipient / L1 asset are absent by design.
 */
export interface MigrationRecord {
  /** Stable persistence key, minted when the migration starts. */
  localId: string
  /** The frozen generation being migrated (its rollup version). */
  rollupVersion: number
  phase: MigrationPhase
  /** Exited amount, decimal string (set once exiting completes). */
  amount?: string
  /** The frozen chain's freeze block (set once exiting completes). */
  freezeBlock?: number
  /**
   * Broadcast L1 operations, keyed by unit then by the note-slice batch within it. A single
   * reference cannot represent this: a unit above the per-refund note cap spans several batches,
   * and each is its own operation. The rebroadcast gate reads this, not a landed check.
   */
  operations?: ExitOperations
  /**
   * The canonical L2 account this exit was built for, pinned when it starts. Every operation binds
   * a freshly-resolved SIPA address gated against the CURRENT account, so without this a rebuild
   * after the active account legitimately changes would pass the gates for a different one: the
   * first operation could execute and pay account A while discovery, now running for B, never finds
   * the note. An L2 identity, not an L1 recipient — safety rule 1 still holds.
   */
  canonicalAccount?: string
  /** Failure message when phase === "failed". */
  error?: string
  /** The phase that threw (set alongside phase === "failed") — where retry resumes. */
  failedFrom?: MigrationPhase
  /** Named unrecoverable deposit residuals — visible on a done record. */
  residuals?: MigrationResidual[]
  /** Per-deposit-key non-benign failure counts — the bounded-attempts escape. */
  depositAttempts?: Record<string, number>
  startTime: number
  phaseEnteredAt: number
  endTime?: number
}

/**
 * The landed verdict plus any record state the reconcile discovered. `buildExit` is not the only
 * place a deposit can be written off: a transient first seen after the record left `exiting` runs
 * its attempt bound here, and this is the channel that names the resulting residual on the record.
 */
export interface MigrationLandedResult
  extends Pick<MigrationRecord, "residuals" | "depositAttempts"> {
  landed: boolean
}

/**
 * The chain-driven step surface. Every fund-routing value (portal, recipient,
 * L1 asset) is sourced inside these steps from chain / host-held state — never
 * passed in via the persisted record. The steps wrap MigrationService:
 * `buildExit` = enumerate + ensurePortalFrozen + exitFrozenGeneration;
 * `submitWithdrawal` = build + broadcast one batched L1-operation transaction; `reclaim` =
 * reclaimDeposit; the `*Landed` reconcilers read chain state for the resume path.
 */
export interface MigrationSteps {
  /** Build the escape-door proof; returns the aggregate plus any residual/attempt state. Read-only vs L1. */
  buildExit(record: MigrationRecord): Promise<{
    amount: string
    freezeBlock: number
    residuals?: MigrationResidual[]
    depositAttempts?: Record<string, number>
  }>
  /** Chain check: has the L1 withdrawal for this record already landed? */
  withdrawalLanded(record: MigrationRecord): Promise<boolean | MigrationLandedResult>
  /**
   * Check per-unit spentness, then broadcast the next not-yet-broadcast payloads — up to the
   * per-tx call budget, distinct units only — as one v5 transaction and return their entries,
   * or report that none remain. Entries from one invocation land atomically (one tx), so the
   * batch is the resumable unit after a kill.
   */
  submitWithdrawal(record: MigrationRecord): Promise<SubmitWithdrawalResult>
  /**
   * Re-read every non-executed entry against chain and return the updated collection: `executed`
   * once this batch's nullifiers read spent, `stale` once the broadcast transaction finalized with
   * them still unspent. Stale entries remain observable for deferred execution. Chain-driven, like
   * every other reconciler here.
   */
  reconcileOperations(record: MigrationRecord): Promise<ExitOperations>
  /**
   * The canonical L2 account for this run. Pinned on the record at start and re-checked on every
   * resume — a mismatch stops the migration rather than silently re-resolving against a different
   * account.
   */
  canonicalAccount(): Promise<string>
  /** Chain check: has the reclaim (canonical deposit + claim) already landed? */
  reclaimed(record: MigrationRecord): Promise<boolean>
  /** Deposit the released ERC20 into the canonical portal and claim it. */
  reclaim(record: MigrationRecord): Promise<void>
}

/** Persist the record after each transition (production: a RecordStorage-backed store). */
export type PersistMigration = (record: MigrationRecord) => Promise<void>

/** Fresh record at the start of a migration. `now` is injected for determinism. */
export function newMigrationRecord(
  localId: string,
  rollupVersion: number,
  now: number,
): MigrationRecord {
  return { localId, rollupVersion, phase: "discovering", startTime: now, phaseEnteredAt: now }
}

/** Read the landed verdict, folding any record state the reconcile handed back and persisting it. */
async function readLanded(
  record: MigrationRecord,
  steps: MigrationSteps,
  persist: PersistMigration,
): Promise<{ landed: boolean; record: MigrationRecord }> {
  const out = await steps.withdrawalLanded(record)
  if (typeof out === "boolean") return { landed: out, record }
  const { landed, ...patch } = out
  const next = { ...record, ...patch }
  await persist(next)
  return { landed, record: next }
}

async function enter(
  record: MigrationRecord,
  phase: MigrationPhase,
  persist: PersistMigration,
  now: number,
): Promise<MigrationRecord> {
  const next: MigrationRecord = {
    ...record,
    phase,
    phaseEnteredAt: now,
    ...(MIGRATION_TERMINAL_PHASES.has(phase) && record.endTime == null ? { endTime: now } : {}),
  }
  await persist(next)
  return next
}

/**
 * Drive a migration from its current phase to a terminal one, persisting each
 * transition. Safe to call again after a crash with the persisted record — it
 * resumes at the stored phase, reconciling the L1 legs against chain rather than
 * re-running them blindly. Never throws on a step failure: a throw terminalizes
 * to `failed` (with the message) so the caller can retry from the persisted phase.
 */
/** A failed record rewound to the phase that threw, ready to drive again. */
export function retryMigrationRecord(record: MigrationRecord): MigrationRecord {
  const { error: _error, failedFrom: _failedFrom, endTime: _endTime, ...rest } = record
  return { ...rest, phase: record.failedFrom ?? "discovering" }
}

export async function advanceMigration(
  record: MigrationRecord,
  steps: MigrationSteps,
  persist: PersistMigration,
  clock: () => number = Date.now,
): Promise<MigrationRecord> {
  let r = record
  // Slices broadcast during THIS pass. Not a cap on rebroadcasts — a later pass legitimately
  // re-offers a stale slice; this only catches a step that fails to gate within one pass.
  const broadcastThisPass = new Set<string>()
  // Set once `withdrawing` reports nothing left to publish. Without it a pass could ping-pong
  // between the two phases forever when the reconcile says work exists but the seam yields none.
  // A later re-drive starts fresh, so this bounds one pass, not the migration.
  let publishExhausted = false
  try {
    // Pin the account on the first pass; re-check it on every resume. A rebuild for a different
    // account would pass the recipient gates and pay an address this run's discovery never
    // searches, so a mismatch stops rather than silently re-resolving.
    const account = await steps.canonicalAccount()
    if (r.canonicalAccount == null) r = { ...r, canonicalAccount: account }
    else if (r.canonicalAccount !== account) {
      throw new Error(
        `migration: record was built for account ${r.canonicalAccount} but the active account is ` +
          `${account} — switch back to finish this migration`,
      )
    }

    // Set when a resting phase has been processed and has nothing more to do this pass. It is
    // not a loop-entry guard: a record RESUMED at a resting phase must still get one pass, or a
    // re-drive would return it untouched and the migration could never finish.
    let resting = false
    while (!MIGRATION_TERMINAL_PHASES.has(r.phase) && !resting) {
      switch (r.phase) {
        case "discovering":
          r = await enter(r, "exiting", persist, clock())
          break
        case "exiting": {
          // Read-only vs L1 until submit — re-running after a kill here is safe.
          const { amount, freezeBlock, residuals, depositAttempts } = await steps.buildExit(r)
          r = await enter(
            {
              ...r,
              amount,
              freezeBlock,
              ...(residuals ? { residuals } : {}),
              ...(depositAttempts ? { depositAttempts } : {}),
            },
            "withdrawing",
            persist,
            clock(),
          )
          break
        }
        case "withdrawing": {
          // Submit before the aggregate reconcile. The submit seam skips chain-landed units, and
          // this ordering lets a retry clear a per-attempt transient mask and make one real build
          // attempt before withdrawalLanded may terminalize the newly-observed failure.
          const result = await steps.submitWithdrawal(r)
          const broadcastCount = result.kind === "broadcast-many" ? result.entries.length : 0
          if (result.kind === "broadcast-many") {
            for (const { unitKey, batch, entry } of result.entries) {
              // The loop terminates because a broadcast unit is gated out of the next selection.
              // If a step ignores that gate it would re-offer the same slice forever, so treat a
              // repeat within one pass as the contract violation it is rather than spinning.
              const slice = `${unitKey}#${batch}`
              if (broadcastThisPass.has(slice)) {
                throw new Error(
                  `migration: step re-offered ${slice} in the same pass — a broadcast unit must be ` +
                    `gated out of the next selection`,
                )
              }
              broadcastThisPass.add(slice)
              r = withExitOperation(r, unitKey, batch, entry)
            }
            if (broadcastCount > 0) {
              // Persist the whole batch before anything else can throw. Its operations are live
              // on chain (one tx, atomic), so a throw before this write would discard their
              // entries and the retry would rebroadcast them. Stay in `withdrawing` — payloads
              // may remain.
              await persist(r)
              publishExhausted = false
            }
            // Surface a partial-batch proof failure only AFTER the live entries are durable.
            if (result.failure) throw result.failure.error
          }

          // Reconcile after every non-failing attempt (a partial-batch failure throws above and
          // reconciles on the retry pass instead), including a successful broadcast: this is the
          // transient terminalization point, and the operation entry is already durable if one
          // went live. A fully-landed resume reaches reclaim without publishing because the submit
          // seam returns none after its per-unit spentness checks.
          {
            const landed = await readLanded(r, steps, persist)
            r = landed.record
            if (landed.landed) {
              r = await enter(r, "reclaiming", persist, clock())
              break
            }
          }
          if (broadcastCount > 0) break

          // Everything publishable is published. Rest until a relayer executes it — entering on
          // the FIRST batch would park a multi-round exit with payloads still pending.
          publishExhausted = true
          r = await enter(r, "awaitingExecution", persist, clock())
          break
        }
        case "awaitingExecution": {
          const before = JSON.stringify(r.operations ?? {})
          // An operation published moments ago must not be judged in the same pass. On a fast
          // chain its own block can already read finalized, which would mark it `stale`, send the
          // machine back to `withdrawing`, and rebroadcast a slice that is still perfectly live —
          // caught only by the re-offer guard, after a second operation is already out there.
          const operations = keepFresh(
            await steps.reconcileOperations(r),
            r.operations ?? {},
            broadcastThisPass,
          )
          r = { ...r, operations }
          await persist(r)
          // A reconcile that moved an entry (executed, or stale and rebuildable) is progress, so
          // the pass may publish again. The guard only bars a SECOND fruitless publish attempt.
          if (JSON.stringify(operations) !== before) publishExhausted = false
          {
            const landed = await readLanded(r, steps, persist)
            r = landed.record
            if (landed.landed) {
              r = await enter(r, "reclaiming", persist, clock())
              break
            }
          }
          // A batch landed but its unit has more slices, or an operation went stale and can be
          // rebuilt: either way there is publishable work again. Anything else rests.
          if (hasPublishableWork(r) && !publishExhausted) {
            r = await enter(r, "withdrawing", persist, clock())
            break
          }
          // Nothing left for the app to do — yield and let the caller re-drive on its triggers.
          resting = true
          break
        }
        case "reclaiming": {
          if (!(await steps.reclaimed(r))) await steps.reclaim(r)
          r = await enter(r, "done", persist, clock())
          break
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const patch = err instanceof MigrationStepError ? err.recordPatch : undefined
    r = await enter(
      { ...r, ...patch, error: message, failedFrom: r.phase },
      "failed",
      persist,
      clock(),
    )
  }
  return r
}
