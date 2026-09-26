/**
 * What the browser says it is. Versions are recorded as reported: Safari on macOS freezes at
 * 10.15.7, Safari 26 on iOS reports 18.6, Firefox on iOS reports 18.7. Nothing here corrects them,
 * so every consumer treats the values as claims.
 */

export type OsFamily = "ios" | "macos" | "android" | "windows" | "linux" | "chromeos" | "unknown"
/** Brave only where its brand is exposed; elsewhere it reads as the family it imitates. */
export type BrowserFamily =
  | "safari"
  | "chrome"
  | "firefox"
  | "edge"
  | "samsung"
  | "brave"
  | "unknown"

export type UserAgentInfo = {
  osFamily: OsFamily
  osVersionReported: string
  /** Present when Client Hints, not the user-agent string, supplied the OS version. */
  osVersionFromHints?: true
  browserFamily: BrowserFamily
  browserVersionReported: string
}

export type UserAgentSnapshot = {
  userAgent: string
  userAgentData?: {
    platform?: string
    /** Client Hints high-entropy `platformVersion`, when the caller asked for it. */
    platformVersion?: string
    brands?: readonly { brand: string; version: string }[]
  }
}

export const UNKNOWN = "unknown"

const dotted = (raw: string | undefined) => (raw ? raw.replace(/_/g, ".") : UNKNOWN)

function osFrom(
  snapshot: UserAgentSnapshot,
): Pick<UserAgentInfo, "osFamily" | "osVersionReported" | "osVersionFromHints"> {
  const ua = snapshot.userAgent
  const hinted = snapshot.userAgentData?.platform
  const hintedVersion = snapshot.userAgentData?.platformVersion || undefined
  const version = (fromUserAgent: string) =>
    hintedVersion
      ? { osVersionReported: hintedVersion, osVersionFromHints: true as const }
      : { osVersionReported: fromUserAgent }
  const ios = ua.match(/(?:iPhone|iPad|iPod).*?OS (\d+(?:[_.]\d+)*)/)
  if (ios) return { osFamily: "ios", osVersionReported: dotted(ios[1]) }
  if (hinted === "Android" || /Android/.test(ua)) {
    const m = ua.match(/Android (\d+(?:\.\d+)*)/)
    return { osFamily: "android", ...version(dotted(m?.[1])) }
  }
  if (hinted === "macOS" || /Macintosh/.test(ua)) {
    const m = ua.match(/Mac OS X (\d+(?:[_.]\d+)*)/)
    return { osFamily: "macos", ...version(dotted(m?.[1])) }
  }
  if (hinted === "Windows" || /Windows NT/.test(ua)) {
    const m = ua.match(/Windows NT (\d+(?:\.\d+)*)/)
    return { osFamily: "windows", ...version(dotted(m?.[1])) }
  }
  if (hinted === "Chrome OS" || /CrOS/.test(ua)) {
    const m = ua.match(/CrOS \S+ (\d+(?:\.\d+)*)/)
    return { osFamily: "chromeos", ...version(dotted(m?.[1])) }
  }
  if (hinted === "Linux" || /Linux|X11/.test(ua)) {
    return { osFamily: "linux", ...version(UNKNOWN) }
  }
  return { osFamily: "unknown", osVersionReported: UNKNOWN }
}

/** Checked in this order whatever order the brands come in. Brave's version is Chromium's. */
const BRAND_FAMILIES: [RegExp, BrowserFamily][] = [
  [/Microsoft Edge/, "edge"],
  [/Brave/, "brave"],
  [/Google Chrome/, "chrome"],
  [/Samsung Internet/, "samsung"],
]

const UA_FAMILIES: [RegExp, BrowserFamily][] = [
  [/EdgiOS\/(\d+(?:\.\d+)*)/, "edge"],
  [/Edg\/(\d+(?:\.\d+)*)/, "edge"],
  [/SamsungBrowser\/(\d+(?:\.\d+)*)/, "samsung"],
  [/CriOS\/(\d+(?:\.\d+)*)/, "chrome"],
  [/Chrome\/(\d+(?:\.\d+)*)/, "chrome"],
  [/FxiOS\/(\d+(?:\.\d+)*)/, "firefox"],
  [/Firefox\/(\d+(?:\.\d+)*)/, "firefox"],
  [/Version\/(\d+(?:\.\d+)*).*Safari/, "safari"],
]

function browserFrom(
  snapshot: UserAgentSnapshot,
): Pick<UserAgentInfo, "browserFamily" | "browserVersionReported"> {
  const brands = snapshot.userAgentData?.brands ?? []
  for (const [pattern, family] of BRAND_FAMILIES) {
    const brand = brands.find((b) => pattern.test(b.brand))
    if (brand) return { browserFamily: family, browserVersionReported: brand.version || UNKNOWN }
  }
  for (const [pattern, family] of UA_FAMILIES) {
    const m = snapshot.userAgent.match(pattern)
    if (m) return { browserFamily: family, browserVersionReported: dotted(m[1]) }
  }
  return { browserFamily: "unknown", browserVersionReported: UNKNOWN }
}

export function parseUserAgent(snapshot: UserAgentSnapshot): UserAgentInfo {
  return { ...osFrom(snapshot), ...browserFrom(snapshot) }
}

type NavigatorWithHints = Navigator & {
  userAgentData?: {
    platform?: string
    brands?: readonly { brand: string; version: string }[]
    getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>
  }
}

/** The live browser's claims; asks Client Hints for the platform version where the API exists. */
export async function currentUserAgentInfo(): Promise<UserAgentInfo> {
  if (typeof navigator === "undefined") return parseUserAgent({ userAgent: "" })
  const nav = navigator as NavigatorWithHints
  const hints = nav.userAgentData
  let platformVersion: string | undefined
  try {
    platformVersion = (await hints?.getHighEntropyValues?.(["platformVersion"]))?.platformVersion
  } catch {
    platformVersion = undefined
  }
  return parseUserAgent({
    userAgent: nav.userAgent ?? "",
    userAgentData: hints
      ? { platform: hints.platform, brands: hints.brands, platformVersion }
      : undefined,
  })
}

/** Compares dotted version strings numerically, missing components counting as zero. */
export function versionBelow(reported: string, floor: string): boolean {
  if (reported === UNKNOWN) return false
  const a = reported.split(".").map(Number)
  const b = floor.split(".").map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Number.isNaN(x)) return false
    if (x !== y) return x < y
  }
  return false
}

/** iOS before this release had a cross-device passkey bug the phone flow trips on. */
export const IOS_PASSKEY_FLOOR = "18.4"

/** Whether the browser claims an iOS below the floor; a frozen or missing version claims nothing. */
export function iosBelowFloor(
  info: Pick<UserAgentInfo, "osFamily" | "osVersionReported">,
): boolean {
  return info.osFamily === "ios" && versionBelow(info.osVersionReported, IOS_PASSKEY_FLOOR)
}
