/**
 * Which kind of device the visitor is on. Decides only which WebAuthn attachment the wallet asks
 * for: a phone keeps its own passkey (`platform`), everything else is sent to a phone over the
 * cross-device route (`cross-platform`). The response attachment, not this guess, picks key
 * material — a wrong guess ends in a loud refusal, never a wrong slot.
 */
export type DevicePosture = "phone" | "laptop"

export type DeviceSnapshot = {
  /** Client Hints `navigator.userAgentData.mobile`, when the browser exposes it. */
  userAgentDataMobile?: boolean
  userAgent: string
}

/** Client Hints win when present; the user-agent string is the fallback; anything unrecognized is a laptop. */
export function classifyDevicePosture(snapshot: DeviceSnapshot): DevicePosture {
  if (snapshot.userAgentDataMobile !== undefined) {
    return snapshot.userAgentDataMobile ? "phone" : "laptop"
  }
  const ua = snapshot.userAgent
  if (/iPhone|iPod/i.test(ua)) return "phone"
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return "phone"
  return "laptop"
}

type NavigatorWithHints = Navigator & { userAgentData?: { mobile?: boolean } }

export function currentDevicePosture(): DevicePosture {
  if (typeof navigator === "undefined") return "laptop"
  const nav = navigator as NavigatorWithHints
  return classifyDevicePosture({
    userAgentDataMobile: nav.userAgentData?.mobile,
    userAgent: nav.userAgent ?? "",
  })
}
