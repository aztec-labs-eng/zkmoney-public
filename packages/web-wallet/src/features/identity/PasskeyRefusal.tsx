import type { ReactNode } from "react"
import {
  type DevicePosture,
  IN_APP_BROWSER_ROWS,
  isNoCredentialError,
  isPasskeyCancelled,
  LEFTOVER_PASSKEY_COPY,
  MISMATCH_COPY,
  type RefusalRow,
  type RefusalState,
  refusalFor as sharedRefusalFor,
} from "@obsidion/passkey-web"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { PASSKEYS_DOCS_URL } from "../../lib/links"
import type { MismatchVerdict } from "../../platform/auth/WebAlphaAuthService"
import { OpenInBrowser } from "./OpenInBrowser"

export type { RefusalState }

/** A refusal whose verdict picks the copy for a record mismatch. */
export type RouteRefusal = RefusalState & {
  /** A record mismatch's verdict, so the card picks the copy and whether "try again" is offered. */
  verdict?: MismatchVerdict
  /** The browser's own error, sent when the user reports the refusal. */
  cause?: unknown
  /** The error said a passkey was written before it, so the card links the cleanup entry. */
  leftover?: boolean
}

/** The line under a refusal that left a passkey behind: where it is and how to delete it. */
function LeftoverPasskeyLine() {
  return (
    <p
      className="ww-paylink-summary__caption ww-passkey-refusal__message"
      data-testid="passkey-leftover"
    >
      {LEFTOVER_PASSKEY_COPY.line}
      <br />{" "}
      <a
        className="ww-invite__link"
        href={`${PASSKEYS_DOCS_URL}#${LEFTOVER_PASSKEY_COPY.anchor}`}
        target="_blank"
        rel="noreferrer"
      >
        {LEFTOVER_PASSKEY_COPY.link}
      </a>
      .
    </p>
  )
}

/** This browser holds the account's record and the passkey no longer reproduces it. */
export const STORED_ADDRESS_MISMATCH = "StoredAddressMismatchError"

/**
 * The name the sign-in screen keys a signup that is still waiting in line. Not an error the
 * ceremony can raise: the passkey worked, and what is missing is a turn.
 */
export const QUEUED_REGISTRATION = "QueuedRegistrationError"

/**
 * The name the sign-in screen keys a signup whose turn has come but which was never finished.
 * Nothing is wrong and nothing is waiting — the tag is simply not claimed yet, and a wallet
 * without one has no route that can spend.
 */
export const GRANTED_REGISTRATION = "GrantedRegistrationError"

/**
 * The name the sign-in screen keys a signup account-service still holds a tag for: reserved under
 * this passkey's key, never registered, so there is no wallet to open until it is finished.
 */
export const RESERVED_REGISTRATION = "ReservedRegistrationError"

/**
 * The name the sign-in screen keys a waitlist check that could not answer. Distinct from being in
 * the queue: nothing about this account is settled, so the only honest offer is another attempt.
 */
export const ADMISSION_UNAVAILABLE = "AdmissionUnavailableError"

/**
 * The sign-in prompt closed without a passkey. A deliberate cancel and a sheet that offered
 * nothing look the same to the wallet, so the card names the likely causes and offers the tag.
 */
export const PASSKEY_NOT_OFFERED = "PasskeyNotOfferedError"

export const isPasskeyNotOffered = (error: unknown): boolean =>
  isPasskeyCancelled(error) || isNoCredentialError(error)

/** The tag's account has no readable passkey credential on L1. */
export const NO_PASSKEY_RECORDED = "NoPasskeyRecordedError"

/** The tag's credential was asked for by id and this device did not offer it. */
export const PASSKEY_NOT_ON_DEVICE = "PasskeyNotOnDeviceError"

/** The pinned passkey answered, but nothing it derives is the tag's account. */
export const PASSKEY_KEY_MISMATCH = "PasskeyKeyMismatchError"

/** The pinned passkey derives the tag's account, but no anchor confirmed the record. */
export const REGISTRY_UNANCHORED = "RegistryUnanchoredError"

/** The tag lists this passkey, but this attempt did not open the wallet. Never a divergence claim. */
export const NOT_REPRODUCED_HERE = "NotReproducedHereError"

/** The tag's complete key set does not hold this passkey. */
export const DIFFERENT_PASSKEY = "DifferentPasskeyError"

/** The tag's account holds more keys than could be read, so membership cannot be settled. */
export const INCONCLUSIVE = "InconclusiveError"

/** The wallet's own refusals beside the shared rows: raised by onboarding, keyed by name like the rest. */
const WALLET_ROWS: Record<string, RefusalRow> = {
  ...IN_APP_BROWSER_ROWS,
  PasskeyMismatchError: { title: "This passkey opens a different account", retry: true },
  // Reached only when the closed prompt followed a saved passkey; a closed first prompt is no card.
  NotAllowedError: { title: "The passkey prompt was closed", retry: true },
  // The screen writes the messages of the by-tag rows: they name the tag and the device.
  [PASSKEY_NOT_OFFERED]: { title: "Your passkey wasn't offered", retry: true },
  [NO_PASSKEY_RECORDED]: { title: "No passkey recorded for this tag", retry: false },
  [PASSKEY_NOT_ON_DEVICE]: { title: "Passkey not on this device", retry: true },
  [PASSKEY_KEY_MISMATCH]: { title: "This passkey doesn't open this tag", retry: false },
  [REGISTRY_UNANCHORED]: { title: "Couldn't confirm this tag's record", retry: true },
  [NOT_REPRODUCED_HERE]: { title: "That didn't open your wallet", retry: true },
  // Retry reopens the browser's prompt, where the right passkey or another device is picked.
  [DIFFERENT_PASSKEY]: { title: "This passkey opens a different account", retry: true },
  [INCONCLUSIVE]: { title: "Couldn't confirm this passkey", retry: true },
  // No message: the screen writes it, because the waitlist answer may carry a position.
  [QUEUED_REGISTRATION]: { title: "You're still in line", retry: false },
  [GRANTED_REGISTRATION]: {
    title: "You're through the queue",
    retry: false,
    message:
      "Your turn came up and your tag is held for you. Pick it back up below to finish signing " +
      "up — a wallet needs its tag before it can send or deposit.",
  },
  // No message: the screen writes it, naming the reserved tag.
  [RESERVED_REGISTRATION]: { title: "Your signup didn't finish", retry: false },
  [ADMISSION_UNAVAILABLE]: {
    title: "Couldn't check your place in line",
    retry: true,
    message:
      "Your passkey worked and your account is fine — we just couldn't reach the waitlist to see " +
      "whether it is your turn.",
  },
}

export function refusalFor(error: { name: string }, verdict?: MismatchVerdict): RefusalRow {
  if (error.name === STORED_ADDRESS_MISMATCH && verdict) return MISMATCH_COPY[verdict]
  return sharedRefusalFor(error, WALLET_ROWS)
}

export type PromptCause = { title: string; detail: string }

/**
 * The likely reasons a passkey prompt offered nothing, with the action each implies, most likely
 * first. The wallet cannot tell them apart; only the "browser can't see it" line depends on the
 * device, since the answer on a phone is its default browser and on a laptop the phone scanning the code.
 */
export function promptCauses(posture: DevicePosture): PromptCause[] {
  return [
    {
      title: "It hasn't synced yet",
      detail:
        "A passkey made minutes ago on another device can take a few minutes to arrive. Wait, then go back and try again.",
    },
    {
      title: "This browser can't see it",
      detail:
        posture === "phone"
          ? "If your password manager shows it, open zk.money in your phone's default browser."
          : "Go back and choose Show passkeys, then pick the phone that holds it.",
    },
    {
      title: "It's a different tag",
      detail: "Go back and check the tag, or sign in on the device you registered on.",
    },
  ]
}

/** The refusal's own error for a report, as an `Error` so the report keeps its message and stack. */
function reportableCause(error: RouteRefusal): Error {
  if (error.cause instanceof Error) return error.cause
  const { name, message, stack } = (error.cause ?? {}) as Record<string, unknown>
  const reported = new Error(typeof message === "string" ? message : error.message)
  reported.name = typeof name === "string" ? name : error.name
  if (typeof stack === "string") reported.stack = stack
  return reported
}

/**
 * A passkey refusal, rendered in place: title, the reason in plain words, a retry where one can
 * help, and whatever exits the surface offers. `reason` is the error's name for tests and analytics.
 * `causes` are the likely reasons, under one heading, where the wallet cannot tell them apart.
 * `primary` takes the gradient button, and the retry becomes a pill beside the exits. A row whose
 * way out is the phone's browser adds it, and a report link; `escapePath` names the page to open.
 */
export function PasskeyRefusal({
  error,
  onRetry,
  busy = false,
  causes,
  primary,
  exits,
  verdict,
  escapePath,
  reportContext = "passkey",
  testId = "passkey-refused",
  retryTestId = "passkey-retry",
}: {
  error: RouteRefusal
  onRetry?: () => void
  busy?: boolean
  causes?: readonly PromptCause[]
  primary?: { title: string; onClick: () => void; testId?: string }
  exits?: ReactNode
  /** For a record mismatch, which verdict picks the copy and whether "try again" is offered. */
  verdict?: MismatchVerdict
  escapePath?: string
  reportContext?: string
  testId?: string
  retryTestId?: string
}) {
  const row = refusalFor(error, verdict)
  const canRetry = !!(row.retry && onRetry)
  if (row.openInBrowser) {
    return (
      <div className="ww-invite-spinner" data-testid={testId} data-reason={error.name}>
        <h2 className="ww-passkey-refusal__title">{row.title}</h2>
        <p role="alert" className="ww-paylink-summary__caption ww-passkey-refusal__message">
          {row.message ?? error.message}
        </p>
        {error.leftover && <LeftoverPasskeyLine />}
        <OpenInBrowser
          path={escapePath}
          retry={canRetry ? { onClick: onRetry!, busy, testId: retryTestId } : undefined}
        />
        {exits}
        <button
          type="button"
          className="zkm-btn-reset ww-invite__link ww-escape__report"
          data-testid="passkey-report"
          onClick={() =>
            showReportableError(reportableCause(error), reportContext, {
              title: `Passkey refused: ${error.name}`,
            })
          }
        >
          Report this issue
        </button>
      </div>
    )
  }
  return (
    <div className="ww-invite-spinner" data-testid={testId} data-reason={error.name}>
      <h2 className="ww-passkey-refusal__title">{row.title}</h2>
      <p role="alert" className="ww-paylink-summary__caption ww-passkey-refusal__message">
        {row.message ?? error.message}
      </p>
      {error.leftover && <LeftoverPasskeyLine />}
      {causes && (
        <section className="ww-passkey-causes" data-testid="passkey-causes">
          <h3 className="ww-passkey-causes__heading">What could have gone wrong?</h3>
          <ul className="ww-passkey-causes__list">
            {causes.map((cause) => (
              <li key={cause.title}>
                <strong className="ww-passkey-causes__title">{cause.title}</strong>
                <span className="ww-passkey-causes__detail">{cause.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {primary ? (
        <PrimaryGradientButton
          title={primary.title}
          testId={primary.testId}
          isLoading={busy}
          onClick={primary.onClick}
        />
      ) : (
        canRetry && (
          <PrimaryGradientButton
            title="Try again"
            testId={retryTestId}
            isLoading={busy}
            onClick={onRetry}
          />
        )
      )}
      {primary && canRetry && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-invite-pill"
          data-testid={retryTestId}
          disabled={busy}
          onClick={onRetry}
        >
          Try again
        </button>
      )}
      {exits}
    </div>
  )
}
