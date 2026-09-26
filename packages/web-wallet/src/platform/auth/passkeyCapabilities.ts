import type { DevicePosture } from "./devicePosture"
import { type UserAgentInfo, currentUserAgentInfo, versionBelow } from "./userAgentInfo"

/**
 * Whether this browser can hand a passkey ceremony to a phone at all. Asked on a laptop before the
 * phone explainer is shown, so a browser without the cross-device route gets a plain refusal
 * instead of a QR code that leads nowhere. `false` from the browser means unsupported; an absent
 * answer means unknown and proceeds.
 */
export type PhoneReach = "ok" | "no-hybrid" | "below-floor" | "unknown"

export type PhoneReachInput = {
  posture: DevicePosture
  userAgent: UserAgentInfo
  /** `PublicKeyCredential.getClientCapabilities()`'s answer, or undefined when unavailable. */
  capabilities?: Record<string, boolean>
}

/** Desktop browsers below these versions have no working cross-device route. */
const DESKTOP_FLOORS: {
  os: UserAgentInfo["osFamily"]
  browser: UserAgentInfo["browserFamily"]
  floor: string
}[] = [
  { os: "macos", browser: "safari", floor: "18" },
  { os: "macos", browser: "firefox", floor: "139" },
]

export function probePhoneReach(input: PhoneReachInput): PhoneReach {
  if (input.posture !== "laptop") return "ok"
  const hybrid = input.capabilities?.hybridTransport
  if (hybrid === false) return "no-hybrid"
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
  return hybrid === true ? "ok" : "unknown"
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
