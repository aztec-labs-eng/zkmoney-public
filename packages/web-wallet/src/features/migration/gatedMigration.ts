/**
 * How an upgrade shares the prover with the user's own transactions. Local proving is single-flight
 * (`page.prover`): only the steps that ask the user something run as a user flow, and each step
 * that sends one transaction runs as its own background operation.
 */
import {
  runBackgroundOperation,
  runListedOperation,
  type OperationInput,
} from "../operations/operations"
import type { MigrationSendGate } from "@obsidion/sdk"
import type { Session } from "../../session/session"
import { runMigrationQueue, type MigrationQueueJob } from "./runMigrationQueue"

/**
 * Runs one upgrade step that sends one transaction as its own background operation: it waits its
 * turn on the prover, and no user flow waits for it. Do not call it from inside a user flow or from
 * inside another background operation, because it would wait for itself.
 */
export const backgroundSend =
  (session: Pick<Session, "operations" | "page">): MigrationSendGate =>
  (step) =>
    runBackgroundOperation(
      session,
      { operationId: `migration_${crypto.randomUUID()}`, flow: "migration", summary: "Upgrade" },
      (op) => step(op.operationId, op.sent),
    )

/**
 * Runs a queue as one listed operation: the bell shows it and it keeps the tab until it ends. Only
 * the prepare pass, which asks for the approvals, is a user flow. The send pass can wait for a long
 * time, for example until another run registers the account, so it is not a user flow, and it sends
 * each transaction through {@link backgroundSend}.
 */
export function runGatedMigrationQueue<T extends MigrationQueueJob>(
  session: Pick<Session, "operations" | "page">,
  operation: OperationInput,
  jobs: T[],
  options: Omit<Parameters<typeof runMigrationQueue<T>>[1], "prepare" | "exclusive"> & {
    /**
     * Runs inside the operation once the queue ends, with whether every source was sent. An error
     * it throws ends the operation as a failed flow would.
     */
    onEnd?(sent: boolean): void
  },
): Promise<boolean> {
  return runListedOperation(session, operation, async () => {
    const sent = await runMigrationQueue(jobs, {
      ...options,
      prepare: (flow) => session.page.prover.runUserFlow(flow),
      exclusive: backgroundSend(session),
    })
    options.onEnd?.(sent)
    return sent
  })
}
