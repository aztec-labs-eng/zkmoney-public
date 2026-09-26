import type { PasskeyAttachment } from "../ceremony/passkeyCeremony.js"
import type { DevicePosture } from "./devicePosture.js"
import { PASSKEY_MANAGER_AAGUIDS } from "./passkeyProviders.js"
import {
  type UserAgentInfo,
  UNKNOWN,
  currentUserAgentInfo,
  parseUserAgent,
  versionBelow,
} from "./userAgentInfo.js"

/**
 * Whether this browser can hand a passkey ceremony to a phone at all. Asked on a laptop before the
 * explainer is shown, so the steps can name a route that exists instead of a QR code that leads
 * nowhere. `false` from the browser means unsupported; an absent answer means unknown and proceeds.
 * Reaching no phone is not the same as reaching no authenticator — see `mayStartLaptopCeremony`.
 */
export type PhoneReach = "ok" | "no-hybrid" | "below-floor" | "unknown"

export type PhoneReachInput = {
  posture: DevicePosture
  userAgent: UserAgentInfo
  /** `PublicKeyCredential.getClientCapabilities()`'s answer, or undefined when unavailable. */
  capabilities?: Record<string, boolean>
}

/**
 * Desktop browsers below these versions cannot create a wallet passkey on a phone. Safari 18
 * returns no PRF from a creation over QR, and labels the follow-up assertion as this computer's
 * own, which a phone's answer cannot be told apart from (measured on 18.6).
 */
const DESKTOP_FLOORS: {
  os: UserAgentInfo["osFamily"]
  browser: UserAgentInfo["browserFamily"]
  floor: string
}[] = [
  { os: "macos", browser: "safari", floor: "26" },
  { os: "macos", browser: "firefox", floor: "139" },
]

export function probePhoneReach(input: PhoneReachInput): PhoneReach {
  if (input.posture !== "laptop") return "ok"
  // The floors decide first. A browser below one is refused whatever it claims about hybrid, and
  // browsers below these floors do report the capability, so reading it first would hide them.
  const { osFamily, browserFamily, browserVersionReported } = input.userAgent
  for (const { os, browser, floor } of DESKTOP_FLOORS) {
    if (
      osFamily === os &&
      browserFamily === browser &&
      versionBelow(browserVersionReported, floor)
    ) {
      return "below-floor"
    }
  }
  const hybrid = input.capabilities?.hybridTransport
  if (hybrid === false) return "no-hybrid"
  return hybrid === true ? "ok" : "unknown"
}

/**
 * Whether a laptop ceremony may start at all. Only a browser below the floor is refused: one that
 * reports no route to a phone can still reach a security key over USB, and the steps say so.
 */
export const mayStartLaptopCeremony = (reach: PhoneReach): boolean => reach !== "below-floor"

/**
 * The macOS Safari versions that label a phone-over-QR or security-key answer `platform`. Below
 * 18.6 the hybrid PRF itself is suspect. 26.4 labels correctly; 26.0 to 26.3 are unobserved and
 * stay outside the window.
 */
const MISLABEL_FLOOR = "18.6"
const MISLABEL_CEILING = "26"

/**
 * Whether the browser reports a version inside that window. A window on the reported version,
 * not proof of the browser: a desktop-mode iPad or a WebKit-family browser sending Safari's UA
 * lands inside it too, and the evidence gates on the response carry the safety.
 */
export function safariMislabelsCrossDevice(ua: UserAgentInfo): boolean {
  if (ua.osFamily !== "macos" || ua.browserFamily !== "safari") return false
  const version = ua.browserVersionReported
  if (version === UNKNOWN) return false
  return !versionBelow(version, MISLABEL_FLOOR) && versionBelow(version, MISLABEL_CEILING)
}

/** The live browser's answer from its user-agent string alone; Safari sends no Client Hints. */
export function currentMisreportsCrossDevice(): boolean {
  if (typeof navigator === "undefined") return false
  return safariMislabelsCrossDevice(parseUserAgent({ userAgent: navigator.userAgent ?? "" }))
}

/** The parts of a create answer the gate below reads. */
type CreatedClass = {
  authenticatorAttachment?: PasskeyAttachment
  aaguid?: string
  transports?: readonly string[]
}

/**
 * Whether a laptop's create answer is a phone answer the browser labelled as the laptop's own.
 * Only Apple's own stack is known to, only when the request asked for another device, and only
 * for a phone provider measured over QR, so the slot it binds is the cell a Chrome-initiated read
 * reproduces. The transports say what the credential can be reached over, not which route
 * answered: `hybrid` marks a syncable passkey and keeps a security key out. The provider id is the
 * only route evidence and it is self-reported, so a manager answering from its local copy under a
 * measured id would pass; that is the accepted limit of this gate. In practice the laptop creation
 * hints keep 1Password's own extension out of the ceremony.
 */
export function mislabelledCreation(input: {
  reported: CreatedClass
  requested: PasskeyAttachment | undefined
  misreportsCrossDevice: boolean | undefined
}): boolean {
  const { reported } = input
  return (
    Boolean(input.misreportsCrossDevice) &&
    input.requested === "cross-platform" &&
    reported.aaguid !== undefined &&
    PASSKEY_MANAGER_AAGUIDS.has(reported.aaguid.toLowerCase()) &&
    reported.transports?.includes("hybrid") === true &&
    reported.authenticatorAttachment !== "cross-platform"
  )
}

/**
 * Whether a laptop's assertion answer must be read as another device's. An assertion names no
 * provider and no transports, so inside the window every answer the browser did not already call
 * another device's is read that way — this device's own copy among them, since an assertion cannot
 * say which answered.
 */
export function mislabelledAssertion(input: {
  reportedAttachment: PasskeyAttachment | undefined
  posture: DevicePosture
  misreportsCrossDevice: boolean | undefined
}): boolean {
  return (
    Boolean(input.misreportsCrossDevice) &&
    input.posture === "laptop" &&
    input.reportedAttachment !== "cross-platform"
  )
}

type CapabilitiesStatic = { getClientCapabilities?: () => Promise<Record<string, boolean>> }

/** `lib.dom` declares the static as a plain object, so it is read through a cast, never merged. */
async function clientCapabilities(): Promise<Record<string, boolean> | undefined> {
  if (typeof PublicKeyCredential === "undefined") return undefined
  const read = (PublicKeyCredential as unknown as CapabilitiesStatic).getClientCapabilities
  if (typeof read !== "function") return undefined
  try {
    return await read.call(PublicKeyCredential)
  } catch {
    return undefined
  }
}

export async function currentPhoneReach(posture: DevicePosture): Promise<PhoneReach> {
  if (posture !== "laptop") return "ok"
  const [userAgent, capabilities] = await Promise.all([
    currentUserAgentInfo(),
    clientCapabilities(),
  ])
  return probePhoneReach({ posture, userAgent, capabilities })
}
