// The sealed hand-off across two same-site origins, in a real browser: the campaign sets this
// click's key cookie on the shared domain and navigates to the wallet with the id and ciphertext in
// the fragment; the wallet's own fragment.ts strips it, checks the referrer, reads and clears that
// cookie and opens the material.
// WebKit is the reason this exists. Pages are fulfilled in-process: no DNS, no network, no wallet
// boot. Needs `pnpm build:passkey-web` and Playwright's browsers (`playwright install chromium webkit`).
// Run: pnpm --filter @obsidion/web-wallet test:sealed-handoff-browser
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, webkit } from "@playwright/test"
import { build } from "vite"

const LAUNCH = "https://launch.zkmoney.test"
const WALLET = "https://wallet.zkmoney.test"
const EVIL = "https://evil.zkmoney.test"
const RP = "zkmoney.test"
const HONEST = `0x${"11".repeat(32)}`
// A valid field element, so only the referrer check can refuse it.
const FORGED = `0x${"22".repeat(32)}`
const ENGINES = { chromium, webkit }
const selected = (process.env.SEALED_HANDOFF_BROWSERS ?? "chromium,webkit").split(",")

async function bundle(entry, name) {
  const [out] = await build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry, formats: ["iife"], name } },
  })
  return out.output[0].code
}

const message = (first) => ({
  v: 1,
  type: "handoff-material",
  nonce: "browser-1",
  derivedAt: Date.now(),
  rpId: RP,
  credentialId: "AbCdEfGhIjKlMnOpQrStUv",
  pubkeyHex: "ab".repeat(64),
  candidates: { first },
})

let pages
before(
  async () => {
    const sealed = await bundle(
      createRequire(import.meta.url).resolve("@obsidion/passkey-web"),
      "Sealed",
    )
    const wallet = await bundle(
      fileURLToPath(new URL("../../src/bridge/fragment.ts", import.meta.url)),
      "Wallet",
    )
    // What walletHandoff.ts does on the tap: this click's key on the shared domain, its id and the
    // ciphertext in the link, then the same-tab navigation.
    const opener = (first, referrer = "") => `<!doctype html>${referrer}<script>${sealed}</script>
    <button id=go>go</button><script>
    window.ready = Sealed.sealHandoff(${JSON.stringify(message(first))}).then((s) => (window.s = s))
    go.onclick = () => {
      const id = crypto.randomUUID()
      document.cookie = Sealed.handoffCookie(s.key, Sealed.sharedCookieDomain(location.hostname, "wallet.zkmoney.test"), true, id)
      location.assign("${WALLET}/claim/alice?entry=passkey#h=" + id + "." + s.sealed)
    }</script>`
    pages = {
      campaign: opener(HONEST),
      noReferrer: opener(HONEST, '<meta name="referrer" content="no-referrer">'),
      evil: opener(FORGED),
      wallet: `<!doctype html><body><script>${wallet}</script><script>
      const sealed = Wallet.takeHandoffFragment()
      window.result = (async () => {
        let held = null
        const ok = await Wallet.receiveHandoffFragment(sealed, { campaignUrl: "${LAUNCH}", rpId: "${RP}" },
          document, (m) => void (held = m))
        return { sealed: !!sealed, url: location.href, ok, candidate: held?.candidates.first ?? null }
      })()</script>`,
    }
  },
  { timeout: 120_000 },
)

for (const name of selected) {
  describe(name, () => {
    let browser
    before(async () => {
      browser = await ENGINES[name].launch()
    })
    after(() => browser?.close())

    /** What the wallet makes of `page`'s click, the hand-off cookies left, and every URL requested. */
    async function handOff(origin, page = "campaign") {
      const context = await browser.newContext()
      const requested = []
      await context.route("**/*", (route) => {
        const url = route.request().url()
        requested.push(url)
        if (url.startsWith(WALLET)) {
          return route.fulfill({
            contentType: "text/html",
            headers: {
              "cross-origin-opener-policy": "same-origin",
              "cross-origin-embedder-policy": "require-corp",
            },
            body: pages.wallet,
          })
        }
        return url.startsWith(origin)
          ? route.fulfill({ contentType: "text/html", body: pages[page] })
          : route.abort()
      })
      const tab = await context.newPage()
      await tab.goto(`${origin}/done`)
      await tab.evaluate(() => window.ready)
      await tab.click("#go")
      await tab.waitForURL(`${WALLET}/**`)
      const result = await tab.evaluate(() => window.result)
      const left = (await context.cookies()).filter((c) => c.name.includes("zkm_handoff_"))
      await context.close()
      return { ...result, requested, left }
    }

    test("the campaign's tab hands the material over and nothing is left behind", async () => {
      const r = await handOff(LAUNCH)
      assert.equal(r.ok, true)
      assert.equal(r.candidate, HONEST)
      assert.equal(r.url, `${WALLET}/claim/alice?entry=passkey`)
      assert.deepEqual(r.left, [])
      assert.ok(!r.requested.some((u) => u.includes("#")), "the fragment reached a server")
    })

    test("a hand-off another host on the domain starts is refused and consumes nothing", async () => {
      const r = await handOff(EVIL, "evil")
      assert.equal(r.sealed, true)
      assert.equal(r.ok, false)
      assert.equal(r.candidate, null)
      // The planted cookie was reachable, so only the referrer refused it; it is left to expire.
      assert.equal(r.left.length, 1)
      assert.equal(r.left[0].domain, ".zkmoney.test")
    })

    test("a hand-off that arrives without a referrer is refused", async () => {
      const r = await handOff(LAUNCH, "noReferrer")
      assert.equal(r.ok, false)
      assert.equal(r.candidate, null)
      assert.equal(r.left.length, 1)
    })
  })
}
