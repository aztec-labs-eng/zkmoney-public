/**
 * The session's tasks for user transactions: the prover's stages mark the records they prove, and
 * once the wallet is ready, whatever an earlier tab left `local` ends with its flow's record, and
 * `sent` operations settle from the chain.
 */
import {
  bestEffort,
  task,
  type Operations,
  type ProvingProgress,
  type ReadonlyStore,
  type Task,
  type Withdrawals,
  type Service,
} from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"

const RESOLVE_SENT_MS = 10_000

const warn = (err: unknown) =>
  console.warn("[operations] could not recover interrupted operations:", err)

/** The session's withdrawals and its operations. */
interface Stores {
  withdrawals: Withdrawals
  operations: Operations
}

/**
 * Marks the session's operations from the prover's stages: every proof reports a stage under its
 * operation's id, after the passkey signed. It runs while the page is hidden too, so a proof begun
 * there is marked, and a reload fails its record rather than dropping it. A failed write runs again
 * after 1 s, doubling to a minute.
 */
export function provingMarks(
  progress: ReadonlyStore<ProvingProgress>,
  operations: Pick<Operations, "apply">,
): Task {
  let marked = progress.get().stages
  return task("provingMarks", {
    needs: {},
    on: { progress },
    every: "once",
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    run: async ({ progress: { stages } }) => {
      const changed = Object.entries(stages).filter(([id, entry]) => marked[id] !== entry)
      await Promise.all(
        changed.map(([id, entry]) => operations.apply(id, { type: "proving", at: entry.at })),
      )
      marked = stages
    },
  })
}

/** Settles `sent` operations from the chain every 10 s while the page is visible. */
export function operationsSettle({
  wallet,
  operations,
}: {
  wallet: Service<Pick<ObsidionWallet, "node">>
  operations: Pick<Operations, "resolveSent">
}): Task {
  return task("operationsSettle", {
    needs: { wallet },
    every: RESOLVE_SENT_MS,
    run: async ({ wallet }) =>
      void (await bestEffort("unknown", operations.resolveSent(wallet.node))),
  })
}

/** Ends what an earlier tab left before submit, once per session: {@link recoverInterrupted}. */
export function interruptedSweep({
  wallet,
  activeSince,
  ...stores
}: Stores & { wallet: Service<unknown>; activeSince: () => number }): Task {
  return task("interruptedSweep", {
    needs: { wallet },
    every: "once",
    run: () => recoverInterrupted(stores, activeSince()),
  })
}

/**
 * End what an earlier tab left before submit: every operation, and the session's withdrawals.
 * One tab runs the wallet and this one starts nothing before `activeSince`, when it became the
 * active tab, so a record that started by then and holds no hash can never be sent. A flow saves
 * its hash on its operation and its own record in one write, so the two never disagree.
 */
export async function recoverInterrupted(
  { withdrawals, operations }: Stores,
  activeSince: number,
  now: number = Date.now(),
): Promise<void> {
  // A store that did not open is not empty, so nothing is failed until a later boot reads it.
  if (
    !(await bestEffort(
      "unknown",
      withdrawals.ready.then(() => true),
    ))
  )
    return
  await Promise.all([
    operations.sweep(activeSince, now).catch(warn),
    withdrawals.failInterrupted(now, now - activeSince).catch(warn),
  ])
}
