// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type LaptopCreation,
  type LocalManager,
  WITHDRAWN,
  currentLaptopCreation,
  laptopCreationFor,
  withoutManager,
} from "../../src/rules/laptopCreation.js"
import { MACOS_APPLE_PRF_FLOOR, parseUserAgent } from "../../src/browser/userAgentInfo.js"
import {
  ANDROID_FIREFOX_UA,
  FIREFOX_ADMITTED,
  LINUX_CHROME_UA,
  LINUX_FIREFOX_UA,
  MAC_CHROME_UA,
  WINDOWS_CHROME_UA,
  WINDOWS_FIREFOX_UA,
  brave,
  chrome,
  edge,
  firefox,
  linux,
  mac,
  macEdgeBrave,
  macFirefox,
  macSafari,
  macSafariUa,
  phone,
  safari,
  windows,
  withdrawing,
} from "../support/laptopRows.js"

/** A Chrome whose user-agent string alone would admit Apple: real Chrome freezes it at 10_15_7. */
const MAC_CHROME_UA_UNFROZEN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_8_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const CROS_FIREFOX_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0; rv:139.0) Gecko/20100101 Firefox/139.0"
const MAC_SAFARI_UA = macSafariUa("26.4")
/** A Firefox fork that appends its own token reads as Firefox. */
const WATERFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0 Waterfox/6.5.0"
const IPAD_CHROME_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.8037.55 Safari/604.1"

/** A Chromium that carries no brand of its own: Chrome only by its user-agent token. */
const chromium = { brand: "Chromium", version: "155" }

/** Phone creation, with the line saying Chrome can create here in Google Password Manager. */
const tipsChrome: LaptopCreation = { local: false, chromeTip: "gpm" }
const macChrome = (managers: LocalManager[], withdrawn: LocalManager[] = []): LaptopCreation => ({
  local: true,
  os: "macos",
  row: "macChrome",
  managers,
  withdrawn,
})
/**
 * The other-Chromium row of Windows or Linux: the extensions alone, Chrome tipped while it has GPM.
 */
const extensionsOn = (
  os: "windows" | "linux",
  withdrawn: LocalManager[] = [],
  chromeTip: "gpm" | false = "gpm",
): LaptopCreation => ({
  local: true,
  os,
  row: os === "windows" ? "windowsEdgeBrave" : "linuxEdgeBrave",
  managers: ["1password", "proton"],
  withdrawn,
  ...(chromeTip ? { chromeTip } : {}),
})
/** The other-Chromium row of Windows 11: Windows Hello and the extensions, Chrome tipped while it has GPM. */
const helloOn = (chromeTip: "gpm" | false = "gpm"): LaptopCreation => ({
  local: true,
  os: "windows",
  row: "windowsEdgeBrave",
  managers: ["windows_hello", "1password", "proton"],
  withdrawn: [],
  ...(chromeTip ? { chromeTip } : {}),
})
/**
 * Firefox's row of Windows or Linux with nothing withdrawn: the extensions, with Windows Hello first
 * on Windows, Chrome tipped while it has GPM.
 */
const firefoxOn = (os: "windows" | "linux", chromeTip: "gpm" | false = "gpm"): LaptopCreation => ({
  local: true,
  os,
  row: os === "windows" ? "windowsFirefox" : "linuxFirefox",
  managers: os === "windows" ? ["windows_hello", "1password", "proton"] : ["1password", "proton"],
  withdrawn: [],
  ...(chromeTip ? { chromeTip } : {}),
})
/** Firefox's Windows row as shipped: Windows Hello alone, its extensions withdrawn. */
const FIREFOX_WINDOWS: LaptopCreation = {
  local: true,
  os: "windows",
  row: "windowsFirefox",
  managers: ["windows_hello"],
  withdrawn: ["1password", "proton"],
  chromeTip: "gpm",
}

describe("laptopCreationFor", () => {
  /** macOS 15 and later, the synced-copy floors' inside and outside alike. */
  const admitted = [MACOS_APPLE_PRF_FLOOR, "15.7.4", "26.3.9", "27.0.1"]

  it("admits Apple on Mac Chrome from macOS 15, beside Google Password Manager, 1Password and Proton Pass", () => {
    const expected = macChrome(["apple", "gpm", "1password", "proton"])
    for (const version of admitted) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
  })

  /** Versions before macOS 15, and hinted versions the floor check cannot read. */
  const refused = ["14.9.9", "15.0-beta"]

  it("offers Mac Chrome without Apple before macOS 15", () => {
    const expected = macChrome(["gpm", "1password", "proton"])
    for (const version of refused) {
      expect(laptopCreationFor(mac(version))).toEqual(expected)
    }
  })

  it("offers Mac Edge and Brave Apple and the extensions from macOS 15, the extensions alone before it", () => {
    for (const brand of [edge, brave, chromium]) {
      expect(laptopCreationFor(mac("15.0", brand))).toEqual(
        macEdgeBrave(["apple", "1password", "proton"]),
      )
      for (const version of refused) {
        expect(laptopCreationFor(mac(version, brand))).toEqual(
          macEdgeBrave(["1password", "proton"], [], "gpm"),
        )
      }
    }
  })

  it("offers Safari 26.4 and later Apple Passwords, 1Password and Proton Pass", () => {
    for (const version of ["26.4", "27.0"]) {
      expect(laptopCreationFor(safari(version))).toEqual(macSafari())
    }
  })

  it("offers Firefox 153 and later on a Mac Apple Passwords and 1Password, Proton Pass withdrawn", () => {
    expect(laptopCreationFor(firefox("153.0"))).toEqual(macFirefox())
  })

  it("keeps Safari below 26.4 and Firefox below 153 on a Mac on phone creation", () => {
    expect(laptopCreationFor(safari("26.3"))).toEqual(phone)
    expect(laptopCreationFor(firefox("152.0"))).toEqual(phone)
  })

  it("offers Chrome on Windows 11 Google Password Manager, Windows Hello, 1Password and Proton Pass", () => {
    expect(laptopCreationFor(windows())).toEqual({
      local: true,
      os: "windows",
      row: "windowsChrome",
      managers: ["gpm", "windows_hello", "1password", "proton"],
      withdrawn: [],
    })
  })

  it("keeps Windows Hello off Chrome on Windows 10, and marks the row so the sheet says why", () => {
    expect(laptopCreationFor(windows(chrome, "10.0.0"))).toEqual({
      local: true,
      os: "windows",
      row: "windowsChrome",
      managers: ["gpm", "1password", "proton"],
      withdrawn: [],
      windows10: true,
    })
  })

  it("offers another Chromium on Windows 11 Windows Hello and the extensions, with the Chrome tip", () => {
    for (const brand of [edge, brave, chromium]) {
      expect(laptopCreationFor(windows(brand))).toEqual(helloOn())
    }
  })

  it("keeps Windows Hello off another Chromium on Windows 10 or without hints, with no Windows 10 mark", () => {
    for (const brand of [edge, brave, chromium]) {
      expect(laptopCreationFor(windows(brand, "10.0.0"))).toEqual(extensionsOn("windows"))
    }
    expect(laptopCreationFor(parseUserAgent({ userAgent: WINDOWS_CHROME_UA }))).toEqual(tipsChrome)
  })

  it("lists Windows Hello on no Linux or Mac row", () => {
    const others = [
      linux(),
      linux(brave),
      parseUserAgent({ userAgent: LINUX_FIREFOX_UA }),
      mac("26.4.1"),
      mac("26.4.1", edge),
      safari(),
      firefox("155.0"),
    ]
    for (const ua of others) {
      for (const withdrawn of [WITHDRAWN, FIREFOX_ADMITTED]) {
        const creation = laptopCreationFor(ua, withdrawn)
        expect(creation.local && creation.managers).not.toContain("windows_hello")
      }
    }
  })

  it("offers Firefox on Windows Windows Hello and the extensions, on Linux the extensions, from its user-agent string", () => {
    // Firefox sends no Client Hints; a Windows 10 claim in them changes nothing.
    const hinted = (platformVersion: string) =>
      parseUserAgent({
        userAgent: WINDOWS_FIREFOX_UA,
        userAgentData: { platform: "Windows", platformVersion },
      })
    for (const ua of [
      hinted("15.0.0"),
      hinted("10.0.0"),
      parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
    ]) {
      expect(laptopCreationFor(ua, FIREFOX_ADMITTED)).toEqual(firefoxOn("windows"))
    }
    expect(
      laptopCreationFor(parseUserAgent({ userAgent: LINUX_FIREFOX_UA }), FIREFOX_ADMITTED),
    ).toEqual(firefoxOn("linux"))
  })

  it("puts Firefox forks on Firefox's rows, and neither a phone's Firefox nor ChromeOS on Linux's", () => {
    expect(laptopCreationFor(parseUserAgent({ userAgent: WATERFOX_UA }), FIREFOX_ADMITTED)).toEqual(
      firefoxOn("windows"),
    )
    expect(laptopCreationFor(parseUserAgent({ userAgent: ANDROID_FIREFOX_UA }))).toEqual(phone)
    for (const userAgent of [CROS_UA, CROS_FIREFOX_UA]) {
      expect(laptopCreationFor(parseUserAgent({ userAgent }))).toEqual(phone)
    }
  })

  it("needs Client Hints for every row but Safari's, WebKit in a Mac's clothing included", () => {
    expect(laptopCreationFor(parseUserAgent({ userAgent: MAC_CHROME_UA }))).toEqual(phone)
    expect(laptopCreationFor(parseUserAgent({ userAgent: IPAD_CHROME_DESKTOP_UA }))).toEqual(phone)
    for (const userAgent of [WINDOWS_CHROME_UA, LINUX_CHROME_UA]) {
      expect(laptopCreationFor(parseUserAgent({ userAgent }))).toEqual(tipsChrome)
    }
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
      macChrome(["apple", "gpm", "1password", "proton"]),
    )
    for (const brand of [chrome, edge]) {
      expect(laptopCreationFor(hinted(brand))).toEqual(phone)
    }
  })

  it("offers Linux Chrome Google Password Manager and the extensions on its platform claim, which carries no version", () => {
    expect(laptopCreationFor(linux())).toEqual({
      local: true,
      os: "linux",
      row: "linuxChrome",
      managers: ["gpm", "1password", "proton"],
      withdrawn: [],
    })
  })

  it("treats another Chromium on Linux as on Windows", () => {
    expect(laptopCreationFor(linux(brave))).toEqual(extensionsOn("linux"))
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
    it("removes the manager from its row and names it", () => {
      expect(laptopCreationFor(mac("26.4.1"), withdrawing({ macChrome: ["gpm"] }))).toEqual(
        macChrome(["apple", "1password", "proton"], ["gpm"]),
      )
      expect(laptopCreationFor(mac("26.4.1"), withdrawing({ macChrome: ["apple"] }))).toEqual(
        macChrome(["gpm", "1password", "proton"], ["apple"]),
      )
      expect(laptopCreationFor(windows(), withdrawing({ windowsChrome: ["1password"] }))).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["gpm", "windows_hello", "proton"],
        withdrawn: ["1password"],
      })
      expect(
        laptopCreationFor(windows(), withdrawing({ windowsChrome: ["windows_hello"] })),
      ).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["gpm", "1password", "proton"],
        withdrawn: ["windows_hello"],
      })
      expect(laptopCreationFor(windows(), withdrawing({ windowsChrome: ["proton"] }))).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["gpm", "windows_hello", "1password"],
        withdrawn: ["proton"],
      })
    })

    it("falls back to the phone when a row has no manager left", () => {
      expect(
        laptopCreationFor(
          mac("26.4.1"),
          withdrawing({ macChrome: ["apple", "gpm", "1password", "proton"] }),
        ),
      ).toEqual(phone)
    })

    it("offers a row left with the extensions alone, with the Chrome tip", () => {
      expect(
        laptopCreationFor(windows(), withdrawing({ windowsChrome: ["gpm", "windows_hello"] })),
      ).toEqual({
        local: true,
        os: "windows",
        row: "windowsChrome",
        managers: ["1password", "proton"],
        withdrawn: ["gpm", "windows_hello"],
      })
      expect(
        laptopCreationFor(mac("26.4.1", edge), withdrawing({ macEdgeBrave: ["apple"] })),
      ).toEqual(macEdgeBrave(["1password", "proton"], ["apple"], "gpm"))
    })

    it("reads each row's own entry: Apple withdrawn from Chrome leaves Edge's managers alone", () => {
      expect(laptopCreationFor(mac("26.4.1", edge), withdrawing({ macChrome: ["apple"] }))).toEqual(
        macEdgeBrave(["apple", "1password", "proton"]),
      )
    })

    it("names in a Chrome tip only what that system's Chrome row still admits", () => {
      const noGpm = (key: "windowsChrome" | "linuxChrome" | "macChrome") =>
        withdrawing({ [key]: ["gpm"] })
      expect(laptopCreationFor(windows(edge), noGpm("windowsChrome"))).toEqual(helloOn(false))
      expect(laptopCreationFor(windows(edge, "10.0.0"), noGpm("windowsChrome"))).toEqual(
        extensionsOn("windows", [], false),
      )
      expect(
        laptopCreationFor(
          parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
          noGpm("windowsChrome"),
        ),
      ).toEqual(firefoxOn("windows", false))
      expect(laptopCreationFor(mac("14.6", edge), noGpm("macChrome"))).toEqual(
        macEdgeBrave(["1password", "proton"]),
      )
    })

    it("points no other browser at a Chrome that has nothing to create in", () => {
      expect(
        laptopCreationFor(
          windows(edge),
          withdrawing({
            windowsChrome: ["gpm"],
            windowsEdgeBrave: ["windows_hello", "1password", "proton"],
          }),
        ),
      ).toEqual(phone)
      expect(
        laptopCreationFor(
          parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
          withdrawing({
            windowsChrome: ["gpm"],
            windowsFirefox: ["windows_hello", "1password", "proton"],
          }),
        ),
      ).toEqual(phone)
    })

    it("keeps the Chrome tip on the phone once the extensions are withdrawn from a row they had alone", () => {
      expect(
        laptopCreationFor(
          windows(edge, "10.0.0"),
          withdrawing({ windowsEdgeBrave: ["1password", "proton"] }),
        ),
      ).toEqual(tipsChrome)
      expect(
        laptopCreationFor(
          windows(edge),
          withdrawing({ windowsEdgeBrave: ["1password", "proton"] }),
        ),
      ).toEqual({ ...helloOn(), managers: ["windows_hello"], withdrawn: ["1password", "proton"] })
      expect(
        laptopCreationFor(
          mac("14.6", edge),
          withdrawing({ macEdgeBrave: ["1password", "proton"] }),
        ),
      ).toEqual(tipsChrome)
      // Chrome's own row is untouched by it.
      expect(
        laptopCreationFor(windows(), withdrawing({ windowsEdgeBrave: ["1password", "proton"] })),
      ).toMatchObject({ managers: ["gpm", "windows_hello", "1password", "proton"] })
    })

    it("gives Safari and Firefox on a Mac no Chrome tip", () => {
      expect(
        laptopCreationFor(safari(), withdrawing({ macSafari: ["apple", "1password", "proton"] })),
      ).toEqual(phone)
      expect(
        laptopCreationFor(
          firefox("155.0"),
          withdrawing({ macFirefox: ["apple", "1password", "proton"] }),
        ),
      ).toEqual(phone)
    })

    it("turns Safari and Firefox on a Mac back to the extensions alone once Apple is withdrawn", () => {
      expect(laptopCreationFor(safari(), withdrawing({ macSafari: ["apple"] }))).toEqual(
        macSafari(["1password", "proton"], ["apple"]),
      )
      expect(laptopCreationFor(firefox("155.0"), withdrawing({ macFirefox: ["apple"] }))).toEqual(
        macFirefox(["1password", "proton"], ["apple"]),
      )
    })

    it("ships with 1Password withdrawn from Firefox on Windows, admitted on Linux, and Proton Pass withdrawn on both", () => {
      expect(laptopCreationFor(parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }))).toEqual(
        FIREFOX_WINDOWS,
      )
      expect(laptopCreationFor(parseUserAgent({ userAgent: LINUX_FIREFOX_UA }))).toEqual({
        ...firefoxOn("linux"),
        managers: ["1password"],
        withdrawn: ["proton"],
      })
    })

    it("offers 1Password through the Mac's window alone on Firefox's Mac row", () => {
      expect(laptopCreationFor(firefox("155.0"))).toMatchObject({ extensionWithdrawn: true })
      expect(laptopCreationFor(safari())).not.toHaveProperty("extensionWithdrawn")
      expect(
        laptopCreationFor(firefox("155.0"), withdrawing({ macFirefox: ["1password"] })),
      ).not.toHaveProperty("extensionWithdrawn")
    })
  })
})

describe("currentLaptopCreation", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps a phone on phone creation", async () => {
    // A laptop would get the Chrome tip here.
    vi.stubGlobal("navigator", {
      userAgent: WINDOWS_CHROME_UA,
      userAgentData: { platform: "Windows", getHighEntropyValues: async () => ({}) },
    })
    expect(await currentLaptopCreation("phone")).toEqual(phone)
  })

  it("reads the version from the live browser's hints", async () => {
    vi.stubGlobal("navigator", {
      userAgent: MAC_CHROME_UA,
      userAgentData: {
        platform: "macOS",
        brands: [chrome, { brand: "Chromium", version: "155" }],
        getHighEntropyValues: async () => ({ platformVersion: "26.4.1" }),
      },
    })
    expect(await currentLaptopCreation("laptop")).toEqual(
      macChrome(["apple", "gpm", "1password", "proton"]),
    )
  })

  it("keeps the phone route when the hints request rejects", async () => {
    vi.stubGlobal("navigator", {
      userAgent: MAC_CHROME_UA_UNFROZEN,
      userAgentData: {
        platform: "macOS",
        brands: [chrome, { brand: "Chromium", version: "155" }],
        getHighEntropyValues: () => Promise.reject(new Error("denied")),
      },
    })
    expect(await currentLaptopCreation("laptop")).toEqual(phone)
  })

  it("offers Safari its row from the user-agent string alone", async () => {
    vi.stubGlobal("navigator", { userAgent: MAC_SAFARI_UA })
    expect(await currentLaptopCreation("laptop")).toEqual(macSafari())
  })
})

describe("withoutManager", () => {
  it("takes the manager off the row", () => {
    expect(withoutManager(macChrome(["apple", "gpm", "1password", "proton"]), "apple")).toEqual(
      macChrome(["gpm", "1password", "proton"]),
    )
    expect(withoutManager(macChrome(["apple", "gpm", "1password", "proton"]), "proton")).toEqual(
      macChrome(["apple", "gpm", "1password"]),
    )
  })

  it("falls back to the phone when the row has nothing left", () => {
    expect(withoutManager(macFirefox(["1password"]), "1password")).toEqual(phone)
    expect(withoutManager(macEdgeBrave(["1password"], [], "gpm"), "1password")).toEqual(tipsChrome)
  })

  it("keeps the Chrome tip where a build takes Windows Hello and Proton Pass off a Windows row", () => {
    const strip = (creation: LaptopCreation) =>
      withoutManager(withoutManager(creation, "windows_hello"), "proton")
    expect(strip(laptopCreationFor(windows(edge)))).toEqual({
      ...extensionsOn("windows"),
      managers: ["1password"],
    })
    expect(strip(laptopCreationFor(parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA })))).toEqual(
      tipsChrome,
    )
    expect(
      strip(laptopCreationFor(windows(edge), withdrawing({ windowsChrome: ["gpm"] }))),
    ).toEqual({ ...extensionsOn("windows", [], false), managers: ["1password"] })
  })

  it("leaves a row without the manager, and phone creation, as they are", () => {
    const row = macChrome(["gpm", "1password"])
    expect(withoutManager(row, "apple")).toBe(row)
    expect(withoutManager(phone, "apple")).toBe(phone)
  })
})
