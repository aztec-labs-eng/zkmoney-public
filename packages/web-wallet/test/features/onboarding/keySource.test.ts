// @vitest-environment node
/**
 * Where the key comes from before any ceremony: the held key when it is the passkey asked for, the
 * chooser always a ceremony.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openTestSession } from "../../support/session"

const h = vi.hoisted(() => ({ recoverFromCache: vi.fn() }))

const fakeAuth = () => ({
  rpId: "localhost",
  recoverFromCache: h.recoverFromCache,
})

const { resolveKeySource } = await import("../../../src/features/identity/passkeyAccount")

const held = { credentialId: "cred-held" }

beforeEach(() => {
  vi.clearAllMocks()
  h.recoverFromCache.mockResolvedValue(undefined)
})

beforeEach(() => void openTestSession({ auth: fakeAuth() }))

describe("resolveKeySource", () => {
  it("the held key answers a visit that names no passkey, or names the held one", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource(openTestSession().auth)).toEqual({ kind: "cache", result: held })
    expect(await resolveKeySource(openTestSession().auth, { credentialId: "cred-held" })).toEqual({
      kind: "cache",
      result: held,
    })
  })

  it("the held key never answers for another passkey", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect((await resolveKeySource(openTestSession().auth, { credentialId: "other" })).kind).toBe(
      "ceremony-required",
    )
  })

  it("a phone-steered request is always a ceremony, even with a held key", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource(openTestSession().auth, { discover: true, phone: true })).toEqual({
      kind: "ceremony-required",
      request: { discover: true, phone: true },
    })
    expect(h.recoverFromCache).not.toHaveBeenCalled()
  })
})
