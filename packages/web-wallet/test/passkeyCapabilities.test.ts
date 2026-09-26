// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { currentPhoneReach, probePhoneReach } from "../src/platform/auth/passkeyCapabilities"
import { parseUserAgent } from "../src/platform/auth/userAgentInfo"

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
    expect(probePhoneReach({ posture: "laptop", userAgent: safari("17.6") })).toBe("below-floor")
    expect(probePhoneReach({ posture: "laptop", userAgent: safari("18.0") })).toBe("unknown")
    expect(probePhoneReach({ posture: "laptop", userAgent: firefoxMac("138.0") })).toBe(
      "below-floor",
    )
    expect(probePhoneReach({ posture: "laptop", userAgent: firefoxMac("139.0") })).toBe("unknown")
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
