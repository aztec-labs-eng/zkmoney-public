import type { MetadataMigrationController } from "./MetadataMigrationController"
import type { MetadataMigrationRecord, MetadataMigrationSummary } from "./metadataMigrationFlow"

/** Failed passes in a row the run tries again, with growing waits, before it stops for the user. */
const RETRIES = 5

/** A stop the user need not act on: a later pass, which never prompts, may clear it. */
export function retryableStop(record: MetadataMigrationRecord | null): boolean {
  return record?.phase === "needsAttention" && !record.stale && !record.halt && !record.refused
}

/** Continue an explicitly authorized migration; release storage locks between observations. */
export async function runMetadataMigration(
  controller: MetadataMigrationController,
  options: {
    signal: AbortSignal
    pollMs?: number
    /**
     * A run the user did not start, such as the boot's: it follows an arriving or waiting run to
     * the end and stops once the run needs the user, never signing.
     */
    observeOnly?: boolean
    /**
     * A run the user did not start that carries a published plan to the end: it sends, but stops
     * for the user rather than prepare, sign a consent or broadcast a bootstrap.
     */
    promptless?: boolean
    /** Runs each step that sends one transaction, as the operation it names to the step. */
    exclusive?: <T>(step: (operationId?: string) => Promise<T>) => Promise<T>
    /** Return once this holds: what is left runs without the user. */
    until?: (record: MetadataMigrationRecord) => boolean
    /** Fires once the user's start has approved and proven everything: the rest needs no prompt. */
    onPrepared?: () => void
    /** Collect and save approvals without sending any transaction. With `retry`, a failed pass is tried again. */
    prepareOnly?: boolean
    /** Like `prepareOnly`, but returns once every approval is saved, before any proof. */
    approvalsOnly?: boolean
    /** A prepared queue must stop if a new approval becomes necessary. */
    prompts?: boolean
    /** Return once every batch is sent: what is left needs no tab. */
    untilArriving?: boolean
    /**
     * Try a failed pass again before stopping. Only for a run whose later passes cannot prompt, as
     * a frozen source's cannot; an observe-only run always does.
     */
    retry?: boolean
    /** What the user's start was quoted, saved with the run. */
    summary?: MetadataMigrationSummary
    beforeApproval?: (approved: number, total: number) => Promise<void>
  },
) {
  const observeOnly = options.observeOnly ?? false
  const promptless = !observeOnly && (options.promptless ?? false)
  const pollMs = options.pollMs ?? 5_000
  const retries = observeOnly || promptless || options.retry ? RETRIES : 0
  let start = !observeOnly && !promptless
  let prepared = false
  let failures = 0
  while (!options.signal.aborted) {
    const record = await controller.advance(start, options.signal, {
      observeOnly,
      promptless,
      prepareOnly: options.prepareOnly,
      approvalsOnly: options.approvalsOnly,
      exclusive: options.exclusive,
      ...(start
        ? {
            // A start tried again rebuilds from saved approvals and never asks for another.
            ...(failures ? { prompts: false } : {}),
            ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
            onPrepared: () => {
              prepared = true
              options.onPrepared?.()
            },
            summary: options.summary,
            beforeApproval: options.beforeApproval,
          }
        : {}),
    })
    const retry = retryableStop(record) && failures < retries
    // A prepare-only pass ends with what it prepared, once no retry is left to clear a stop.
    if ((options.prepareOnly || options.approvalsOnly) && !retry) return record
    failures = retry ? failures + 1 : 0
    start = start && retry && !prepared
    if (!retry) {
      if (observeOnly && record?.phase !== "arriving" && record?.phase !== "waiting") return record
      if (options.untilArriving && record?.phase === "arriving") return record
      if (record && options.until?.(record)) return record
      if (
        !record ||
        record.phase === "done" ||
        record.phase === "needsAttention" ||
        record.phase === "needsApproval"
      )
        return record
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        options.signal.removeEventListener("abort", finish)
        resolve()
      }
      const timer = setTimeout(finish, retry ? pollMs * 2 ** (failures - 1) : pollMs)
      options.signal.addEventListener("abort", finish, { once: true })
      if (options.signal.aborted) finish()
    })
  }
  return controller.getSnapshot()
}
