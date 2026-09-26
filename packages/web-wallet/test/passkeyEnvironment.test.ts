import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildPasskeyEnvironment,
  lastPasskeyEnvironment,
  recordPasskeyEnvironment,
} from "../src/platform/auth/passkeyEnvironment"

const SCHEMA = [
  "aaguid",
  "osFamily",
  "osVersionReported",
  "browserFamily",
  "browserVersionReported",
  "posture",
].sort()

const userAgent = {
  osFamily: "macos" as const,
  osVersionReported: "10.15.7",
  browserFamily: "safari" as const,
  browserVersionReported: "26.0",
}

describe("passkey environment", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("builds exactly the schema, with unknown standing in for a missing manager id", () => {
    const record = buildPasskeyEnvironment({ posture: "laptop", userAgent })
    expect(Object.keys(record).sort()).toEqual(SCHEMA)
    expect(record.aaguid).toBe("unknown")
    expect(buildPasskeyEnvironment({ aaguid: "abc", posture: "phone", userAgent }).aaguid).toBe(
      "abc",
    )
  })

  it("records the latest environment and reads it back", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    })
    await recordPasskeyEnvironment({
      aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
      posture: "phone",
    })
    await recordPasskeyEnvironment({ posture: "phone" })
    const record = lastPasskeyEnvironment()
    expect(record).toEqual({
      aaguid: "unknown",
      osFamily: "ios",
      osVersionReported: "18.3",
      browserFamily: "safari",
      browserVersionReported: "18.3",
      posture: "phone",
    })
  })

  it("never stores a credential id, key bytes, or an address", async () => {
    await recordPasskeyEnvironment({ aaguid: "x", posture: "laptop" })
    const raw = localStorage.getItem("webwallet.passkeyEnv")!
    for (const forbidden of ["credentialId", "prf", "pubkey", "address", "msk"]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it("is a no-op without storage", async () => {
    vi.stubGlobal("localStorage", undefined)
    await expect(recordPasskeyEnvironment({ posture: "laptop" })).resolves.toBeUndefined()
    expect(lastPasskeyEnvironment()).toBeNull()
  })
})
