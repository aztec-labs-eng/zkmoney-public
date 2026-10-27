import type { OldVersionWithdrawal } from "../core/migration/OldVersionWithdrawalStorage"
import { bestEffort } from "./errors"
import type { Loaded } from "./recordSource"
import { within, type TaskDef } from "./runtime"
import type { ReadonlyStore } from "./store"

/** Longest one refund check may take; one that takes longer counts as failed. */
export const REFUND_CHECK_TIMEOUT_MS = 60_000

/** Checks each sending old-version withdrawal for its refunds every 15 s; `settle` saves them. */
export function oldVersionWithdrawalTask(deps: {
  records: ReadonlyStore<Loaded<OldVersionWithdrawal>>
  settle(id: string): Promise<unknown>
}): TaskDef {
  return {
    id: "oldVersionWithdrawals",
    stage: "oldVersionWithdrawals",
    cadence: 15_000,
    async run({ signal }) {
      const sending = deps.records.get().records.filter((r) => r.phase === "sending")
      const check = (id: string) =>
        within(deps.settle(id), "oldVersionWithdrawals", { ms: REFUND_CHECK_TIMEOUT_MS, signal })
      await Promise.all(sending.map((r) => bestEffort("refund.unchecked", check(r.id))))
    },
  }
}
