// @vitest-environment node
/** The invite link's host, and the invite read: the code and whether a referral is credited. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { inviteLink, loadInvite } from "../../../src/features/invite/useInvite"
import { defaultConfig } from "../../support/page"
afterEach(() => vi.unstubAllGlobals())

describe("inviteLink", () => {
  it("names the invite host beside the wallet's own, and production's anywhere else", () => {
    vi.stubGlobal("location", { hostname: "wallet.staging.zk.money" })
    expect(inviteLink("k7q2m9x")).toBe("invite.staging.zk.money/k7q2m9x")
    vi.stubGlobal("location", { hostname: "localhost" })
    expect(inviteLink("k7q2m9x")).toBe("invite.zk.money/k7q2m9x")
  })
})

/** An account service answering the invite code and `credited` referrals. */
function service(credited: number) {
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const body = path === "/domain/invite" ? { code: "k7q2m9x" } : { pending: 1, credited }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}

/** A session over the seeded page, whose auth holds `secretKey`. */
const session = (secretKey: Fr | undefined) =>
  ({ page: { config: defaultConfig }, auth: { getSecretKey: async () => secretKey } } as never)
const unlocked = () => session(new Fr(123n))
const locked = () => session(undefined)

describe("loadInvite", () => {
  it("reads the code and a referral not yet credited", async () => {
    const fetch = service(0)
    await expect(loadInvite(unlocked())).resolves.toEqual({ code: "k7q2m9x", credited: false })
    const paths = fetch.mock.calls.map(([url]) => url.split("?")[0])
    expect(paths.sort()).toEqual([
      `${defaultConfig.accountServiceUrl}/domain/invite`,
      `${defaultConfig.accountServiceUrl}/domain/invite/status`,
    ])
  })

  it("reports a credited referral", async () => {
    service(1)
    await expect(loadInvite(unlocked())).resolves.toEqual({ code: "k7q2m9x", credited: true })
  })

  it("reads nothing while the wallet is locked", async () => {
    const fetch = service(1)
    await expect(loadInvite(locked())).resolves.toEqual({ credited: false })
    expect(fetch).not.toHaveBeenCalled()
  })
})
