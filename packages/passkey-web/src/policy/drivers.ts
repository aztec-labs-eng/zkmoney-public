import type { PrfSlot } from "@obsidion/core/types"
import type {
  PasskeyAssertResult,
  PasskeyAttachment,
  PasskeyCeremony,
  PasskeyCreateResult,
  PasskeyHint,
} from "../ceremony/passkeyCeremony.js"
import { bytesToBase64Url } from "../ceremony/bytes.js"
import { prfSalts } from "./derivation.js"
import type { DevicePosture } from "./devicePosture.js"
import type { UserAgentInfo } from "./userAgentInfo.js"
import { type Evidence, evidenceOf, isComplete, prfOutputFor } from "./evidence.js"
import type { LocalManager } from "./laptopCreation.js"
import { mislabelledAssertion, mislabelledCreation } from "./passkeyCapabilities.js"
import {
  IncompleteCreationError,
  LaptopPasskeyRefusedError,
  NoPrfError,
  SecurityKeyNoPrfError,
  UnsupportedProviderError,
  markPasskeyWritten,
} from "./passkeyErrors.js"
import {
  localManagerFor,
  localProviderVerdict,
  providerAllowed,
  providerNameFor,
  refusalKindFor,
} from "./passkeyProviders.js"
import { creationProvenanceFor } from "./provenance.js"
import {
  checkAssertionRoute,
  checkCreationRoute,
  creationHintsFor,
  creationTimeoutMs,
  isSecurityKey,
  offerableTransports,
  requestedAttachment,
  signInHintsFor,
  slotForAttachment,
} from "./slotRule.js"

/**
 * The two ceremony sequences both web fronts run, written once. Every raw result reaches the
 * consumer's `observe` before any check, so a refused ceremony is still recorded; the checks then
 * run in one order: authenticator class, Safari's label correction, route, provider, the local
 * route's own provider rule, slot, the chained assertion when the evidence is incomplete (held to
 * the credential just made and to the same route), and the gates. The class is read first because
 * the route rule takes it.
 */

export type ObservedCeremony =
  | { phase: "created"; result: PasskeyCreateResult }
  | { phase: "chained" | "asserted"; result: PasskeyAssertResult }

/**
 * Awaited with every raw result before any check on it. A consumer's own lookups and records go
 * here; slow work must not be awaited, since it holds the ceremony. A created result's id must not
 * be kept as account state from here: a creation that then fails asks the authenticator to remove
 * that credential.
 */
export type CeremonyObserver = (event: ObservedCeremony) => void | Promise<void>

export type PasskeyCreationOptions = {
  posture: DevicePosture
  rpId: string
  rpName: string
  userName: string
  /** The route a laptop creation opens on; absent opens on the phone, `null` sends no hints. */
  laptopHints?: readonly PasskeyHint[] | null
  /**
   * The browser's claims about its OS and chip, written into the passkey's handle beside the route
   * this request asks for; absent writes an unknown OS.
   */
  userAgent?: UserAgentInfo
  /**
   * Create on the laptop's own password manager: ask for this device and admit only a `platform`
   * answer from one of `managers`. Absent, a laptop is sent to a phone or a key as always. The
   * value comes from `laptopCreationFor`, probed once for the attempt the sheet showed.
   */
  localCreation?: { managers: readonly LocalManager[]; appleWithdrawn?: boolean }
  /** Provider ids admitted beyond the measured set; a test seam, and empty in production. */
  extraProviders?: readonly string[]
  /** The challenge the chained assertion signs; asked for only when creation left a gap. */
  challengeForChained: () => Promise<Uint8Array> | Uint8Array
  /** Inside the window `safariMislabelsCrossDevice` names, from `currentMisreportsCrossDevice`. */
  misreportsCrossDevice?: boolean
  /** From `currentTrustsAttachmentLabel`; only then may a refusal name the provider that answered. */
  attachmentLabelTrusted?: boolean
  observe?: CeremonyObserver
  /**
   * Ends the creation wherever it is, its follow-up prompt included; see
   * `PasskeyCreateRequest.signal`. A caller whose screen can abandon an attempt passes one: a laptop
   * waits five minutes, and a late answer would otherwise finish an attempt the user had left.
   */
  signal?: AbortSignal
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
  const localManagers = options.localCreation?.managers
  const local = localManagers !== undefined
  const hints = creationHintsFor(posture, options.laptopHints, local)
  const requested = requestedAttachment(posture, local)
  const timeoutMs = creationTimeoutMs(posture, local)
  const ending = options.signal ? { signal: options.signal } : {}
  const salts = await prfSalts()
  const reported = await ceremony.create({
    rpId,
    rpName: options.rpName,
    userName: options.userName,
    authenticatorAttachment: requested,
    hints,
    provenance: creationProvenanceFor({
      posture,
      userAgent: options.userAgent,
      requested,
      laptopHints: options.laptopHints,
    }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...ending,
    ...salts,
  })
  // The credential exists from here on: every failure below leaves it behind.
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
      localManagers,
    )
    if (!providerAllowed(created.aaguid, securityKey, options.extraProviders)) {
      throw new UnsupportedProviderError(refusalKindFor(created.aaguid, securityKey), {
        providerName: providerNameFor(created.aaguid),
        keyOfferable: true,
        localManagers,
      })
    }
    // A laptop's own passkey must come from a manager the row admits, by a name it reported: the
    // provider gate lets a missing id through, and nothing else defends this binding.
    if (localManagers && !securityKey) {
      const verdict = localProviderVerdict(created.aaguid, localManagers, options.extraProviders)
      if (verdict === "apple" || verdict === "unnamed") {
        throw new LaptopPasskeyRefusedError(verdict, localManagers, {
          appleWithdrawn: options.localCreation?.appleWithdrawn,
        })
      }
      if (verdict === "unsupported") {
        throw new UnsupportedProviderError("manager", {
          providerName: providerNameFor(created.aaguid),
          keyOfferable: true,
          localManagers,
        })
      }
    }
    // Past the route check the attachment is set: reported and admitted, or corrected.
    const slot = slotForAttachment(created.authenticatorAttachment!)

    let evidence = evidenceOf(created)
    let chained: PasskeyAssertResult | undefined
    if (!isComplete(evidence, slot)) {
      // The follow-up names the credential but not the device, and a corrected answer's passkey may
      // already have synced to this one, so nothing can keep the follow-up on the phone.
      if (corrected) throw new IncompleteCreationError()
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
        ...ending,
        ...salts,
      })
      await options.observe?.({ phase: "chained", result: chained })
      // The request named one credential, but the browser returns whichever answered: a different
      // passkey's key material must never be bound to the public key of the one just made.
      if (chained.credentialId !== created.credentialId) {
        throw new IncompleteCreationError("other-credential")
      }
      checkCreationRoute(
        posture,
        chained.authenticatorAttachment,
        securityKey,
        undefined,
        localManagers,
      )
      evidence = evidenceOf(chained)
    }

    // A browser can answer a request it was told to end; an ended creation still returns no keys.
    options.signal?.throwIfAborted()
    return {
      created,
      chained,
      slot,
      securityKey,
      prfOutput: readPrfOrRefuseKey(evidence, slot, securityKey, localManagers, created.aaguid),
    }
  } catch (err) {
    forgetCredential(rpId, reported.credentialId)
    throw markPasskeyWritten(err)
  }
}

/**
 * The key material, or a refusal the user can act on. Only a total absence is translated: an
 * unreadable backup flag and a value in the wrong slot keep their own refusals. A key gets its own
 * refusal; a platform passkey keeps `NoPrfError`, naming the laptop manager the creation reported.
 */
function readPrfOrRefuseKey(
  evidence: Evidence,
  slot: PrfSlot,
  securityKey: boolean,
  localManagers: readonly LocalManager[] | undefined,
  createdAaguid: string | undefined,
): Uint8Array {
  try {
    return prfOutputFor(evidence, slot, securityKey, localManagers)
  } catch (err) {
    if (!(err instanceof NoPrfError)) throw err
    if (securityKey) throw new SecurityKeyNoPrfError()
    throw new NoPrfError({ localManagers, manager: localManagerFor(createdAaguid) })
  }
}

/**
 * Tell the authenticator this credential is not one of ours, which it is expected to answer by
 * deleting it. A failed creation returns nothing, so no account can name the credential it wrote.
 * Deletion cannot be undone and the browser asks the user nothing, so the one caller passes the id
 * of the creation in hand and nothing else may. Best effort in both directions: browsers without
 * the call do nothing, and whether a key acts on it is unverified.
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

/**
 * Ask the authenticator to show `name` on the passkey created under `userHandle`. WebAuthn cannot
 * change the handle itself, so the name it carries stays the creation's. Best effort: browsers
 * without the call keep the old label.
 */
export function renamePasskey(rpId: string, userHandle: Uint8Array, name: string): void {
  try {
    const api = (
      globalThis as {
        PublicKeyCredential?: {
          signalCurrentUserDetails?: (o: {
            rpId: string
            userId: string
            name: string
            displayName: string
          }) => Promise<void>
        }
      }
    ).PublicKeyCredential
    if (typeof api?.signalCurrentUserDetails !== "function") {
      console.warn("[passkey] rename skipped: this browser has no signalCurrentUserDetails")
      return
    }
    const userId = bytesToBase64Url(userHandle)
    void Promise.resolve(api.signalCurrentUserDetails({ rpId, userId, name, displayName: name }))
      .then(() => console.info("[passkey] rename signalled", { rpId, name }))
      .catch((err: unknown) => console.warn("[passkey] rename refused", err))
  } catch (err) {
    // The label is cosmetic; nothing here may fail the caller.
    console.warn("[passkey] rename failed", err)
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
