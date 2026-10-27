import {
  runMetadataMigration,
  type MetadataMigrationController,
  type MetadataMigrationSummary,
  type MetadataMigrationRecord,
} from "@obsidion/front-core"

export interface MigrationQueueJob {
  controller: MetadataMigrationController
  summary?: MetadataMigrationSummary
}

/**
 * An upgrade's approvals over all its runs, counted as one: each run's own count once it has asked,
 * else what its quote asks. None when nothing is asked.
 */
export function upgradeApprovals(
  runs: readonly { record?: MetadataMigrationRecord | null; summary?: MetadataMigrationSummary }[],
): { approved: number; total: number } | undefined {
  let approved = 0
  let total = 0
  for (const { record, summary } of runs) {
    approved += record?.approvals?.approved ?? 0
    total += record?.approvals?.total ?? summary?.approvals ?? record?.summary?.approvals ?? 0
  }
  return total > 0 ? { approved, total } : undefined
}

/** Runs one step that sends one transaction, as the operation it names to the step. */
export type MigrationQueueSend = <T>(step: (operationId?: string) => Promise<T>) => Promise<T>

/**
 * Approve every source before publishing any source. Execution follows the registration source.
 *
 * The queue runs in two passes. The prepare pass asks for every approval and builds every proof,
 * and sends nothing; it runs inside `prepare`, for example the user's flow on the prover. The send
 * pass starts only after `prepare` has ended. It sends each transaction inside `exclusive`, and it
 * can wait a long time: a funds-only run waits until another run registers the account. Thus the
 * send pass must not run inside a user flow, because a background step that it waits for could not
 * start.
 */
export async function runMigrationQueue<T extends MigrationQueueJob>(
  jobs: T[],
  options: {
    signal: AbortSignal
    onActive(job: T): () => void
    onRecord?(job: T, record: MetadataMigrationRecord | null): void
    onPrepared(): void
    onArriving(job: T): void
    /** Runs the prepare pass. The default runs it immediately. */
    prepare?: <R>(pass: () => Promise<R>) => Promise<R>
    /** Runs each step of the send pass that sends one transaction. */
    exclusive?: MigrationQueueSend
    /** How long a pass waits before it observes again. */
    pollMs?: number
    beforeApproval?: (approved: number, total: number) => Promise<void>
  },
) {
  const prepare = options.prepare ?? ((pass) => pass())
  if (!(await prepare(() => prepareMigrationQueue(jobs, options)))) return false
  options.signal.throwIfAborted()
  options.onPrepared()
  return sendMigrationQueue(jobs, options)
}

/**
 * The prepare pass: collect and save the approvals of every source, in order, then prove them. It
 * sends nothing.
 */
async function prepareMigrationQueue<T extends MigrationQueueJob>(
  jobs: T[],
  options: {
    signal: AbortSignal
    onActive(job: T): () => void
    onRecord?(job: T, record: MetadataMigrationRecord | null): void
    beforeApproval?: (approved: number, total: number) => Promise<void>
  },
): Promise<boolean> {
  for (const approvalsOnly of [true, false]) {
    for (const job of jobs) {
      const unsubscribe = options.onActive(job)
      try {
        const record = await runMetadataMigration(job.controller, {
          signal: options.signal,
          prepareOnly: true,
          approvalsOnly,
          summary: job.summary,
          beforeApproval: options.beforeApproval,
        })
        options.onRecord?.(job, record)
        if (
          !record ||
          record.phase === "needsAttention" ||
          record.phase === "needsApproval" ||
          options.signal.aborted
        )
          return false
      } finally {
        unsubscribe()
      }
    }
  }
  return true
}

/** The send pass: send every source, in order, on its saved approvals, until each is arriving. */
async function sendMigrationQueue<T extends MigrationQueueJob>(
  jobs: T[],
  options: {
    signal: AbortSignal
    onActive(job: T): () => void
    onRecord?(job: T, record: MetadataMigrationRecord | null): void
    onArriving(job: T): void
    exclusive?: MigrationQueueSend
    pollMs?: number
  },
): Promise<boolean> {
  for (const job of jobs) {
    const unsubscribe = options.onActive(job)
    try {
      const record = await runMetadataMigration(job.controller, {
        signal: options.signal,
        retry: true,
        prompts: false,
        untilArriving: true,
        exclusive: options.exclusive,
        pollMs: options.pollMs,
      })
      options.onRecord?.(job, record)
      if (
        !record ||
        (record.phase !== "arriving" && record.phase !== "done") ||
        options.signal.aborted
      )
        return false
      options.onArriving(job)
    } finally {
      unsubscribe()
    }
  }
  return true
}
