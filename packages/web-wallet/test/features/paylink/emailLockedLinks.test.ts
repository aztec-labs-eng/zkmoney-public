// @vitest-environment node
/** Email-locked links: off unless VITE_EMAIL_LOCKED_LINKS is "true"; while off, refused at decode and at creation. */
import { describe, expect, it, vi } from "vitest"
import { openTestSession } from "../../support/session"

vi.stubGlobal("location", { origin: "https://wallet.test" })
vi.stubEnv("VITE_EMAIL_LOCKED_LINKS", undefined)
const config = await (await import("../../support/seedBootConfig")).sandboxConfig()

const { createSponsoredLink, decodeLink, EmailPaylinkUnsupportedError } = await import(
  "../../../src/features/paylink/sponsoredPaylink"
)
const { demoClaimFragments } = await import("../../../src/dev/demoFixtures")

describe("email-locked links", () => {
  it("decodeLink refuses an email link by its paylink type and decodes a direct one", () => {
    const { direct, email } = demoClaimFragments()
    expect(() => decodeLink(config, email)).toThrow(EmailPaylinkUnsupportedError)
    expect(decodeLink(config, direct)).toMatchObject({ fragment: direct, flavor: "direct" })
  })

  it("createSponsoredLink refuses an email lock before any work, and lets a direct link through", async () => {
    const session = openTestSession()
    const runUserFlow = vi.spyOn(session.page.prover, "runUserFlow")
    await expect(
      createSponsoredLink({ session } as never, "5", vi.fn(), { email: "friend@example.com" }),
    ).rejects.toBeInstanceOf(EmailPaylinkUnsupportedError)
    expect(runUserFlow).not.toHaveBeenCalled()
    // A direct link passes the lock and runs as a user flow; a visitor has no account to send it.
    const direct = createSponsoredLink({ session } as never, "5", vi.fn(), {})
    await expect(direct).rejects.toMatchObject({ code: "wallet.notReady" })
    expect(runUserFlow).toHaveBeenCalledOnce()
  })
})
