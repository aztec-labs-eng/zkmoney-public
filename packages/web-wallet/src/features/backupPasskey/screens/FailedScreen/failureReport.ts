import { WalletError } from "@obsidion/core/errors"
import { RotationFlowError } from "@obsidion/front-core"
import { reportEnv } from "../../../../errors/errorModal"
import { sendErrorReport } from "../../../../errors/shareErrorReport"
import type { BackupFailure } from "../../backupFailure"
import { BackupStepError, LeftoverPasskeyError } from "../../backupPasskeyAdd"

/**
 * What names a failure in a bug report: its step and kind, the error's name, and the code of the
 * wallet's own errors. Never the message, which can carry account details.
 */
export function failureId({ kind, step, error }: BackupFailure): string {
  const cause = error instanceof LeftoverPasskeyError ? error.cause : error
  const name = cause instanceof Error ? cause.name : typeof cause
  const code =
    cause instanceof BackupStepError ||
    cause instanceof RotationFlowError ||
    cause instanceof WalletError
      ? `:${cause.code}`
      : ""
  return `${step ?? "state"}/${kind}/${name}${code}`
}

/** Sends the failure's id and the device to the bug reports; whether they took it. */
export const sendFailureReport = (failure: BackupFailure): Promise<boolean> =>
  sendErrorReport({
    title: "Backup passkey add failed",
    message: failureId(failure),
    context: "backup-passkey",
    env: reportEnv(),
  })
