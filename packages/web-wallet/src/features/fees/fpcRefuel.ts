/**
 * ClaimFPC top-up. A sponsored flow owes its sponsor FPC a refuel check (`Session.oweFpcRefuel`);
 * the session's refuel task runs the checks as background proofs, so none starts while a user flow
 * runs and a user flow waits out one in flight.
 */
import { createPublicClient } from "viem"
import {
  service,
  task,
  type Prover,
  type Service,
  type Store,
  type Task,
} from "@obsidion/front-core"
import { FpcRefuelService, type FpcRefuelTarget, type ObsidionWallet } from "@obsidion/sdk"
import { l1ChainFor, l1Transport, type WebWalletConfig } from "../../config/env"

/** The least time between two bursts of checks: the flows owing one meanwhile share the next. */
export const REFUEL_COOLDOWN_MS = 60_000

/** The page's refuel check over its wallet. */
export const pageFpcRefuel = (
  wallet: Service<ObsidionWallet>,
  config: WebWalletConfig,
): Service<FpcRefuelService> =>
  service(
    "fpcRefuel",
    { from: [wallet], retry: "manual" },
    async ([w]) =>
      new FpcRefuelService(
        w,
        w.node,
        createPublicClient({ chain: l1ChainFor(config.l1ChainId), transport: l1Transport(config) }),
        { threshold: config.fpcRefuelThreshold },
      ),
  )

/** Ends after `ms`, or at once when `signal` aborts. A timer: no chain change ends it. */
const quiet = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

/**
 * The task that runs the refuel checks a session owes. A burst checks each owed FPC once, then the
 * cooldown passes before the next burst. A run reads `owed` as it goes, and a change to it, the
 * task's own writes included, runs the task again once a clean run ends, so the burst and the
 * cooldown outlive a run. A failed check leaves its FPC owed for the next owe.
 */
export function fpcRefuels(deps: {
  owed: Store<ReadonlyMap<string, FpcRefuelTarget>>
  refuel: Service<Pick<FpcRefuelService, "refuel">>
  prover: Pick<Prover, "runBackground">
}): Task {
  const { owed } = deps
  /** The FPCs the open burst checked; undefined between bursts. */
  let burst: Set<string> | undefined
  let quietUntil = 0
  const next = (checked: Set<string>) =>
    [...owed.get().values()].find((fpc) => !checked.has(fpc.address.toString()))
  const close = () => {
    burst = undefined
    quietUntil = Date.now() + REFUEL_COOLDOWN_MS
  }
  return task("fpcRefuel", {
    needs: { refuel: deps.refuel },
    on: { owed },
    every: "once",
    async run({ refuel, signal }) {
      while (!signal.aborted) {
        if (!burst) {
          if (owed.get().size === 0) return
          await quiet(quietUntil - Date.now(), signal)
          if (signal.aborted) return
          burst = new Set()
        }
        const checked = burst
        if (!next(checked)) {
          close()
          continue
        }
        try {
          // One background proof per check, so a user flow waits for the check in flight only.
          await deps.prover.runBackground(async () => {
            // Read once the prover is free: an FPC owed meanwhile joins this burst. An FPC stays
            // owed until its check ends, so a failed check leaves the rest owed.
            const fpc = signal.aborted ? undefined : next(checked)
            if (!fpc) return
            checked.add(fpc.address.toString())
            await refuel.refuel(fpc)
            const rest = new Map(owed.get())
            rest.delete(fpc.address.toString())
            owed.set(rest)
          })
        } catch (e) {
          close()
          throw e
        }
      }
    },
  })
}
