import type { PrfSlot } from "@obsidion/core/types"
import type {
  PasskeyAssertResult,
  PasskeyAttachment,
  PasskeyCeremony,
  PasskeyCreateResult,
  PasskeyHint,
} from "../ceremony/passkeyCeremony.js"
import { prfSalts } from "./derivation.js"
import type { DevicePosture } from "./devicePosture.js"
import { type Evidence, evidenceOf, isComplete, prfOutputFor } from "./evidence.js"
import { mislabelledAssertion, mislabelledCreation } from "./passkeyCapabilities.js"
import {
  IncompleteCreationError,
  NoPrfError,
  SecurityKeyNoPrfError,
  UnsupportedProviderError,
  markPasskeyWritten,
} from "./passkeyErrors.js"
import { providerAllowed, providerNameFor, refusalKindFor } from "./passkeyProviders.js"
import {
  checkAssertionRoute,
  checkCreationRoute,
  creationHintsFor,
  isSecurityKey,
  offerableTransports,
  requestedAttachment,
  signInHintsFor,
  slotForAttachment,
} from "./slotRule.js"

/**
 * The two ceremony sequences both web fronts run, written once. Every raw result reaches the
 * consumer's `observe` before any check, so a refused ceremony is still recorded; the checks then
 * run in one order: authenticator class, Safari's label correction, route, provider, slot, the
 * chained assertion when the evidence is incomplete, and the gates. The class is read first
 * because the route rule takes it.
 */

export type ObservedCeremony =
  | { phase: "created"; result: PasskeyCreateResult }
  | { phase: "chained" | "asserted"; result: PasskeyAssertResult }

/**
 * Awaited with every raw result before any check on it. A consumer's own lookups and records go
 * here; slow work must not be awaited, since it holds the ceremony.
 */
export type CeremonyObserver = (event: ObservedCeremony) => void | Promise<void>

export type PasskeyCreationOptions = {
  posture: DevicePosture
  rpId: string
  rpName: string
  userName: string
  /** The route a laptop creation opens on; absent opens on the phone, `null` sends no hints. */
  laptopHints?: readonly PasskeyHint[] | null
  /** Provider ids admitted beyond the measured set; a test seam, and empty in production. */
  extraProviders?: readonly string[]
  /** The challenge the chained assertion signs; asked for only when creation left a gap. */
  challengeForChained: () => Promise<Uint8Array> | Uint8Array
  /** Inside the window `safariMislabelsCrossDevice` names, from `currentMisreportsCrossDevice`. */
  misreportsCrossDevice?: boolean
  /** From `currentTrustsAttachmentLabel`; only then may a refusal name the provider that answered. */
  attachmentLabelTrusted?: boolean
  observe?: CeremonyObserver
}

export type PasskeyCreation = {
  created: PasskeyCreateResult
  /** The assertion that stood in for an incomplete creation, when one was needed. */
  chained?: PasskeyAssertResult
  slot: PrfSlot
  prfOutput: Uint8Array
  /** A hardware key answered, so this wallet's only copy of the key lives on it. */
  securityKey: boolean
}

/**
 * The provider a refused creation may name as having answered on this device. None where the
 * browser's label can't be trusted, and never a security key, whose local label is a contradiction.
 */
function answeringProvider(
  created: PasskeyCreateResult,
  securityKey: boolean,
  options: PasskeyCreationOptions,
): string | undefined {
  if (!options.attachmentLabelTrusted || options.misreportsCrossDevice) return undefined
  if (refusalKindFor(created.aaguid, securityKey) !== "manager") return undefined
  return providerNameFor(created.aaguid)
}

/** The same response, read as another device's. */
const asCrossDevice = <T extends { authenticatorAttachment?: PasskeyAttachment }>(
  result: T,
): T => ({
  ...result,
  authenticatorAttachment: "cross-platform",
})

/** Create a passkey under the route rule and return the PRF output the account binds to. */
export async function runPasskeyCreation(
  ceremony: PasskeyCeremony,
  options: PasskeyCreationOptions,
): Promise<PasskeyCreation> {
  const { posture, rpId } = options
  const hints = creationHintsFor(posture, options.laptopHints)
  const requested = requestedAttachment(posture)
  const salts = await prfSalts()
  const reported = await ceremony.create({
    rpId,
    rpName: options.rpName,
    userName: options.userName,
    authenticatorAttachment: requested,
    hints,
    ...salts,
  })
  // The credential exists from here on: every refusal below leaves it behind.
  try {
    await options.observe?.({ phase: "created", result: reported })
    // Only the creation response carries the transports and the provider id; the chained assertion
    // below carries neither, so both are read here and the class is reused for its evidence.
    const securityKey = isSecurityKey(reported)
    const corrected = mislabelledCreation({
      reported,
      requested,
      misreportsCrossDevice: options.misreportsCrossDevice,
    })
    const created = corrected ? asCrossDevice(reported) : reported
    checkCreationRoute(
      posture,
      created.authenticatorAttachment,
      securityKey,
      answeringProvider(created, securityKey, options),
    )
    if (!providerAllowed(created.aaguid, securityKey, options.extraProviders)) {
      throw new UnsupportedProviderError(refusalKindFor(created.aaguid, securityKey), {
        providerName: providerNameFor(created.aaguid),
        keyOfferable: true,
      })
    }
    // Past the route check the attachment is set: reported and admitted, or corrected.
    const slot = slotForAttachment(created.authenticatorAttachment!)

    let evidence = evidenceOf(created)
    let chained: PasskeyAssertResult | undefined
    if (!isComplete(evidence, slot)) {
      // The follow-up names the credential but not the device, and a corrected answer's passkey may
      // already have synced to this one, so nothing can keep the follow-up on the phone.
      if (corrected) {
        forgetCredential(rpId, created.credentialId)
        throw new IncompleteCreationError()
      }
      // Some providers only return PRF on an assertion, some evaluate one salt at creation, and
      // some responses carry no readable flags. The assertion has to stand on its own: nothing
      // from the create result is kept.
      const challenge = await options.challengeForChained()
      // A security key that just answered is asked again as itself: its transports send the browser
      // straight back to it, and naming it keeps the sheet off the phone route. A laptop otherwise
      // asks over the routes it created on; a phone names none.
      const again = securityKey
        ? {
            hints: ["security-key"] as const,
            ...(created.transports?.length ? { transports: created.transports } : {}),
          }
        : { hints: posture === "laptop" ? hints : undefined }
      chained = await ceremony.assert({
        rpId,
        challenge,
        credentialIds: [created.credentialId],
        ...again,
        ...salts,
      })
      await options.observe?.({ phase: "chained", result: chained })
      checkCreationRoute(posture, chained.authenticatorAttachment, securityKey)
      evidence = evidenceOf(chained)
    }

    return {
      created,
      chained,
      slot,
      securityKey,
      prfOutput: readPrfOrRefuseKey(evidence, slot, securityKey, rpId, created.credentialId),
    }
  } catch (err) {
    throw markPasskeyWritten(err)
  }
}

/**
 * The key material, or a refusal a key holder can act on. Only a total absence is translated: an
 * unreadable backup flag and a value in the wrong slot keep their own refusals, and a platform
 * passkey keeps `NoPrfError`.
 *
 * A key that answered with nothing has still written a credential, so this also asks the
 * authenticator to take it back, as the corrected-but-incomplete branch above does. Deletion cannot
 * be undone and the browser asks the user nothing, so the id comes from the creation in hand and
 * from nowhere else.
 */
function readPrfOrRefuseKey(
  evidence: Evidence,
  slot: PrfSlot,
  securityKey: boolean,
  rpId: string,
  credentialId: string,
): Uint8Array {
  try {
    return prfOutputFor(evidence, slot, securityKey)
  } catch (err) {
    if (!securityKey || !(err instanceof NoPrfError)) throw err
    forgetCredential(rpId, credentialId)
    throw new SecurityKeyNoPrfError()
  }
}

/**
 * Tell the authenticator this credential is not one of ours, which it is expected to answer by
 * deleting it. Best effort in both directions: browsers without the call do nothing, and whether a
 * key acts on it is unverified.
 */
function forgetCredential(rpId: string, credentialId: string): void {
  // The lookup is inside the guard too: an accessor-shaped API could throw on the read itself,
  // and nothing here may replace the refusal the caller is about to see.
  try {
    const api = (
      globalThis as {
        PublicKeyCredential?: {
          signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>
        }
      }
    ).PublicKeyCredential
    if (typeof api?.signalUnknownCredential !== "function") return
    void Promise.resolve(api.signalUnknownCredential({ rpId, credentialId })).catch(() => {})
  } catch {
    // Nothing to do: the refusal stands on its own.
  }
}

export type PasskeyAssertionOptions = {
  posture: DevicePosture
  rpId: string
  challenge: Uint8Array
  /** Constrain the sheet to these credentials; absent leaves the browser's list open. */
  credentialIds?: string[]
  /** What the record says those credentials can be reached over; the posture decides what is sent. */
  transports?: readonly string[]
  laptopHints?: readonly PasskeyHint[] | null
  /**
   * The browser is inside the window `safariMislabelsCrossDevice` names. A laptop's answer is
   * then read as `cross-platform`, this device's own copy among them, since an assertion cannot
   * say which answered; the consumer's anchors decide what it opens.
   */
  misreportsCrossDevice?: boolean
  /** Admit the laptop's own passkey: open the sheet on this device, send no transport restriction,
   *  and let a `platform` answer through the route check. Default false keeps today's rule. */
  localAllowed?: boolean
  /** The credentials are a hardware key's, as far as the consumer knows: a security key is named
   *  beside the local route, so the sheet keeps that row and a manager's extension stands aside. */
  securityKey?: boolean
  observe?: CeremonyObserver
  /** Ends the assertion wherever it is; see `PasskeyAssertRequest.signal`. */
  signal?: AbortSignal
}

/**
 * One PRF-reading assertion checked against the route. Only the observer is promised the raw
 * result; the return carries the corrected label when the browser mislabels. The caller runs its
 * own checks on it, then `candidatesFrom` for the gates.
 */
export async function runPasskeyAssertion(
  ceremony: PasskeyCeremony,
  options: PasskeyAssertionOptions,
): Promise<PasskeyAssertResult> {
  const reported = await ceremony.assert({
    rpId: options.rpId,
    challenge: options.challenge,
    credentialIds: options.credentialIds,
    transports: offerableTransports(options.posture, options.transports, options.localAllowed),
    hints: signInHintsFor(
      options.posture,
      options.laptopHints,
      options.localAllowed,
      options.securityKey,
    ),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(await prfSalts()),
  })
  await options.observe?.({ phase: "asserted", result: reported })
  const corrected = mislabelledAssertion({
    reportedAttachment: reported.authenticatorAttachment,
    posture: options.posture,
    misreportsCrossDevice: options.misreportsCrossDevice,
  })
  const assertion = corrected ? asCrossDevice(reported) : reported
  checkAssertionRoute(options.posture, assertion.authenticatorAttachment, options.localAllowed)
  return assertion
}
