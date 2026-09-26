// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildPasskeyEnvironment,
  lastPasskeyEnvironment,
  recordPasskeyEnvironment,
} from "../src/policy/passkeyEnvironment.js"

const KEY = "x.passkeyEnv"

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

  it("builds exactly the schema, with unknown standing in for a missing id or label", () => {
    const record = buildPasskeyEnvironment({ posture: "laptop", userAgent })
    expect(Object.keys(record).sort()).toEqual(SCHEMA)
    expect(record.aaguid).toBe("unknown")
    expect(record.attachment).toBeUndefined()
    const created = buildPasskeyEnvironment({ created: {}, posture: "laptop", userAgent })
    expect(created.attachment).toBe("unknown")
    const full = buildPasskeyEnvironment({
      aaguid: "abc",
      created: { attachment: "platform", transports: ["hybrid", "internal"] },
      posture: "phone",
      userAgent,
    })
    expect(full.aaguid).toBe("abc")
    expect(full.attachment).toBe("platform")
    expect(full.transports).toEqual(["hybrid", "internal"])
  })

  it("keeps the creation's label and transports across the assertion records that follow", async () => {
    await recordPasskeyEnvironment(
      { created: { attachment: "platform", transports: ["hybrid"] }, posture: "laptop" },
      KEY,
    )
    await recordPasskeyEnvironment({ aaguid: "abc", posture: "laptop" }, KEY)
    expect(lastPasskeyEnvironment(KEY)).toMatchObject({
      aaguid: "abc",
      attachment: "platform",
      transports: ["hybrid"],
    })
    // A later creation replaces them.
    await recordPasskeyEnvironment({ created: {}, posture: "laptop" }, KEY)
    expect(lastPasskeyEnvironment(KEY)?.attachment).toBe("unknown")
    expect(lastPasskeyEnvironment(KEY)?.transports).toBeUndefined()
  })

  it("an assertion naming another provider does not wear the creation's fields", async () => {
    await recordPasskeyEnvironment(
      {
        aaguid: "apple",
        created: { attachment: "platform", transports: ["hybrid"] },
        posture: "laptop",
      },
      KEY,
    )
    await recordPasskeyEnvironment({ aaguid: "key", posture: "laptop" }, KEY)
    expect(lastPasskeyEnvironment(KEY)).toMatchObject({ aaguid: "key" })
    expect(lastPasskeyEnvironment(KEY)?.attachment).toBeUndefined()
    expect(lastPasskeyEnvironment(KEY)?.transports).toBeUndefined()
  })

  it("reads a record written before there was a label", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        aaguid: "unknown",
        osFamily: "macos",
        osVersionReported: "10.15.7",
        browserFamily: "safari",
        browserVersionReported: "18.6",
        posture: "laptop",
      }),
    )
    const old = lastPasskeyEnvironment(KEY)
    expect(old?.browserVersionReported).toBe("18.6")
    expect(old?.attachment).toBeUndefined()
  })

  it("records the latest environment under the given key and reads it back", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    })
    await recordPasskeyEnvironment(
      { aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd", posture: "phone" },
      KEY,
    )
    await recordPasskeyEnvironment({ posture: "phone" }, KEY)
    expect(lastPasskeyEnvironment(KEY)).toEqual({
      aaguid: "unknown",
      osFamily: "ios",
      osVersionReported: "18.3",
      browserFamily: "safari",
      browserVersionReported: "18.3",
      posture: "phone",
    })
    expect(lastPasskeyEnvironment("other.key")).toBeNull()
  })

  it("never stores a credential id, key bytes, or an address", async () => {
    await recordPasskeyEnvironment({ aaguid: "x", posture: "laptop" }, KEY)
    const raw = localStorage.getItem(KEY)!
    for (const forbidden of ["credentialId", "prf", "pubkey", "address", "msk"]) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it("is a no-op without storage", async () => {
    vi.stubGlobal("localStorage", undefined)
    await expect(recordPasskeyEnvironment({ posture: "laptop" }, KEY)).resolves.toBeUndefined()
    expect(lastPasskeyEnvironment(KEY)).toBeNull()
  })
})
