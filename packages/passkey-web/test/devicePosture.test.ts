// @vitest-environment node
import { describe, expect, it } from "vitest"
import { classifyDevicePosture } from "../src/policy/devicePosture.js"

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  // iPad in desktop mode and an iPhone with "Request Desktop Website" both send a Mac UA.
  desktopModeSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
}

describe("classifyDevicePosture", () => {
  it("phones by user agent", () => {
    expect(classifyDevicePosture({ userAgent: UA.iphoneSafari })).toBe("phone")
    expect(classifyDevicePosture({ userAgent: UA.androidChrome })).toBe("phone")
  })

  it("laptops by user agent", () => {
    expect(classifyDevicePosture({ userAgent: UA.macChrome })).toBe("laptop")
    expect(classifyDevicePosture({ userAgent: UA.windowsEdge })).toBe("laptop")
  })

  it("Client Hints win over the user agent", () => {
    expect(classifyDevicePosture({ userAgent: UA.macChrome, userAgentDataMobile: true })).toBe(
      "phone",
    )
    expect(classifyDevicePosture({ userAgent: UA.iphoneSafari, userAgentDataMobile: false })).toBe(
      "laptop",
    )
  })

  it("tablets and desktop-mode phones are laptops", () => {
    expect(classifyDevicePosture({ userAgent: UA.ipadSafari })).toBe("laptop")
    expect(classifyDevicePosture({ userAgent: UA.desktopModeSafari })).toBe("laptop")
    expect(classifyDevicePosture({ userAgent: UA.androidTablet })).toBe("laptop")
  })

  it("an empty user agent is a laptop", () => {
    expect(classifyDevicePosture({ userAgent: "" })).toBe("laptop")
  })
})
