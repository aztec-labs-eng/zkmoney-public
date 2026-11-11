/**
 * What a move's time note is built from: the slot grid the deposit screen reads, and
 * the release ETA the withdrawal flow's estimator gives for a burn landing at a given time.
 */
import {
  estimateWithdrawalSpeedup,
  memoryStore,
  type QueryFactory,
  type QueryState,
  type SavingsMoveEta,
  type SavingsMoveTiming,
  serviceStatus,
  useStore,
} from "@obsidion/front-core"
import { loadArrivalGrid } from "../deposit/depositArrival"
import { etaLabel } from "../withdraw/WithdrawalSpeedPicker"
import { useSession, type Session } from "../../session/session"

/** A burn that has landed: its release is estimated from where it sits in its epoch. */
const LANDED = { expected: 0, earliest: 0, latest: 0 }

type TimingPage = Pick<Session["page"], "speedupEstimator" | "wallet">

async function loadTiming(page: TimingPage, signal: AbortSignal): Promise<SavingsMoveTiming> {
  const [{ node }, estimator] = await Promise.all([
    page.wallet.ready(signal),
    page.speedupEstimator.ready(signal),
  ])
  const [grid, constants, calibration] = await Promise.all([
    loadArrivalGrid(node),
    node.getL1Constants(),
    estimator.calibrate(),
  ])
  return {
    grid,
    releaseSeconds: (landedAtSeconds: number) =>
      estimateWithdrawalSpeedup({ constants, now: landedAtSeconds, landing: LANDED, calibration })
        .standardEtaSeconds,
  }
}

/** The timing every move's note shares: read once per page, and again after a failed read. */
export const savingsMoveTimings = (query: QueryFactory, page: () => TimingPage) =>
  query<[], SavingsMoveTiming>("savingsMoveTiming", {
    load: (signal) => loadTiming(page(), signal),
  })

export type SavingsMoveTimings = ReturnType<typeof savingsMoveTimings>

const UNREAD = memoryStore<QueryState<SavingsMoveTiming>>({ status: "pending" }).readonly

/** The shared timing once the wallet is up; undefined while it loads or where a read failed. */
export function useSavingsMoveTiming(): SavingsMoveTiming | undefined {
  const { page, wallet } = useSession()
  const up = useStore(wallet, serviceStatus) === "ready"
  const timing = useStore(up ? page.savingsMoveTiming() : UNREAD)
  return timing.status === "ready" ? timing.value : undefined
}

/** "About 12 min left" while a leg counts down, "Usually about 25 min" for a typical duration. */
export const savingsEtaCopy = (eta: SavingsMoveEta): string =>
  eta.remaining
    ? `${etaLabel(eta.seconds)} left`
    : `Usually ${etaLabel(eta.seconds).replace(/^About/, "about")}`
