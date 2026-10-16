/** Shared migration driver. Contract actions live in the SDK adapter; this layer owns durability. */
export type MetadataMigrationPhase =
  | "preparing"
  | "broadcasting"
  | "funding"
  | "awaitingMessages"
  | "subscribing"
  | "recovering"
  | "done"
  | "needsAttention"

export type MigrationTxState = "unknown" | "pending" | "included" | "reverted" | "dropped"

export interface MetadataMigrationRecord {
  id: string
  /** Hash of the source deployment, destination deployment, account, and resolver key. */
  binding: string
  phase: MetadataMigrationPhase
  /** Signed public plan and derivation coordinates. Routing is re-derived and verified by the SDK. */
  plan?: string
  bootstrapTx?: string
  bootstrapStatus?: MigrationTxState
  subscriptionTx?: string
  subscriptionStatus?: MigrationTxState
  allowance: "unspent" | "unknown" | "spent" | "registered"
  error?: string
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
  /** Destination deposit receipt verified, including all selected source batches. */
  complete: boolean
}

export interface MetadataMigrationSteps {
  binding(): Promise<string>
  /** Derive metadata and prepare the first sufficient refund batch and every signature. No tx. */
  prepare(): Promise<string>
  observe(record: MetadataMigrationRecord): Promise<MetadataMigrationObservation>
  /** The callback MUST resolve durably before the proven tx is submitted to the node. */
  broadcast(plan: string, onTxHash: (txHash: string) => Promise<void>): Promise<void>
  /** Live source: withdraw to the prepared SIPA. Frozen/external: observe funding only. */
  fund(plan: string): Promise<void>
  subscribe(plan: string, onTxHash: (txHash: string) => Promise<void>): Promise<void>
  /**
   * Only ordinary DepositSIPAs, and only after recurring sponsorship is established. `published` is
   * false when the destination record was already current, so no bootstrap carried a first deposit.
   */
  recoverRemaining(plan: string, published: boolean): Promise<void>
}

export function newMetadataMigration(id: string, binding: string): MetadataMigrationRecord {
  return { id, binding, phase: "preparing", allowance: "unknown" }
}

export const metadataMigrationPhaseLabel: Record<MetadataMigrationPhase, string> = {
  preparing: "Preparing your migration",
  broadcasting: "Publishing your migration",
  funding: "Waiting for migration funding",
  awaitingMessages: "Waiting for your deposit and sponsorship",
  subscribing: "Activating recurring sponsorship",
  recovering: "Recovering remaining funds",
  done: "Migration complete",
  needsAttention: "Migration needs attention",
}

/**
 * Advance at most one transaction action per invocation. Reconcile before acting, including after
 * a restart or a rejected RPC response. An unknown submission is never treated as a free retry.
 * A completed migration is observed again, since funds can reach the source after it.
 */
export async function advanceMetadataMigration(
  initial: MetadataMigrationRecord,
  steps: MetadataMigrationSteps,
  persist: (record: MetadataMigrationRecord) => Promise<void>,
): Promise<MetadataMigrationRecord> {
  let record = { ...initial }
  const save = async (patch: Partial<MetadataMigrationRecord>) => {
    record = { ...record, ...patch }
    await persist(record)
  }
  try {
    if ((await steps.binding()) !== record.binding) {
      throw new Error("Switch back to the account and deployments used to start this migration")
    }
    // No hash means this driver never authorized RPC submission. A user-triggered retry may
    // obtain fresh metadata consent after a stale-state rejection. Submitted plans stay intact.
    if (record.phase === "needsAttention" && !record.bootstrapTx && !record.subscriptionTx) {
      await save({ plan: undefined, phase: "preparing", error: undefined })
    }
    if (!record.plan) {
      await save({ phase: "preparing", error: undefined })
      await save({ plan: await steps.prepare(), phase: "broadcasting" })
    }
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
      await save({ phase: "recovering", error: undefined })
      await steps.recoverRemaining(plan, !!record.bootstrapTx)
    } else if (observed.messagesReady) {
      if (record.subscriptionTx && observed.subscriptionStatus !== "dropped") {
        if (observed.subscriptionStatus === "reverted") {
          throw new Error(
            "The sponsorship transaction reverted. Its consumed attestation and subscription must be reconciled before retrying",
          )
        }
        await save({ phase: "subscribing", error: undefined })
        return record
      }
      await save({ phase: "subscribing", error: undefined })
      await steps.subscribe(plan, async (txHash) => {
        await save({ subscriptionTx: txHash, subscriptionStatus: "unknown" })
      })
    } else if (record.bootstrapTx) {
      if (observed.bootstrapStatus === "reverted") {
        throw new Error(
          "The migration transaction was included but its public execution reverted. The initial sponsored allowance may be spent; a free retry is unavailable",
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
        await steps.fund(plan)
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
      await steps.broadcast(plan, async (txHash) => {
        await save({
          bootstrapTx: txHash,
          bootstrapStatus: "unknown",
          allowance: observed.recurringSponsorship ? "registered" : "unknown",
        })
      })
    }
  } catch (error) {
    await save({
      phase: "needsAttention",
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return record
}
