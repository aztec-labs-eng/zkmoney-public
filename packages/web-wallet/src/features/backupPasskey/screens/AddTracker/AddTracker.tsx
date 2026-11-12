import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { InfoBox, StepTracker, type SheetAction, type TrackerStep } from "@obsidion/web-ds"
import { formatUnits } from "viem"
import { fmt } from "../../../../lib/fmt"
import { usdFigure } from "../../../../ui/format"
import { failureLine, type BackupFailure } from "../../backupFailure"
import { relandingCopy } from "../../backupPasskeyCopy"
import type { BackupActions, BackupSaved, Tracked } from "../../backupScreen"
import copy from "./AddTracker.copy"
import styles from "./AddTracker.module.css"

const MINUTE = 60_000

/** Dollars, as the add's Activity row shows them. */
export const dollars = (atomic: bigint) => usdFigure(formatUnits(atomic, DEFAULT_DECIMALS))

/** Whole minutes, rounded up the way the time left is, so it never reads past its bound. */
export const minutes = (ms: number) => Math.ceil(ms / MINUTE)

/** The passkey that approves, by the key list's name for it. */
export const approverOf = ({ approver }: Pick<Tracked, "approver">) => approver ?? copy.yourPasskey

export const approveLabel = (screen: Pick<Tracked, "approver">) =>
  fmt(copy.approve, { approver: approverOf(screen) })

/**
 * The current step's line. A warning or error is announced as `say`, else as the line itself, so
 * a line that changes every minute can say what holds the step once.
 */
export type StepLine = Pick<TrackerStep, "detail" | "tone" | "failed"> & { say?: string }

/** A closed prompt names the step to retry; other failures say what stopped it. */
export const failedLine = (failure: BackupFailure): StepLine => ({
  detail: failure.kind === "declined" ? copy.closed : failureLine(failure),
  tone: "warning",
  failed: true,
})

const RELANDING: StepLine = { detail: relandingCopy.line, tone: "warning" }

/** C6's line: how long ago the chain was last read for the add. */
export function delayedLine({ checkedAgoMs }: Pick<Tracked, "checkedAgoMs">): StepLine {
  const detail =
    checkedAgoMs === undefined
      ? copy.delayed
      : checkedAgoMs < MINUTE
      ? copy.checkedNow
      : fmt(copy.checkedAgo, { minutes: Math.floor(checkedAgoMs / MINUTE) })
  return { detail, tone: "warning", say: copy.delayed }
}

/** Closes the sheet, where the host can; the add goes on without it. */
export const closeAction = (
  actions: BackupActions,
  style?: "plain",
): (SheetAction & { style?: "plain" }) | undefined =>
  actions.close && {
    label: copy.close,
    onClick: actions.close,
    testId: "backup-close",
    ...(style && { style }),
  }

/** Asks the driver about the attempt again, after its last read failed. */
export const retryAction = (screen: Tracked, actions: BackupActions): SheetAction => ({
  label: copy.tryAgain,
  onClick: actions.check,
  loading: screen.checking,
  testId: "backup-watch-retry",
})

const savedLine = (saved?: BackupSaved) =>
  !saved
    ? undefined
    : "securityKey" in saved
    ? copy.savedOnKey
    : fmt(copy.savedIn, { manager: saved.manager })

/**
 * The add's four steps. The current one shows the attempt's failure, else `prompt`, else the
 * sweep re-landing while it does, else `line`. A failure or prompt keeps the step's line, and the
 * re-landing shows as a note below.
 */
export function AddTracker({
  screen,
  line,
  prompt,
}: {
  screen: Tracked
  line?: StepLine
  /** What the step asks the user to do. */
  prompt?: StepLine
}) {
  const { step, relanding } = screen.progress
  const approver = approverOf(screen)
  const kept = screen.failure ? failedLine(screen.failure) : prompt
  const shown = kept ?? (relanding ? RELANDING : line)
  // Any action in flight, such as a retry, turns a failed step's ring again.
  const retrying = screen.busy || screen.checking
  const at = (n: number): Omit<TrackerStep, "label"> =>
    n === step
      ? {
          state: "current",
          detail: shown?.detail,
          tone: shown?.tone,
          failed: shown?.failed && !retrying,
        }
      : { state: "todo" }
  const steps: TrackerStep[] = [
    { label: copy.saved, detail: savedLine(screen.savedIn), state: "done" },
    step > 2
      ? {
          label: fmt(copy.approved, { approver }),
          detail:
            screen.paid === undefined
              ? undefined
              : fmt(copy.paid, { amount: dollars(screen.paid) }),
          state: "done",
        }
      : { label: approveLabel(screen), ...at(2) },
    step > 3
      ? { label: copy.confirmed, detail: copy.confirmedDetail, state: "done" }
      : { label: step === 3 ? copy.waiting : copy.wait, ...at(3) },
    { label: copy.finish, ...at(4) },
  ]
  return (
    <>
      <StepTracker label={copy.label} progress={fmt(copy.progress, { step })} steps={steps} />
      {shown?.tone && shown.tone !== "progress" && (
        <p className={styles.announce} role="alert">
          {shown.say ?? shown.detail}
        </p>
      )}
      {relanding && kept && <InfoBox title={relandingCopy.title}>{relandingCopy.line}</InfoBox>}
    </>
  )
}
