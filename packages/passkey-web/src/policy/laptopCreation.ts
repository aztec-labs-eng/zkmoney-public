import type { DevicePosture } from "./devicePosture.js"
import { TRUSTED_CHROMIUM, trustsAttachmentLabel } from "./passkeyCapabilities.js"
import {
  type UserAgentInfo,
  MACOS_SYNCED_COPY_FLOORS,
  currentUserAgentInfo,
  macosSyncedCopyReadsRight,
} from "./userAgentInfo.js"

/**
 * Whether a laptop may create the wallet's passkey on its own password manager ("laptop
 * creation") instead of on a phone over QR, and which managers it may use. Decided once per
 * attempt before the steps sheet opens; the sheet shows the answer and the creation driver checks
 * the manager that answered against it.
 *
 * Apple Passwords needs the macOS version, which only Client Hints carry (Safari and Firefox
 * freeze theirs), and is admitted only where a Mac is known to read its own synced passkey
 * correctly: macOS 15.7.5 or a later macOS 15, or 26.4.1 or later. Outside those ranges an Apple
 * answer is refused after creation. Google Password Manager lives in Chrome. 1Password needs
 * only a browser whose attachment label is trusted: its extension and the macOS passkey sheet
 * both answer under its id with key material, while its Windows app returns none and is refused
 * after creation. The sheet decides where it opens; the row only says what is admitted.
 */

export type LocalManager = "apple" | "gpm" | "1password"

export type Row =
  | "macChrome"
  | "macEdgeBrave"
  | "macSafari"
  | "windowsChrome"
  | "windowsEdgeBrave"
  | "linuxChrome"
  | "linuxEdgeBrave"

/**
 * A line saying Chrome can create on this computer, and in which manager: Apple Passwords on a
 * Mac, Google Password Manager elsewhere. Named only while that system's Chrome row still admits
 * the manager.
 */
export type ChromeTip = "apple" | "gpm"

export type LaptopCreation =
  | {
      local: false
      chromeTip: false | ChromeTip
    }
  | {
      local: true
      os: "macos" | "windows" | "linux"
      row: Row
      /** The managers this row admits, in the order the copy names them. */
      managers: readonly LocalManager[]
      /** Managers a failed release gate removed from this row. */
      withdrawn: readonly LocalManager[]
      /** Set on a row left with 1Password alone, for the phone variant it may open on. */
      chromeTip?: ChromeTip
    }

/** A `LaptopCreation` that offers the local route. */
export type LocalCreation = Extract<LaptopCreation, { local: true }>

/** The admitted macOS ranges, for the Chrome tip and the refusal of an Apple answer elsewhere. */
export const MAC_FLOORS_ADMITTED =
  `macOS ${MACOS_SYNCED_COPY_FLOORS.sequoia} or a later macOS 15, ` +
  `or macOS ${MACOS_SYNCED_COPY_FLOORS.tahoe} or later`

export type Withdrawn = Readonly<Record<Row, readonly LocalManager[]>>

/** Managers a release gate withdrew, per row. Empty at launch; one entry removes a manager. */
export const WITHDRAWN: Withdrawn = {
  macChrome: [],
  macEdgeBrave: [],
  macSafari: [],
  windowsChrome: [],
  windowsEdgeBrave: [],
  linuxChrome: [],
  linuxEdgeBrave: [],
}

const PHONE: LaptopCreation = { local: false, chromeTip: false }

const appleAdmitted = (ua: UserAgentInfo): boolean =>
  macosSyncedCopyReadsRight(ua.osVersionReported)

/**
 * A row after withdrawals. The tip is kept only on a row left with 1Password alone, and on the
 * phone result a row with nothing left falls back to.
 */
function row(
  os: "macos" | "windows" | "linux",
  key: Row,
  base: readonly LocalManager[],
  withdrawn: Withdrawn,
  chromeTip?: ChromeTip,
): LaptopCreation {
  const gone = withdrawn[key]
  const managers = base.filter((m) => !gone.includes(m))
  if (managers.length === 0) return { local: false, chromeTip: chromeTip ?? false }
  const alone = managers.every((m) => m === "1password")
  return {
    local: true,
    os,
    row: key,
    managers,
    withdrawn: base.filter((m) => gone.includes(m)),
    ...(alone && chromeTip ? { chromeTip } : {}),
  }
}

/**
 * The decision for a laptop, from the browser's claims. `withdrawn` is a test seam over the
 * release-gate constant.
 */
export function laptopCreationFor(
  ua: UserAgentInfo,
  withdrawn: Withdrawn = WITHDRAWN,
): LaptopCreation {
  const admits = (key: Row, manager: LocalManager) => !withdrawn[key].includes(manager)
  const apple = appleAdmitted(ua)
  // Linux hints carry no version, so naming the platform is its proof of Client Hints.
  const hinted = ua.osVersionFromHints || (ua.osFamily === "linux" && ua.platformFromHints)
  // Google Password Manager lives only in the browser that names itself Google Chrome; another
  // Chromium carries Chrome's user-agent token without it.
  const googleChrome = hinted && ua.browserFamily === "chrome" && ua.browserFromHints === true
  if (ua.osFamily === "windows" || ua.osFamily === "linux") {
    const windows = ua.osFamily === "windows"
    const chromeKey: Row = windows ? "windowsChrome" : "linuxChrome"
    if (googleChrome) return row(ua.osFamily, chromeKey, ["gpm", "1password"], withdrawn)
    const gpmTip = admits(chromeKey, "gpm") ? "gpm" : undefined
    // Another Chromium has no Google Password Manager; 1Password is what it can use.
    if (hinted && TRUSTED_CHROMIUM.includes(ua.browserFamily)) {
      const key: Row = windows ? "windowsEdgeBrave" : "linuxEdgeBrave"
      return row(ua.osFamily, key, ["1password"], withdrawn, gpmTip)
    }
    return { local: false, chromeTip: gpmTip ?? false }
  }
  if (!hinted) {
    const appleTip = admits("macChrome", "apple") ? "apple" : undefined
    // Safari cannot report the macOS version, so Apple Passwords stays off its row; 1Password
    // needs only the trusted label Safari 26.4 and later report.
    if (ua.osFamily === "macos" && ua.browserFamily === "safari" && trustsAttachmentLabel(ua)) {
      return row("macos", "macSafari", ["1password"], withdrawn, appleTip)
    }
    const macWebKitOrGecko =
      ua.osFamily === "macos" && (ua.browserFamily === "safari" || ua.browserFamily === "firefox")
    return { local: false, chromeTip: (macWebKitOrGecko && appleTip) || false }
  }
  if (ua.osFamily === "macos" && googleChrome) {
    return row(
      "macos",
      "macChrome",
      apple ? ["apple", "gpm", "1password"] : ["gpm", "1password"],
      withdrawn,
    )
  }
  if (ua.osFamily === "macos" && TRUSTED_CHROMIUM.includes(ua.browserFamily)) {
    // Edge, Brave and a Chromium without Chrome's name have no Google Password Manager.
    const gpmTip = admits("macChrome", "gpm") ? "gpm" : undefined
    return row(
      "macos",
      "macEdgeBrave",
      apple ? ["apple", "1password"] : ["1password"],
      withdrawn,
      gpmTip,
    )
  }
  return PHONE
}

/** The live browser's decision. A phone never creates on a laptop's terms, so it reads no hints. */
export async function currentLaptopCreation(posture: DevicePosture): Promise<LaptopCreation> {
  if (posture !== "laptop") return PHONE
  return laptopCreationFor(await currentUserAgentInfo())
}
