/** The analytics a session owes from its withdrawals: the withdraw funnel and link claims. */
import {
  task,
  type OwedClaims,
  type Task,
  type WithdrawFunnel,
  type Withdrawals,
} from "@obsidion/front-core"
import { reportPaylinkClaims } from "../features/paylink/paylinkClaimReport"
import { reportWithdrawFunnel } from "../features/withdraw/withdrawFunnel"

/**
 * Reports both each time the withdrawals change, once they are read: before that, an expired claim
 * whose burn mined would be dropped unsent. Each report fires an event once, on durable state, so a
 * report again finds nothing new. An L1 leg that completed while the wallet was closed is reported
 * from the record's own timestamps.
 */
export function withdrawReports({
  withdrawals,
  funnel,
  claims,
}: {
  withdrawals: Pick<Withdrawals, "list">
  funnel: WithdrawFunnel
  claims: OwedClaims
}): Task {
  return task("withdrawReports", {
    needs: {},
    on: { list: withdrawals.list },
    every: "once",
    run: async ({ list: { records, hydrated } }) => {
      if (!hydrated) return
      await Promise.all([
        reportWithdrawFunnel(records, funnel),
        reportPaylinkClaims(records, claims),
      ])
    },
  })
}
