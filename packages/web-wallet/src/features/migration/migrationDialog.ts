/**
 * Reaches the migration dialog from outside `MigrationDetectionMount`: a request to open it, and
 * where the account's upgrade stands, which the mount derives and nothing persists.
 */
import { useSyncExternalStore } from "react"
import type { MetadataMigrationPhase } from "@obsidion/front-core"
import { createExternalState } from "../../lib/externalState"
import type { WalletAction } from "../actionGate"

/**
 * - `checking`: what the account holds on old versions, or whether it must upgrade, is not known yet.
 * - `offered`: there is something to move, or the account's registration to update, and no run.
 * - `finishing`: the account's registration is current but not yet active here, with no run here.
 * - `running` / `stopped`: a run is going, or waits for the user.
 * - `failed`: a check of the old versions failed; trying again checks once more.
 */
export type UpgradeState =
  | "none"
  | "checking"
  | "offered"
  | "finishing"
  | "running"
  | "stopped"
  | "failed"

export interface UpgradeStatus {
  state: UpgradeState
  /** Where a running or stopped run stands. */
  phase?: MetadataMigrationPhase
  /** The upgrade also updates the account's registration for this version. */
  registration: boolean
  /** Nothing on an old version can pay for it: a deposit funds it. */
  external?: boolean
}

const requests = createExternalState(0)
let requestReason: MigrationDialogReason | undefined
const status = createExternalState<UpgradeStatus>({ state: "checking", registration: false })

/**
 * What asked for the dialog, when it should show that first: the residuals row lists what is left;
 * an action waits on the upgrade, and `then` starts it once the account turns out not to need one.
 */
export type MigrationDialogReason = "residuals" | { action: WalletAction; then?: () => void }

/** Opens the dialog, even after the session's "Later". */
export function openMigrationDialog(reason?: MigrationDialogReason): void {
  requestReason = reason
  requests.set(requests.get() + 1)
}

/** The reason of the latest request. */
export function migrationDialogReason(): MigrationDialogReason | undefined {
  return requestReason
}

/** Changes on every open request. */
export function useMigrationDialogRequest(): number {
  return useSyncExternalStore(requests.subscribe, requests.get)
}

export function setUpgradeStatus(next: UpgradeStatus): void {
  const now = status.get()
  if (
    now.state !== next.state ||
    now.phase !== next.phase ||
    now.registration !== next.registration ||
    now.external !== next.external
  ) {
    status.set(next)
  }
}

export function useUpgradeStatus(): UpgradeStatus {
  return useSyncExternalStore(status.subscribe, status.get)
}
