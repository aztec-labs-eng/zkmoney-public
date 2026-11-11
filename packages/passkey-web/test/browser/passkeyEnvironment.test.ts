// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  recordPasskeyEnvironment,
  type PasskeyEnvironment,
  type PasskeyEnvironmentStore,
} from "../../src/browser/passkeyEnvironment.js"

/** A store over one slot, as a consumer keeps the record. */
function memoryStore(): PasskeyEnvironmentStore & { record: PasskeyEnvironment | null } {
  const store = {
    record: null as PasskeyEnvironment | null,
    last: () => store.record,
    save: async (record: PasskeyEnvironment) => void (store.record = record),
  }
  return store
}

describe("passkey environment", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("keeps the creation's label and transports across the assertion records that follow", async () => {
    const store = memoryStore()
    await recordPasskeyEnvironment(
      { created: { attachment: "platform", transports: ["hybrid"] }, posture: "laptop" },
      store,
    )
    await recordPasskeyEnvironment({ aaguid: "abc", posture: "laptop" }, store)
    expect(store.record).toMatchObject({
      aaguid: "abc",
      attachment: "platform",
      transports: ["hybrid"],
    })
    // A later creation replaces them.
    await recordPasskeyEnvironment({ created: {}, posture: "laptop" }, store)
    expect(store.record?.attachment).toBe("unknown")
    expect(store.record?.transports).toBeUndefined()
  })

  it("an assertion naming another provider does not wear the creation's fields", async () => {
    const store = memoryStore()
    await recordPasskeyEnvironment(
      {
        aaguid: "apple",
        created: { attachment: "platform", transports: ["hybrid"] },
        posture: "laptop",
      },
      store,
    )
    await recordPasskeyEnvironment({ aaguid: "key", posture: "laptop" }, store)
    expect(store.record).toMatchObject({ aaguid: "key" })
    expect(store.record?.attachment).toBeUndefined()
    expect(store.record?.transports).toBeUndefined()
  })

  it("records the latest environment as the browser reports it", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    })
    const store = memoryStore()
    await recordPasskeyEnvironment(
      { aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd", posture: "phone" },
      store,
    )
    await recordPasskeyEnvironment({ posture: "phone" }, store)
    expect(store.record).toEqual({
      aaguid: "unknown",
      osFamily: "ios",
      osVersionReported: "18.3",
      browserFamily: "safari",
      browserVersionReported: "18.3",
      posture: "phone",
    })
  })

  it("never throws when the store refuses the record", async () => {
    const store = { last: () => null, save: () => Promise.reject(new Error("quota")) }
    await expect(recordPasskeyEnvironment({ posture: "laptop" }, store)).resolves.toBeUndefined()
  })
})
