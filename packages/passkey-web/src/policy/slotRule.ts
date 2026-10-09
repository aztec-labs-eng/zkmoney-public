import type { PrfSlot } from "@obsidion/core/types"
import type { PasskeyAttachment, PasskeyHint } from "../ceremony/passkeyCeremony.js"
import type { DevicePosture } from "./devicePosture.js"
import {
  LocalPasskeyRequiredError,
  PhoneRequiredError,
  SecurityKeyRequiredError,
} from "./passkeyErrors.js"

export type { PrfSlot }

/** Local reads land the account's value in `second`, cross-device reads in `first` (the route table). */
export const slotForAttachment = (attachment: PasskeyAttachment): PrfSlot =>
  attachment === "platform" ? "second" : "first"

/** How a roaming hardware key is reached. A phone over QR reports `hybrid` instead. */
const PHYSICAL_TRANSPORTS: readonly string[] = ["usb", "nfc", "ble", "smart-card"]

/** A non-empty list naming only physical transports: the shape a hardware key's creation reports. */
export const isPhysicalOnly = (transports: readonly string[] | undefined): boolean =>
  Boolean(transports?.length) && transports!.every((t) => PHYSICAL_TRANSPORTS.includes(t))

/**
 * A security key: another device's authenticator that the browser says is reached only over a
 * physical transport. Everything else is treated as a phone — a list naming a transport this code
 * does not know, an empty list, no list at all, or a local answer — so a key the browser described
 * poorly meets the backup gate and is refused rather than quietly exempted.
 */
export function isSecurityKey(response: {
  authenticatorAttachment?: PasskeyAttachment
  // Required key, possibly-undefined value: only a creation response carries transports, and an
  // assertion passed here would silently answer "not a key" on a route that holds one.
  transports: readonly string[] | undefined
}): boolean {
  return (
    response.authenticatorAttachment === "cross-platform" && isPhysicalOnly(response.transports)
  )
}

/**
 * What a consumer key is asked over when nothing was recorded for it. Never `ble`: Chrome reads
 * it as the phone route and opens its picker again.
 */
const IMPLIED_KEY_TRANSPORTS: readonly string[] = ["usb", "nfc", "smart-card"]

/**
 * The transports an assertion implies for its authenticator, when it implies any. An assertion
 * names none, but creation admits only a synced passkey or a security key, so another device's
 * answer that cannot be backed up is a key.
 */
export function impliedKeyTransports(evidence: {
  authenticatorAttachment?: PasskeyAttachment
  backupEligible?: boolean
}): readonly string[] | undefined {
  const key =
    evidence.authenticatorAttachment === "cross-platform" && evidence.backupEligible === false
  return key ? IMPLIED_KEY_TRANSPORTS : undefined
}

/**
 * The class a creation must be answered by. A laptop is always sent to another device. A phone
 * keeps its own passkey, unless a security key answered — hardware held against the phone is not
 * the delegation to another phone the rule exists to prevent.
 */
const expectedAtCreation = (posture: DevicePosture, securityKey: boolean): PasskeyAttachment =>
  posture === "laptop" || securityKey ? "cross-platform" : "platform"

/**
 * The route rule for a creation, applied to the create response and again to the chained assertion
 * that follows it. Both are held to the same class, so a ceremony cannot start as one thing and
 * finish as another; the assertion carries no transports of its own, so `securityKey` is the class
 * the creation established.
 *
 * An unreported attachment refuses on either posture. Nothing downstream may pick a slot from a
 * route the browser declined to name.
 *
 * `providerName` is what answered, for a laptop refusal to name; it is dropped unless the browser
 * reported this device, since an unreported answer says nothing about where the passkey went.
 */
export function checkCreationRoute(
  posture: DevicePosture,
  attachment: PasskeyAttachment | undefined,
  securityKey: boolean,
  providerName?: string,
): void {
  if (attachment === expectedAtCreation(posture, securityKey)) return
  // Each refusal names the device this ceremony was already using: the key it started on, this
  // phone's own passkey, or the phone a laptop is waiting for.
  if (securityKey) throw new SecurityKeyRequiredError()
  if (posture === "phone") throw new LocalPasskeyRequiredError()
  throw new PhoneRequiredError({
    ceremony: "create",
    providerName: attachment === "platform" ? providerName : undefined,
  })
}

/** The route rule for a sign-in: a laptop still needs another device, a phone takes any answer. */
export function checkAssertionRoute(
  posture: DevicePosture,
  attachment: PasskeyAttachment | undefined,
  localAllowed = false,
): void {
  if (posture !== "laptop") return
  if (attachment === "cross-platform") return
  // The device's own passkey is admitted only when the caller opted in; an unreported attachment
  // is refused either way, so nothing downstream picks a slot from a route the browser did not name.
  if (localAllowed && attachment === "platform") return
  throw new PhoneRequiredError()
}

/**
 * The class a creation asks the browser for. A laptop asks for another device outright. A phone
 * asks for nothing, so its sheet can offer both its own passkey and a security key; the route
 * check above is what holds the answer to one of those two.
 */
export const requestedAttachment = (posture: DevicePosture): PasskeyAttachment | undefined =>
  posture === "laptop" ? "cross-platform" : undefined

const LAPTOP_CREATION_WAIT_MS = 300_000

/**
 * The timeout a creation request names. A laptop gets five minutes: fetching a phone, scanning the
 * QR code and unlocking it outlasts the ceremony's default. A phone names none and keeps that
 * default.
 */
export const creationTimeoutMs = (posture: DevicePosture): number | undefined =>
  posture === "laptop" ? LAPTOP_CREATION_WAIT_MS : undefined

/** The device's own authenticator, as a transport list names it. */
const LOCAL_TRANSPORT = "internal"

/** Every route a laptop accepts: a phone over QR, or a hardware key on any physical transport. */
const CROSS_DEVICE_TRANSPORTS: readonly string[] = ["hybrid", ...PHYSICAL_TRANSPORTS]

/**
 * The transports a ceremony may offer for a recorded credential. When the local route is not
 * allowed a laptop never offers the device's own: the route rule refuses an answer from it, so the
 * copy synced to this computer would sit at the top of the browser's list as a dead end. A record
 * that names nothing else — no transports at all, or only `internal` — falls back to the
 * cross-device set rather than to nothing, because an empty list is what lets the browser hand the
 * ceremony to that synced copy anyway. With `localAllowed`, a laptop sends only a physical-only
 * list — a hardware key's, which names no synced copy to hide — and otherwise no restriction: a
 * synced passkey's record can name only `hybrid`, and sending it would exclude `internal` and hide
 * the very copy the user picked. Transaction signing applies the same rule.
 */
export function offerableTransports(
  posture: DevicePosture,
  transports?: readonly string[],
  localAllowed = false,
): readonly string[] | undefined {
  if (posture !== "laptop") return transports?.length ? transports : undefined
  if (localAllowed) return isPhysicalOnly(transports) ? transports : undefined
  const offered = transports?.filter((t) => t !== LOCAL_TRANSPORT) ?? []
  return offered.length ? offered : CROSS_DEVICE_TRANSPORTS
}

/**
 * Name a security key after the route the consumer asked for. A password manager's browser
 * extension reads a request's hints to decide whether to take it over, and 1Password's stands aside
 * only when a security key is named; otherwise it answers a laptop's QR route from its synced copy,
 * which the route rule then refuses. The browser opens its sheet on the first hint, so the
 * consumer's route still comes first.
 */
const namingSecurityKey = (hints: readonly PasskeyHint[]): readonly PasskeyHint[] =>
  hints.includes("security-key") ? hints : [...hints, "security-key"]

/** The two classes a phone creation admits, named so its sheet opens on them rather than on QR. */
const PHONE_CREATION_HINTS: readonly PasskeyHint[] = ["client-device", "security-key"]

/** A laptop creation whose consumer names no route: the phone over QR first, then a key. */
const LAPTOP_CREATION_HINTS: readonly PasskeyHint[] = ["hybrid", "security-key"]

/**
 * Steering for a creation. A laptop leads with the route its consumer names, the phone when it
 * names none, and always names a security key; `null` sends nothing. A phone names its own passkey
 * and a security key — the two classes the route rule admits — and never `hybrid`, which it would
 * refuse. Steering is advisory: the route rule is what enforces this.
 */
export function creationHintsFor(
  posture: DevicePosture,
  laptopHints?: readonly PasskeyHint[] | null,
): readonly PasskeyHint[] | undefined {
  if (posture !== "laptop") return PHONE_CREATION_HINTS
  if (laptopHints === null) return undefined
  return laptopHints?.length ? namingSecurityKey(laptopHints) : LAPTOP_CREATION_HINTS
}

/** The two routes a laptop sign-in accepts when the device's own copy is not admitted. */
const LAPTOP_SIGN_IN_HINTS: readonly PasskeyHint[] = ["hybrid", "security-key"]

/**
 * Steering when the device's own copy IS admitted: open the sheet on this computer. No security key
 * is named, so a password manager's browser extension answers for a synced passkey; one is named
 * beside it only for a credential the consumer knows to be a hardware key.
 */
const LAPTOP_LOCAL_HINTS: readonly PasskeyHint[] = ["client-device"]

/**
 * Steering for a sign-in. Without `localAllowed` a laptop names the two cross-device routes it
 * accepts, because `checkAssertionRoute` refuses a local answer there — both, since `hybrid` alone
 * risks a sheet that hides the security-key option. With `localAllowed` it opens on this computer,
 * naming a security key only when `securityKey` says the credential is one. A consumer's own hints
 * still win, and `null` still sends none.
 *
 * A phone sends none. Its sign-in legitimately accepts another phone over QR, so steering there
 * would push those users off the route they need.
 */
export function signInHintsFor(
  posture: DevicePosture,
  laptopHints?: readonly PasskeyHint[] | null,
  localAllowed = false,
  securityKey = false,
): readonly PasskeyHint[] | undefined {
  if (posture !== "laptop" || laptopHints === null) return undefined
  if (laptopHints?.length) return namingSecurityKey(laptopHints)
  if (!localAllowed) return LAPTOP_SIGN_IN_HINTS
  return securityKey ? namingSecurityKey(LAPTOP_LOCAL_HINTS) : LAPTOP_LOCAL_HINTS
}
