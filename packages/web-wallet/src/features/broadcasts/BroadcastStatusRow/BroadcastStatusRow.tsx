/**
 * The line under an address whose broadcast has not landed: where it stands. Funds sent meanwhile
 * wait at the address.
 */
import type { ReactNode } from "react"
import { ProvingStage } from "@obsidion/core/types"
import { selectSipaDeposit, useStore } from "@obsidion/front-core"
import type { SipaBroadcast } from "@obsidion/front-core"
import { Spinner } from "@obsidion/web-ds"
import { useSession } from "../../../session/session"
import copy from "./BroadcastStatusRow.copy"

const STAGE: Record<ProvingStage, string> = {
  [ProvingStage.Simulating]: copy.stage.preparing,
  [ProvingStage.Witgen]: copy.stage.preparing,
  [ProvingStage.Proving]: copy.stage.proving,
  [ProvingStage.Mining]: copy.stage.mining,
}

const WAITS = { unlock: "unlock", registration: "registration", balanceMove: "moving" } as const

type Status =
  | "published"
  | "waiting"
  | "proving"
  | "unlock"
  | "registration"
  | "moving"
  | "retrying"

function statusOf(job: SipaBroadcast, now: number): Status {
  if (job.state === "landed") return "published"
  if (job.state === "proving" || job.state === "sent") return "proving"
  if (job.wait) return WAITS[job.wait]
  if (job.failures > 0 || (job.retryAt ?? 0) > now) return "retrying"
  return "waiting"
}

/** `fallback` reads while no broadcast is owed for the address yet, e.g. before a tick owes it. */
export function BroadcastStatusRow({
  address,
  fallback = copy.waiting,
}: {
  address: string
  fallback?: ReactNode
}) {
  const { sipaDeposits, tasks, wake, page } = useSession()
  const job = useStore(sipaDeposits.view, (set) => selectSipaDeposit(set, address)?.broadcast)
  const { wallClock } = useSession().page
  const now = useStore(wallClock)
  const operationId = job?.operationId
  const stage = useStore(page.prover.progress, (p) =>
    operationId ? p.stages[operationId]?.stage ?? null : null,
  )
  if (!job)
    return (
      <div className="ww-send-to__note" data-testid="broadcast-status" data-status="unknown">
        <Spinner size={12} />
        <span>{fallback}</span>
      </div>
    )
  const status = statusOf(job, now)
  if (status === "published") return null
  const working = status !== "unlock" && status !== "registration" && status !== "moving"
  const line = status === "proving" ? (stage ? STAGE[stage] : copy.proving) : copy[status]
  return (
    <div className="ww-send-to__note" data-testid="broadcast-status" data-status={status}>
      {working && <Spinner size={12} />}
      <span>{line}</span>
      {status === "retrying" && (
        <button
          type="button"
          className="zkm-btn-reset ww-send-to__link"
          data-testid="broadcast-retry"
          onClick={() =>
            void sipaDeposits
              .apply(address, { type: "broadcastRetry" })
              .then(() => wake(tasks.sipaBroadcasts))
          }
        >
          {copy.retry}
        </button>
      )}
    </div>
  )
}
