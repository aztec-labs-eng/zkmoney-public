/** The sign-in's pure readings: which card a failure or a miss shows, and the code it reports. */
import { PasskeyEnvelopeError, StoredAddressMismatchError } from "@obsidion/front-core"
import {
  currentDevicePosture,
  currentMacCopyMayBeWrong,
  currentUserAgentInfoSync,
  type ExtensionAdvice,
  inAppBrowserRefusal,
  isPasskeyPolicyError,
  passkeyExtensionFor,
  type PasskeyClassification,
} from "@obsidion/passkey-web"
import { errorMessage } from "../../../errors/catalog"
import { failureCode } from "../../../lib/analytics"
import { fmt } from "../../../lib/fmt"
import type { MismatchVerdict, Observation } from "../../../platform/auth/WebAlphaAuthService"
import { mismatchVerdictOf, observedOf } from "../../../platform/auth/WebAlphaAuthService"
import {
  DIFFERENT_PASSKEY,
  INCONCLUSIVE,
  isPasskeyNotOffered,
  NO_PASSKEY_RECORDED,
  NOT_REPRODUCED_HERE,
  PASSKEY_KEY_MISMATCH,
  PASSKEY_NOT_OFFERED,
  PASSKEY_NOT_ON_DEVICE,
  REGISTRY_UNANCHORED,
  RESERVED_REGISTRATION,
  SET_UNREAD,
  STORED_ADDRESS_MISMATCH,
  type RouteRefusal,
} from "../../identity/PasskeyRefusal"
import { isCommittedFailure, PasskeyMismatchError } from "../../identity/passkeyAccount"
import {
  BY_TAG_FAILURE_CODES,
  diagnoseUnknown,
  type MissDiagnosis,
  type UnknownDiagnosis,
} from "../findPasskeyByTag"
import { PasskeySetUnreadError, type EnterResult } from "../oxideOnboarding"
import copy from "./EnterAppScreen.copy"

/**
 * `committed` marks a refusal raised after an account was committed and its signup may hold a tag,
 * whose ways on are its retry and the signup it continues; `probeCommitted` one raised after the
 * arrival probe committed a registered account and a later write failed, whose only ways on are
 * re-probing and the cancel. `resumeTag` names the reservation whose card's way on picks it back up.
 */
export type Refusal = RouteRefusal & {
  committed?: boolean
  probeCommitted?: boolean
  resumeTag?: string
}

/** Which sign-in ran: the arrival's ceremony-free probe, the open chooser, or pinned to a tag. */
export type SignInKind = "probe" | "enter" | "pinned"

type Unknown = Extract<EnterResult, { reason: "unknown" }>

/**
 * Cards whose retry would run the same attempt again: the screen is where the user tries again —
 * the row, the tag, or Show passkeys — so these offer Back and the cancel instead.
 */
// eslint-disable-next-line no-restricted-syntax -- debt
export const NO_RETRY = new Set<string>([
  "NoWalletForPasskeyError",
  PASSKEY_NOT_OFFERED,
  PASSKEY_NOT_ON_DEVICE,
  "PasskeyMismatchError",
  PASSKEY_KEY_MISMATCH,
  DIFFERENT_PASSKEY,
  NOT_REPRODUCED_HERE,
  INCONCLUSIVE,
  NO_PASSKEY_RECORDED,
  SET_UNREAD,
])

/**
 * A Windows sign-in refused for want of key material, where this computer answered, gets the
 * 1Password advice: its Windows app returns none, its browser extension does. A sign-in cannot
 * name what answered, so the line is advice beside the refusal; its wording follows whether the
 * script answering the page's passkey creation is 1Password's.
 */
function extensionAdviceFor(e: {
  name: string
  observed?: Observation
}): ExtensionAdvice | undefined {
  if (e.name !== "NoPrfError" || e.observed?.attachment !== "platform") return undefined
  if (currentUserAgentInfoSync().osFamily !== "windows") return undefined
  return passkeyExtensionFor() === "1password" ? "use" : "install"
}

/** The card for an error the wallet names itself, with `extra` beside it. */
export const refusalOf = (e: Error, extra?: Partial<Refusal>): Refusal => ({
  name: e.name,
  message: errorMessage(e),
  extensionAdvice: extensionAdviceFor(e),
  ...extra,
})

/**
 * A card for a miss that may be this Mac's own copy returning the wrong key suggests a macOS
 * update and, where `lead`, leads with the phone.
 */
export const macHelpFor = (observed: Observation | undefined, lead = false): Partial<Refusal> =>
  currentMacCopyMayBeWrong(observed) ? { macUpdate: true, ...(lead ? { macPhone: true } : {}) } : {}

/** The card for a record this browser holds that the passkey no longer reproduces. */
const mismatchCard = (verdict: MismatchVerdict | undefined, observed?: Observation): Refusal => ({
  name: STORED_ADDRESS_MISMATCH,
  message: "",
  verdict,
  ...macHelpFor(observed, verdict === "wrong-key"),
})

/** The card each tag-diagnosis verdict shows. The chain marks no root, so it never asserts divergence. */
export function missDiagnosisCard(diagnosis: MissDiagnosis, tag: string): Refusal | undefined {
  switch (diagnosis) {
    case "REGISTRY_UNANCHORED":
      return { name: REGISTRY_UNANCHORED, message: fmt(copy.diagnosis.unanchored, { tag }) }
    case "NOT_REPRODUCED_HERE":
      return { name: NOT_REPRODUCED_HERE, message: fmt(copy.diagnosis.notReproducedHere, { tag }) }
    case "DIFFERENT_PASSKEY":
      return { name: DIFFERENT_PASSKEY, message: fmt(copy.diagnosis.differentPasskey, { tag }) }
    case "INCONCLUSIVE":
      return { name: INCONCLUSIVE, message: fmt(copy.diagnosis.inconclusive, { tag }) }
    // notFound / staleRollup / noKeyInstalled / unreadable: the screen's inline notices handle these.
    default:
      return undefined
  }
}

/** The refusal row (by error name) each reading of a pinned `unknown` shows. */
const DIAGNOSIS_ROWS: Record<Exclude<UnknownDiagnosis, "LOCAL_COPY_WRONG_KEY">, string> = {
  REGISTRY_UNANCHORED,
  PASSKEY_KEY_MISMATCH,
}

/** The card a matched reservation shows before the signup picks it back up. */
export const reservedCard = (tag: string): Refusal => ({
  name: RESERVED_REGISTRATION,
  message: fmt(copy.reserved, { tag }),
  resumeTag: tag,
})

/**
 * What a sign-in result means for its passkey attempt. `unknown` found no wallet, or, pinned to a
 * tag's account, is read the way the refusal card reads it. Every other result succeeded.
 */
export const enterOutcome =
  (pinnedTo?: string) =>
  (result: EnterResult): PasskeyClassification | undefined => {
    if (result.entered || result.reason !== "unknown") return undefined
    if (pinnedTo === undefined) return { outcome: "refused", reason: "no_wallet_for_passkey" }
    return diagnoseUnknown(result, pinnedTo) === "REGISTRY_UNANCHORED"
      ? { outcome: "failed", reason: "registry_unconfirmed" }
      : { outcome: "refused", reason: "passkey_mismatch" }
  }

/**
 * `raw` as a path inside this wallet at `origin`, or undefined: parsed the way the browser will, so
 * `//host`, `/\host` and control characters the parser strips cannot name another origin.
 */
export function walletPath(raw: string | undefined, origin: string): string | undefined {
  if (!raw?.startsWith("/")) return undefined
  try {
    const url = new URL(raw, origin)
    // A normalized path can still start `//` (via `..` or `%2e`), which a later navigation would
    // read as protocol-relative.
    if (url.origin !== origin || url.pathname.startsWith("//")) return undefined
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return undefined
  }
}

/**
 * The card a pinned `unknown` shows, and its code. Pinning the same credential again would end the
 * same way, so the failure is named; a record this browser holds that no longer reproduces keeps
 * its verdict. A sole key is proven only by a read that found one.
 */
export function pinnedMiss(
  result: Unknown,
  { tag, l2Address, moreKeys }: { tag: string; l2Address: string; moreKeys?: boolean },
): { code: string; refusal: Refusal } {
  if (result.storedAddressMismatch && result.verdict)
    return {
      code: BY_TAG_FAILURE_CODES.PASSKEY_KEY_MISMATCH,
      refusal: mismatchCard(result.verdict, result.observed),
    }
  const diagnosis = diagnoseUnknown(result, l2Address, {
    laptop: currentDevicePosture() === "laptop",
    moreKeys: moreKeys !== false,
  })
  const code = BY_TAG_FAILURE_CODES[diagnosis]
  // This computer's copy of the account's one key answered with the wrong value: the same card as a
  // record mismatch, whose way on is another device.
  if (diagnosis === "LOCAL_COPY_WRONG_KEY")
    return { code, refusal: mismatchCard("wrong-key", result.observed) }
  const unanchored = diagnosis === "REGISTRY_UNANCHORED"
  return {
    code,
    refusal: {
      name: DIAGNOSIS_ROWS[diagnosis],
      message: fmt(unanchored ? copy.unanchored : copy.keyMismatch, { tag }),
      ...(unanchored ? {} : macHelpFor(result.observed)),
    },
  }
}

/**
 * How a sign-in that threw ends. A card with `code` reports a failed entry; `reported` sets its
 * card and goes to the error report; no card shows the screen again (a probe's read that failed
 * before anything was asked or written). A probe never prompts, so it has no closed prompt or
 * in-app refusal of its own.
 */
export function classifyEntryFailure(
  e: unknown,
  kind: SignInKind,
  tag: string,
): { refusal?: Refusal; code?: string; reported?: boolean } {
  const pinned = kind === "pinned"
  const unusable = kind === "probe" ? undefined : inAppBrowserRefusal(e)
  if (isPasskeyNotOffered(e))
    return {
      code: pinned ? BY_TAG_FAILURE_CODES.promptClosed : "passkey_prompt_closed",
      refusal: unusable
        ? { ...unusable, cause: e }
        : pinned
        ? { name: PASSKEY_NOT_ON_DEVICE, message: fmt(copy.notOnDevice, { tag }) }
        : { name: PASSKEY_NOT_OFFERED, message: copy.notOffered },
    }
  // A record this browser holds no longer reproduces from this passkey: its verdict picks the copy.
  if (e instanceof StoredAddressMismatchError)
    return { code: failureCode(e), refusal: mismatchCard(mismatchVerdictOf(e), observedOf(e)) }
  if (e instanceof PasskeyMismatchError)
    return {
      code: BY_TAG_FAILURE_CODES.wrongCredential,
      refusal: { name: e.name, message: errorMessage(e) },
    }
  // A backup record's envelope did not open, or the account holds more keys than the sign-in
  // could read: the wallet's own cards, as the policy's are.
  if (
    isPasskeyPolicyError(e) ||
    (kind !== "probe" && (e instanceof PasskeyEnvelopeError || e instanceof PasskeySetUnreadError))
  )
    return { code: failureCode(e), refusal: refusalOf(e) }
  // Committed, then a write failed: Retry re-probes the committed key, with no prompt.
  if (isCommittedFailure(e))
    return {
      reported: true,
      refusal: { name: "error", message: copy.network, probeCommitted: true },
    }
  if (kind === "probe") return { code: failureCode(e) }
  if (unusable) return { code: failureCode(e), refusal: { ...unusable, cause: e } }
  // Reported, but the user stays: /claim would mint a second account for someone who has one.
  return { reported: true, refusal: { name: "error", message: copy.network } }
}
