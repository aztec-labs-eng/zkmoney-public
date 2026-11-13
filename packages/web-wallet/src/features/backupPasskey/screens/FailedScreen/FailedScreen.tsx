import { useRef } from "react"
import {
  FactBox,
  InfoBox,
  SheetShell,
  type SheetAction,
  type SheetShellProps,
} from "@obsidion/web-ds"
import { BackupPasskeyRefusedError } from "@obsidion/passkey-web"
import { useSubmit } from "../../../../ui/hooks"
import { useDomEffect } from "../../../../ui/useDomEffect"
import { failureLine } from "../../backupFailure"
import { attentionLine, panelCopy } from "../../backupPasskeyCopy"
import type { BackupScreenProps } from "../../backupScreen"
import copy from "./FailedScreen.copy"
import styles from "./FailedScreen.module.css"
import { failedSheet, placeUnder, type SheetKind, type SheetMove } from "./failedSheet"
import { sendFailureReport } from "./failureReport"

function wordsOf(kind: SheetKind, error: unknown): Pick<SheetShellProps, "title" | "lead"> {
  switch (kind) {
    case "closed":
      return copy.closed
    case "refused":
      return error instanceof BackupPasskeyRefusedError
        ? { title: error.copy.title, lead: error.copy.fix }
        : copy.tooLong
    case "changed":
      return copy.changed
    case "fees":
      return copy.fees
    case "damaged":
      return { title: copy.failed.title, lead: attentionLine.corrupt }
    case "mismatch":
      return { title: copy.failed.title, lead: copy.mismatch }
    case "failed":
      return copy.failed
  }
}

/** C1, C2, C4, C5 and C8: what failed, what it charged, and the way on. */
export function FailedScreen({ screen, actions }: BackupScreenProps<"failed">) {
  const { failure, busy, checking, canCancel, inline } = screen
  const { status, submit } = useSubmit(() => sendFailureReport(failure))
  const sheet = useRef<HTMLDivElement>(null)
  // It replaces the screen the user acted on, whose focus went with it.
  useDomEffect(() => sheet.current?.focus(), [])

  const place = placeUnder(screen.under)
  const { kind, primary, secondary } = failedSheet(screen)
  const { title, lead } = wordsOf(kind, failure.error)
  const moves: Record<SheetMove, Omit<SheetAction, "testId">> = {
    retry: {
      label: panelCopy.tryAgain,
      onClick: () =>
        failure.step === "approve"
          ? actions.approve()
          : failure.step === "fund"
          ? actions.fund()
          : actions.add(place?.selected),
    },
    phone: {
      label: copy.usePhone,
      onClick: () => {
        actions.pick("phone")
        actions.add("phone")
      },
    },
    back: { label: place ? copy.otherPlace : panelCopy.cancel, onClick: () => actions.dismiss() },
    cancel: {
      label: kind === "damaged" ? copy.startOver : panelCopy.cancel,
      // A sheet whose only way on is dropping the attempt drops it at once.
      onClick: () => (primary === "cancel" ? actions.cancel() : actions.askCancel()),
    },
    keys: {
      label: copy.check,
      onClick: () => {
        if (canCancel) actions.cancel()
        else actions.dismiss()
        actions.retryRead("keys")
      },
    },
    check: { label: panelCopy.tryAgain, onClick: () => actions.check(), loading: checking },
    report: {
      label: copy.report[status],
      onClick: () => void submit(),
      loading: status === "sending",
      disabled: status === "sent",
    },
  }
  const action = (move?: SheetMove): SheetAction | undefined =>
    move && {
      ...moves[move],
      disabled: busy || moves[move].disabled,
      testId: `backup-failed-${move}`,
    }

  const charged = kind !== "failed"
  return (
    <div ref={sheet} tabIndex={-1} role="group" aria-label={title} className={styles.sheet}>
      <SheetShell
        hero={kind === "failed" || kind === "damaged" || kind === "mismatch" ? "error" : "warning"}
        title={title}
        lead={lead}
        primary={action(primary)}
        secondary={action(secondary)}
      >
        {charged || failure.leftover || inline ? (
          <>
            {charged && <FactBox facts={[{ label: copy.charged, value: copy[failure.charged] }]} />}
            {failure.leftover && (
              <InfoBox title={copy.cleanup}>
                {(failure.error instanceof BackupPasskeyRefusedError &&
                  failure.error.copy.cleanup) ||
                  panelCopy.leftoverPasskey}
              </InfoBox>
            )}
            {inline && (
              <p className="ww-search__error" role="alert" data-testid="backup-error">
                {failureLine(inline)}
              </p>
            )}
          </>
        ) : undefined}
      </SheetShell>
    </div>
  )
}
