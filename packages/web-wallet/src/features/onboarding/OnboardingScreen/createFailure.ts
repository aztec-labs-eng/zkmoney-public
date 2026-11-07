import type { SignInRoute } from "@obsidion/core/types"
import {
  LaptopPasskeyRefusedError,
  NoPrfError,
  inAppBrowserRefusal,
  isBlockedPromptError,
  isPasskeyCancelled,
  isPasskeyPolicyError,
  passkeyExtensionFor,
  passkeyWritten,
  type ExtensionAdvice,
  type LaptopCreation,
  type PhoneReach,
  type SheetReopen,
  type SignUpChoice,
} from "@obsidion/passkey-web"
import type { RouteRefusal } from "../../identity/PasskeyRefusal"
import { errorMessage } from "../../../errors/catalog"
import { passkeyErrorMessage } from "../onboardingErrorCopy"

/** A creation as the gate opened it, and the ticket attempt it began. */
export type CreateAttempt = {
  choice?: SignUpChoice
  /** The route the gate derived from `choice`. */
  route?: SignInRoute
  reach: PhoneReach
  /** The gate's decision for this laptop, so a refusal's advice follows what the sheet offered. */
  creation?: LaptopCreation
  ticketAttemptId?: string
}

/** A creation's refusal, with what it attempted so the card's actions can go back to the sheet. */
export type CreateRefusal = RouteRefusal & { choice?: SignUpChoice; ticketAttemptId?: string }

/** A sign-up saved on this computer, in a browser whose sheet said Chrome could keep it here. */
const chromeAdviceFor = (err: { name: string }, attempted: CreateAttempt | undefined): boolean =>
  err.name === "PhoneRequiredError" && attempted?.creation?.chromeTip === "gpm"

/**
 * A Windows sign-up on this computer that 1Password answered without key material gets the
 * 1Password advice: its Windows app returns none, its browser extension does. The wording follows
 * whether the script answering the page's creation is 1Password's.
 */
function extensionAdviceFor(
  err: unknown,
  attempted: CreateAttempt | undefined,
): ExtensionAdvice | undefined {
  if (attempted?.route !== "this-device" || !attempted.creation?.local) return undefined
  const { os, managers } = attempted.creation
  if (os !== "windows" || !managers.includes("1password")) return undefined
  if (!(err instanceof NoPrfError) || err.manager !== "1password") return undefined
  return passkeyExtensionFor() === "1password" ? "use" : "install"
}

/** The pop-up a refusal points at answers only the 1Password option, so its retry opens there. */
export const retryChoiceFor = (refusal: CreateRefusal): SignUpChoice | undefined =>
  refusal.extensionAdvice === "use" && refusal.choice === "computer" ? "1password" : refusal.choice

/** How a failed passkey step ends: its card, the sheet again, an error line, or nothing at all. */
export type CreateFailure =
  | { kind: "refusal"; refusal: CreateRefusal; toCreate: boolean }
  | { kind: "reopen"; openOn: SignUpChoice; reopened: SheetReopen; restart?: string }
  | { kind: "error"; error: unknown }
  | { kind: "silent" }

/**
 * Classifies the passkey step's failure. `attempted` is the creation's, if this was one; `portable`
 * says it could start again in another browser. `fastRefusals` counts the refusals in a row before
 * any prompt opened: the second says to try another browser.
 */
export function classifyCreateFailure(
  err: unknown,
  {
    attempted,
    portable,
    fastRefusals,
  }: {
    attempted?: CreateAttempt
    portable: boolean
    fastRefusals: number
  },
): { failure: CreateFailure; fastRefusals: number } {
  const unusable = portable ? inAppBrowserRefusal(err) : undefined
  const leftover = passkeyWritten(err)
  const cancelled = !unusable && isPasskeyCancelled(err) && !leftover
  const blocked = cancelled && isBlockedPromptError(err)
  const refusals = blocked ? fastRefusals + 1 : 0
  const ended = (failure: CreateFailure) => ({ failure, fastRefusals: refusals })
  if (unusable)
    return ended({
      kind: "refusal",
      refusal: { ...unusable, cause: err, leftover },
      toCreate: true,
    })
  if (cancelled) {
    // Nothing was made: no error, just back to where it opened. A laptop's sheet re-opens on the
    // option it ran, saying why; a phone is left on its button. A ticket attempt begun for the
    // prompt is restarted by the next pick, before its replacement begins.
    if (!attempted?.choice) return ended({ kind: "silent" })
    return ended({
      kind: "reopen",
      openOn: attempted.choice,
      reopened: blocked ? (refusals > 1 ? "blocked-again" : "blocked") : "unfinished",
      restart: attempted.ticketAttemptId,
    })
  }
  if (isPasskeyPolicyError(err)) {
    const appleRefusedHere = err instanceof LaptopPasskeyRefusedError && err.appleRefusedHere
    const refusal: CreateRefusal = {
      name: err.name,
      message: errorMessage(err),
      leftover,
      ...(appleRefusedHere ? { appleRefusedHere } : {}),
      ...(chromeAdviceFor(err, attempted) ? { chromeAdvice: true } : {}),
      extensionAdvice: extensionAdviceFor(err, attempted),
      ...attempted,
    }
    return ended({ kind: "refusal", refusal, toCreate: false })
  }
  if (leftover) {
    // A passkey was saved before this failed, so the card that links the cleanup shows it.
    const { name } = err as { name?: unknown }
    const refusal: CreateRefusal = {
      name: typeof name === "string" ? name : "Error",
      message: passkeyErrorMessage(err),
      cause: err,
      leftover,
      ...attempted,
    }
    return ended({ kind: "refusal", refusal, toCreate: false })
  }
  return ended({ kind: "error", error: err })
}
