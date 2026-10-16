// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type LaptopCreation,
  type LocalManager,
  type Withdrawn,
  WITHDRAWN,
  currentLaptopCreation,
  laptopCreationFor,
} from "../src/policy/laptopCreation.js"
import { MACOS_SYNCED_COPY_FLOORS, parseUserAgent } from "../src/policy/userAgentInfo.js"

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
/** A Chrome whose user-agent string alone would admit Apple: real Chrome freezes it at 10_15_7. */
const MAC_CHROME_UA_UNFROZEN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_8_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const macSafariUa = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`
const MAC_SAFARI_UA = macSafariUa("26.4")
const MAC_FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0"
const WINDOWS_FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0"
const IPAD_CHROME_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.8037.55 Safari/604.1"

const chrome = { brand: "Google Chrome", version: "155" }
const edge = { brand: "Microsoft Edge", version: "155" }
const brave = { brand: "Brave", version: "155" }
/** A Chromium that carries no brand of its own: Chrome only by its user-agent token. */
const chromium = { brand: "Chromium", version: "155" }

/** A Chromium on a Mac answering Client Hints with the given version. */
const mac = (version: string, brand: { brand: string; version: string } = chrome) =>
  parseUserAgent({
    userAgent: MAC_CHROME_UA,
    userAgentData: {
      platform: "macOS",
      platformVersion: version,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

/** A Chromium on Windows; the hinted version is 13 or more on Windows 11, 10 or less before it. */
const windows = (brand = chrome, version = "15.0.0") =>
  parseUserAgent({
    userAgent: WINDOWS_CHROME_UA,
    userAgentData: {
      platform: "Windows",
      platformVersion: version,
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

/** Chrome on Linux as it answers Client Hints: the platform's name and an empty version. */
const linux = (brand = chrome) =>
  parseUserAgent({
    userAgent: LINUX_CHROME_UA,
    userAgentData: {
      platform: "Linux",
      platformVersion: "",
      brands: [brand, { brand: "Chromium", version: "155" }],
    },
  })

const safari = (version = "26.4") => parseUserAgent({ userAgent: macSafariUa(version) })

const phone: LaptopCreation = { local: false, chromeTip: false }
/** Phone creation, with the line saying Chrome can create here in Google Password Manager. */
const tipsChrome: LaptopCreation = { local: false, chromeTip: "gpm" }
/** Phone creation on a Mac, with the line saying Chrome can create here in Apple Passwords. */
const tipsApple: LaptopCreation = { local: false, chromeTip: "apple" }
const macChrome = (managers: LocalManager[], withdrawn: LocalManager[] = []): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macChrome",
  managers,
  withdrawn,
})
const macEdgeBrave = (
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
const macSafari = (chromeTip?: "apple"): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macSafari",
  managers: ["1password"],
  withdrawn: [],
  ...(chromeTip ? { chromeTip } : {}),
})
/** The other-Chromium row of Windows or Linux: 1Password alone, Chrome tipped while it has GPM. */
const onePasswordOn = (
  os: "windows" | "linux",
  withdrawn: LocalManager[] = [],
  chromeTip: "gpm" | false = "gpm",
): LaptopCreation => ({
  local: true,
  os,
  row: os === "windows" ? "windowsEdgeBrave" : "linuxEdgeBrave",
  managers: ["1password"],
  withdrawn,
  ...(chromeTip ? { chromeTip } : {}),
})

describe("laptopCreationFor", () => {
  it("admits Apple on Mac Chrome at either floor, beside Google Password Manager and 1Password", () => {
    const expected = macChrome(["apple", "gpm", "1password"])
    for (const version of [MACOS_SYNCED_COPY_FLOORS.tahoe, "26.6.2", "27.0.1"]) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
    for (const version of [
      MACOS_SYNCED_COPY_FLOORS.sequoia,
      "15.7.9",
      "15.8",
      "15.8.1",
      "15.10.0",
    ]) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
  })

  /** Versions outside both ranges, and hinted versions the floor check cannot read. */
  const refused = [
    "26.4.0",
    "26.3.9",
    "26.3.0",
    "15.7.4",
    "15.7",
    "16.0.0",
    "25.9.9",
    "14.8.5",
    "15.7.5-beta",
    "15.7.5.1",
    " ",
  ]

  it("offers Mac Chrome without Apple outside the two ranges", () => {
    const expected = macChrome(["gpm", "1password"])
    for (const version of refused) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
  })

  it("offers Mac Edge and Brave Apple and 1Password at the floor, 1Password alone outside it", () => {
    for (const brand of [edge, brave, chromium]) {
      for (const version of ["26.4.1", "15.7.5", "15.8.1"]) {
        expect(laptopCreationFor(mac(version, brand))).toEqual(macEdgeBrave(["apple", "1password"]))
      }
      for (const version of refused) {
        expect(laptopCreationFor(mac(version, brand))).toEqual(
          macEdgeBrave(["1password"], [], "gpm"),
        )
      }
    }
  })

  it("offers Safari 26.4 and later 1Password alone, with the Apple Chrome tip", () => {
    for (const version of ["26.4", "26.4.1", "26.5", "27.0"]) {
      expect(laptopCreationFor(safari(version))).toEqual(macSafari("apple"))
    }
  })

  it("keeps Safari below 26.4 and Firefox on a Mac on phone creation with the Apple Chrome tip", () => {
    for (const version of ["26.0", "26.3", "18.6", "17.6"]) {
      expect(laptopCreationFor(safari(version))).toEqual(tipsApple)
    }
    expect(laptopCreationFor(parseUserAgent({ userAgent: MAC_FIREFOX_UA }))).toEqual(tipsApple)
  })

  it("offers Windows Chrome Google Password Manager and 1Password on any Windows", () => {
    const expected: LaptopCreation = {
      local: true,
      os: "windows",
      row: "windowsChrome",
      managers: ["gpm", "1password"],
      withdrawn: [],
    }
    for (const ua of [windows(), windows(chrome, "10.0.0")]) {
      expect(laptopCreationFor(ua)).toEqual(expected)
    }
  })

  it("offers another Chromium on Windows 1Password alone, with the Chrome tip", () => {
    for (const brand of [edge, brave, chromium, { brand: "Not Google Chrome", version: "155" }]) {
      expect(laptopCreationFor(windows(brand))).toEqual(onePasswordOn("windows"))
    }
  })

  it("keeps Firefox on Windows on phone creation with the Chrome tip", () => {
    const hinted = parseUserAgent({
      userAgent: WINDOWS_FIREFOX_UA,
      userAgentData: { platform: "Windows", platformVersion: "15.0.0" },
    })
    for (const ua of [hinted, parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA })]) {
      expect(laptopCreationFor(ua)).toEqual(tipsChrome)
    }
  })

  it("needs Client Hints for every row but Safari's, WebKit in a Mac's clothing included", () => {
    expect(laptopCreationFor(parseUserAgent({ userAgent: MAC_CHROME_UA }))).toEqual(phone)
    expect(laptopCreationFor(parseUserAgent({ userAgent: IPAD_CHROME_DESKTOP_UA }))).toEqual(phone)
    expect(
      laptopCreationFor(parseUserAgent({ userAgent: MAC_CHROME_UA, userAgentData: {} })),
    ).toEqual(phone)
    for (const userAgent of [WINDOWS_CHROME_UA, LINUX_CHROME_UA]) {
      expect(laptopCreationFor(parseUserAgent({ userAgent }))).toEqual(tipsChrome)
    }
    expect(
      laptopCreationFor(parseUserAgent({ userAgent: LINUX_CHROME_UA, userAgentData: {} })),
    ).toEqual(tipsChrome)
  })

  it("needs the version from the hints, not from the user-agent string", () => {
    // The string alone would admit; only the hints guard can send this Mac to the phone.
    const hinted = (brand: { brand: string; version: string }, platformVersion?: string) =>
      parseUserAgent({
        userAgent: MAC_CHROME_UA_UNFROZEN,
        userAgentData: {
          platform: "macOS",
          brands: [brand, { brand: "Chromium", version: "155" }],
          ...(platformVersion === undefined ? {} : { platformVersion }),
        },
      })
    expect(laptopCreationFor(hinted(chrome, "15.8.1"))).toEqual(
      macChrome(["apple", "gpm", "1password"]),
    )
    for (const brand of [chrome, edge, brave]) {
      expect(laptopCreationFor(hinted(brand))).toEqual(phone)
      expect(laptopCreationFor(hinted(brand, ""))).toEqual(phone)
    }
  })

  it("offers Linux Chrome Google Password Manager and 1Password on its platform claim, which carries no version", () => {
    expect(laptopCreationFor(linux())).toEqual({
      local: true,
      os: "linux",
      row: "linuxChrome",
      managers: ["gpm", "1password"],
      withdrawn: [],
    })
  })

  it("treats another Chromium on Linux as on Windows", () => {
    for (const brand of [edge, brave, chromium]) {
      expect(laptopCreationFor(linux(brand))).toEqual(onePasswordOn("linux"))
    }
  })

  it("keeps other systems on phone creation", () => {
    const chromeOs = parseUserAgent({
      userAgent: CROS_UA,
      userAgentData: { platformVersion: "6.1.0" },
    })
    const androidDesktop = parseUserAgent({
      userAgent: LINUX_CHROME_UA,
      userAgentData: { platform: "Android", platformVersion: "15.0.0" },
    })
    for (const ua of [chromeOs, androidDesktop]) {
      expect(laptopCreationFor(ua)).toEqual(phone)
    }
  })

  describe("withdrawal", () => {
    const withdrawing = (
      overrides: Partial<Record<keyof Withdrawn, LocalManager[]>>,
    ): Withdrawn => ({
      macChrome: [],
      macEdgeBrave: [],
      macSafari: [],
      windowsChrome: [],
      windowsEdgeBrave: [],
      linuxChrome: [],
      linuxEdgeBrave: [],
      ...overrides,
    })

    it("removes the manager from its row and names it", () => {
      for (const version of ["26.4.1", "15.8.1"]) {
        expect(laptopCreationFor(mac(version), withdrawing({ macChrome: ["gpm"] }))).toEqual(
          macChrome(["apple", "1password"], ["gpm"]),
        )
        expect(laptopCreationFor(mac(version), withdrawing({ macChrome: ["apple"] }))).toEqual(
          macChrome(["gpm", "1password"], ["apple"]),
        )
      }
      expect(laptopCreationFor(windows(), withdrawing({ windowsChrome: ["1password"] }))).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["gpm"],
        withdrawn: ["1password"],
      })
    })

    it("falls back to the phone when a row has no manager left", () => {
      expect(
        laptopCreationFor(mac("15.7.4"), withdrawing({ macChrome: ["gpm", "1password"] })),
      ).toEqual(phone)
      expect(
        laptopCreationFor(mac("26.4.1"), withdrawing({ macChrome: ["apple", "gpm", "1password"] })),
      ).toEqual(phone)
      expect(
        laptopCreationFor(windows(), withdrawing({ windowsChrome: ["gpm", "1password"] })),
      ).toEqual(phone)
    })

    it("offers a row left with 1Password alone, with the Chrome tip", () => {
      expect(laptopCreationFor(windows(), withdrawing({ windowsChrome: ["gpm"] }))).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["1password"],
        withdrawn: ["gpm"],
      })
      expect(
        laptopCreationFor(mac("26.4.1", edge), withdrawing({ macEdgeBrave: ["apple"] })),
      ).toEqual(macEdgeBrave(["1password"], ["apple"], "gpm"))
    })

    it("reads each row's own entry: Apple withdrawn from Chrome leaves Edge's managers alone", () => {
      expect(laptopCreationFor(mac("26.4.1", edge), withdrawing({ macChrome: ["apple"] }))).toEqual(
        macEdgeBrave(["apple", "1password"]),
      )
    })

    it("names in a Chrome tip only what that system's Chrome row still admits", () => {
      const noGpm = (key: "windowsChrome" | "linuxChrome" | "macChrome") =>
        withdrawing({ [key]: ["gpm"] })
      expect(laptopCreationFor(windows(edge), noGpm("windowsChrome"))).toEqual(
        onePasswordOn("windows", [], false),
      )
      expect(laptopCreationFor(linux(brave), noGpm("linuxChrome"))).toEqual(
        onePasswordOn("linux", [], false),
      )
      expect(laptopCreationFor(mac("26.3.0", edge), noGpm("macChrome"))).toEqual(
        macEdgeBrave(["1password"]),
      )
      expect(
        laptopCreationFor(
          mac("26.4.1", edge),
          withdrawing({ macChrome: ["gpm"], macEdgeBrave: ["apple"] }),
        ),
      ).toEqual(macEdgeBrave(["1password"], ["apple"]))
      expect(laptopCreationFor(safari(), withdrawing({ macChrome: ["apple"] }))).toEqual(
        macSafari(),
      )
    })

    it("points no other browser at a Chrome that has nothing to create in", () => {
      expect(
        laptopCreationFor(
          windows(edge),
          withdrawing({ windowsChrome: ["gpm"], windowsEdgeBrave: ["1password"] }),
        ),
      ).toEqual(phone)
      expect(
        laptopCreationFor(
          parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
          withdrawing({ windowsChrome: ["gpm"] }),
        ),
      ).toEqual(phone)
    })

    it("keeps the Chrome tip on the phone once 1Password is withdrawn from a row it had alone", () => {
      expect(
        laptopCreationFor(windows(edge), withdrawing({ windowsEdgeBrave: ["1password"] })),
      ).toEqual(tipsChrome)
      expect(
        laptopCreationFor(linux(brave), withdrawing({ linuxEdgeBrave: ["1password"] })),
      ).toEqual(tipsChrome)
      expect(laptopCreationFor(safari(), withdrawing({ macSafari: ["1password"] }))).toEqual(
        tipsApple,
      )
      expect(
        laptopCreationFor(mac("26.3.0", edge), withdrawing({ macEdgeBrave: ["1password"] })),
      ).toEqual(tipsChrome)
      // Chrome's own row is untouched by it.
      expect(
        laptopCreationFor(windows(), withdrawing({ windowsEdgeBrave: ["1password"] })),
      ).toMatchObject({ managers: ["gpm", "1password"] })
    })

    it("drops the Apple Chrome tip while Apple is withdrawn from Mac Chrome", () => {
      const noApple = withdrawing({ macChrome: ["apple"], macSafari: ["1password"] })
      expect(laptopCreationFor(safari(), noApple)).toEqual(phone)
      expect(laptopCreationFor(safari("26.0"), withdrawing({ macChrome: ["apple"] }))).toEqual(
        phone,
      )
    })

    it("ships with nothing withdrawn", () => {
      expect(WITHDRAWN).toEqual({
        macChrome: [],
        macEdgeBrave: [],
        macSafari: [],
        windowsChrome: [],
        windowsEdgeBrave: [],
        linuxChrome: [],
        linuxEdgeBrave: [],
      })
    })
  })
})

describe("currentLaptopCreation", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads no hints on a phone", async () => {
    const getHighEntropyValues = vi.fn()
    vi.stubGlobal("navigator", {
      userAgent: WINDOWS_CHROME_UA,
      userAgentData: { platform: "Windows", getHighEntropyValues },
    })
    expect(await currentLaptopCreation("phone")).toEqual(phone)
    expect(getHighEntropyValues).not.toHaveBeenCalled()
  })

  it("asks the live browser for the version", async () => {
    const getHighEntropyValues = vi.fn().mockResolvedValue({ platformVersion: "26.4.1" })
    vi.stubGlobal("navigator", {
      userAgent: MAC_CHROME_UA,
      userAgentData: {
        platform: "macOS",
        brands: [chrome, { brand: "Chromium", version: "155" }],
        getHighEntropyValues,
      },
    })
    expect(await currentLaptopCreation("laptop")).toEqual(macChrome(["apple", "gpm", "1password"]))
    expect(getHighEntropyValues).toHaveBeenCalledWith(["platformVersion", "architecture"])
  })

  it("keeps the phone route when the hints request rejects", async () => {
    const getHighEntropyValues = vi.fn().mockRejectedValue(new Error("denied"))
    vi.stubGlobal("navigator", {
      userAgent: MAC_CHROME_UA_UNFROZEN,
      userAgentData: {
        platform: "macOS",
        brands: [chrome, { brand: "Chromium", version: "155" }],
        getHighEntropyValues,
      },
    })
    expect(await currentLaptopCreation("laptop")).toEqual(phone)
  })

  it("offers Safari its row from the user-agent string alone", async () => {
    vi.stubGlobal("navigator", { userAgent: MAC_SAFARI_UA })
    expect(await currentLaptopCreation("laptop")).toEqual(macSafari("apple"))
  })
})
