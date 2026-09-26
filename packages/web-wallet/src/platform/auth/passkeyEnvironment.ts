import type { DevicePosture } from "./devicePosture"
import { UNKNOWN, currentUserAgentInfo, type UserAgentInfo } from "./userAgentInfo"

/**
 * What surrounded the last passkey ceremony: the provider's self-reported id, the OS and browser
 * as they report themselves, and whether the wallet took the visitor for a phone or a laptop. Kept
 * device-locally for a later reporting step; never sent from here, and never holding a credential
 * id, key material, or an address.
 */
export type PasskeyEnvironment = {
  aaguid: string
  osFamily: UserAgentInfo["osFamily"]
  osVersionReported: string
  browserFamily: UserAgentInfo["browserFamily"]
  browserVersionReported: string
  posture: DevicePosture
}

export type PasskeyEnvironmentEvidence = {
  aaguid?: string
  posture: DevicePosture
  userAgent: UserAgentInfo
}

const STORAGE_KEY = "webwallet.passkeyEnv"

const store = () => (typeof localStorage === "undefined" ? undefined : localStorage)

export function buildPasskeyEnvironment(evidence: PasskeyEnvironmentEvidence): PasskeyEnvironment {
  return {
    aaguid: evidence.aaguid ?? UNKNOWN,
    osFamily: evidence.userAgent.osFamily,
    osVersionReported: evidence.userAgent.osVersionReported,
    browserFamily: evidence.userAgent.browserFamily,
    browserVersionReported: evidence.userAgent.browserVersionReported,
    posture: evidence.posture,
  }
}

/** Replaces the previous record. Never throws: a full or blocked store only loses the record. */
export async function recordPasskeyEnvironment(input: {
  aaguid?: string
  posture: DevicePosture
}): Promise<void> {
  try {
    const record = buildPasskeyEnvironment({ ...input, userAgent: await currentUserAgentInfo() })
    store()?.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Collection is best-effort by design.
  }
}

export function lastPasskeyEnvironment(): PasskeyEnvironment | null {
  try {
    const raw = store()?.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PasskeyEnvironment) : null
  } catch {
    return null
  }
}
