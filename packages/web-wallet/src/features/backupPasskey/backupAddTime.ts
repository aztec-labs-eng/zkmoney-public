import { bestEffort } from "@obsidion/core/errors"
import { backupAddTakesMs, DEFAULT_PROOF_LATENCY, type BurnDurations } from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { withTimeout } from "../../lib/withTimeout"
import type { Session } from "../../session/session"
import { burnLanding } from "../withdraw/burnTiming"

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
