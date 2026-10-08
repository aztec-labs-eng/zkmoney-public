/**
 * The campaign hand-off's health counts: what a page load did with the hand-off, and where an
 * adopted campaign account's key came from. They leave on the identifier-free signup channel,
 * whatever the consent answer, once per page load; the boot strips the fragment before anything
 * can see it and reports only after. Requests are recorded offline by a stubbed fetch.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

const API = "http://api.test"
const ID = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
const CIPHERTEXT = "c2VhbGVkLW1hdGVyaWFs"

let fetchSpy: MockInstance<typeof fetch>

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("VITE_ZKMONEY_API_URL", API)
  vi.stubEnv("VITE_CAMPAIGN_URL", "https://launch.zk.money")
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
  history.replaceState(null, "", "/")
})
afterEach(() => {
  fetchSpy.mockRestore()
  vi.unstubAllEnvs()
  vi.doUnmock("../src/BootGate")
  vi.doUnmock("../src/config/env")
  vi.doUnmock("../src/platform/auth/discardIncompatiblePasskeyState")
  vi.restoreAllMocks()
})

/** Every request posted so far, parsed. */
const posted = () =>
  fetchSpy.mock.calls.map(([url, init]) => ({
    url: String(url),
    credentials: init?.credentials,
    body: JSON.parse(String(init?.body)),
  }))

async function load(consent: boolean) {
  const analytics = await import("../src/lib/analytics")
  analytics.bindAnalyticsConsent(() => consent)
  return import("../src/lib/handoffHealth")
}

describe("the signup channel", () => {
  it.each([true, false])(
    "sends one receipt per page load with no id, viewport or cookie (consent %s)",
    async (consent) => {
      const health = await load(consent)
      health.reportHandoffReceipt({ receipt: "accepted" })
      health.reportHandoffReceipt({ receipt: "rejected", rejection: "no_key" })
      expect(posted()).toEqual([
        {
          url: `${API}/events`,
          credentials: "omit",
          body: {
            event: "handoff_received",
            platform: "web-signup",
            app_version: "dev",
            props: { receipt: "accepted" },
          },
        },
      ])
    },
  )

  it("reports one adoption, naming whether this page load accepted sealed material", async () => {
    let health = await load(true)
    health.reportHandoffReceipt({ receipt: "accepted" })
    health.reportHandoffAdopted("ceremony")
    health.reportHandoffAdopted("handoff")
    expect(posted().map(({ body }) => body.props)).toEqual([
      { receipt: "accepted" },
      { key_source: "ceremony", material: "accepted" },
    ])

    fetchSpy.mockClear()
    vi.resetModules()
    health = await load(true)
    health.reportHandoffReceipt({ receipt: "plain" })
    health.reportHandoffAdopted("cache")
    expect(posted().map(({ body }) => body.props)).toEqual([
      { receipt: "plain" },
      { key_source: "cache", material: "none" },
    ])
  })

  it("sends nothing in demo mode or with no endpoint", async () => {
    history.replaceState(null, "", "/?demo=recovery")
    let health = await load(true)
    health.reportHandoffReceipt({ receipt: "accepted" })
    health.reportHandoffAdopted("handoff")
    expect(fetchSpy).not.toHaveBeenCalled()

    history.replaceState(null, "", "/")
    sessionStorage.clear()
    vi.resetModules()
    vi.stubEnv("VITE_ZKMONEY_API_URL", "")
    health = await load(true)
    health.reportHandoffReceipt({ receipt: "accepted" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("the boot", () => {
  /** The boot module with its heavy collaborators replaced, and its resolver captured. */
  async function boot() {
    vi.doMock("../src/BootGate", () => ({ BootGate: () => null }))
    vi.doMock("../src/config/env", () => ({
      resolveBootConfig: async () => ({ config: { rpId: "localhost" } }),
    }))
    vi.doMock("../src/platform/auth/discardIncompatiblePasskeyState", () => ({
      discardIncompatiblePasskeyState: async () => {},
    }))
    const order: string[] = []
    vi.spyOn(history, "replaceState").mockImplementation(function (
      this: History,
      ...args: Parameters<History["replaceState"]>
    ) {
      order.push(`strip ${location.hash}`)
      return History.prototype.replaceState.apply(this, args)
    })
    fetchSpy.mockImplementation(async () => {
      order.push(`fetch ${location.hash}`)
      return { ok: true } as Response
    })
    const listen = vi.spyOn(window, "addEventListener")
    const module = await import("../src/walletBoot")
    const afterImport = { hash: location.hash, order: [...order], listeners: listen.mock.calls }
    // The element the component renders carries the resolver the gate would run.
    const element = (module.default as () => { props: { resolveBoot: () => Promise<unknown> } })()
    return { resolveBoot: element.props.resolveBoot, afterImport, order }
  }

  it("strips the fragment before anything runs, and reports the receipt once, after", async () => {
    await load(false)
    history.replaceState(null, "", `/claim/alice?entry=passkey&src=campaign#h=${ID}.${CIPHERTEXT}`)
    const { resolveBoot, afterImport, order } = await boot()
    expect(afterImport.hash).toBe("")
    expect(afterImport.order).toEqual([`strip #h=${ID}.${CIPHERTEXT}`])
    expect(afterImport.listeners).toEqual([])

    // StrictMode shares one attempt, but a retry after a boot error runs the resolver again.
    await resolveBoot()
    await resolveBoot()
    expect(order).toEqual([`strip #h=${ID}.${CIPHERTEXT}`, "fetch "])
    const [{ body, credentials }] = posted()
    // jsdom opened this tab with no referrer, so the campaign did not send it.
    expect(body).toEqual({
      event: "handoff_received",
      platform: "web-signup",
      app_version: "dev",
      props: { receipt: "rejected", rejection: "not_from_campaign" },
    })
    expect(credentials).toBe("omit")
    const text = JSON.stringify(body)
    for (const secret of [ID, CIPHERTEXT, "alice", "launch.zk.money", "#h="]) {
      expect(text).not.toContain(secret)
    }
  })

  it("reports a campaign claim arrival with no fragment as plain, and an ordinary load not at all", async () => {
    await load(false)
    history.replaceState(null, "", "/claim/alice?entry=passkey&src=campaign&rp=localhost")
    await (await boot()).resolveBoot()
    expect(posted().map(({ body }) => body.props)).toEqual([{ receipt: "plain" }])

    fetchSpy.mockClear()
    vi.resetModules()
    await load(false)
    history.replaceState(null, "", "/claim/alice?entry=passkey")
    await (await boot()).resolveBoot()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("imports only reviewed modules, so nothing new runs before the fragment is stripped", () => {
    const source = readFileSync(join(__dirname, "../src/walletBoot.tsx"), "utf8")
    const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map(([, spec]) => spec)
    expect(imports).toEqual([
      "./BootGate",
      "virtual:baked-config-profile",
      "./config/env",
      "./dev/demoFlag",
      "./bridge/fragment",
      "./lib/handoffHealth",
      "../../design-system/src/styles/styles.css",
      "../../design-system/src/styles/cards-modals.css",
    ])
  })
})
