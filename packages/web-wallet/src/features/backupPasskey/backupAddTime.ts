/**
 * How long the backup add's funding takes: the bound the plan stores for the delayed rule, and the
 * release the screens' estimate is built on.
 */
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { bestEffort, WalletError } from "@obsidion/core/errors"
import {
  backupAddTakesMs,
  DEFAULT_PROOF_LATENCY,
  serviceStatus,
  UNREAD,
  useStore,
  type BackupAddRelease,
  type BackupRotationRecord,
  type BurnDurations,
  type QueryFactory,
  type WithdrawalPhase,
  type WithdrawalRecord,
  type WithdrawalSpeedupEstimator,
} from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { withTimeout } from "../../lib/withTimeout"
import { useSession, type Session } from "../../session/session"
import { burnLanding } from "../withdraw/burnTiming"
import { SWAP_QUOTE_MAX_AGE_MS, SWAP_QUOTE_REFRESH_MS } from "../withdraw/swapQuotes"

/** A cold proof calibration scans L1 logs; past this the bound takes the usual proof time. */
const CALIBRATE_WITHIN_MS = 10_000

/** The most an add takes from paying, by this device's burns and the rollup's epochs and proofs. */
export async function readBackupAddTakesMs(
  durations: BurnDurations,
  page: Pick<Session["page"], "speedupEstimator">,
  node: ObsidionWallet["node"],
): Promise<number> {
  const calibrate = page.speedupEstimator.ready().then((estimator) => estimator.calibrate())
  const [landing, constants, calibration] = await Promise.all([
    burnLanding(durations),
    node.getL1Constants(),
    bestEffort("timeout", withTimeout(calibrate, CALIBRATE_WITHIN_MS)),
  ])
  const fullProof = calibration?.fullProofSeconds ?? DEFAULT_PROOF_LATENCY.fullProofSeconds
  return backupAddTakesMs(landing.latest, constants, fullProof)
}

type ReleasePage = Pick<Session["page"], "speedupEstimator" | "wallet">

/** The estimate for the funding that landed in L2 block `landedBlock`, or for one landing now. */
async function estimateFunding(
  estimator: WithdrawalSpeedupEstimator,
  node: ObsidionWallet["node"],
  durations: BurnDurations,
  landedBlock: number | undefined,
) {
  if (landedBlock === undefined) {
    const landing = await burnLanding(durations)
    return { landingSeconds: landing.expected, estimate: await estimator.estimate(landing) }
  }
  const header = (await node.getBlockData(BlockNumber(landedBlock)))?.header
  if (!header) throw new WalletError("unknown", `no L2 block ${landedBlock}`)
  const landedAt = Number(header.globalVariables.timestamp)
  return { landingSeconds: 0, landedAt, estimate: await estimator.estimateLanded(landedAt) }
}

async function loadRelease(
  durations: BurnDurations,
  page: ReleasePage,
  landedBlock: number | undefined,
  signal: AbortSignal,
): Promise<BackupAddRelease> {
  const [{ node }, estimator] = await Promise.all([
    page.wallet.ready(signal),
    page.speedupEstimator.ready(signal),
  ])
  const [constants, { estimate, ...landing }] = await Promise.all([
    node.getL1Constants(),
    estimateFunding(estimator, node, durations, landedBlock),
  ])
  return {
    ...landing,
    standardEtaSeconds: estimate.standardEtaSeconds,
    tippedEtaSeconds: estimate.tippedEtaSeconds,
    l1SlotSeconds: constants.ethereumSlotDuration,
  }
}

/**
 * The release of the add's funding, by the L2 block it landed in: none for a burn landing now from
 * this device's history. Read again at the offer's cadence while a screen shows it, since the epoch
 * position, the device's landing and the previous epoch's proof all move with time.
 */
export const backupAddReleases = (
  query: QueryFactory,
  durations: BurnDurations,
  page: () => ReleasePage,
) =>
  query<[landedBlock: number | undefined], BackupAddRelease>("backupAddRelease", {
    load: (landedBlock, signal) => loadRelease(durations, page(), landedBlock, signal),
    poll: SWAP_QUOTE_REFRESH_MS,
    stale: SWAP_QUOTE_MAX_AGE_MS,
  })

export type BackupAddReleases = ReturnType<typeof backupAddReleases>

/** The phases a funding has landed in: its release is estimated from its landing. */
const LANDED_PHASES: ReadonlySet<WithdrawalPhase> = new Set<WithdrawalPhase>([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
  "done",
])

/** The L2 block the funding landed in, for the release read; undefined until it is mined. */
export const fundingBlock = (
  row?: Pick<WithdrawalRecord, "phase" | "blockNumber">,
): number | undefined => (row && LANDED_PHASES.has(row.phase) ? row.blockNumber : undefined)

/**
 * The release for the funding that landed in `landedBlock`, or for one landing now, while a screen
 * `shows` the add's time and the wallet is up; undefined while it loads or where a read failed.
 */
export function useBackupAddRelease(
  shows: boolean,
  landedBlock: number | undefined,
): BackupAddRelease | undefined {
  const { backupAddRelease, wallet } = useSession()
  const up = useStore(wallet, serviceStatus) === "ready"
  const state = useStore(shows && up ? backupAddRelease(landedBlock) : UNREAD)
  if (state.status !== "ready") return undefined
  // A wait before landing counts from now, so one whose refresh failed has gone stale.
  return landedBlock === undefined && state.error !== undefined ? undefined : state.value
}

/** The attempt's funding as the withdrawal tracker has it; each send writes the same row. */
export function useFundingRow(record: BackupRotationRecord | null): WithdrawalRecord | undefined {
  const session = useSession()
  const { records } = useStore(session.withdrawals.list)
  const localId = record?.fundings.at(-1)?.localId
  return localId === undefined ? undefined : records.find((row) => row.localId === localId)
}
