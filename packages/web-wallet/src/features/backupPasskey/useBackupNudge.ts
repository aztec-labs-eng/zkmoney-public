import { bestEffort } from "@obsidion/core/errors"
import { backupAddTiming, memoryStore, useStore, type BalanceView } from "@obsidion/front-core"
import { backupRecordFor } from "../../platform/auth/WebPasskeyIdentityMap"
import type { DeviceState } from "../../platform/storage/deviceKeys"
import { useSession } from "../../session/session"
import { selectMoveUnfinished } from "./accountHistory"
import { fundingBlock, useBackupAddRelease, useFundingRow } from "./backupAddTime"
import { savingsMoving, withdrawalInFlight } from "./backupPasskeyFacts"
import {
  backupNudge,
  homeNudge,
  type BackupNudge,
  type BackupNudgeFacts,
  type HomeNudge,
} from "./backupReminder"
import { useBackupRotation } from "./backupRotations"
import { selectAddStep, type AddStep } from "./backupScreen"
import { useRotationDrive } from "./rotationDrive"

const NOT_PUT_OFF = memoryStore<bigint | null | "unread">(null).readonly
const SHOWN = memoryStore(false).readonly
const NO_CLOCK = memoryStore(0).readonly

/** The session passkey's record. At module scope, so the store's cache parses the map once per change. */
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

/** The session account's one-passkey classification, which Settings and the badges read. */
export const useBackupNudge = (): BackupNudge | undefined => backupNudge(useNudgeFacts())

/** Main Account's balance once the session knows it. */
export const mainBalance = ({ known, main }: BalanceView) =>
  known ? main?.atomic ?? 0n : undefined

/**
 * The saved add's step, with the sheet's time left while the network works after paying; none in a
 * build without the add's card, which then reads nothing.
 */
function useAddStep(enabled: boolean): AddStep | undefined {
  const { page } = useSession()
  const saved = useBackupRotation()
  const record = typeof saved === "object" ? saved : null
  const drive = useRotationDrive(record?.owner ?? "")
  const funding = useFundingRow(record)
  const step = enabled ? selectAddStep(saved, { drive }) : undefined
  const network = step?.kind === "adding" && !step.delayed
  const now = useStore(network ? page.wallClock : NO_CLOCK)
  // Only a paid add still on time has a countdown, so a late one stops reading the estimate.
  const timing = network && record ? backupAddTiming(record, now) : undefined
  const release = useBackupAddRelease(timing?.delayed === false, fundingBlock(funding))
  return network ? selectAddStep(saved, { drive, funding, release, now }) : step
}

/** Home's card for the session's account, and its "Not now". */
export function useHomeNudge(): { nudge: HomeNudge | undefined; dismiss: () => void } {
  const session = useSession()
  const nudges = session.backupNudges
  const withdrawals = useStore(session.withdrawals.list)
  const moves = useStore(session.moves.view)
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
    add: useAddStep(nudges !== null),
    moveUnfinished: useStore(session.accountHistory, selectMoveUnfinished),
  })
  const dismiss = () => {
    if (nudge?.kind === "oneDevice") nudges?.hideForSession()
    if (nudge?.kind === "oneKey" && nudges)
      void bestEffort("unknown", nudges.putOffUntilAbove(nudge.threshold))
  }
  return { nudge, dismiss }
}
