import {
  APPLE_ICLOUD_AAGUID,
  GPM_AAGUID,
  ONEPASSWORD_AAGUID,
  SECURITY_KEY_AAGUIDS,
  ZERO_AAGUID,
} from "@obsidion/core/constants"
import { describe, expect, it } from "vitest"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"
import {
  CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
  type CreationRoute,
  LOCAL_MANAGER_NAMES,
  PASSKEY_MANAGER_AAGUIDS,
  PROTON_PASS,
  PROTON_PASS_AAGUID,
  SAMSUNG_PASS_AAGUID,
  WINDOWS_HELLO as WINDOWS_HELLO_NAME,
  localManagerFor,
  localManagersClause,
  localProviderVerdict,
  protonPassAdmitted,
  providerAllowed,
  providerNameFor,
  providerSlugFor,
  refusalKindFor,
  semiDeviceBound,
} from "../../src/rules/passkeyProviders.js"
import type { OsFamily } from "../../src/browser/userAgentInfo.js"

const BRAVE = "b5397666-4885-aa6b-cebf-e52262a439a2"
const WINDOWS_HELLO = "08987058-cadc-4b81-b6e1-30de50dcbe96"
const UNMEASURED = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
const A_KEY = [...SECURITY_KEY_AAGUIDS][0]!

describe("localProviderVerdict", () => {
  it("admits a manager on the row, by its id, whatever its case", () => {
    expect(localProviderVerdict(GPM_AAGUID.toUpperCase(), ["apple", "gpm"])).toBe("admitted")
  })

  it("refuses a missing or all-zero id, unlike the provider gate", () => {
    expect(localProviderVerdict(undefined, ["apple", "gpm"])).toBe("unnamed")
    expect(localProviderVerdict(ZERO_AAGUID, ["apple", "gpm"])).toBe("unnamed")
  })

  it("names Apple when the row leaves it out, and anything else as unsupported", () => {
    expect(localProviderVerdict(APPLE_ICLOUD_AAGUID, ["gpm"])).toBe("apple")
    expect(localProviderVerdict(GPM_AAGUID, ["apple"])).toBe("unsupported")
    expect(localProviderVerdict(WINDOWS_HELLO, ["gpm"])).toBe("unsupported")
    expect(localProviderVerdict(PROTON_PASS_AAGUID, ["gpm", "1password"])).toBe("unsupported")
  })

  it("admits Proton Pass on a row that names it", () => {
    expect(localProviderVerdict(PROTON_PASS_AAGUID, ["gpm", "proton"])).toBe("admitted")
  })

  it("admits the browser-test id through the extra list", () => {
    expect(localProviderVerdict(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, ["gpm"])).toBe("unsupported")
    expect(
      localProviderVerdict(
        CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID,
        ["gpm"],
        [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID],
      ),
    ).toBe("admitted")
  })
})

describe("localManagerFor", () => {
  it("names the manager an id belongs to, whatever its case, and none for any other id", () => {
    expect(localManagerFor(ONEPASSWORD_AAGUID)).toBe("1password")
    expect(localManagerFor(GPM_AAGUID.toUpperCase())).toBe("gpm")
    expect(localManagerFor(APPLE_ICLOUD_AAGUID)).toBe("apple")
    expect(localManagerFor(PROTON_PASS_AAGUID)).toBe("proton")
    expect(localManagerFor(undefined)).toBeUndefined()
    expect(localManagerFor(A_KEY)).toBeUndefined()
  })
})

describe("protonPassAdmitted", () => {
  const row = ["gpm", "1password", "proton"] as const

  it("admits the sheet's Proton Pass pick on a laptop row that names it, and nothing else there", () => {
    expect(
      protonPassAdmitted({ posture: "laptop", localManagers: row, extensionAllowed: true }),
    ).toBe(true)
    expect(protonPassAdmitted({ posture: "laptop", localManagers: row })).toBe(false)
    expect(
      protonPassAdmitted({
        posture: "laptop",
        localManagers: ["gpm", "1password"],
        extensionAllowed: true,
      }),
    ).toBe(false)
    for (const osFamily of ["macos", "android", undefined] as const) {
      expect(protonPassAdmitted({ posture: "laptop", osFamily, extensionAllowed: true })).toBe(
        false,
      )
    }
  })

  it("admits a phone's own Proton Pass on every known OS but iOS", () => {
    const admitted: OsFamily[] = ["android", "macos", "windows", "linux", "chromeos"]
    for (const osFamily of admitted) {
      expect(protonPassAdmitted({ posture: "phone", osFamily })).toBe(true)
    }
    expect(protonPassAdmitted({ posture: "phone", osFamily: "ios" })).toBe(false)
    expect(protonPassAdmitted({ posture: "phone", osFamily: "unknown" })).toBe(false)
    expect(protonPassAdmitted({ posture: "phone" })).toBe(false)
  })

  it("refuses on a build that withdraws Proton Pass, on either posture", () => {
    const withdrawn = ["windows_hello", "proton"] as const
    expect(protonPassAdmitted({ posture: "phone", osFamily: "android", withdrawn })).toBe(false)
    expect(
      protonPassAdmitted({
        posture: "laptop",
        localManagers: row,
        extensionAllowed: true,
        withdrawn,
      }),
    ).toBe(false)
    expect(
      protonPassAdmitted({ posture: "phone", osFamily: "android", withdrawn: ["windows_hello"] }),
    ).toBe(true)
  })
})

describe("semiDeviceBound", () => {
  it("is true for Proton Pass's id alone", () => {
    expect(semiDeviceBound(PROTON_PASS_AAGUID)).toBe(true)
    expect(semiDeviceBound(PROTON_PASS_AAGUID.toUpperCase())).toBe(true)
    for (const id of [GPM_AAGUID, WINDOWS_HELLO, ONEPASSWORD_AAGUID, ZERO_AAGUID, undefined]) {
      expect(semiDeviceBound(id)).toBe(false)
    }
  })
})

describe("localManagersClause", () => {
  it("names the managers in order", () => {
    const managers = ["apple", "gpm", "1password"] as const
    const clause = localManagersClause(managers)
    const at = managers.map((m) => clause.indexOf(LOCAL_MANAGER_NAMES[m]))
    expect(at).not.toContain(-1)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(localManagersClause(["gpm"])).toBe(LOCAL_MANAGER_NAMES.gpm)
    expect(localManagersClause([])).not.toBe("")
  })
})

describe("providerAllowed", () => {
  it("admits every measured manager to a phone passkey", () => {
    for (const id of [APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID]) {
      expect(providerAllowed(id, false)).toBe(true)
    }
    expect(providerAllowed(APPLE_ICLOUD_AAGUID.toUpperCase(), false)).toBe(true)
  })

  it("admits every measured security key to a key", () => {
    for (const id of SECURITY_KEY_AAGUIDS) expect(providerAllowed(id, true)).toBe(true)
  })

  it("admits an absent or all-zero id to either class", () => {
    for (const securityKey of [true, false]) {
      expect(providerAllowed(undefined, securityKey)).toBe(true)
      expect(providerAllowed(ZERO_AAGUID, securityKey)).toBe(true)
    }
  })

  it("refuses an id that contradicts the class that answered", () => {
    // A manager id on a hardware key, or a key's id on a phone passkey: one of the two is lying.
    expect(providerAllowed(GPM_AAGUID, true)).toBe(false)
    expect(providerAllowed(A_KEY, false)).toBe(false)
  })

  it("refuses an unmeasured provider to either class", () => {
    for (const securityKey of [true, false]) {
      expect(providerAllowed(UNMEASURED, securityKey)).toBe(false)
    }
  })

  it("leaves Proton Pass to its own rule", () => {
    expect(providerAllowed(PROTON_PASS_AAGUID, false)).toBe(false)
  })

  it("admits an id the caller lists on top of the measured set", () => {
    const extra = [CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID]
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, false)).toBe(false)
    expect(providerAllowed(CHROMIUM_VIRTUAL_AUTHENTICATOR_AAGUID, false, extra)).toBe(true)
    expect(providerAllowed(UNMEASURED, false, extra)).toBe(false)
    // Ids arrive from a parser that emits lowercase, but a caller's list is hand-written.
    expect(providerAllowed(UNMEASURED, false, [UNMEASURED.toUpperCase()])).toBe(true)
  })

  describe("Samsung Pass, admitted only on its own Android phone", () => {
    const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko)"
    const chromeAndroid = parseUserAgent({
      userAgent: `${ANDROID} Chrome/155.0.0.0 Mobile Safari/537.36`,
      userAgentData: {
        platform: "Android",
        brands: [
          { brand: "Chromium", version: "155" },
          { brand: "Google Chrome", version: "155" },
        ],
      },
    })
    const samsungInternet = parseUserAgent({
      userAgent: `${ANDROID} SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36`,
      userAgentData: {
        platform: "Android",
        brands: [
          { brand: "Samsung Internet", version: "28.0" },
          { brand: "Chromium", version: "130" },
        ],
      },
    })
    // A Chromium fork that names no brand reads as Chrome from the string alone.
    const unbrandedChromium = parseUserAgent({
      userAgent: `${ANDROID} Chrome/155.0.0.0 Mobile Safari/537.36`,
    })
    const edgeAndroid = parseUserAgent({
      userAgent: `${ANDROID} Chrome/155.0.0.0 Mobile Safari/537.36 EdgA/155.0.0.0`,
      userAgentData: {
        platform: "Android",
        brands: [
          { brand: "Chromium", version: "155" },
          { brand: "Microsoft Edge", version: "155" },
        ],
      },
    })
    const braveAndroid = parseUserAgent({
      userAgent: `${ANDROID} Chrome/155.0.0.0 Mobile Safari/537.36`,
      userAgentData: {
        platform: "Android",
        brands: [
          { brand: "Chromium", version: "155" },
          { brand: "Brave", version: "155" },
        ],
      },
    })
    const firefoxAndroid = parseUserAgent({
      userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
    })
    const unnamedAndroid = parseUserAgent({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko)",
    })
    const iphone = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    })
    const empty = parseUserAgent({ userAgent: "" })
    const chromeMac = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
      userAgentData: { platform: "macOS", brands: [{ brand: "Google Chrome", version: "155" }] },
    })
    const phone = (userAgent: CreationRoute["userAgent"]): CreationRoute => ({
      posture: "phone",
      attachment: "platform",
      userAgent,
    })
    const overQr: CreationRoute = {
      posture: "laptop",
      attachment: "cross-platform",
      userAgent: chromeMac,
    }

    it("in every Android phone browser", () => {
      const browsers = [
        chromeAndroid,
        samsungInternet,
        unbrandedChromium,
        edgeAndroid,
        braveAndroid,
        firefoxAndroid,
        unnamedAndroid,
      ]
      expect(browsers.map((ua) => ua.browserFamily)).toEqual([
        "chrome",
        "samsung",
        "chrome",
        "edge",
        "brave",
        "firefox",
        "unknown",
      ])
      for (const ua of browsers) {
        expect(ua.osFamily).toBe("android")
        expect(providerAllowed(SAMSUNG_PASS_AAGUID, false, [], phone(ua))).toBe(true)
      }
      expect(
        providerAllowed(SAMSUNG_PASS_AAGUID.toUpperCase(), false, [], phone(chromeAndroid)),
      ).toBe(true)
    })

    it("refused over QR, in any laptop browser", () => {
      for (const userAgent of [chromeMac, undefined]) {
        const route: CreationRoute = { ...overQr, userAgent }
        expect(providerAllowed(SAMSUNG_PASS_AAGUID, false, [], route)).toBe(false)
      }
    })

    it("refused on a phone that isn't Android or made no claims", () => {
      expect(empty.osFamily).toBe("unknown")
      for (const ua of [iphone, empty, undefined]) {
        expect(providerAllowed(SAMSUNG_PASS_AAGUID, false, [], phone(ua))).toBe(false)
      }
    })

    it("refused as a laptop's own passkey, as a key's id, another device's on a phone, and with no route", () => {
      const laptopLocal: CreationRoute = { ...overQr, attachment: "platform" }
      expect(providerAllowed(SAMSUNG_PASS_AAGUID, false, [], laptopLocal)).toBe(false)
      expect(providerAllowed(SAMSUNG_PASS_AAGUID, true, [], phone(chromeAndroid))).toBe(false)
      for (const attachment of [undefined, "cross-platform"] as const) {
        expect(
          providerAllowed(SAMSUNG_PASS_AAGUID, false, [], { ...phone(chromeAndroid), attachment }),
        ).toBe(false)
      }
      // The backup gate asks with no route; its own candidates admit Samsung Pass there.
      expect(providerAllowed(SAMSUNG_PASS_AAGUID, false)).toBe(false)
    })

    it("admits no other unmeasured manager on those routes", () => {
      expect(providerAllowed(UNMEASURED, false, [], phone(chromeAndroid))).toBe(false)
      expect(providerAllowed(UNMEASURED, false, [], overQr)).toBe(false)
    })
  })
})

describe("refusalKindFor", () => {
  it("follows the class when the class is certain", () => {
    expect(refusalKindFor(undefined, true)).toBe("security-key")
    expect(refusalKindFor(UNMEASURED, false)).toBe("manager")
  })

  it("follows the id when a key was named but its transports were withheld", () => {
    // Classed as a phone (no transports) but the orphan is on the key, so the key's advice wins.
    expect(refusalKindFor(A_KEY, false)).toBe("security-key")
    expect(refusalKindFor(A_KEY.toUpperCase(), false)).toBe("security-key")
  })
})

describe("providerNameFor", () => {
  it("never invents a name for an id it does not know, nor for zeros", () => {
    expect(providerNameFor(UNMEASURED)).toBeUndefined()
    expect(providerNameFor(ZERO_AAGUID)).toBeUndefined()
    expect(providerNameFor(undefined)).toBeUndefined()
    expect(providerNameFor("constructor")).toBeUndefined()
  })

  it("can name everything it admits", () => {
    for (const id of [...PASSKEY_MANAGER_AAGUIDS, SAMSUNG_PASS_AAGUID, ...SECURITY_KEY_AAGUIDS]) {
      expect(providerNameFor(id)).toBeTruthy()
    }
  })

  it("gives Windows Hello and Proton Pass the names their refusal copy keys on", () => {
    expect(providerNameFor(WINDOWS_HELLO)).toBe(WINDOWS_HELLO_NAME)
    expect(providerNameFor(PROTON_PASS_AAGUID)).toBe(PROTON_PASS)
  })
})

describe("providerSlugFor", () => {
  it("counts each named provider under its slug", () => {
    expect(providerSlugFor(APPLE_ICLOUD_AAGUID.toUpperCase())).toBe("icloud_keychain")
  })

  it("counts every measured security key as a YubiKey", () => {
    for (const id of SECURITY_KEY_AAGUIDS) expect(providerSlugFor(id)).toBe("yubikey")
  })

  it("tells a provider that did not report itself from one that said nothing", () => {
    expect(providerSlugFor(ZERO_AAGUID)).toBe("not_reported")
    expect(providerSlugFor(undefined)).toBe("unknown")
    expect(providerSlugFor("unknown")).toBe("unknown")
  })

  it("counts an id it cannot name, or names without a slug, as another provider", () => {
    expect(providerSlugFor(UNMEASURED)).toBe("other")
    expect(providerSlugFor(BRAVE)).toBe("other")
  })
})
