/**
 * Which owed broadcast runs next. One runs at a time: every sponsored broadcast spends the
 * account's subscription note, and the PXE cannot see a pending spend, so a second one sent before
 * the first is decided conflicts with it. The registration goes first, because no deposit
 * broadcast is sponsored before the name lands. Then funded addresses, then the user's own, then
 * the pool, each oldest first.
 */
import type { BroadcastJob } from "./BroadcastLedger"

const rank = (job: BroadcastJob) =>
  job.fundedAt !== undefined ? 0 : job.kind === "registration" ? 1 : job.kind === "deposit" ? 2 : 3

/** Jobs that wait their turn: open, and blocked only by the queue. */
function contenders(jobs: readonly BroadcastJob[]): BroadcastJob[] {
  const open = jobs.filter((job) => job.state !== "landed")
  if (open.some((job) => job.state === "proving" || job.state === "sent")) return []
  const registrations = open.filter((job) => job.kind === "registration")
  return registrations.length > 0 ? registrations : open
}

export function nextBroadcast(
  jobs: readonly BroadcastJob[],
  now: number,
  { runnable = () => true }: { runnable?: (job: BroadcastJob) => boolean } = {},
): BroadcastJob | undefined {
  return contenders(jobs)
    .filter((job) => (job.retryAt ?? 0) <= now && runnable(job))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)[0]
}

/** When a contender's retry time comes up, if none is due now. */
export function nextRetryAt(jobs: readonly BroadcastJob[], now: number): number | undefined {
  const times = contenders(jobs)
    .filter((job) => job.retryAt !== undefined && job.retryAt > now)
    .map((job) => job.retryAt!)
  return times.length > 0 ? Math.min(...times) : undefined
}
