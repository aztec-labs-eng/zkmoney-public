import { isClaimAttemptsExhausted, isClaimConflict } from "@obsidion/front-core"
import { NameTakenError } from "./oxideOnboarding"

/** Shown in place of the deposit address where this network prices no registration a sweep can take. */
export const REGISTRATIONS_PAUSED_NOTICE =
  "Registrations on this network are paused. Your name is held for you. Check again in a few minutes."

/** Each refusal leads somewhere different, so each says what it is rather than "couldn't claim". */
const nameTakenMessage = (err: NameTakenError): string => {
  const tag = `@${err.handle}`
  if (err.reason === "registered")
    return `${tag} already belongs to an account. Pick a different tag, or sign in with the passkey that holds it.`
  if (err.reason === "reserved")
    return `${tag} is held by another account's signup. Check the spelling, or pick a different tag.`
  return `${tag} can't be used. Pick a different tag.`
}

const errorSummary = (err: unknown): string => {
  if (!(err instanceof Error)) return ""
  const short = (err as { shortMessage?: unknown }).shortMessage
  const line = (typeof short === "string" ? short : err.message).split("\n")[0].trim()
  return line.replace(/\.$/, "")
}

const withCause = (lead: string, err: unknown): string => {
  const cause = errorSummary(err)
  return `${lead}${cause ? `. ${cause}` : ""}. Try again.`
}

export const passkeyErrorMessage = (err: unknown): string => {
  if (err instanceof Error && err.name === "NotAllowedError") {
    return "The passkey prompt was closed before it finished. Nothing was created. Try again when you're ready."
  }
  return withCause("Couldn't create your passkey", err)
}

export const enterErrorMessage = (err: unknown): string => {
  if (err instanceof Error && err.name === "NotAllowedError") {
    return "The passkey prompt was closed before it finished. Try again when you're ready."
  }
  return withCause("Couldn't enter with your passkey", err)
}

const clearsAt = (untilSeconds: number | undefined, nowMs: number): string => {
  const untilMs = untilSeconds === undefined ? NaN : untilSeconds * 1000
  if (!(untilMs > nowMs)) return "within an hour"
  return `at ${new Date(untilMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
}

/** `tag` is the name the claim was for, `until` the reservation deadline in seconds. */
export const claimErrorMessage = (
  err: unknown,
  hints: { tag?: string; until?: number; nowMs?: number } = {},
): string => {
  const { tag, until, nowMs = Date.now() } = hints
  // The name gate refused, and which refusal it was decides where the user goes: retrying the same
  // tag reaches the same answer, so the copy sends them to the field rather than to a retry.
  if (err instanceof NameTakenError) return nameTakenMessage(err)
  // The attempts budget is per (device, name) and outlives the reservation, so retrying is futile.
  if (isClaimAttemptsExhausted(err)) {
    const on = tag ? ` on @${tag}` : ""
    return `This device has used up its claim attempts${on}. Pick a different tag to carry on.`
  }
  if (isClaimConflict(err)) {
    return `Couldn't claim your tag. An earlier reservation for it is still active under a different account. It clears ${clearsAt(
      until,
      nowMs,
    )}. Try again after that.`
  }
  // The link's note is not where the witness needs it yet (sync, prune, reorg): nothing was
  // spent, and the same claim can run again.
  if ((err as { retryable?: unknown })?.retryable === true) {
    return withCause("Your payment isn't visible on the network yet. Try again in a moment", err)
  }
  const cause = errorSummary(err)
  if (
    /cannot cover the account deposit|did not waive the tag price|not issuing paylink tickets|below the amount that waives/.test(
      cause,
    )
  ) {
    return withCause("Couldn't finish signup with this payment", err)
  }
  return withCause("Couldn't claim your tag", err)
}
