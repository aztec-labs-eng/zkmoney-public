import {
  ApprovalNeededError,
  MigrationHaltedError,
  MigrationSubsidyNotReadyError,
  StalePlanError,
  type MigrationHalt,
  type MigrationSendGate,
} from "@obsidion/sdk"
import { provingProgress } from "@obsidion/proving-progress"

/** Shared migration driver. Contract actions live in the SDK adapter; this layer owns durability. */
export type MetadataMigrationPhase =
  | "preparing"
  | "broadcasting"
  | "awaitingMessages"
  | "subscribing"
  | "recovering"
  | "arriving"
  /**
   * The run cannot send now and observes again until it can: it waits for the registration of
   * another run, or for the migration subsidy (`waitReason`). It never stops for the user.
   */
  | "waiting"
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
  /** What the run was quoted at its start, kept for a resumed run's sheet. */
  summary?: MetadataMigrationSummary
  /** While the run is `waiting`: why, in the user's terms. Absent while it waits for registration. */
  waitReason?: string
  /** A funds send of this run started, so funds may have left the source. */
  fundsSent?: boolean
}

/** A run's network fees, in the token's base units, and the approvals it asks for. */
export interface MetadataMigrationSummary {
  fees: string
  approvals: number
}

export interface MetadataMigrationObservation {
  bootstrapStatus?: MigrationTxState
  subscriptionStatus?: MigrationTxState
  bootstrapSpent: boolean
  metadataSettled: boolean
  /** Includes the metadata state and actual L1-to-L2 message availability. */
  messagesReady: boolean
  /** A synced recurring-rail subscription with executable allowance. */
  recurringSponsorship: boolean
  /** Every planned later batch has been sent: what is left needs no tab. */
  sent: boolean
  /** Destination deposit receipt verified, including all selected source batches. */
  complete: boolean
}

export interface MetadataMigrationSteps {
  /**
   * The run moves only funds, and another run registers the account. Until the destination has
   * recurring sponsorship and current metadata, the run waits; it never stops for the user.
   */
  readonly waitsForRegistration?: boolean
  binding(): Promise<string>
  /**
   * Sign the record update, or plan and prove every batch of a funds-only run. No tx.
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
  /**
   * The callback MUST resolve durably before the proven tx is submitted to the node. `operationId`
   * names the proof to the operation running it.
   */
  broadcast(
    plan: string,
    onTxHash: (txHash: string) => Promise<void>,
    operationId?: string,
  ): Promise<void>
  subscribe(
    plan: string,
    onTxHash: (txHash: string) => Promise<void>,
    operationId?: string,
  ): Promise<void>
  /** Send the source's batches, only after recurring sponsorship is established. It sends each transaction inside `gate`. */
  recoverRemaining(plan: string, signal?: AbortSignal, gate?: MigrationSendGate): Promise<void>
  /**
   * Bring every sent batch up to date from chain evidence, and send again each batch whose refund
   * is late. It never signs. `signal` stops it before a send. It sends each transaction inside
   * `gate`.
   */
  reconcileRemaining?(plan: string, signal?: AbortSignal, gate?: MigrationSendGate): Promise<void>
  /** Whether the balance holds everything the run imported: the run is done only then. */
  confirmBalance?(): Promise<boolean>
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

/** The migration subsidy does not pay for a refund now; it can clear by itself. Matched by name too. */
function subsidyNotReady(error: unknown): boolean {
  return (
    error instanceof MigrationSubsidyNotReadyError ||
    (error as Error | undefined)?.name === "MigrationSubsidyNotReadyError"
  )
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
 * what it sees, but never prepares, signs or sends. A `promptless` pass carries a published plan on:
 * it sends, but never prepares, signs a consent or broadcasts a bootstrap, and stops for the user
 * where one of those is next. `exclusive` runs each step that sends one transaction, as the
 * operation it names to the step: the bootstrap, the subscription, and each send of the remaining
 * funds and of their re-sends. A start saves its `summary` with the record.
 */
export async function advanceMetadataMigration(
  initial: MetadataMigrationRecord,
  steps: MetadataMigrationSteps,
  persist: (record: MetadataMigrationRecord) => Promise<void>,
  {
    start = false,
    signal,
    observeOnly = false,
    promptless = false,
    onPrepared,
    prepareOnly = false,
    approvalsOnly = false,
    summary,
    exclusive = (step) => step(),
    beforeApproval,
  }: {
    start?: boolean
    signal?: AbortSignal
    observeOnly?: boolean
    promptless?: boolean
    onPrepared?: () => void
    /** Persist approvals and return before observing or sending. */
    prepareOnly?: boolean
    /** The pass saves approvals and proves nothing, so it is not yet prepared. */
    approvalsOnly?: boolean
    summary?: MetadataMigrationSummary
    exclusive?: MigrationSendGate
    /** Awaited while another approval is next, so the user can start each prompt. */
    beforeApproval?: (approved: number, total: number) => Promise<void>
  } = {},
): Promise<MetadataMigrationRecord> {
  let record = { ...initial }
  const save = async (patch: Partial<MetadataMigrationRecord>) => {
    record = { ...record, ...patch }
    await persist(record)
  }
  // A step cancelled while it waited its turn never starts.
  const send = <T>(step: (operationId?: string) => Promise<T>) =>
    exclusive((operationId) => {
      signal?.throwIfAborted()
      return step(operationId)
    })
  // The record holds the hash, so the step's operation is safe to reload over.
  const saved = (operationId: string | undefined, txHash: string) => {
    if (operationId) provingProgress.emitTxHashSaved(operationId, txHash)
  }
  const progress = async (approved: number, total: number) => {
    await save({ approvals: { approved, total } })
    if (approved < total) await beforeApproval?.(approved, total)
  }
  // A replacement for a stale plan is under way: a failed attempt keeps the plan stale.
  let replacing = false
  try {
    if ((await steps.binding()) !== record.binding) {
      throw new MigrationHaltedError(
        "account",
        "Switch back to the account and deployments used to start this upgrade",
      )
    }
    if (start && !observeOnly && summary) await save({ summary })
    // No hash means this driver never authorized RPC submission. A stale plan is prepared again,
    // with fresh consent; any other stop keeps it and its saved approvals. Submitted plans stay intact.
    const unpublished = !record.bootstrapTx && !record.subscriptionTx
    if (observeOnly && !record.plan) return record
    if (promptless && (!record.plan || record.stale)) throw new ApprovalNeededError()
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
      // A prepare-only pass returns before observing, so it clears a stop the user has now resolved.
      if (record.phase === "needsApproval" || (record.phase === "needsAttention" && !record.halt)) {
        await save({ phase: "broadcasting", error: undefined, refused: undefined })
      }
    }
    if (start && !observeOnly && !approvalsOnly) onPrepared?.()
    if (prepareOnly) return record
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

    // A dropped bootstrap whose allowance is unspent is sent again from the same plan, which still
    // observes the dropped one should it land after all.
    const resend =
      !!record.bootstrapTx &&
      observed.bootstrapStatus === "dropped" &&
      (!observed.bootstrapSpent || observed.recurringSponsorship)

    const complete = observed.complete && observed.recurringSponsorship && observed.metadataSettled
    if (complete && (await steps.confirmBalance?.()) !== false) {
      await save({ phase: "done", error: undefined })
    } else if (observed.recurringSponsorship && observed.metadataSettled) {
      const phase = observed.sent ? "arriving" : "recovering"
      // A run that waits for the subsidy keeps its reason until a pass gets past it.
      const held = record.phase === "waiting" && !!record.waitReason
      if (!held) await save({ phase, error: undefined })
      signal?.throwIfAborted()
      // Each funds send waits its turn through `send`, one transaction at a time.
      // Saved before the send: a send whose result is unknown may still move funds.
      const sendFunds: MigrationSendGate = (step) =>
        send(async (operationId) => {
          if (!record.fundsSent) await save({ fundsSent: true })
          return step(operationId)
        })
      if (observeOnly) await steps.reconcileRemaining?.(plan, signal, sendFunds)
      else await steps.recoverRemaining(plan, signal, sendFunds)
      if (held) await save({ phase, error: undefined, waitReason: undefined })
    } else if (observeOnly) {
      return record
    } else if (steps.waitsForRegistration) {
      // It sends nothing until the registration run sets up the destination; a later pass observes again.
      await save({ phase: "waiting", error: undefined, waitReason: undefined })
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
      await send((operationId) =>
        steps.subscribe(
          plan,
          async (txHash) => {
            signal?.throwIfAborted()
            await save({ subscriptionTx: txHash, subscriptionStatus: "unknown" })
            saved(operationId, txHash)
          },
          operationId,
        ),
      )
    } else if (record.bootstrapTx && !resend) {
      if (observed.bootstrapStatus === "reverted") {
        throw new MigrationHaltedError(
          "reverted",
          "The upgrade transaction was included but its public execution reverted. The initial sponsored allowance may be spent; a free retry is unavailable",
        )
      }
      if (observed.bootstrapStatus === "included") {
        await save({ phase: "awaitingMessages", error: undefined })
      } else {
        await save({ phase: "broadcasting", error: undefined })
      }
    } else {
      if (observed.bootstrapSpent && !observed.recurringSponsorship) {
        throw new Error(
          "This identity has already used its initial sponsored transaction on this FPC. Changing metadata does not renew that allowance",
        )
      }
      if (promptless) throw new ApprovalNeededError()
      if (resend && record.stale) {
        if (!start) throw new ApprovalNeededError()
        // The stale plan and its dropped hash stay until a replacement is saved: a late landing is
        // still observed through them, and a replacement its spent allowance refuses changes nothing.
        await save({ phase: "preparing", error: undefined })
        replacing = true
        const replacement = await steps.prepare(
          record.draft,
          (draft) => save({ draft }),
          signal,
          progress,
        )
        signal?.throwIfAborted()
        await save({
          plan: replacement,
          draft: undefined,
          bootstrapTx: undefined,
          bootstrapStatus: undefined,
          stale: undefined,
        })
        replacing = false
      }
      await save({ phase: "broadcasting", error: undefined })
      signal?.throwIfAborted()
      // Called before submission: a cancel here means nothing is sent.
      await send((operationId) =>
        steps.broadcast(
          record.plan!,
          async (txHash) => {
            signal?.throwIfAborted()
            await save({
              bootstrapTx: txHash,
              bootstrapStatus: "unknown",
              allowance: observed.recurringSponsorship ? "registered" : "unknown",
            })
            saved(operationId, txHash)
          },
          operationId,
        ),
      )
    }
  } catch (error) {
    if (signal?.aborted) return record
    if (needsApproval(error)) {
      await save({ phase: "needsApproval", error: (error as Error).message })
      return record
    }
    if (subsidyNotReady(error)) {
      await save({ phase: "waiting", error: undefined, waitReason: (error as Error).message })
      return record
    }
    await save({
      phase: "needsAttention",
      error: error instanceof Error ? error.message : String(error),
      stale: isStalePlan(error) || replacing || undefined,
      halt: haltOf(error),
      refused: refusedPrompt(error) || undefined,
    })
  }
  return record
}
