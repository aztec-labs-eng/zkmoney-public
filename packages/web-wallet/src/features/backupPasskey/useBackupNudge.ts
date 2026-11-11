import { bestEffort } from "@obsidion/core/errors"
import { memoryStore, useStore, type BalanceView, type RotationDrive } from "@obsidion/front-core"
import { backupRecordFor } from "../../platform/auth/WebPasskeyIdentityMap"
import type { DeviceState } from "../../platform/storage/deviceKeys"
import { useSession } from "../../session/session"
import { savingsMoving, withdrawalInFlight } from "./backupPasskeyFacts"
import {
  backupNudge,
  homeNudge,
  type BackupNudge,
  type BackupNudgeFacts,
  type HomeNudge,
} from "./backupReminder"
import { useBackupRotation } from "./backupRotations"
import { awaitsApproval, useRotationDrives } from "./rotationDrive"

const NOT_PUT_OFF = memoryStore<bigint | null | "unread">(null).readonly
const SHOWN = memoryStore(false).readonly

/** Whether a saved add waits on the user's tap to move on. */
export const approvalWaiting = (drives: ReadonlyMap<string, RotationDrive>) =>
  [...drives.values()].some((drive) => awaitsApproval(drive) && !drive.approving)

// At module scope, so the store's cache parses the passkey map once per change.
const sessionRecord = ({ credentialId, passkeyMap }: DeviceState) =>
  credentialId ? backupRecordFor(passkeyMap, credentialId) : undefined

function useNudgeFacts(): BackupNudgeFacts {
  const session = useSession()
  const saved = useBackupRotation()
  const backupOnChain = useStore(session.page.backupReminder.seenOnChain)
  const record = useStore(session.device, sessionRecord)
  return {
    enabled: session.backupNudges !== null,
    record,
    noAddSaved: saved === null,
    backupOnChain,
  }
}

/** The Settings card and badges for the session's account. */
export const useBackupNudge = (): BackupNudge | undefined => backupNudge(useNudgeFacts())

const mainBalance = ({ known, main }: BalanceView) => (known ? main?.atomic ?? 0n : undefined)

/** Home's card for the session's account, and its "Not now". */
export function useHomeNudge(): { nudge: HomeNudge | undefined; dismiss: () => void } {
  const session = useSession()
  const nudges = session.backupNudges
  const withdrawals = useStore(session.withdrawals.list)
  const moves = useStore(session.savingsMoves.view)
  const nudge = homeNudge({
    ...useNudgeFacts(),
    balance: useStore(session.balances.view, mainBalance),
    busy:
      !withdrawals.hydrated ||
      !moves.loaded ||
      moves.failed ||
      withdrawalInFlight(withdrawals.records) ||
      savingsMoving(moves.records, withdrawals.records),
    putOffAt: useStore(nudges?.putOffAt ?? NOT_PUT_OFF),
    hiddenForSession: useStore(nudges?.hiddenForSession ?? SHOWN),
    awaitsApproval: approvalWaiting(useRotationDrives()),
  })
  const dismiss = () => {
    if (nudge?.kind === "oneDevice") nudges?.hideForSession()
    if (nudge?.kind === "oneKey" && nudges)
      void bestEffort("unknown", nudges.putOffUntilAbove(nudge.threshold))
  }
  return { nudge, dismiss }
}
