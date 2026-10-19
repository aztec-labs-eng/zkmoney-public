import {
  ApprovalNeededError,
  MigrationHaltedError,
  StalePlanError,
  type MigrationHalt,
} from "@obsidion/sdk"

/** Shared migration driver. Contract actions live in the SDK adapter; this layer owns durability. */
export type MetadataMigrationPhase =
  | "preparing"
  | "broadcasting"
  | "funding"
  | "awaitingMessages"
  | "subscribing"
  | "recovering"
  | "arriving"
  | "done"
  | "needsAttention"
  | "needsApproval"

export type MigrationTxState = "unknown" | "pending" | "included" | "reverted" | "dropped"

export interface MetadataMigrationRecord {
  id: string
  /** Hash of the source deployment, destination deployment, account, and resolver key. */
  binding: string
  phase: MetadataMigrationPhase
  /** Signed public plan and derivation coordinates. Routing is re-derived and verified by the SDK. */
  plan?: string
  /** What an unfinished preparation saved before its approvals; resuming it asks for the same ones. */
  draft?: string
  bootstrapTx?: string
  bootstrapStatus?: MigrationTxState
  subscriptionTx?: string
  subscriptionStatus?: MigrationTxState
  allowance: "unspent" | "unknown" | "spent" | "registered"
  error?: string
  /** The error was a stale plan, so the next run prepares again. */
  stale?: boolean
  /** The error repeats on a retry soon, and why. */
  halt?: MigrationHalt
  /** The user closed a passkey prompt, or it timed out. */
  refused?: boolean
  /** Batch approvals given so far in this run's preparation, of how many. */
  approvals?: { approved: number; total: number }
}

export interface MetadataMigrationObservation {
  bootstrapStatus?: MigrationTxState
  subscriptionStatus?: MigrationTxState
  bootstrapSpent: boolean
  metadataSettled: boolean
  /** Includes the metadata state, SIPA sweep and actual L1-to-L2 message availability. */
  messagesReady: boolean
  /** A synced recurring-rail subscription with executable allowance. */
  recurringSponsorship: boolean
  /** Every planned later batch has been sent: what is left needs no tab. */
  sent: boolean
  /** Destination deposit receipt verified, including all selected source batches. */
  complete: boolean
}

export interface MetadataMigrationSteps {
  binding(): Promise<string>
  /**
   * Derive metadata and prepare the first sufficient refund batch and every signature. No tx.
   * Resumes `draft`; `saveDraft` must resolve durably before the approval that follows it.
   */
  prepare(
    draft: string | undefined,
    saveDraft: (draft: string) => Promise<void>,
    signal?: AbortSignal,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ): Promise<string>
  /**
   * The user's own step before the run sends anything more: rebuild what the next send needs from
   * saved approvals, approve what is missing, and prove funds that reached the source since.
   */
  ready(
    plan: string,
    signal?: AbortSignal,
    published?: boolean,
    onApproval?: (approved: number, total: number) => Promise<void>,
  ): Promise<void>
  observe(record: MetadataMigrationRecord): Promise<MetadataMigrationObservation>
  /** The callback MUST resolve durably before the proven tx is submitted to the node. */
  broadcast(plan: string, onTxHash: (txHash: string) => Promise<void>): Promise<void>
  /** Live source: withdraw to the prepared SIPA. Frozen/external: observe funding only. */
  fund(plan: string, signal?: AbortSignal): Promise<void>
  subscribe(plan: string, onTxHash: (txHash: string) => Promise<void>): Promise<void>
  /**
   * Only ordinary DepositSIPAs, and only after recurring sponsorship is established. `published` is
   * false when the destination record was already current, so no bootstrap carried a first deposit.
   */
  recoverRemaining(plan: string, published: boolean, signal?: AbortSignal): Promise<void>
  /** Bring every sent batch up to date from chain evidence, never signing or sending. */
  reconcileRemaining?(plan: string): Promise<void>
}

export function newMetadataMigration(id: string, binding: string): MetadataMigrationRecord {
  return { id, binding, phase: "preparing", allowance: "unknown" }
}

/** Matched by name too: the error may come from another copy of the sdk module. */
function isStalePlan(error: unknown): boolean {
  return error instanceof StalePlanError || (error as Error | undefined)?.name === "StalePlanError"
}

function haltOf(error: unknown): MigrationHalt | undefined {
  if (error instanceof MigrationHaltedError) return error.halt
  return (error as Error | undefined)?.name === "MigrationHaltedError"
    ? (error as MigrationHaltedError).halt
    : undefined
}

/** A browser passkey prompt that was closed or timed out before it answered. */
function refusedPrompt(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name
  return name === "NotAllowedError" || name === "AbortError"
}

function needsApproval(error: unknown): boolean {
  return (
    error instanceof ApprovalNeededError ||
    (error as Error | undefined)?.name === "ApprovalNeededError"
  )
}

/**
 * Advance at most one transaction action per invocation. Reconcile before acting, including after
 * a restart or a rejected RPC response. An unknown submission is never treated as a free retry.
 * A completed migration is observed again, since funds can reach the source after it.
 *
 * `start` is the user's own action: before anything is published it first rebuilds the saved plan,
 * so `signal` can still stop it. A cancel leaves the record as last saved. `onPrepared` fires once
 * that pass has nothing left to approve or prove. `observeOnly` reconciles what was sent and saves
 * what it sees, but never prepares, signs or sends.
 */
export async function advanceMetadataMigration(
  initial: MetadataMigrationRecord,
  steps: MetadataMigrationSteps,
  persist: (record: MetadataMigrationRecord) => Promise<void>,
  {
    start = false,
    signal,
    observeOnly = false,
    onPrepared,
  }: {
    start?: boolean
    signal?: AbortSignal
    observeOnly?: boolean
    onPrepared?: () => void
  } = {},
): Promise<MetadataMigrationRecord> {
  let record = { ...initial }
  const save = async (patch: Partial<MetadataMigrationRecord>) => {
    record = { ...record, ...patch }
    await persist(record)
  }
  const progress = (approved: number, total: number) => save({ approvals: { approved, total } })
  try {
    if ((await steps.binding()) !== record.binding) {
      throw new MigrationHaltedError(
        "account",
        "Switch back to the account and deployments used to start this upgrade",
      )
    }
    // No hash means this driver never authorized RPC submission. A stale plan is prepared again,
    // with fresh consent; any other stop keeps it and its saved approvals. Submitted plans stay intact.
    const unpublished = !record.bootstrapTx && !record.subscriptionTx
    if (observeOnly && !record.plan) return record
    if (!observeOnly && record.phase === "needsAttention" && unpublished && record.stale) {
      await save({ plan: undefined, draft: undefined, phase: "preparing", stale: undefined })
    }
    if (!record.plan) {
      await save({ phase: "preparing", error: undefined, stale: undefined })
      const plan = await steps.prepare(record.draft, (draft) => save({ draft }), signal, progress)
      signal?.throwIfAborted()
      await save({ plan, draft: undefined, phase: "broadcasting" })
    } else if (start && !observeOnly) {
      await steps.ready(record.plan, signal, !unpublished, progress)
      signal?.throwIfAborted()
    }
    if (start && !observeOnly) onPrepared?.()
    const plan = record.plan!
    const observed = await steps.observe(record)
    await save({
      bootstrapStatus: observed.bootstrapStatus,
      subscriptionStatus: observed.subscriptionStatus,
      allowance: observed.recurringSponsorship
        ? "registered"
        : observed.bootstrapSpent
        ? "spent"
        : record.bootstrapTx && observed.bootstrapStatus !== "dropped"
        ? "unknown"
        : "unspent",
    })

    if (observed.complete && observed.recurringSponsorship && observed.metadataSettled) {
      await save({ phase: "done", error: undefined })
    } else if (observed.recurringSponsorship && observed.metadataSettled) {
      await save({ phase: observed.sent ? "arriving" : "recovering", error: undefined })
      signal?.throwIfAborted()
      if (observeOnly) await steps.reconcileRemaining?.(plan)
      else await steps.recoverRemaining(plan, !!record.bootstrapTx, signal)
    } else if (observeOnly) {
      return record
    } else if (observed.messagesReady) {
      if (record.subscriptionTx && observed.subscriptionStatus !== "dropped") {
        if (observed.subscriptionStatus === "reverted") {
          throw new MigrationHaltedError(
            "reverted",
            "The sponsorship transaction reverted. Its consumed attestation and subscription must be reconciled before retrying",
          )
        }
        await save({ phase: "subscribing", error: undefined })
        return record
      }
      await save({ phase: "subscribing", error: undefined })
      signal?.throwIfAborted()
      await steps.subscribe(plan, async (txHash) => {
        signal?.throwIfAborted()
        await save({ subscriptionTx: txHash, subscriptionStatus: "unknown" })
      })
    } else if (record.bootstrapTx) {
      if (observed.bootstrapStatus === "reverted") {
        throw new MigrationHaltedError(
          "reverted",
          "The upgrade transaction was included but its public execution reverted. The initial sponsored allowance may be spent; a free retry is unavailable",
        )
      }
      if (
        observed.bootstrapStatus === "dropped" &&
        (!observed.bootstrapSpent || observed.recurringSponsorship)
      ) {
        // A definitive drop plus the unspent identity nullifier permits a new preparation.
        await save({
          bootstrapTx: undefined,
          bootstrapStatus: undefined,
          plan: undefined,
          phase: "preparing",
        })
      } else if (observed.bootstrapStatus === "included") {
        await save({ phase: "funding", error: undefined })
        signal?.throwIfAborted()
        await steps.fund(plan, signal)
        await save({ phase: "awaitingMessages" })
      } else {
        await save({ phase: "broadcasting", error: undefined })
      }
    } else {
      if (observed.bootstrapSpent && !observed.recurringSponsorship) {
        throw new Error(
          "This identity has already used its initial sponsored transaction on this FPC. Changing metadata does not renew that allowance",
        )
      }
      await save({ phase: "broadcasting", error: undefined })
      signal?.throwIfAborted()
      // Called before submission: a cancel here means nothing is sent.
      await steps.broadcast(plan, async (txHash) => {
        signal?.throwIfAborted()
        await save({
          bootstrapTx: txHash,
          bootstrapStatus: "unknown",
          allowance: observed.recurringSponsorship ? "registered" : "unknown",
        })
      })
    }
  } catch (error) {
    if (signal?.aborted) return record
    if (needsApproval(error)) {
      await save({ phase: "needsApproval", error: (error as Error).message })
      return record
    }
    await save({
      phase: "needsAttention",
      error: error instanceof Error ? error.message : String(error),
      stale: isStalePlan(error) || undefined,
      halt: haltOf(error),
      refused: refusedPrompt(error) || undefined,
    })
  }
  return record
}
