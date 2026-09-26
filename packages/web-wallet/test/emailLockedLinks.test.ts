// @vitest-environment node
/** Email-locked links: off unless VITE_EMAIL_LOCKED_LINKS is "true"; while off, refused at decode and at creation. */
import { describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"

const runUserFlow = vi.fn()
vi.stubGlobal("location", { origin: "https://wallet.test" })
vi.stubEnv("VITE_EMAIL_LOCKED_LINKS", undefined)
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: Network.SANDBOX }) }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ getAuthService: () => ({}) }))
vi.mock("../src/features/provingGate", () => ({
  runUserFlow: (...a: unknown[]) => runUserFlow(...a),
}))

const { emailLockedLinksEnabled } = await import("../src/config/features")
const { createSponsoredLink, decodeLink, EmailPaylinkUnsupportedError } = await import(
  "../src/features/paylink/sponsoredPaylink"
)
const { demoClaimFragments } = await import("../src/dev/demoFixtures")

describe("email-locked links", () => {
  it("are off when VITE_EMAIL_LOCKED_LINKS is unset", () => {
    expect(emailLockedLinksEnabled).toBe(false)
  })

  it("decodeLink refuses an email link by its paylink type and decodes a direct one", () => {
    const { direct, email } = demoClaimFragments()
    expect(() => decodeLink(email)).toThrow(EmailPaylinkUnsupportedError)
    expect(decodeLink(direct)).toMatchObject({ fragment: direct, flavor: "direct" })
  })

  it("createSponsoredLink refuses an email lock before any work, and lets a direct link through", async () => {
    await expect(
      createSponsoredLink({} as never, "5", vi.fn(), { email: "friend@example.com" }),
    ).rejects.toBeInstanceOf(EmailPaylinkUnsupportedError)
    expect(runUserFlow).not.toHaveBeenCalled()
    void createSponsoredLink({} as never, "5", vi.fn(), {})
    expect(runUserFlow).toHaveBeenCalledOnce()
  })

  it('decode an email link when VITE_EMAIL_LOCKED_LINKS is "true"', async () => {
    vi.stubEnv("VITE_EMAIL_LOCKED_LINKS", "true")
    vi.resetModules()
    const on = await import("../src/features/paylink/sponsoredPaylink")
    expect(on.decodeLink(demoClaimFragments().email)).toMatchObject({ flavor: "email" })
  })
})
