import { BackupPasskeyRefusedError } from "@obsidion/passkey-web"
import { SignerKeyMismatchError } from "../../../../platform/auth/webauthnSigning"
import type { BackupStep } from "../../backupFailure"
import type { BackupScreen } from "../../backupScreen"

/**
 * What a sheet's button does: `retry` runs the step again, `phone` adds on the phone, `back` returns
 * to the screen under the sheet, `cancel` drops the saved attempt, `keys` drops it where it can and
 * reads the account's keys again, `check` asks the chain again, `report` sends a bug report.
 */
export type SheetMove = "retry" | "phone" | "back" | "cancel" | "keys" | "check" | "report"

/**
 * C1 closed, C2 refused, C4 changed, C5 failed, C8 fees, a damaged record, and a session key this
 * browser recorded wrong, which no retry signs with.
 */
export type SheetKind =
  | "closed"
  | "refused"
  | "changed"
  | "failed"
  | "fees"
  | "damaged"
  | "mismatch"

interface FailedSheet {
  kind: SheetKind
  primary?: SheetMove
  secondary?: SheetMove
}

const RETRIED: ReadonlySet<BackupStep> = new Set(["add", "approve", "fund"])

/** The picker under an add that failed. */
export const placeUnder = (under?: BackupScreen) =>
  under?.id === "place" || under?.id === "keys" ? under.place : undefined

/** The sheet a failure gets, and what its buttons do. */
export function failedSheet({
  failure,
  under,
  canCancel,
}: Extract<BackupScreen, { id: "failed" }>): FailedSheet {
  const { kind, step, error } = failure
  const retry = step && RETRIED.has(step) ? "retry" : undefined
  // Before an attempt is saved, the screen under the sheet; once saved, dropping it.
  const back = step === "add" ? "back" : canCancel ? "cancel" : undefined
  switch (kind) {
    case "declined":
      return { kind: "closed", primary: retry, secondary: back }
    case "refused": {
      const place = placeUnder(under)
      // The phone is the security key's fix, where the picker offers it.
      const phone =
        error instanceof BackupPasskeyRefusedError &&
        error.kind === "key-no-prf" &&
        place?.selected !== "phone" &&
        place?.options.some((option) => option.id === "phone")
      return { kind: "refused", primary: phone ? "phone" : retry, secondary: back }
    }
    case "credential-too-long":
      // No retry changes the id the device minted.
      return { kind: "refused", primary: back }
    case "changed":
      return { kind: "changed", primary: "keys" }
    case "route":
      return { kind: "fees", primary: "check", secondary: back }
    case "corrupt":
      return { kind: "damaged", primary: back }
    default:
      return error instanceof SignerKeyMismatchError
        ? { kind: "mismatch", primary: back, secondary: "report" }
        : { kind: "failed", primary: retry, secondary: "report" }
  }
}
