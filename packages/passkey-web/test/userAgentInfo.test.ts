// @vitest-environment node
import { describe, expect, it } from "vitest"
import { iosBelowFloor, parseUserAgent, versionBelow } from "../src/policy/userAgentInfo.js"

const cases: [string, string, ReturnType<typeof parseUserAgent>][] = [
  [
    "Safari on macOS reports the frozen 10.15.7",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    {
      osFamily: "macos",
      osVersionReported: "10.15.7",
      browserFamily: "safari",
      browserVersionReported: "26.0",
    },
  ],
  [
    "Safari 26 on iOS reports 18.6",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    {
      osFamily: "ios",
      osVersionReported: "18.6",
      browserFamily: "safari",
      browserVersionReported: "26.0",
    },
  ],
  [
    "Firefox on macOS",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0",
    {
      osFamily: "macos",
      osVersionReported: "10.15",
      browserFamily: "firefox",
      browserVersionReported: "139.0",
    },
  ],
  [
    "Chrome on Android",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
    {
      osFamily: "android",
      osVersionReported: "14",
      browserFamily: "chrome",
      browserVersionReported: "126.0.6478.71",
    },
  ],
  [
    "Chrome on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
    {
      osFamily: "ios",
      osVersionReported: "17.5",
      browserFamily: "chrome",
      browserVersionReported: "126.0.6478.54",
    },
  ],
  [
    "Firefox on iOS reports the frozen 18.7",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
    {
      osFamily: "ios",
      osVersionReported: "18.7",
      browserFamily: "firefox",
      browserVersionReported: "127.0",
    },
  ],
  [
    "Edge on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.2592.56 Version/18.0 Mobile/15E148 Safari/604.1",
    {
      osFamily: "ios",
      osVersionReported: "18.3",
      browserFamily: "edge",
      browserVersionReported: "126.0.2592.56",
    },
  ],
  [
    "Edge on Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.56",
    {
      osFamily: "windows",
      osVersionReported: "10.0",
      browserFamily: "edge",
      browserVersionReported: "126.0.2592.56",
    },
  ],
  [
    "Firefox on Linux",
    "Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0",
    {
      osFamily: "linux",
      osVersionReported: "unknown",
      browserFamily: "firefox",
      browserVersionReported: "138.0",
    },
  ],
  [
    "nothing recognisable",
    "curl/8.4.0",
    {
      osFamily: "unknown",
      osVersionReported: "unknown",
      browserFamily: "unknown",
      browserVersionReported: "unknown",
    },
  ],
]

describe("parseUserAgent", () => {
  for (const [name, userAgent, expected] of cases) {
    it(name, () => {
      expect(parseUserAgent({ userAgent })).toEqual(expected)
    })
  }

  it("prefers Client Hints for the platform version and the brand for the browser", () => {
    expect(
      parseUserAgent({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        userAgentData: {
          platform: "macOS",
          platformVersion: "14.5.0",
          brands: [
            { brand: "Not/A)Brand", version: "8" },
            { brand: "Chromium", version: "126" },
            { brand: "Google Chrome", version: "126" },
          ],
        },
      }),
    ).toEqual({
      osFamily: "macos",
      osVersionReported: "14.5.0",
      osVersionFromHints: true,
      browserFamily: "chrome",
      browserVersionReported: "126",
    })
  })

  it("says the OS version came from Client Hints only when it did", () => {
    const chromeMac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    expect(parseUserAgent({ userAgent: chromeMac }).osVersionFromHints).toBeUndefined()
    expect(
      parseUserAgent({ userAgent: chromeMac, userAgentData: { platform: "macOS" } })
        .osVersionFromHints,
    ).toBeUndefined()
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
    expect(
      parseUserAgent({ userAgent: iphone, userAgentData: { platformVersion: "18.6.0" } }),
    ).toMatchObject({ osVersionReported: "18.6" })
    expect(
      parseUserAgent({ userAgent: iphone, userAgentData: { platformVersion: "18.6.0" } })
        .osVersionFromHints,
    ).toBeUndefined()
  })
})

describe("parseUserAgent brands", () => {
  const chromiumUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
  const brave = { brand: "Brave", version: "140" }
  const chromium = { brand: "Chromium", version: "140" }
  const filler = { brand: "Not-A.Brand", version: "24" }

  it("reads Brave from its brand, in any order, with its Chromium-numbered version", () => {
    for (const brands of [
      [chromium, brave, filler],
      [brave, filler, chromium],
      [filler, chromium, brave],
    ]) {
      expect(parseUserAgent({ userAgent: chromiumUa, userAgentData: { brands } })).toMatchObject({
        browserFamily: "brave",
        browserVersionReported: "140",
      })
    }
  })

  it("puts Brave ahead of a Chrome brand whatever order they come in", () => {
    const googleChrome = { brand: "Google Chrome", version: "140" }
    expect(
      parseUserAgent({ userAgent: chromiumUa, userAgentData: { brands: [googleChrome, brave] } })
        .browserFamily,
    ).toBe("brave")
  })

  it("reads Chrome from its brand, and Brave without a brand as the Chrome it claims to be", () => {
    const googleChrome = { brand: "Google Chrome", version: "140" }
    expect(
      parseUserAgent({ userAgent: chromiumUa, userAgentData: { brands: [chromium, googleChrome] } })
        .browserFamily,
    ).toBe("chrome")
    expect(parseUserAgent({ userAgent: chromiumUa }).browserFamily).toBe("chrome")
    expect(parseUserAgent({ userAgent: chromiumUa, userAgentData: {} }).browserFamily).toBe(
      "chrome",
    )
  })
})

describe("parseUserAgent with empty Client Hints", () => {
  it("treats an empty platformVersion as no version", () => {
    const info = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
      userAgentData: { platform: "Linux", platformVersion: "" },
    })
    expect(info.osFamily).toBe("linux")
    expect(info.osVersionReported).toBe("unknown")
  })
})

describe("versionBelow", () => {
  it("compares dotted versions numerically", () => {
    expect(versionBelow("18.3", "18.4")).toBe(true)
    expect(versionBelow("18.3.1", "18.4")).toBe(true)
    expect(versionBelow("18.4", "18.4")).toBe(false)
    expect(versionBelow("18.6", "18.4")).toBe(false)
    expect(versionBelow("26.0", "18.4")).toBe(false)
    expect(versionBelow("18", "18.4")).toBe(true)
  })

  it("never calls an unknown or malformed version below the floor", () => {
    expect(versionBelow("unknown", "18.4")).toBe(false)
    expect(versionBelow("abc", "18.4")).toBe(false)
  })
})

describe("iosBelowFloor", () => {
  const ios = (v: string) => ({ osFamily: "ios" as const, osVersionReported: v })
  it("flags only an iOS claim below 18.4", () => {
    expect(iosBelowFloor(ios("18.3"))).toBe(true)
    expect(iosBelowFloor(ios("17.6.1"))).toBe(true)
    expect(iosBelowFloor(ios("18.4"))).toBe(false)
    expect(iosBelowFloor(ios("18.6"))).toBe(false)
    expect(iosBelowFloor(ios("26.0"))).toBe(false)
    expect(iosBelowFloor(ios("unknown"))).toBe(false)
    expect(iosBelowFloor({ osFamily: "macos", osVersionReported: "10.15.7" })).toBe(false)
  })
})
