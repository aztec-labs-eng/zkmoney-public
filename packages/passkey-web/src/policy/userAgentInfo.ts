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
  /** Client Hints `architecture` (`arm`, `x86`), a claim like the versions; absent without hints. */
  architectureReported?: string
  /** Present when Client Hints named the platform; Linux hints carry no version, only this. */
  platformFromHints?: true
  browserFamily: BrowserFamily
  browserVersionReported: string
  /** Present when a Client Hints brand, not the user-agent string, named the browser. */
  browserFromHints?: true
}

export type UserAgentSnapshot = {
  userAgent: string
  userAgentData?: {
    platform?: string
    /** Client Hints high-entropy `platformVersion`, when the caller asked for it. */
    platformVersion?: string
    /** Client Hints high-entropy `architecture`, when the caller asked for it. */
    architecture?: string
    brands?: readonly { brand: string; version: string }[]
  }
}

export const UNKNOWN = "unknown"

const dotted = (raw: string | undefined) => (raw ? raw.replace(/_/g, ".") : UNKNOWN)

function osFrom(
  snapshot: UserAgentSnapshot,
): Pick<
  UserAgentInfo,
  "osFamily" | "osVersionReported" | "osVersionFromHints" | "platformFromHints"
> {
  const ua = snapshot.userAgent
  const hinted = snapshot.userAgentData?.platform
  const hintedVersion = snapshot.userAgentData?.platformVersion || undefined
  const version = (fromUserAgent: string) => ({
    ...(hintedVersion
      ? { osVersionReported: hintedVersion, osVersionFromHints: true as const }
      : { osVersionReported: fromUserAgent }),
    ...(hinted ? { platformFromHints: true as const } : {}),
  })
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

/**
 * Checked in this order whatever order the brands come in. Brave's version is Chromium's. Chrome's
 * brand is matched whole: it admits a password manager, so a name that only contains it is not it.
 */
const BRAND_FAMILIES: [RegExp, BrowserFamily][] = [
  [/Microsoft Edge/, "edge"],
  [/Brave/, "brave"],
  [/^Google Chrome$/, "chrome"],
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
): Pick<UserAgentInfo, "browserFamily" | "browserVersionReported" | "browserFromHints"> {
  const brands = snapshot.userAgentData?.brands ?? []
  for (const [pattern, family] of BRAND_FAMILIES) {
    const brand = brands.find((b) => pattern.test(b.brand))
    if (brand) {
      return {
        browserFamily: family,
        browserVersionReported: brand.version || UNKNOWN,
        browserFromHints: true,
      }
    }
  }
  for (const [pattern, family] of UA_FAMILIES) {
    const m = snapshot.userAgent.match(pattern)
    if (m) return { browserFamily: family, browserVersionReported: dotted(m[1]) }
  }
  return { browserFamily: "unknown", browserVersionReported: UNKNOWN }
}

export function parseUserAgent(snapshot: UserAgentSnapshot): UserAgentInfo {
  const architecture = snapshot.userAgentData?.architecture || undefined
  return {
    ...osFrom(snapshot),
    ...(architecture ? { architectureReported: architecture } : {}),
    ...browserFrom(snapshot),
  }
}

type NavigatorWithHints = Navigator & {
  userAgentData?: {
    platform?: string
    brands?: readonly { brand: string; version: string }[]
    getHighEntropyValues?: (
      hints: string[],
    ) => Promise<{ platformVersion?: string; architecture?: string }>
  }
}

/**
 * The live browser's claims; asks Client Hints for the platform version and the architecture
 * where the API exists.
 */
export async function currentUserAgentInfo(): Promise<UserAgentInfo> {
  if (typeof navigator === "undefined") return parseUserAgent({ userAgent: "" })
  const nav = navigator as NavigatorWithHints
  const hints = nav.userAgentData
  let platformVersion: string | undefined
  let architecture: string | undefined
  try {
    const values = await hints?.getHighEntropyValues?.(["platformVersion", "architecture"])
    platformVersion = values?.platformVersion
    architecture = values?.architecture
  } catch {
    platformVersion = undefined
    architecture = undefined
  }
  return parseUserAgent({
    userAgent: nav.userAgent ?? "",
    userAgentData: hints
      ? { platform: hints.platform, brands: hints.brands, platformVersion, architecture }
      : undefined,
  })
}

/** The live browser's claims from its user-agent string alone, for callers that cannot wait. */
export function currentUserAgentInfoSync(): UserAgentInfo {
  return parseUserAgent({
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent ?? "",
  })
}

const HINTS_WAIT_MS = 1000

/**
 * The live browser's claims for a request that must go out soon: Client Hints get a bounded wait,
 * and a read that stalls or fails leaves the user-agent string's claims standing alone. A prompt
 * has to open on the tap that asked for it.
 */
export async function currentUserAgentInfoSoon(): Promise<UserAgentInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<UserAgentInfo>((resolve) => {
    timer = setTimeout(() => resolve(currentUserAgentInfoSync()), HINTS_WAIT_MS)
  })
  try {
    return await Promise.race([currentUserAgentInfo().catch(currentUserAgentInfoSync), expired])
  } finally {
    clearTimeout(timer)
  }
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

const STRICT_VERSION = /^\d+(\.\d+){0,2}$/

/**
 * Whether a version is at or above a floor, for a floor that must fail closed: only a plain
 * dotted version of one to three numbers qualifies, so `unknown`, an empty string or a suffix
 * such as `-beta` never passes. `versionBelow` is the lenient comparison for refusals.
 */
export function atLeast(version: string, floor: string): boolean {
  if (!STRICT_VERSION.test(version)) return false
  return !versionBelow(version, floor)
}

/**
 * The first macOS on each branch measured to read a synced iPhone-made passkey right. Below either,
 * a Mac can read the wrong secret key from its own copy.
 */
export const MACOS_SYNCED_COPY_FLOORS = { sequoia: "15.7.5", tahoe: "26.4.1" } as const

/** Whether a macOS version is in a range measured to read its synced copy right. Fails closed. */
export function macosSyncedCopyReadsRight(version: string): boolean {
  return (
    atLeast(version, MACOS_SYNCED_COPY_FLOORS.tahoe) ||
    (atLeast(version, MACOS_SYNCED_COPY_FLOORS.sequoia) && versionBelow(version, "16"))
  )
}

/** iOS before this release had a cross-device passkey bug the phone flow trips on. */
export const IOS_PASSKEY_FLOOR = "18.4"

/** Whether the browser claims an iOS below the floor; a missing version claims nothing. */
export function iosBelowFloor(
  info: Pick<UserAgentInfo, "osFamily" | "osVersionReported">,
): boolean {
  return info.osFamily === "ios" && versionBelow(info.osVersionReported, IOS_PASSKEY_FLOOR)
}
