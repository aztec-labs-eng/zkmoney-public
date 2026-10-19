import type { MetadataMigrationController } from "./MetadataMigrationController"
import type { MetadataMigrationRecord } from "./metadataMigrationFlow"

/** Failed passes in a row the run tries again, with growing waits, before it stops for the user. */
const RETRIES = 5

/** A stop the user need not act on: a later pass, which never prompts, may clear it. */
function retryable(record: MetadataMigrationRecord | null): boolean {
  return record?.phase === "needsAttention" && !record.stale && !record.halt && !record.refused
}

/** Continue an explicitly authorized migration; release storage locks between observations. */
export async function runMetadataMigration(
  controller: MetadataMigrationController,
  options: {
    signal: AbortSignal
    pollMs?: number
    onProgress?: () => Promise<void>
    /**
     * A run the user did not start, such as the boot's: it follows an arriving run to the end and
     * stops once the run needs the user, never signing or sending.
     */
    observeOnly?: boolean
    /** Fires once the user's start has approved and proven everything: the rest needs no prompt. */
    onPrepared?: () => void
    /** Return once every batch is sent: what is left needs no tab. */
    untilArriving?: boolean
    /**
     * Try a failed pass again before stopping. Only for a run whose later passes cannot prompt, as
     * a frozen source's cannot; an observe-only run always does.
     */
    retry?: boolean
  },
) {
  const observeOnly = options.observeOnly ?? false
  const pollMs = options.pollMs ?? 5_000
  const retries = observeOnly || options.retry ? RETRIES : 0
  let start = !observeOnly
  let prepared = false
  let failures = 0
  while (!options.signal.aborted) {
    const record = await controller.advance(start, options.signal, {
      observeOnly,
      ...(start
        ? {
            // A start tried again rebuilds from saved approvals and never asks for another.
            ...(failures ? { prompts: false } : {}),
            onPrepared: () => {
              prepared = true
              options.onPrepared?.()
            },
          }
        : {}),
    })
    await options.onProgress?.()
    const retry = retryable(record) && failures < retries
    failures = retry ? failures + 1 : 0
    start = start && retry && !prepared
    if (!retry) {
      if (observeOnly && record?.phase !== "arriving") return record
      if (options.untilArriving && record?.phase === "arriving") return record
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
