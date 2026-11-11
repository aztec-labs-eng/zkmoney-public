import type { DevicePosture } from "../browser/devicePosture.js"
import { TRUSTED_CHROMIUM, trustsAttachmentLabel } from "../browser/passkeyCapabilities.js"
import {
  type UserAgentInfo,
  atLeast,
  currentUserAgentInfo,
  macosGivesApplePrf,
  windowsReleaseFromHints,
} from "../browser/userAgentInfo.js"

/**
 * Whether a laptop may create the wallet's passkey on its own password manager ("laptop
 * creation") instead of on a phone over QR, and which managers it may use. Decided once per
 * attempt before the steps sheet opens; the sheet shows the answer and the creation driver checks
 * the manager that answered against it.
 *
 * Apple Passwords returns no key material before macOS 15. A Mac's own new passkey reads right on
 * that Mac and on iPhones, so Chromium, whose Client Hints carry the version, admits Apple from
 * macOS 15. Safari and Firefox cannot report the version: they admit Apple from the browser version
 * that labels the answer truthfully (Safari 26.4) or names its provider (Firefox 153), and an
 * Apple answer there that brings no key is refused after creation. Google Password Manager lives
 * in Chrome. Windows Hello is admitted on Windows 11 in every browser; it keeps the only copy, as a
 * security key does, and on Windows 10 it returns no key material. Chromium reads the release from
 * Client Hints; Firefox cannot, so a Windows 10 answer there is refused after creation. 1Password's
 * extension and the macOS passkey window both answer under its id with key material, while its
 * Windows app returns none and is refused after creation. It needs no trusted attachment label:
 * the Mac's window offers no phone for a creation on this Mac, so a 1Password answer on Firefox's
 * Mac row is this Mac's, and one without its key is refused with no follow-up.
 * Its Firefox extension gives up on production's related-origin requests, so that row offers
 * 1Password through the Mac's window alone (`extensionWithdrawn`), and Firefox on Windows, which
 * sends no Client Hints and whose row is read from the user-agent string, ships its extensions
 * withdrawn, keeping Windows Hello; Linux's row, read the same way, keeps 1Password. Proton Pass is
 * admitted on every row through its browser extension, measured with key material in Chrome on a
 * Mac; only a request that opted into the wrapper the page-start lock kept aside reaches the
 * extension, so the sheet offers it where that wrapper is kept. Firefox prints the wrapper as a
 * named native, nothing is kept, and its rows ship Proton withdrawn. The sheet decides where it
 * opens; the row only says what is admitted.
 */

export type LocalManager = "apple" | "gpm" | "windows_hello" | "1password" | "proton"

export type Row =
  | "macChrome"
  | "macEdgeBrave"
  | "macSafari"
  | "macFirefox"
  | "windowsChrome"
  | "windowsEdgeBrave"
  | "windowsFirefox"
  | "linuxChrome"
  | "linuxEdgeBrave"
  | "linuxFirefox"

/**
 * A line saying Chrome can create on this computer in Google Password Manager. Named only while
 * that system's Chrome row still admits it.
 */
export type ChromeTip = "gpm"

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
      /** Managers `WITHDRAWN` removed from this row. */
      withdrawn: readonly LocalManager[]
      /** Set on a row left with the extensions and Windows Hello alone, for the sheet's Chrome tip. */
      chromeTip?: ChromeTip
      /** The sheet offers no extension-backed 1Password option: the Mac's window is its surface. */
      extensionWithdrawn?: true
      /** Client Hints say Windows 10, whose Windows Hello gives no key; the sheet says so first. */
      windows10?: true
    }

/** A `LaptopCreation` that offers the local route. */
export type LocalCreation = Extract<LaptopCreation, { local: true }>

export type Withdrawn = Readonly<Record<Row, readonly LocalManager[]>>

/**
 * Managers withdrawn per row, by a failed release gate or a browser the lock cannot route to; one
 * entry removes a manager.
 */
export const WITHDRAWN: Withdrawn = {
  macChrome: [],
  macEdgeBrave: [],
  macSafari: [],
  // Firefox prints Proton Pass's wrapper as a named native, so the lock keeps none to route to.
  macFirefox: ["proton"],
  windowsChrome: [],
  windowsEdgeBrave: [],
  // 1Password's Firefox extension (8.12.41) gives up on production's related-origin requests.
  windowsFirefox: ["1password", "proton"],
  linuxChrome: [],
  linuxEdgeBrave: [],
  // 1Password admitted despite 8.12.41: without it, Firefox on Linux can sign up only on a security key.
  linuxFirefox: ["proton"],
}

/**
 * Rows whose 1Password surface is the Mac's passkey window alone: 1Password's Firefox extension
 * (8.12.41) gives up on production's related-origin requests. Lifted with the Windows Firefox entry
 * in `WITHDRAWN`.
 */
export const EXTENSION_WITHDRAWN: readonly Row[] = ["macFirefox"]

/** The first Firefox that reports the provider's id for a passkey made on a Mac; older ones zero it. */
export const MAC_FIREFOX_PROVIDER_ID_FLOOR = "153"

/**
 * Whether an Apple answer on this row must bring its key with the creation, never on a follow-up:
 * Safari and Firefox can't say which macOS they run on, and Safari's label was measured on one Mac,
 * so a phone's passkey passed off as this Mac's could be read back from this Mac's wrong copy.
 */
export const appleKeyAtCreation = (creation: LocalCreation): boolean =>
  creation.row === "macSafari" || creation.row === "macFirefox"

const PHONE: LaptopCreation = { local: false, chromeTip: false }

const appleAdmitted = (ua: UserAgentInfo): boolean => macosGivesApplePrf(ua.osVersionReported)

/**
 * A row after withdrawals. The tip is kept only on a row with no manager but the extensions
 * (1Password, Proton Pass) and Windows Hello, and on the phone result a row with nothing left falls
 * back to.
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
  const alone = managers.every((m) => m === "1password" || m === "proton" || m === "windows_hello")
  return {
    local: true,
    os,
    row: key,
    managers,
    withdrawn: base.filter((m) => gone.includes(m)),
    ...(alone && chromeTip ? { chromeTip } : {}),
    ...(managers.includes("1password") && EXTENSION_WITHDRAWN.includes(key)
      ? { extensionWithdrawn: true as const }
      : {}),
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
    const release = windowsReleaseFromHints(ua)
    const hello: LocalManager[] = release === "11" ? ["windows_hello"] : []
    if (googleChrome) {
      const base: LocalManager[] = ["gpm", ...hello, "1password", "proton"]
      const creation = row(ua.osFamily, chromeKey, base, withdrawn)
      return creation.local && release === "10" ? { ...creation, windows10: true } : creation
    }
    const gpmTip = admits(chromeKey, "gpm") ? "gpm" : undefined
    if (ua.browserFamily === "firefox") {
      const key: Row = windows ? "windowsFirefox" : "linuxFirefox"
      const base: LocalManager[] = windows
        ? ["windows_hello", "1password", "proton"]
        : ["1password", "proton"]
      return row(ua.osFamily, key, base, withdrawn, gpmTip)
    }
    // Another Chromium has no Google Password Manager; Windows Hello and the extensions remain.
    if (hinted && TRUSTED_CHROMIUM.includes(ua.browserFamily)) {
      const key: Row = windows ? "windowsEdgeBrave" : "linuxEdgeBrave"
      return row(ua.osFamily, key, [...hello, "1password", "proton"], withdrawn, gpmTip)
    }
    return { local: false, chromeTip: gpmTip ?? false }
  }
  if (!hinted) {
    if (ua.osFamily === "macos" && ua.browserFamily === "safari" && trustsAttachmentLabel(ua)) {
      return row("macos", "macSafari", ["apple", "1password", "proton"], withdrawn)
    }
    const firefoxNamesProvider =
      ua.browserFamily === "firefox" &&
      atLeast(ua.browserVersionReported, MAC_FIREFOX_PROVIDER_ID_FLOOR)
    if (ua.osFamily === "macos" && firefoxNamesProvider) {
      return row("macos", "macFirefox", ["apple", "1password", "proton"], withdrawn)
    }
    return PHONE
  }
  if (ua.osFamily === "macos" && googleChrome) {
    return row(
      "macos",
      "macChrome",
      apple ? ["apple", "gpm", "1password", "proton"] : ["gpm", "1password", "proton"],
      withdrawn,
    )
  }
  if (ua.osFamily === "macos" && TRUSTED_CHROMIUM.includes(ua.browserFamily)) {
    // Edge, Brave and a Chromium without Chrome's name have no Google Password Manager.
    const gpmTip = admits("macChrome", "gpm") ? "gpm" : undefined
    return row(
      "macos",
      "macEdgeBrave",
      apple ? ["apple", "1password", "proton"] : ["1password", "proton"],
      withdrawn,
      gpmTip,
    )
  }
  return PHONE
}

/** `creation` with `manager` taken off its row; a row left empty falls back to the phone, tip kept. */
export function withoutManager(creation: LaptopCreation, manager: LocalManager): LaptopCreation {
  if (!creation.local || !creation.managers.includes(manager)) return creation
  const managers = creation.managers.filter((m) => m !== manager)
  if (managers.length === 0) return { local: false, chromeTip: creation.chromeTip ?? false }
  return { ...creation, managers }
}

/** The live browser's decision. A phone never creates on a laptop's terms, so it reads no hints. */
export async function currentLaptopCreation(posture: DevicePosture): Promise<LaptopCreation> {
  if (posture !== "laptop") return PHONE
  return laptopCreationFor(await currentUserAgentInfo())
}
