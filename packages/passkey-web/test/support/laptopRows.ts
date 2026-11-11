/** Browsers on each laptop row, and the rows `laptopCreationFor` returns for them. */
import {
  type LaptopCreation,
  type LocalManager,
  type Withdrawn,
  WITHDRAWN,
} from "../../src/rules/laptopCreation.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"

/** The Firefox rows of Windows and Linux as they read once nothing is withdrawn from them. */
export const FIREFOX_ADMITTED: Withdrawn = { ...WITHDRAWN, windowsFirefox: [], linuxFirefox: [] }

export const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
export const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
export const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
export const macSafariUa = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`
export const WINDOWS_FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0"
/** Firefox on Linux, and Firefox on an Android phone asking for the desktop site: the same claim. */
export const LINUX_FIREFOX_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0"
export const ANDROID_FIREFOX_UA =
  "Mozilla/5.0 (Android 15; Mobile; rv:139.0) Gecko/139.0 Firefox/139.0"

export const chrome = { brand: "Google Chrome", version: "155" }
export const edge = { brand: "Microsoft Edge", version: "155" }
export const brave = { brand: "Brave", version: "155" }

/** A Chromium on a Mac answering Client Hints with the given version. */
export const mac = (version: string, brand: { brand: string; version: string } = chrome) =>
  parseUserAgent({
    userAgent: MAC_CHROME_UA,
    userAgentData: {
      platform: "macOS",
      platformVersion: version,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

/** A Chromium on Windows; the hinted version is 13 or more on Windows 11, 10 or less before it. */
export const windows = (brand = chrome, version = "15.0.0") =>
  parseUserAgent({
    userAgent: WINDOWS_CHROME_UA,
    userAgentData: {
      platform: "Windows",
      platformVersion: version,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

/** Chrome on Linux as it answers Client Hints: the platform's name and an empty version. */
export const linux = (brand = chrome) =>
  parseUserAgent({
    userAgent: LINUX_CHROME_UA,
    userAgentData: {
      platform: "Linux",
      platformVersion: "",
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

export const safari = (version = "26.4") => parseUserAgent({ userAgent: macSafariUa(version) })

export const firefox = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
  })

export const phone: LaptopCreation = { local: false, chromeTip: false }
export const macEdgeBrave = (
  managers: LocalManager[],
  withdrawn: LocalManager[] = [],
  chromeTip?: "gpm",
): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macEdgeBrave",
  managers,
  withdrawn,
  ...(chromeTip ? { chromeTip } : {}),
})
export const macSafari = (
  managers: LocalManager[] = ["apple", "1password", "proton"],
  withdrawn: LocalManager[] = [],
): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macSafari",
  managers,
  withdrawn,
})
/** Firefox's Mac row ships Proton withdrawn: the lock keeps no wrapper there. */
export const macFirefox = (
  managers: LocalManager[] = ["apple", "1password"],
  withdrawn: LocalManager[] = ["proton"],
): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macFirefox",
  managers,
  withdrawn,
  ...(managers.includes("1password") ? { extensionWithdrawn: true as const } : {}),
})

export const withdrawing = (
  overrides: Partial<Record<keyof Withdrawn, LocalManager[]>>,
): Withdrawn => ({
  macChrome: [],
  macEdgeBrave: [],
  macSafari: [],
  macFirefox: [],
  windowsChrome: [],
  windowsEdgeBrave: [],
  windowsFirefox: [],
  linuxChrome: [],
  linuxEdgeBrave: [],
  linuxFirefox: [],
  ...overrides,
})
