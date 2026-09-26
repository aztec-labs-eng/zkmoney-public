// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  currentMisreportsCrossDevice,
  currentPhoneReach,
  mayStartLaptopCeremony,
  safariMislabelsCrossDevice,
  probePhoneReach,
} from "../src/policy/passkeyCapabilities.js"
import { parseUserAgent } from "../src/policy/userAgentInfo.js"

const chromeMac = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
})
const safari = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`,
  })
const firefoxMac = (version: string) =>
  parseUserAgent({
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}) Gecko/20100101 Firefox/${version}`,
  })
const edgeWindows = parseUserAgent({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.56",
})

describe("probePhoneReach", () => {
  it("proceeds when hybrid transport is reported or unknown", () => {
    expect(
      probePhoneReach({
        posture: "laptop",
        userAgent: chromeMac,
        capabilities: { hybridTransport: true },
      }),
    ).toBe("ok")
    expect(probePhoneReach({ posture: "laptop", userAgent: chromeMac, capabilities: {} })).toBe(
      "unknown",
    )
    expect(probePhoneReach({ posture: "laptop", userAgent: chromeMac })).toBe("unknown")
    expect(
      probePhoneReach({
        posture: "laptop",
        userAgent: edgeWindows,
        capabilities: { hybridTransport: true },
      }),
    ).toBe("ok")
  })

  it("refuses an explicit false", () => {
    expect(
      probePhoneReach({
        posture: "laptop",
        userAgent: chromeMac,
        capabilities: { hybridTransport: false },
      }),
    ).toBe("no-hybrid")
  })

  it("applies the desktop floors", () => {
    for (const version of ["17.6", "18.0", "18.6", "25.9"]) {
      expect(probePhoneReach({ posture: "laptop", userAgent: safari(version) })).toBe("below-floor")
    }
    for (const version of ["26", "26.0", "26.4"]) {
      expect(probePhoneReach({ posture: "laptop", userAgent: safari(version) })).toBe("unknown")
    }
    expect(probePhoneReach({ posture: "laptop", userAgent: firefoxMac("138.0") })).toBe(
      "below-floor",
    )
    expect(probePhoneReach({ posture: "laptop", userAgent: firefoxMac("139.0") })).toBe("unknown")
  })

  it("keeps the floors above whatever the browser says about hybrid", () => {
    for (const userAgent of [safari("18.6"), firefoxMac("138.0")]) {
      for (const capabilities of [
        { hybridTransport: false },
        { hybridTransport: true },
        undefined,
      ]) {
        expect(probePhoneReach({ posture: "laptop", userAgent, capabilities })).toBe("below-floor")
      }
    }
  })

  it("never probes a phone", () => {
    expect(
      probePhoneReach({
        posture: "phone",
        userAgent: safari("17.6"),
        capabilities: { hybridTransport: false },
      }),
    ).toBe("ok")
  })
})

describe("mayStartLaptopCeremony", () => {
  it("refuses only a browser below the floor; no phone route is not no authenticator", () => {
    expect(mayStartLaptopCeremony("below-floor")).toBe(false)
    for (const reach of ["ok", "unknown", "no-hybrid"] as const) {
      expect(mayStartLaptopCeremony(reach)).toBe(true)
    }
  })
})

describe("currentPhoneReach", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the static through a cast and treats a missing or failing API as unknown", async () => {
    vi.stubGlobal("navigator", { userAgent: chromeMacUa() })
    vi.stubGlobal("PublicKeyCredential", {})
    expect(await currentPhoneReach("laptop")).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: () => Promise.reject(new Error("x")),
    })
    expect(await currentPhoneReach("laptop")).toBe("unknown")
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: () => Promise.resolve({ hybridTransport: false }),
    })
    expect(await currentPhoneReach("laptop")).toBe("no-hybrid")
    expect(await currentPhoneReach("phone")).toBe("ok")
  })
})

function chromeMacUa() {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
}

const safariMacUa = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`

describe("safariMislabelsCrossDevice", () => {
  it("is the macOS Safari window from 18.6 up to 26", () => {
    for (const version of ["18.6", "18.6.1", "18.7", "25.0"]) {
      expect(safariMislabelsCrossDevice(safari(version))).toBe(true)
    }
    for (const version of ["17.6", "18.0", "18.4", "18.5", "26", "26.0", "26.4"]) {
      expect(safariMislabelsCrossDevice(safari(version))).toBe(false)
    }
  })

  it("needs a parsed version, whatever the bounds", () => {
    const noVersion = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15",
    })
    expect(noVersion.browserVersionReported).toBe("unknown")
    expect(safariMislabelsCrossDevice(noVersion)).toBe(false)
  })

  it("is never another browser or a phone", () => {
    expect(safariMislabelsCrossDevice(chromeMac)).toBe(false)
    expect(safariMislabelsCrossDevice(firefoxMac("139.0"))).toBe(false)
    expect(safariMislabelsCrossDevice(edgeWindows)).toBe(false)
    const iphone = parseUserAgent({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    })
    expect(safariMislabelsCrossDevice(iphone)).toBe(false)
  })

  it("admits whatever sends Safari's UA: a desktop-mode iPad, a WebKit-family browser", () => {
    // Both send the Macintosh string byte for byte, so the window cannot tell them apart and
    // does not try to. Pinned so the admission is a choice, not an accident.
    expect(safariMislabelsCrossDevice(parseUserAgent({ userAgent: safariMacUa("18.6") }))).toBe(
      true,
    )
  })
})

describe("currentMisreportsCrossDevice", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the live user agent, and is false without one", () => {
    vi.stubGlobal("navigator", { userAgent: safariMacUa("18.6") })
    expect(currentMisreportsCrossDevice()).toBe(true)
    vi.stubGlobal("navigator", { userAgent: chromeMacUa() })
    expect(currentMisreportsCrossDevice()).toBe(false)
    vi.stubGlobal("navigator", undefined)
    expect(currentMisreportsCrossDevice()).toBe(false)
  })
})
