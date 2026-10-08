// @vitest-environment node
/**
 * Where the key comes from before any ceremony: hand-off material only on the hand-off naming it,
 * the held key when it is the passkey asked for, the chooser always a ceremony.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  recoverFromHandoffMaterial: vi.fn(),
  recoverFromCache: vi.fn(),
  takeHandoffMaterial: vi.fn(),
}))

vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    rpId: "localhost",
    recoverFromHandoffMaterial: h.recoverFromHandoffMaterial,
    recoverFromCache: h.recoverFromCache,
  }),
}))
vi.mock("../src/platform/storage/handoffMaterial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/storage/handoffMaterial")>()),
  takeHandoffMaterial: h.takeHandoffMaterial,
}))

const { resolveKeySource } = await import("../src/features/onboarding/oxideOnboarding")
const { NoPrfError, RotatedCredentialError } = await import("@obsidion/passkey-web")

const held = { credentialId: "cred-held" }

beforeEach(() => {
  vi.clearAllMocks()
  h.takeHandoffMaterial.mockReturnValue(null)
  h.recoverFromCache.mockResolvedValue(undefined)
})

describe("resolveKeySource", () => {
  it("a plain visit with no held key is a ceremony with the request as given", async () => {
    expect(await resolveKeySource({ credentialId: "cred" })).toEqual({
      kind: "ceremony-required",
      request: { credentialId: "cred" },
    })
    expect(h.takeHandoffMaterial).not.toHaveBeenCalled()
  })

  it("the held key answers a visit that names no passkey, or names the held one", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource()).toEqual({ kind: "cache", result: held })
    expect(await resolveKeySource({ credentialId: "cred-held" })).toEqual({
      kind: "cache",
      result: held,
    })
  })

  it("the held key never answers for another passkey", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect((await resolveKeySource({ credentialId: "other" })).kind).toBe("ceremony-required")
  })

  it("the chooser is always a ceremony, even with a held key", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource({ chooser: true })).toEqual({
      kind: "ceremony-required",
      request: { chooser: true },
    })
    expect(h.recoverFromCache).not.toHaveBeenCalled()
  })

  it("a discoverable request without the chooser still lets the held key answer", async () => {
    h.recoverFromCache.mockResolvedValue(held)
    expect(await resolveKeySource({ discover: true })).toEqual({ kind: "cache", result: held })
    expect(h.recoverFromCache).toHaveBeenCalled()
  })

  it("the chooser bypasses the hand-off material too, not only the cache", async () => {
    h.takeHandoffMaterial.mockReturnValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromCache.mockResolvedValue(held)
    expect(
      (await resolveKeySource({ credentialId: "cred", handoff: true, chooser: true })).kind,
    ).toBe("ceremony-required")
    expect(h.takeHandoffMaterial).not.toHaveBeenCalled()
    expect(h.recoverFromCache).not.toHaveBeenCalled()
  })

  it("hand-off material is read only on the hand-off navigation, and only for its credential", async () => {
    const material = { credentialId: "cred" }
    const result = { credentialId: "cred" }
    h.takeHandoffMaterial.mockReturnValue(material)
    h.recoverFromHandoffMaterial.mockResolvedValue(result)
    // Not a hand-off: material untouched.
    expect((await resolveKeySource({ credentialId: "cred" })).kind).toBe("ceremony-required")
    expect(h.takeHandoffMaterial).not.toHaveBeenCalled()
    // The hand-off itself.
    expect(await resolveKeySource({ credentialId: "cred", handoff: true })).toEqual({
      kind: "handoff",
      result,
    })
    expect(h.takeHandoffMaterial).toHaveBeenCalledWith("cred", "localhost")
  })

  it("material with no usable candidate is spent, and what follows decides", async () => {
    h.takeHandoffMaterial.mockReturnValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockRejectedValue(new NoPrfError())
    h.recoverFromCache.mockResolvedValue({ credentialId: "cred" })
    expect((await resolveKeySource({ credentialId: "cred", handoff: true })).kind).toBe("cache")
    h.recoverFromCache.mockResolvedValue(undefined)
    expect((await resolveKeySource({ credentialId: "cred", handoff: true })).kind).toBe(
      "ceremony-required",
    )
  })

  it("material naming a rotated credential is refused, as after a ceremony", async () => {
    h.takeHandoffMaterial.mockReturnValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockRejectedValue(new RotatedCredentialError())
    await expect(resolveKeySource({ credentialId: "cred", handoff: true })).rejects.toMatchObject({
      name: "RotatedCredentialError",
    })
  })

  it("a hand-off with no material falls through to the held key, then to the ceremony", async () => {
    h.recoverFromCache.mockResolvedValue({ credentialId: "cred" })
    expect((await resolveKeySource({ credentialId: "cred", handoff: true })).kind).toBe("cache")
    h.recoverFromCache.mockResolvedValue(undefined)
    expect((await resolveKeySource({ credentialId: "cred", handoff: true })).kind).toBe(
      "ceremony-required",
    )
  })
})
