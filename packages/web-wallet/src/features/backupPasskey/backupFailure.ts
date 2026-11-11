import { WalletError } from "@obsidion/core/errors"
import {
  fundingLanding,
  RootPasskeyRequiredError,
  RotationFlowError,
  type BackupRotationRecord,
} from "@obsidion/front-core"
import { BackupPasskeyRefusedError, passkeyWritten } from "@obsidion/passkey-web"
import {
  AccountRecordMismatchError,
  BackupCredentialIdLengthError,
  BackupSetConflictError,
  RotationRouteNotLiveError,
} from "@obsidion/sdk"
import { errorMessage } from "../../errors/catalog"
import { DepositReadError } from "../deposit/depositReadErrors"
import { BackupStepError, LeftoverPasskeyError, passkeyDeclined } from "./backupPasskeyAdd"
import { panelCopy } from "./backupPasskeyCopy"

/** What went wrong, in the terms the screens word it in. */
export type BackupFailureKind =
  /** The passkey prompt was closed or timed out. */
  | "declined"
  /** The new passkey can't be a backup: passkey-web's refusals. */
  | "refused"
  /** The device minted a credential id longer than the account can store. */
  | "credential-too-long"
  /** Another device changed the account's keys or record. */
  | "changed"
  /** Only the account's first passkey can sign the step. */
  | "first-passkey"
  /** The network has no route that adds a backup. */
  | "route-not-live"
  /** The route that runs the change is not paying; the attempt is parked on it. */
  | "route"
  /** The attempt's record is damaged. */
  | "corrupt"
  | "funding-open"
  | "not-cancellable"
  | "deposit-read"
  | "unknown"

/** The step whose failure it is; `resume` is the driver's own run. */
export type BackupStep =
  | "add"
  | "approve"
  | "fund"
  | "move"
  | "cancel"
  | "recover"
  | "finish"
  | "resume"

/** Whether the attempt has taken the user's funds: nothing before the funding is sent. */
export type Charged = "nothing" | "funding"

/**
 * Where a failure shows: its own sheet, the network's or the first passkey's sheet, or a line on
 * the screen it happened on.
 */
export type FailureScreen = "failed" | "unavailable" | "firstPasskey" | "inline"

export interface BackupFailure {
  kind: BackupFailureKind
  /** Undefined for a failure the record's state is, rather than an error. */
  step?: BackupStep
  charged: Charged
  /** A passkey was saved on the device before the failure; the account never lists it. */
  leftover: boolean
  error?: unknown
}

/** The steps that open an attempt or take its funds; an unknown failure before paying ends them. */
const OPENING: ReadonlySet<BackupStep> = new Set(["add", "approve", "fund"])

/** The error table: each kind's screen, by the step it failed in and what it had charged. */
const SCREENS: Record<BackupFailureKind, (step: BackupStep, charged: Charged) => FailureScreen> = {
  "declined": (step) => (step === "add" || step === "fund" ? "failed" : "inline"),
  "refused": () => "failed",
  "credential-too-long": () => "failed",
  "changed": (step) => (step === "resume" ? "inline" : "failed"),
  "first-passkey": () => "firstPasskey",
  "route-not-live": (step) => (step === "resume" ? "inline" : "unavailable"),
  "route": () => "failed",
  "corrupt": () => "failed",
  "funding-open": () => "inline",
  "not-cancellable": () => "inline",
  "deposit-read": () => "inline",
  "unknown": (step, charged) => (charged === "nothing" && OPENING.has(step) ? "failed" : "inline"),
}

/** A funding that may still land, or one already swept: money left the balance. */
export const charged = (record: BackupRotationRecord | undefined): Charged =>
  record?.fundings.some((f) => fundingLanding(f) || f.outcome === "swept") ? "funding" : "nothing"

function kindOf(error: unknown): BackupFailureKind {
  if (error instanceof LeftoverPasskeyError) return kindOf(error.cause)
  if (error instanceof DepositReadError) return "deposit-read"
  if (error instanceof RotationRouteNotLiveError) return "route-not-live"
  if (error instanceof BackupCredentialIdLengthError) return "credential-too-long"
  if (error instanceof BackupPasskeyRefusedError) return "refused"
  if (error instanceof AccountRecordMismatchError || error instanceof BackupSetConflictError)
    return "changed"
  if (error instanceof RootPasskeyRequiredError) return "first-passkey"
  if (error instanceof RotationFlowError && error.code === "funding-open") return "funding-open"
  if (error instanceof RotationFlowError && error.code === "not-cancellable")
    return "not-cancellable"
  return passkeyDeclined(error) ? "declined" : "unknown"
}

function written(error: unknown): boolean {
  if (error instanceof LeftoverPasskeyError) return true
  try {
    return passkeyWritten(error)
  } catch {
    return false
  }
}

/** A step's failure, classified, over the record it ran on. */
export function backupFailure(
  error: unknown,
  step: BackupStep,
  record?: BackupRotationRecord,
): BackupFailure {
  return { kind: kindOf(error), step, charged: charged(record), leftover: written(error), error }
}

/** A failure the record's state is: a conflict, a parked route, a damaged record. */
export const stateFailure = (
  kind: "changed" | "route" | "corrupt",
  record: BackupRotationRecord,
): BackupFailure => ({ kind, charged: charged(record), leftover: false })

/** Where `failure` shows; a state failure is always its own sheet. */
export const failureScreen = (failure: BackupFailure): FailureScreen =>
  failure.step ? SCREENS[failure.kind](failure.step, failure.charged) : "failed"

/**
 * Logs a failure by its name and, for a step the record refused or a `WalletError`, its code. No
 * message, cause or field reaches the console: the driver's and the flow's errors are not a secrecy
 * boundary.
 */
export function warnFailure(what: string, error: unknown): void {
  if (error instanceof LeftoverPasskeyError)
    return warnFailure(`${what} after creation`, error.cause)
  const name = error instanceof Error ? error.name : typeof error
  const code =
    error instanceof BackupStepError ||
    error instanceof RotationFlowError ||
    error instanceof WalletError
      ? ` ${error.code}`
      : ""
  console.warn(`[backup-passkey] ${what}: ${name}${code}`)
}

/** The line each kind shows; the rest read as a check that could not finish. */
const LINES: Partial<Record<BackupFailureKind, string>> = {
  "route-not-live": panelCopy.routeNotLive,
  "credential-too-long": panelCopy.credentialIdTooLong,
  "funding-open": panelCopy.fundingOnItsWay,
  "not-cancellable": panelCopy.notCancellable,
  "declined": panelCopy.declined,
}

/**
 * What a failure says, in the user's terms, with the leftover line once when it left a passkey,
 * unless a refusal already says where to remove it.
 */
export function failureLine(failure: BackupFailure): string {
  const { error } = failure
  const cause = error instanceof LeftoverPasskeyError ? error.cause : error
  // A refusal's and a deposit read's own words are written for the user.
  const line =
    cause instanceof BackupPasskeyRefusedError
      ? errorMessage(cause)
      : cause instanceof DepositReadError
      ? cause.message
      : LINES[failure.kind] ?? panelCopy.unverifiable
  if (!failure.leftover || (cause instanceof BackupPasskeyRefusedError && cause.removalAdvice))
    return line
  return `${/[.!?…]$/.test(line) ? line : `${line}.`} ${panelCopy.leftoverPasskey}`
}
